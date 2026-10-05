import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionEntry,
  type AgentSessionImportSelectedInput,
  type AgentSessionImportSelectedOutcome,
  type AgentSessionImportSelectedResult,
  type AgentSessionImportSkipReason,
  type AgentSessionListInput,
  type AgentSessionListResult,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

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
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const ProviderResumeCursorIds = Schema.Struct({
  threadId: Schema.optional(Schema.String),
  resume: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
});
const decodeProviderResumeCursorIds = Schema.decodeUnknownOption(ProviderResumeCursorIds);

const ownedSessionKey = (provider: string, providerSessionId: string) =>
  `${provider}\0${providerSessionId}`;

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const importAgentThread = Effect.fn("importAgentThreadV2")(function* (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly thread: AgentSessionScanner.AgentSessionThread;
    readonly source: AgentSessionImportSource;
  }) {
    const { thread, source } = input;
    const threadId = ThreadId.make(
      `import:${thread.providerInstanceId}:${thread.providerSessionId}`,
    );
    if (
      thread.source === "claudeAgent" &&
      !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
    ) {
      return yield* new AgentSessionUnresumableSessionError({
        source: thread.source,
        providerSessionId: thread.providerSessionId,
      });
    }
    const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
    if (Option.isSome(existing)) {
      if (existing.value.thread.projectId !== input.projectId) {
        return yield* new AgentSessionThreadProjectConflictError({
          threadId,
          expectedProjectId: input.projectId,
          actualProjectId: existing.value.thread.projectId,
        });
      }
      if (existing.value.thread.historyOrigin !== "v1_import") {
        return yield* new AgentSessionThreadModifiedError({ threadId });
      }
      yield* runtimes.recordImportedTranscript({ threadId, source });
      return threadId;
    }

    const driver = ProviderDriverKind.make(thread.source);
    const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      nativeThreadId: thread.providerSessionId,
    });
    const createdAt = dateTime(thread.createdAt);
    const updatedAt = dateTime(thread.updatedAt);
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: input.projectId,
      title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
      providerInstanceId: thread.providerInstanceId,
      modelSelection: { instanceId: thread.providerInstanceId, model },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      historyOrigin: "v1_import",
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: null,
      settledOverride: "settled",
      settledAt: updatedAt,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: thread.providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver,
        nativeId: thread.providerSessionId,
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt,
      updatedAt,
    };

    yield* runtimes.upsert(
      {
        threadId,
        providerName: driver,
        providerInstanceId: thread.providerInstanceId,
        adapterKey: driver,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        status: "stopped",
        lastSeenAt: thread.updatedAt,
        resumeCursor:
          thread.source === "codex"
            ? { threadId: thread.providerSessionId }
            : { threadId, resume: thread.providerSessionId },
        runtimePayload: { cwd: input.workspaceRoot },
      },
      { onConflict: "ignore" },
    );
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
          type: "thread.created",
          threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: createdAt,
          payload: appThread,
        },
        ...thread.messages.flatMap((message, index) => messageEvents({ threadId, index, message })),
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: updatedAt,
          payload: providerThread,
        },
      ],
    });
    yield* runtimes.recordImportedTranscript({ threadId, source });
    return threadId;
  });

  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* importAgentThread({
          projectId: input.projectId,
          workspaceRoot: project.workspaceRoot,
          thread: outcome.thread,
          source,
        }).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
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

  const readOwnedSessions = Effect.fn("readOwnedSessions")(function* () {
    const bindings = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const owned = new Map<string, ThreadId>();
    for (const binding of bindings) {
      // The resume cursor is stored before imported history. An interrupted
      // import without its completion marker must remain retryable.
      if (binding.threadId.startsWith("import:")) {
        const payload = decodeImportedTranscriptPayload(binding.runtimePayload);
        if (Option.isNone(payload) || !payload.value.importedTranscripts?.length) continue;
      }
      const cursor = decodeProviderResumeCursorIds(binding.resumeCursor);
      if (Option.isNone(cursor)) continue;
      const providerSessionId =
        binding.providerName === "codex"
          ? cursor.value.threadId
          : binding.providerName === "claudeAgent"
            ? (cursor.value.resume ?? cursor.value.sessionId)
            : undefined;
      if (providerSessionId !== undefined && providerSessionId.length > 0) {
        owned.set(ownedSessionKey(binding.providerName, providerSessionId), binding.threadId);
      }
    }
    return owned;
  });

  const readProjectsByRoot = Effect.fn("readProjectsByRoot")(function* () {
    const shells = yield* projects
      .listShells()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    return new Map(
      shells.map((project) => [normalizeProjectPathForComparison(project.workspaceRoot), project]),
    );
  });

  /** Every Claude Code and Codex session on this environment, for the session picker. */
  const listAgentSessions = Effect.fn("listAgentSessions")(function* (
    _input: AgentSessionListInput,
  ) {
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
  const importSelectedAgentSessions = Effect.fn("importSelectedAgentSessions")(function* (
    input: AgentSessionImportSelectedInput,
  ) {
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
          const projectId = yield* idAllocator.allocate.project({ fixtureName: cwd });
          const commandId = yield* idAllocator.allocate.command({
            fixtureName: cwd,
            commandName: "agent-session-import.project.bootstrap",
          });
          return yield* projects.bootstrap({
            commandId,
            projectId,
            title: folderName,
            workspaceRoot: cwd,
          });
        }).pipe(Effect.result);
        if (created._tag === "Failure") {
          yield* Effect.logWarning("Could not create a project for an imported session", {
            cwd,
            cause: created.failure,
          });
          skip("conflict");
          continue;
        }
        project = created.success.project;
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
      owned.set(ownedSessionKey(thread.source, thread.providerSessionId), imported.success);
      outcomes.push({
        _tag: "Imported",
        session,
        threadId: imported.success,
        projectId: project.id,
      });
    }

    return { outcomes } satisfies AgentSessionImportSelectedResult;
  });

  return { importRecentAgentThreads, listAgentSessions, importSelectedAgentSessions };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
