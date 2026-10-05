import { expect, it } from "@effect/vitest";
import {
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    listSessions: Effect.die("unused"),
    readSession: () => Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const testLayer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(testLayer));
});

const selectedSession = (
  provider: "codex" | "claudeAgent",
  nativeId: string,
  cwd = "/workspace/project",
): AgentSessionScanner.AgentSessionRead => ({
  cwd,
  cwdExists: true,
  folderName: "project",
  source: {
    provider,
    providerInstanceId: ProviderInstanceId.make(provider),
    providerSessionId: nativeId,
    filePath: `/sessions/${nativeId}.jsonl`,
    size: 100,
    mtimeMs: 2,
    device: 3,
    inode: 4,
    birthtimeMs: 1,
  },
  thread: {
    source: provider,
    providerInstanceId: ProviderInstanceId.make(provider),
    providerSessionId: nativeId,
    title: "Chosen conversation",
    model: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:01:00.000Z",
    messages: [
      { role: "user", text: "Continue this task", createdAt: "2026-09-01T10:00:00.000Z" },
      { role: "assistant", text: "Previous progress", createdAt: "2026-09-01T10:01:00.000Z" },
    ],
  },
});

const project: Project = {
  id: projectId,
  title: "project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
  deletedAt: null,
};

function pickerHarness(input: {
  readonly sessions: ReadonlyArray<AgentSessionScanner.AgentSessionRead>;
  readonly projects?: ReadonlyArray<Project>;
  readonly runtimes?: ReadonlyArray<ProviderSessionRuntime.ProviderSessionRuntime>;
}) {
  const knownProjects = [...(input.projects ?? [])];
  const runtimeRows = [...(input.runtimes ?? [])];
  const events: OrchestrationV2DomainEvent[] = [];
  const createdProjects: Project[] = [];
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () => Stream.empty,
    listSessions: Effect.succeed({
      sessions: input.sessions.map((read) => ({
        ...read.thread,
        cwd: read.cwd,
        cwdExists: read.cwdExists,
        size: read.source.size,
        automated: false,
        lastActiveAtMs: Date.parse(read.thread.updatedAt),
        filePath: read.source.filePath,
      })),
      truncated: false,
    }),
    readSession: (key) =>
      Effect.succeed(
        Option.fromNullishOr(
          input.sessions.find(
            (read) =>
              read.thread.providerInstanceId === key.providerInstanceId &&
              read.thread.providerSessionId === key.providerSessionId,
          ),
        ),
      ),
  });
  const layer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.sync(() => [...knownProjects]),
          bootstrap: (request) =>
            Effect.sync(() => {
              const created = {
                ...project,
                id: request.projectId,
                title: request.title,
                workspaceRoot: request.workspaceRoot,
              };
              createdProjects.push(created);
              knownProjects.push(created);
              return { project: created, created: true };
            }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (id) =>
            Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId: id })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (request) =>
            Effect.sync(() => {
              events.push(...request.events);
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.sync(() => [...runtimeRows]),
          upsert: (runtime) =>
            Effect.sync(() => {
              runtimeRows.push(runtime);
            }),
          recordImportedTranscript: ({ threadId, source }) =>
            Effect.sync(() => {
              const index = runtimeRows.findIndex((runtime) => runtime.threadId === threadId);
              const runtime = runtimeRows[index];
              if (runtime !== undefined) {
                runtimeRows[index] = {
                  ...runtime,
                  runtimePayload: { cwd: "/workspace/project", importedTranscripts: [source] },
                };
              }
            }),
        }),
        IdAllocator.layer,
      ),
    ),
  );
  return { layer, events, createdProjects, runtimeRows };
}

const keyOf = (read: AgentSessionScanner.AgentSessionRead) => ({
  providerInstanceId: read.thread.providerInstanceId,
  providerSessionId: read.thread.providerSessionId,
});

it.effect(
  "selected Codex and Claude sessions share a created project and preserve resumable V2 history",
  () => {
    const codex = selectedSession("codex", "chosen-codex");
    const claude = selectedSession("claudeAgent", "11111111-2222-4333-8444-555555555555");
    const harness = pickerHarness({ sessions: [codex, claude] });
    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const result = yield* importer.importSelectedAgentSessions({
        sessions: [keyOf(codex), keyOf(claude)],
      });
      expect(result.outcomes.map((outcome) => outcome._tag)).toEqual(["Imported", "Imported"]);
      expect(harness.createdProjects).toHaveLength(1);
      const project = harness.createdProjects[0]!;
      expect(project.workspaceRoot).toBe(codex.cwd);
      expect(
        harness.events
          .filter((event) => event.type === "thread.created")
          .map((event) => event.payload.projectId),
      ).toEqual([project.id, project.id]);
      expect(
        harness.events
          .filter((event) => event.type === "message.updated")
          .map((event) => event.payload.text),
      ).toEqual([
        "Continue this task",
        "Previous progress",
        "Continue this task",
        "Previous progress",
      ]);
      expect(
        harness.events
          .filter((event) => event.type === "provider-thread.updated")
          .map((event) => event.payload.nativeThreadRef?.nativeId),
      ).toEqual([codex.thread.providerSessionId, claude.thread.providerSessionId]);
      expect(harness.runtimeRows.map((runtime) => runtime.resumeCursor)).toEqual([
        { threadId: codex.thread.providerSessionId },
        {
          threadId: `import:claudeAgent:${claude.thread.providerSessionId}`,
          resume: claude.thread.providerSessionId,
        },
      ]);
      const again = yield* importer.importSelectedAgentSessions({ sessions: [keyOf(codex)] });
      expect(again.outcomes[0]?._tag).toBe("AlreadyInT3");
      expect(harness.events.filter((event) => event.type === "thread.created")).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("the picker marks provider sessions already owned by native T3 threads", () => {
  const codex = selectedSession("codex", "native-existing");
  const existingThreadId = ThreadId.make("existing-t3-thread");
  const harness = pickerHarness({
    sessions: [codex],
    projects: [project],
    runtimes: [
      {
        threadId: existingThreadId,
        providerName: "codex",
        providerInstanceId,
        adapterKey: "codex",
        runtimeMode: DEFAULT_RUNTIME_MODE,
        status: "stopped",
        lastSeenAt: codex.thread.updatedAt,
        resumeCursor: { threadId: codex.thread.providerSessionId },
        runtimePayload: { cwd: codex.cwd },
      },
    ],
  });
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const listing = yield* importer.listAgentSessions({});
    expect(listing.sessions[0]).toMatchObject({
      provider: "codex",
      threadId: existingThreadId,
      projectId,
    });
    const selected = yield* importer.importSelectedAgentSessions({ sessions: [keyOf(codex)] });
    expect(selected.outcomes).toEqual([
      { _tag: "AlreadyInT3", session: keyOf(codex), threadId: existingThreadId },
    ]);
    expect(harness.events).toEqual([]);
    expect(harness.createdProjects).toEqual([]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "selected imports skip unavailable sessions and do not create projects for missing folders",
  () => {
    const missingFolder = { ...selectedSession("codex", "deleted-project"), cwdExists: false };
    const valid = selectedSession("codex", "valid-project");
    const missingKey = { providerInstanceId, providerSessionId: "deleted-transcript" };
    const harness = pickerHarness({ sessions: [missingFolder, valid], projects: [project] });
    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const result = yield* importer.importSelectedAgentSessions({
        sessions: [keyOf(missingFolder), missingKey, keyOf(valid), keyOf(valid)],
      });
      expect(
        result.outcomes.map((outcome) =>
          outcome._tag === "Skipped" ? outcome.reason : outcome._tag,
        ),
      ).toEqual(["folder-missing", "not-found", "Imported", "AlreadyInT3"]);
      expect(harness.createdProjects).toEqual([]);
      expect(harness.events.filter((event) => event.type === "thread.created")).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "an interrupted import's resume row does not hide a session whose history was never saved",
  () => {
    const session = selectedSession("codex", "interrupted");
    const importedThreadId = ThreadId.make("import:codex:interrupted");
    const harness = pickerHarness({
      sessions: [session],
      projects: [project],
      runtimes: [
        {
          threadId: importedThreadId,
          providerName: "codex",
          providerInstanceId,
          adapterKey: "codex",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          status: "stopped",
          lastSeenAt: session.thread.updatedAt,
          resumeCursor: { threadId: session.thread.providerSessionId },
          runtimePayload: { cwd: session.cwd },
        },
      ],
    });
    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const listing = yield* importer.listAgentSessions({});
      expect(listing.sessions[0]?.threadId).toBeUndefined();
      const result = yield* importer.importSelectedAgentSessions({ sessions: [keyOf(session)] });
      expect(result.outcomes[0]).toMatchObject({ _tag: "Imported", threadId: importedThreadId });
      expect(harness.events.filter((event) => event.type === "message.updated")).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer));
  },
);
