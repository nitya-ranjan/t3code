import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  FallbackChainId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  initialThreadFallbackState,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AccountFallback from "./AccountFallbackReactor.ts";
import { FallbackWebhook } from "./accountFallback/webhook.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapters from "./ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const a = ProviderInstanceId.make("codex-a");
const b = ProviderInstanceId.make("codex-b");
const chainId = FallbackChainId.make("work");
const threadId = ThreadId.make("fallback-thread");
const nowIso = "2026-10-05T12:00:00.000Z";
const resetAt = "2026-10-05T13:00:00.000Z";
const selection = {
  instanceId: a,
  model: "gpt-6",
  options: [{ id: "reasoningEffort", value: "high" }],
};

function testLayer(options: { differentHome?: boolean; exhausted?: boolean } = {}) {
  const notifications: string[] = [];
  let beforeCandidates: Effect.Effect<void> = Effect.void;
  const adapters = [a, b].map(
    (instanceId) =>
      ({
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("No provider process needed"),
      }) as ProviderAdapterV2Shape,
  );
  const providers: ServerProvider[] = [a, b].map((instanceId) => ({
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: nowIso,
    models: [],
    slashCommands: [],
    skills: [],
    ...(options.exhausted
      ? {
          usageLimits: {
            checkedAt: nowIso,
            windows: [
              { id: "daily", kind: "other", label: "Daily", usedPercent: 100, resetsAt: resetAt },
            ],
          },
        }
      : {}),
  }));
  const instances = adapters.map(
    (adapter) =>
      ({
        instanceId: adapter.instanceId,
        driverKind: adapter.driver,
        enabled: true,
        displayName: adapter.instanceId,
        orchestrationAdapter: adapter,
        snapshot: {
          getSnapshot: Effect.succeed(providers.find((p) => p.instanceId === adapter.instanceId)!),
          refresh: Effect.succeed(providers.find((p) => p.instanceId === adapter.instanceId)!),
          streamChanges: Stream.empty,
          applyUsageLimits: () => Effect.void,
          resolveMaintenance: () => Effect.die("unused maintenance"),
        },
        textGeneration: {
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
        },
        continuationIdentity: {
          driverKind: adapter.driver,
          continuationKey: options.differentHome ? `home:${adapter.instanceId}` : "home:shared",
        },
      }) satisfies ProviderInstance,
  );
  const instanceLayer = Layer.mock(ProviderInstanceRegistry)({
    getInstance: (id) => Effect.succeed(instances.find((instance) => instance.instanceId === id)),
    listInstances: Effect.succeed(instances),
  });
  const database = SqlitePersistenceMemory;
  const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "account-fallback" },
    ProviderAdapters.layerFromProviderInstanceRegistry.pipe(Layer.provide(instanceLayer)),
    { databaseLayer: database, runEffectWorker: false },
  );
  const projections = ProjectionStore.layer.pipe(Layer.provide(database));
  const threads = ThreadManagement.layer.pipe(Layer.provide(runtime));
  const sweepProjections = Layer.effect(
    ProjectionStore.ProjectionStoreV2,
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      return {
        ...store,
        getAccountFallbackCandidates: () =>
          Effect.gen(function* () {
            const candidates = yield* store.getAccountFallbackCandidates();
            yield* beforeCandidates;
            return candidates;
          }),
      };
    }),
  ).pipe(Layer.provide(projections));
  const fallback = AccountFallback.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        threads,
        sweepProjections,
        instanceLayer,
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed(providers),
          refreshInstance: () => Effect.succeed(providers),
        }),
        Layer.succeed(FallbackWebhook, {
          notify: (_url, text) =>
            Effect.sync(() => {
              notifications.push(text);
            }),
        }),
        ServerSettings.layerTest({
          accountFallbackChainId: chainId,
          accountFallback: {
            chains: { [chainId]: { displayName: "Work", instanceIds: [a, b] } },
            webhookUrl: "https://example.test/hook",
          },
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return {
    notifications,
    beforeCandidates: (effect: Effect.Effect<void>) => {
      beforeCandidates = effect;
    },
    layer: Layer.mergeAll(runtime, projections, threads, fallback),
  };
}

const seedFailure = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(nowIso));
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("project"),
    title: "Fix the login",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("send"),
    threadId,
    messageId: MessageId.make("question"),
    text: "Fix the login and add a test",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const run = (yield* projections.getThreadProjection(threadId)).runs[0]!;
  const now = yield* DateTime.now;
  yield* events.write({
    events: [
      {
        id: EventId.make("failure-run"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...run, status: "failed", completedAt: now },
      },
      {
        id: EventId.make("failure-error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("error"),
          type: "error",
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "failed",
          title: "Usage limit",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          failure: {
            class: "usage_limit",
            message: "Account exhausted",
            code: "usageLimitExceeded",
            retryable: null,
            resetAt,
          },
        },
      },
    ],
  });
  return { orchestrator, projections, run, reactor: yield* AccountFallback.AccountFallbackReactor };
});

it.effect("switches same-home accounts once on the V2 thread and preserves model options", () => {
  const fixture = testLayer();
  return Effect.gen(function* () {
    const { projections, reactor } = yield* seedFailure;
    yield* reactor.sweep;
    yield* reactor.sweep;
    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(projection.thread.modelSelection.instanceId, b);
    assert.deepEqual(projection.thread.modelSelection.options, selection.options);
    assert.equal(projection.runs.length, 2);
    assert.equal(projection.runs[1]?.providerInstanceId, b);
    assert.equal(projection.thread.fallback?.handoffTimes.length, 1);
    assert.equal(fixture.notifications.length, 1);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "hands different homes to a new V2 thread with context and shared fallback lineage",
  () => {
    const fixture = testLayer({ differentHome: true });
    return Effect.gen(function* () {
      const { projections, reactor } = yield* seedFailure;
      yield* reactor.sweep;
      const childId = (yield* projections.getThreadProjection(threadId)).thread.fallback
        ?.continuedToThreadId;
      assert.ok(childId);
      const child = yield* projections.getThreadProjection(childId);
      assert.equal(child.thread.fallback?.continuedFromThreadId, threadId);
      assert.equal(child.thread.modelSelection.instanceId, b);
      assert.equal(child.thread.branch, "main");
      assert.equal(child.thread.fallback?.handoffTimes.length, 1);
      assert.ok(
        child.messages.some((message) => message.text.includes("Fix the login and add a test")),
      );
      yield* reactor.sweep;
      assert.equal((yield* projections.getShellSnapshot()).threads.length, 2);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("pauses before the first fallback and resumes after explicit unpause", () => {
  const fixture = testLayer();
  return Effect.gen(function* () {
    const { orchestrator, projections, reactor } = yield* seedFailure;
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("pause"),
      threadId,
      fallbackChainId: chainId,
      fallbackPaused: true,
    });
    yield* reactor.sweep;
    assert.equal((yield* projections.getThreadProjection(threadId)).runs.length, 1);
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("unpause"),
      threadId,
      fallbackPaused: false,
    });
    yield* reactor.sweep;
    assert.equal((yield* projections.getThreadProjection(threadId)).runs.length, 2);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("persists exhausted waits and resumes after reset without duplicate turns", () => {
  const fixture = testLayer({ exhausted: true });
  return Effect.gen(function* () {
    const { projections, reactor } = yield* seedFailure;
    yield* reactor.sweep;
    assert.equal(
      (yield* projections.getThreadProjection(threadId)).thread.fallback?.resumeAt,
      resetAt,
    );
    yield* TestClock.setTime(Date.parse(resetAt));
    yield* reactor.sweep;
    yield* reactor.sweep;
    const resumed = yield* projections.getThreadProjection(threadId);
    assert.equal(resumed.thread.fallback?.status, "idle");
    assert.equal(resumed.runs.length, 2);
    assert.equal(resumed.thread.modelSelection.instanceId, a);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("a real user message cancels a wait and resets tried accounts atomically", () => {
  const fixture = testLayer({ exhausted: true });
  return Effect.gen(function* () {
    const { orchestrator, projections, reactor } = yield* seedFailure;
    yield* reactor.sweep;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("new-question"),
      threadId,
      messageId: MessageId.make("new-question"),
      text: "Do something else",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* reactor.sweep;
    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(projection.thread.fallback?.status, "idle");
    assert.deepEqual(projection.thread.fallback?.triedInstanceIds, []);
    assert.equal(projection.runs.length, 2);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "cancel wait preserves the chain and rejects a stale continuation after a concurrent pause",
  () => {
    const fixture = testLayer({ exhausted: true });
    return Effect.gen(function* () {
      const { orchestrator, projections, reactor, run } = yield* seedFailure;
      yield* reactor.sweep;
      const stale = (yield* projections.getThreadProjection(threadId)).thread.fallback!;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("cancel-wait"),
        threadId,
        fallbackCancelWait: true,
      });
      let fallback = (yield* projections.getThreadProjection(threadId)).thread.fallback!;
      assert.equal(fallback.paused, true);
      assert.equal(fallback.status, "idle");
      assert.equal(fallback.waitReason, undefined);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("stale-worker"),
        threadId,
        fallback: { ...stale, paused: false },
      });
      fallback = (yield* projections.getThreadProjection(threadId)).thread.fallback!;
      assert.equal(fallback.paused, true);
      const result = yield* Effect.exit(
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("stale-send"),
          threadId,
          messageId: MessageId.make("stale-send"),
          text: "Continue",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "system",
          creationSource: "server",
          accountFallbackSource: { threadId, runId: run.id },
        }),
      );
      assert.equal(result._tag, "Failure");
      assert.equal((yield* projections.getThreadProjection(threadId)).runs.length, 1);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("enforces the hourly handoff cap on persisted V2 state", () => {
  const fixture = testLayer();
  return Effect.gen(function* () {
    const { orchestrator, projections, reactor } = yield* seedFailure;
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("cap"),
      threadId,
      fallback: { ...initialThreadFallbackState(chainId), handoffTimes: [nowIso, nowIso, nowIso] },
    });
    yield* reactor.sweep;
    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(projection.thread.fallback?.waitReason, "handoff-cap");
    assert.equal(projection.thread.fallback?.candidateInstanceId, b);
    assert.equal(projection.runs.length, 1);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "ignores a stale limited-run snapshot when the user has already completed newer work",
  () => {
    const fixture = testLayer();
    return Effect.gen(function* () {
      const { orchestrator, projections, reactor } = yield* seedFailure;
      const events = yield* EventSink.EventSinkV2;
      fixture.beforeCandidates(
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("race-user"),
            threadId,
            messageId: MessageId.make("race-user"),
            text: "User already continued",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const run = (yield* projections.getThreadProjection(threadId)).runs[1]!;
          const now = yield* DateTime.now;
          yield* events.write({
            events: [
              {
                id: EventId.make("new-complete"),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: { ...run, status: "completed", completedAt: now },
              },
            ],
          });
        }).pipe(Effect.orDie),
      );
      yield* reactor.sweep;
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.runs.length, 2);
      assert.equal(projection.thread.modelSelection.instanceId, a);
      assert.equal(projection.thread.fallback, undefined);
      assert.equal(fixture.notifications.length, 0);
    }).pipe(Effect.provide(fixture.layer));
  },
);
