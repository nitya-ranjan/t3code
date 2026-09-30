import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionSource,
  AgentSessionScanError,
  isImportedAgentSessionMessageId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type AgentSessionEntry,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionImportSelectedInput,
  type AgentSessionImportSelectedOutcome,
  type AgentSessionImportSelectedResult,
  type AgentSessionImportSkipReason,
  type AgentSessionImportSource,
  type AgentSessionListInput,
  type AgentSessionListResult,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' changed before its history import completed.`;
  }
}

function hasImportedHistory(thread: OrchestrationThread): boolean {
  return thread.messages.some((message) => isImportedAgentSessionMessageId(message.id));
}

function hasImportBlockingActivity(
  thread: OrchestrationThread,
  importedHistoryPresent: boolean,
): boolean {
  return (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.latestTurn !== null ||
    thread.session !== null ||
    thread.messages.some((message) => !isImportedAgentSessionMessageId(message.id)) ||
    thread.proposedPlans.length > 0 ||
    thread.activities.length > 0 ||
    thread.checkpoints.length > 0 ||
    thread.snoozedUntil != null ||
    thread.snoozedAt != null ||
    thread.pinnedAt != null ||
    thread.pinOrderKey != null ||
    thread.autoSettleDisabledAt != null ||
    thread.titleRegeneration != null ||
    thread.linkedPullRequest != null ||
    thread.unsettledAt != null ||
    (importedHistoryPresent
      ? thread.settledOverride !== "settled"
      : thread.settledOverride !== null || thread.settledAt !== null)
  );
}

/**
 * Create one imported thread with its history and the cursor that resumes the
 * provider session. Safe to repeat: an already imported thread only records the
 * transcript copy.
 */
const importAgentThread = Effect.fn("importAgentThread")(function* (input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly thread: AgentSessionScanner.AgentSessionThread;
  readonly source: AgentSessionImportSource;
}) {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const { thread, workspaceRoot } = input;
  const threadId = ThreadId.make(`import:${thread.providerInstanceId}:${thread.providerSessionId}`);
  const provider = ProviderDriverKind.make(thread.source);
  const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  const existingThread = yield* snapshots.getThreadDetailById(threadId);
  const existingBinding = yield* directory.getBinding(threadId);

  if (
    thread.source === "claudeAgent" &&
    !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
  ) {
    return yield* new AgentSessionUnresumableSessionError({
      source: thread.source,
      providerSessionId: thread.providerSessionId,
    });
  }

  if (Option.isSome(existingThread) && existingThread.value.projectId !== input.projectId) {
    return yield* new AgentSessionThreadProjectConflictError({
      threadId,
      expectedProjectId: input.projectId,
      actualProjectId: existingThread.value.projectId,
    });
  }

  const importedHistoryPresent = Option.isSome(existingThread)
    ? hasImportedHistory(existingThread.value)
    : false;
  if (Option.isSome(existingThread) && importedHistoryPresent && Option.isSome(existingBinding)) {
    yield* directory.recordImportedTranscript({ threadId, source: input.source });
    return threadId;
  }

  if (
    Option.isSome(existingThread) &&
    hasImportBlockingActivity(existingThread.value, importedHistoryPresent)
  ) {
    return yield* new AgentSessionThreadModifiedError({ threadId });
  }

  if (
    Option.isSome(existingBinding) &&
    (existingBinding.value.provider !== provider ||
      existingBinding.value.providerInstanceId !== thread.providerInstanceId ||
      existingBinding.value.status !== "stopped")
  ) {
    return yield* new AgentSessionThreadModifiedError({ threadId });
  }

  // Install the cursor before the thread becomes visible. A concurrent
  // real session can replace it, while insert-ignore keeps this import
  // from replacing that newer binding.
  if (Option.isNone(existingBinding)) {
    yield* directory.upsert(
      {
        threadId,
        provider,
        providerInstanceId: thread.providerInstanceId,
        status: "stopped",
        runtimeMode: DEFAULT_RUNTIME_MODE,
        resumeCursor:
          thread.source === "codex"
            ? { threadId: thread.providerSessionId }
            : { threadId, resume: thread.providerSessionId },
        runtimePayload: { cwd: workspaceRoot },
      },
      { onConflict: "ignore" },
    );
  }

  if (Option.isNone(existingThread)) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId,
      projectId: input.projectId,
      title: thread.title,
      modelSelection: { instanceId: thread.providerInstanceId, model },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: thread.createdAt,
      historyImport: true,
    });
  }

  if (!importedHistoryPresent) {
    yield* engine.dispatch({
      type: "thread.history.import",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId,
      messages: thread.messages.map((message, index) => ({
        messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      })),
    });
  }

  yield* directory.recordImportedTranscript({ threadId, source: input.source });

  return threadId;
});

/** Import recent transcript text and persist the cursor needed to resume its provider session. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
        onSome: Effect.succeed,
      }),
    ),
  );
  const workspaceRoot = project.workspaceRoot;
  if (
    input.expectedWorkspaceRoot !== undefined &&
    normalizeProjectPathForComparison(workspaceRoot) !==
      normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
  ) {
    return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
  }
  const completedSources = yield* snapshots
    .getImportedAgentSessionSources(input.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const threads = scanner.recentThreads(
    workspaceRoot,
    completedSources.map((entry) => entry.source),
  );
  const importedThreadIds = new Set<ThreadId>();
  let importedCount = 0;
  let skippedCount = 0;

  yield* Stream.runForEach(threads, (outcome) =>
    Effect.gen(function* () {
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        return;
      }
      if (outcome._tag === "AlreadyImported" || outcome._tag === "Duplicate") {
        const threadId = ThreadId.make(
          `import:${outcome.source.providerInstanceId}:${outcome.source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (importedThreadIds.has(threadId)) {
          const recorded = yield* directory
            .recordImportedTranscript({ threadId, source: outcome.source })
            .pipe(Effect.result);
          if (recorded._tag === "Failure") {
            skippedCount += 1;
            yield* Effect.logWarning("Could not record an imported transcript copy", {
              threadId,
              cause: recorded.failure,
            });
          }
        }
        return;
      }
      const thread = outcome.thread;
      const threadId = ThreadId.make(
        `import:${thread.providerInstanceId}:${thread.providerSessionId}`,
      );
      const imported = yield* importAgentThread({
        projectId: input.projectId,
        workspaceRoot,
        thread,
        source: outcome.source,
      }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Could not import an agent session", {
            provider: thread.source,
            sessionId: thread.providerSessionId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

      if (imported) {
        importedThreadIds.add(threadId);
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
    }),
  );

  return { importedCount, skippedCount } satisfies AgentSessionImportResult;
});

const ProviderResumeCursorIds = Schema.Struct({
  threadId: Schema.optional(Schema.String),
  resume: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
});
const decodeProviderResumeCursorIds = Schema.decodeUnknownOption(ProviderResumeCursorIds);

const ownedSessionKey = (provider: string, providerSessionId: string) =>
  `${provider}\0${providerSessionId}`;

/**
 * Provider sessions T3 Code already owns, keyed by provider and session ID.
 * Imported threads and threads started in T3 Code both count, so neither can
 * be imported a second time. Codex cursors carry the Codex thread ID; Claude
 * cursors carry the session ID as `resume`.
 */
const readOwnedSessions = Effect.fn("readOwnedSessions")(function* () {
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const bindings = yield* directory
    .listBindings()
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const owned = new Map<string, ThreadId>();
  for (const binding of bindings) {
    const cursor = decodeProviderResumeCursorIds(binding.resumeCursor);
    if (Option.isNone(cursor)) continue;
    const providerSessionId =
      binding.provider === "codex"
        ? cursor.value.threadId
        : binding.provider === "claudeAgent"
          ? (cursor.value.resume ?? cursor.value.sessionId)
          : undefined;
    if (providerSessionId !== undefined && providerSessionId.length > 0) {
      owned.set(ownedSessionKey(binding.provider, providerSessionId), binding.threadId);
    }
  }
  return owned;
});

const readProjectsByRoot = Effect.fn("readProjectsByRoot")(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const projects = yield* snapshots
    .getProjectShells()
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  return new Map(
    projects.map((project) => [normalizeProjectPathForComparison(project.workspaceRoot), project]),
  );
});

/** Every Claude Code and Codex session on this environment, for the session picker. */
export const listAgentSessions = Effect.fn("listAgentSessions")(function* (
  _input: AgentSessionListInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const listing = yield* scanner.listSessions;
  const owned = yield* readOwnedSessions();
  const projectsByRoot = yield* readProjectsByRoot();

  const sessions = listing.sessions.map((session): AgentSessionEntry => {
    const threadId = owned.get(ownedSessionKey(session.source, session.providerSessionId));
    const project = projectsByRoot.get(normalizeProjectPathForComparison(session.cwd));
    return {
      provider: session.source,
      providerInstanceId: session.providerInstanceId,
      providerSessionId: session.providerSessionId,
      cwd: session.cwd,
      cwdExists: session.cwdExists,
      title: session.title,
      lastActiveAt: DateTime.formatIso(DateTime.makeUnsafe(session.lastActiveAtMs)),
      size: session.size,
      automated: session.automated,
      ...(threadId === undefined ? {} : { threadId }),
      ...(project === undefined ? {} : { projectId: project.id }),
    };
  });
  return {
    sessions,
    scannedAt: DateTime.formatIso(yield* DateTime.now),
    ...(listing.truncated ? { truncated: true } : {}),
  } satisfies AgentSessionListResult;
});

/**
 * Import the sessions a user picked. Each lands in the project rooted at its
 * working directory, which is created when missing, because a provider only
 * resumes a session from the directory it ran in.
 */
export const importSelectedAgentSessions = Effect.fn("importSelectedAgentSessions")(function* (
  input: AgentSessionImportSelectedInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const owned = yield* readOwnedSessions();
  const projectsByRoot = yield* readProjectsByRoot();
  const outcomes: Array<AgentSessionImportSelectedOutcome> = [];

  for (const session of input.sessions) {
    const skip = (reason: AgentSessionImportSkipReason) =>
      outcomes.push({ _tag: "Skipped", session, reason });
    const read = yield* scanner.readSession(session);
    if (Option.isNone(read)) {
      skip("not-found");
      continue;
    }
    const { thread, cwd, cwdExists, folderName, source } = read.value;
    const ownerThreadId = owned.get(ownedSessionKey(thread.source, thread.providerSessionId));
    if (ownerThreadId !== undefined) {
      outcomes.push({ _tag: "AlreadyInT3", session, threadId: ownerThreadId });
      continue;
    }
    if (!cwdExists) {
      skip("folder-missing");
      continue;
    }

    const rootKey = normalizeProjectPathForComparison(cwd);
    let project = projectsByRoot.get(rootKey);
    if (project === undefined) {
      const created = yield* Effect.gen(function* () {
        const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          projectId,
          title: folderName,
          workspaceRoot: cwd,
          createdAt,
        });
        return { projectId, createdAt };
      }).pipe(Effect.result);
      if (created._tag === "Failure") {
        yield* Effect.logWarning("Could not create a project for an imported session", {
          cwd,
          cause: created.failure,
        });
        skip("conflict");
        continue;
      }
      project = {
        id: created.success.projectId,
        title: folderName,
        workspaceRoot: cwd,
        defaultModelSelection: null,
        scripts: [],
        createdAt: created.success.createdAt,
        updatedAt: created.success.createdAt,
      };
      projectsByRoot.set(rootKey, project);
    }

    const imported = yield* importAgentThread({
      projectId: project.id,
      workspaceRoot: project.workspaceRoot,
      thread,
      source,
    }).pipe(Effect.result);
    if (imported._tag === "Failure") {
      yield* Effect.logWarning("Could not import a selected agent session", {
        provider: thread.source,
        sessionId: thread.providerSessionId,
        cause: imported.failure,
      });
      skip(
        imported.failure._tag === "AgentSessionThreadProjectConflictError" ||
          imported.failure._tag === "AgentSessionThreadModifiedError"
          ? "conflict"
          : "unreadable",
      );
      continue;
    }
    outcomes.push({
      _tag: "Imported",
      session,
      threadId: imported.success,
      projectId: project.id,
    });
  }

  return { outcomes } satisfies AgentSessionImportSelectedResult;
});
