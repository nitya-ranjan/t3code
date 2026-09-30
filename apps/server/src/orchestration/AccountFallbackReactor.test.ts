import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  FallbackChainId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  type ServerProvider,
  type ServerSettings,
  type ThreadFallbackState,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { ProviderUnsupportedError } from "../provider/Errors.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as AccountFallbackReactor from "./AccountFallbackReactor.ts";
import { FallbackWebhook } from "./accountFallback/webhook.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-09-29T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const PROJECT_ID = ProjectId.make("fallback-project");
const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");
const WEBHOOK_URL = "https://hooks.example.test/fallback";
const id = ProviderInstanceId.make;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

let uuidCounter = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill((uuidCounter += 1) % 256),
  digest: (_algorithm, data) => Effect.succeed(data),
});

interface InstanceFixture {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly displayName: string;
  readonly continuationKey: string;
  readonly enabled?: boolean;
  readonly authenticated?: boolean;
  readonly exhaustedUntil?: string;
}

const claudeWork: InstanceFixture = {
  instanceId: id("claude_work"),
  driver: "claudeAgent",
  displayName: "Claude Work",
  continuationKey: "claudeAgent:home:/work",
};
const claudePersonal: InstanceFixture = {
  instanceId: id("claude_personal"),
  driver: "claudeAgent",
  displayName: "Claude Personal",
  continuationKey: "claudeAgent:home:/personal",
};
const codexA: InstanceFixture = {
  instanceId: id("codex_a"),
  driver: "codex",
  displayName: "Codex A",
  continuationKey: "codex:home:/shared",
};
const codexB: InstanceFixture = {
  instanceId: id("codex_b"),
  driver: "codex",
  displayName: "Codex B",
  continuationKey: "codex:home:/shared",
};

function settingsWithChain(
  instanceIds: ReadonlyArray<ProviderInstanceId>,
  chainName = "Work",
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    accountFallback: {
      ...DEFAULT_SERVER_SETTINGS.accountFallback,
      webhookUrl: WEBHOOK_URL,
      chains: {
        [FallbackChainId.make("work")]: { displayName: chainName, instanceIds },
      },
    },
    accountFallbackChainId: FallbackChainId.make("work"),
  };
}

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix login",
    modelSelection: { instanceId: claudeWork.instanceId, model: "claude-opus-4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: "feature/login",
    worktreePath: "/work/tree",
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeProvider(fixture: InstanceFixture): ServerProvider {
  return {
    instanceId: fixture.instanceId,
    driver: ProviderDriverKind.make(fixture.driver),
    enabled: fixture.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: fixture.authenticated === false ? "unauthenticated" : "authenticated" },
    checkedAt: NOW,
    models: [],
    slashCommands: [],
    skills: [],
    ...(fixture.exhaustedUntil !== undefined
      ? {
          usageLimits: {
            checkedAt: NOW,
            windows: [
              {
                id: "session",
                kind: "session" as const,
                label: "Session",
                usedPercent: 100,
                resetsAt: fixture.exhaustedUntil,
              },
            ],
          },
        }
      : {}),
  };
}

function limitEvent(
  instanceId: ProviderInstanceId,
  resetsAt: string | null,
  options: { readonly turnId?: TurnId; readonly type?: "runtime.warning" | "runtime.error" } = {},
): ProviderRuntimeEvent {
  const turnId = options.turnId ?? TURN_ID;
  return {
    eventId: EventId.make(`limit-${instanceId}-${turnId}-${options.type ?? "runtime.error"}`),
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: instanceId,
    threadId: THREAD_ID,
    turnId,
    createdAt: NOW,
    type: options.type ?? "runtime.error",
    payload: {
      message: "Usage limit reached.",
      usageLimit: { instanceId, blocking: true, resetsAt },
    },
  };
}

const makeHarness = Effect.fn("makeAccountFallbackHarness")(function* (options: {
  readonly settings: ServerSettings;
  readonly instances: ReadonlyArray<InstanceFixture>;
  readonly thread: OrchestrationThreadShell;
}) {
  const activation = yield* Deferred.make<void>();
  const subscribed = yield* Deferred.make<void>();
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
  const threads = yield* Ref.make(new Map([[options.thread.id, options.thread]]));
  const shellReads = yield* Queue.unbounded<ThreadId>();
  const snapshotReads = yield* Queue.unbounded<void>();
  const refreshedInstances = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
  const settingsReads = yield* Queue.unbounded<void>();
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const webhooks = yield* Ref.make<ReadonlyArray<{ url: string | null; text: string }>>([]);

  const dispatch = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      if (command.type === "thread.fallback.update") {
        yield* Ref.update(threads, (current) => {
          const next = new Map(current);
          const thread = next.get(command.threadId);
          if (thread !== undefined) next.set(thread.id, { ...thread, fallback: command.fallback });
          return next;
        });
      }
      if (command.type === "thread.create") {
        yield* Ref.update(threads, (current) =>
          new Map(current).set(
            command.threadId,
            makeThread({
              id: command.threadId,
              title: command.title,
              modelSelection: command.modelSelection,
              branch: command.branch,
              worktreePath: command.worktreePath,
            }),
          ),
        );
      }
      return { sequence: 1 };
    });

  const detail = {
    ...makeThread(),
    messages: [
      {
        id: MessageId.make("m1"),
        role: "user" as const,
        text: "Please fix the login bug.",
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: MessageId.make("m2"),
        role: "assistant" as const,
        text: "I found the session cookie issue.",
        turnId: TURN_ID,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  } as unknown as OrchestrationThread;

  const byId = new Map(options.instances.map((instance) => [instance.instanceId, instance]));
  const dependencies = Layer.mergeAll(
    Layer.mock(ProviderService)({
      streamEvents: Stream.unwrap(
        PubSub.subscribe(runtimeEvents).pipe(
          Effect.tap(() => Deferred.succeed(subscribed, undefined)),
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      ),
      getInstanceInfo: (instanceId) => {
        const instance = byId.get(instanceId);
        if (instance === undefined) {
          return Effect.fail(
            new ProviderUnsupportedError({ provider: ProviderDriverKind.make("unknown") }),
          );
        }
        return Effect.succeed({
          instanceId,
          driverKind: ProviderDriverKind.make(instance.driver),
          displayName: instance.displayName,
          enabled: instance.enabled ?? true,
          continuationIdentity: {
            driverKind: ProviderDriverKind.make(instance.driver),
            continuationKey: instance.continuationKey,
          },
        });
      },
    }),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed(options.instances.map(makeProvider)),
      refreshInstance: (instanceId) =>
        Ref.update(refreshedInstances, (ids) => [...ids, instanceId]).pipe(
          Effect.as(options.instances.map(makeProvider)),
        ),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Ref.get(threads).pipe(
          Effect.map((current) => Option.fromUndefinedOr(current.get(threadId))),
          Effect.tap(() => Queue.offer(shellReads, threadId)),
        ),
      getThreadDetailById: () => Effect.succeedSome(detail),
      getShellSnapshot: () =>
        Ref.get(threads).pipe(
          Effect.map((current) => ({
            snapshotSequence: 1,
            projects: [],
            threads: [...current.values()],
            updatedAt: NOW,
          })),
          Effect.tap(() => Queue.offer(snapshotReads, undefined)),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch,
      subscribeDomainEvents: PubSub.subscribe(domainEvents).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.mock(ServerSettingsService)({
      getSettings: Queue.offer(settingsReads, undefined).pipe(Effect.as(options.settings)),
    }),
    // Only `devUrl` is read; undefined keeps the dev-only limit simulation off.
    Layer.succeed(ServerConfig, { devUrl: undefined } as unknown as ServerConfig["Service"]),
    Layer.succeed(
      FallbackWebhook,
      FallbackWebhook.of({
        notify: (url, text) => Ref.update(webhooks, (recorded) => [...recorded, { url, text }]),
      }),
    ),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  const layer = AccountFallbackReactor.layer.pipe(Layer.provide(dependencies));

  /** Starts the reactor and waits until it listens to provider events. */
  const start = Effect.gen(function* () {
    const reactor = yield* AccountFallbackReactor.AccountFallbackReactor;
    yield* reactor.start();
    yield* Deferred.succeed(activation, undefined);
    yield* Deferred.await(subscribed);
    return reactor;
  });

  /** Publishes one runtime event and waits until the reactor has handled it. */
  const publishLimit = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const reactor = yield* AccountFallbackReactor.AccountFallbackReactor;
      yield* PubSub.publish(runtimeEvents, event);
      yield* Queue.take(shellReads);
      yield* reactor.drain;
    });

  const publishDomainEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const reactor = yield* AccountFallbackReactor.AccountFallbackReactor;
      yield* PubSub.publish(domainEvents, event);
      yield* Queue.take(shellReads);
      yield* reactor.drain;
    });

  return {
    layer,
    start,
    publishLimit,
    publishDomainEvent,
    commands,
    webhooks,
    threads,
    shellReads,
    snapshotReads,
    settingsReads,
    refreshedInstances,
    domainEvents,
  };
});

const commandsOfType = <T extends OrchestrationCommand["type"]>(
  commands: ReadonlyArray<OrchestrationCommand>,
  type: T,
) =>
  commands.filter(
    (command): command is Extract<OrchestrationCommand, { readonly type: T }> =>
      command.type === type,
  );

const run = <A, E>(
  body: (
    harness: Effect.Success<ReturnType<typeof makeHarness>>,
  ) => Effect.Effect<A, E, AccountFallbackReactor.AccountFallbackReactor>,
  options: Parameters<typeof makeHarness>[0],
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const harness = yield* makeHarness(options);
      return yield* Effect.gen(function* () {
        yield* harness.start;
        return yield* body(harness);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

describe("AccountFallbackReactor", () => {
  it.effect("dispatches nothing when the project has no chain", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* harness.publishLimit(limitEvent(claudeWork.instanceId, null));
          assert.deepStrictEqual(yield* Ref.get(harness.commands), []);
          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), []);
        }),
      {
        settings: DEFAULT_SERVER_SETTINGS,
        instances: [claudeWork, claudePersonal],
        thread: makeThread(),
      },
    ),
  );

  it.effect("continues in a new linked thread in the same worktree", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* harness.publishLimit(
            limitEvent(claudeWork.instanceId, iso(NOW_MS + 2 * 60 * 60 * 1000)),
          );
          const commands = yield* Ref.get(harness.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            [
              "thread.turn.interrupt",
              "thread.create",
              "thread.fallback.update",
              "thread.turn.start",
              "thread.fallback.update",
            ],
          );
          for (const command of commands) {
            assert.isTrue(command.commandId.startsWith("server:account-fallback:"));
          }
          const [interrupt] = commandsOfType(commands, "thread.turn.interrupt");
          assert.strictEqual(interrupt!.threadId, THREAD_ID);
          assert.strictEqual(interrupt!.turnId, TURN_ID);

          const [create] = commandsOfType(commands, "thread.create");
          assert.notStrictEqual(create!.threadId, THREAD_ID);
          assert.strictEqual(create!.projectId, PROJECT_ID);
          assert.strictEqual(create!.title, "Fix login");
          assert.strictEqual(create!.worktreePath, "/work/tree");
          assert.strictEqual(create!.branch, "feature/login");
          assert.strictEqual(create!.modelSelection.instanceId, claudePersonal.instanceId);
          assert.strictEqual(create!.modelSelection.model, "claude-fable-5-1");

          const [turnStart] = commandsOfType(commands, "thread.turn.start");
          assert.strictEqual(turnStart!.threadId, create!.threadId);
          assert.include(turnStart!.message.text, "## What the user asked");
          assert.include(turnStart!.message.text, "Please fix the login bug.");

          const [newUpdate, oldUpdate] = commandsOfType(commands, "thread.fallback.update");
          assert.strictEqual(newUpdate!.threadId, create!.threadId);
          assert.strictEqual(newUpdate!.fallback.continuedFromThreadId, THREAD_ID);
          assert.strictEqual(newUpdate!.fallback.status, "idle");
          assert.deepStrictEqual(newUpdate!.fallback.triedInstanceIds, [claudeWork.instanceId]);
          assert.deepStrictEqual(newUpdate!.fallback.handoffTimes, [NOW]);
          assert.strictEqual(oldUpdate!.threadId, THREAD_ID);
          assert.strictEqual(oldUpdate!.reason, "handed-off");
          assert.strictEqual(oldUpdate!.fallback.continuedToThreadId, create!.threadId);
          assert.strictEqual(oldUpdate!.fromInstanceId, claudeWork.instanceId);
          assert.strictEqual(oldUpdate!.toInstanceId, claudePersonal.instanceId);

          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), [
            {
              url: WEBHOOK_URL,
              text: 'T3 "Fix login": Claude Work hit its usage limit → Claude Personal (new thread)',
            },
          ]);
        }),
      {
        settings: settingsWithChain([claudeWork.instanceId, claudePersonal.instanceId]),
        instances: [claudeWork, claudePersonal],
        thread: makeThread(),
      },
    ),
  );

  it.effect("switches accounts on the same thread when the continuation key matches", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* harness.publishLimit(limitEvent(codexA.instanceId, null));
          const commands = yield* Ref.get(harness.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            [
              "thread.turn.interrupt",
              "thread.meta.update",
              "thread.turn.start",
              "thread.fallback.update",
            ],
          );
          const [metaUpdate] = commandsOfType(commands, "thread.meta.update");
          assert.strictEqual(metaUpdate!.threadId, THREAD_ID);
          assert.deepStrictEqual(metaUpdate!.modelSelection, {
            instanceId: codexB.instanceId,
            model: "gpt-5",
            options: [{ id: "reasoningEffort", value: "high" }],
          });
          const [turnStart] = commandsOfType(commands, "thread.turn.start");
          assert.strictEqual(turnStart!.threadId, THREAD_ID);
          assert.deepStrictEqual(turnStart!.modelSelection, {
            instanceId: codexB.instanceId,
            model: "gpt-5",
            options: [{ id: "reasoningEffort", value: "high" }],
          });
          assert.strictEqual(
            turnStart!.message.text,
            "You were interrupted by an account usage limit. Continue where you left off.",
          );
          assert.strictEqual(turnStart!.runtimeMode, "full-access");
          assert.strictEqual(turnStart!.interactionMode, "default");
          const [update] = commandsOfType(commands, "thread.fallback.update");
          assert.strictEqual(update!.reason, "switched-account");
          assert.deepStrictEqual(update!.fallback.triedInstanceIds, [codexA.instanceId]);
          assert.deepStrictEqual(update!.fallback.handoffTimes, [NOW]);
          assert.strictEqual(update!.fallback.chainId, FallbackChainId.make("work"));
          assert.strictEqual(update!.fallback.paused, false);
          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), [
            {
              url: WEBHOOK_URL,
              text: 'T3 "Fix login": Codex A hit its usage limit → Codex B (same thread)',
            },
          ]);
        }),
      {
        settings: settingsWithChain([codexA.instanceId, codexB.instanceId], "Codex"),
        instances: [codexA, codexB],
        thread: makeThread({
          modelSelection: {
            instanceId: codexA.instanceId,
            model: "gpt-5",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        }),
      },
    ),
  );

  it.effect("waits with the earliest reset when every account is exhausted", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* harness.publishLimit(
            limitEvent(claudeWork.instanceId, iso(NOW_MS + 3 * 60 * 60 * 1000)),
          );
          const commands = yield* Ref.get(harness.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            ["thread.turn.interrupt", "thread.fallback.update"],
          );
          const [update] = commandsOfType(commands, "thread.fallback.update");
          const earliest = iso(NOW_MS + 2 * 60 * 60 * 1000);
          assert.strictEqual(update!.reason, "waiting");
          assert.strictEqual(update!.fallback.status, "waiting");
          assert.strictEqual(update!.fallback.resumeAt, earliest);
          assert.strictEqual(update!.fallback.waitingSince, NOW);
          assert.strictEqual(update!.fallback.candidateInstanceId, claudePersonal.instanceId);
          assert.strictEqual(update!.fallback.waitReason, "usage-exhausted");
          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), [
            {
              url: WEBHOOK_URL,
              text: `T3 "Fix login": all accounts in Work are out, resuming around ${earliest}`,
            },
          ]);
        }),
      {
        settings: settingsWithChain([claudeWork.instanceId, claudePersonal.instanceId]),
        instances: [
          claudeWork,
          { ...claudePersonal, exhaustedUntil: iso(NOW_MS + 2 * 60 * 60 * 1000) },
        ],
        thread: makeThread(),
      },
    ),
  );

  it.effect("does nothing for a paused thread", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* harness.publishLimit(limitEvent(claudeWork.instanceId, null));
          assert.deepStrictEqual(yield* Ref.get(harness.commands), []);
          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), []);
        }),
      {
        settings: settingsWithChain([claudeWork.instanceId, claudePersonal.instanceId]),
        instances: [claudeWork, claudePersonal],
        thread: makeThread({
          fallback: {
            chainId: FallbackChainId.make("work"),
            status: "idle",
            paused: true,
            resumeAt: null,
            waitingSince: null,
            candidateInstanceId: null,
            triedInstanceIds: [],
            handoffTimes: [],
            continuedToThreadId: null,
            continuedFromThreadId: null,
          },
        }),
      },
    ),
  );

  it.effect("handles a turn's limit once, and a later turn's limit again", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          // One limit reported twice for the same turn: one switch, one line.
          yield* harness.publishLimit(
            limitEvent(codexA.instanceId, null, { type: "runtime.warning" }),
          );
          yield* harness.publishLimit(
            limitEvent(codexA.instanceId, null, { type: "runtime.error" }),
          );
          assert.strictEqual((yield* Ref.get(harness.webhooks)).length, 1);
          assert.strictEqual(
            commandsOfType(yield* Ref.get(harness.commands), "thread.turn.start").length,
            1,
          );
          // Back on the already-tried account (say, after a resume) with no
          // user turn in between, a new turn's limit is still handled.
          yield* harness.publishLimit(
            limitEvent(codexA.instanceId, null, { turnId: TurnId.make("turn-2") }),
          );
          const commands = yield* Ref.get(harness.commands);
          assert.strictEqual(commandsOfType(commands, "thread.turn.interrupt").length, 2);
          const turnStarts = commandsOfType(commands, "thread.turn.start");
          assert.strictEqual(turnStarts.length, 2);
          assert.strictEqual(turnStarts[1]!.modelSelection?.instanceId, codexB.instanceId);
          assert.strictEqual((yield* Ref.get(harness.webhooks)).length, 2);
        }),
      {
        settings: settingsWithChain([codexA.instanceId, codexB.instanceId], "Codex"),
        instances: [codexA, codexB],
        thread: makeThread({ modelSelection: { instanceId: codexA.instanceId, model: "gpt-5" } }),
      },
    ),
  );

  const triedState: ThreadFallbackState = {
    chainId: FallbackChainId.make("work"),
    status: "idle",
    paused: true,
    resumeAt: null,
    waitingSince: null,
    candidateInstanceId: null,
    triedInstanceIds: [codexA.instanceId],
    handoffTimes: [NOW],
    continuedToThreadId: null,
    continuedFromThreadId: null,
  };
  const turnStartRequested = (commandId: string): OrchestrationEvent => ({
    sequence: 5,
    eventId: EventId.make(`turn-start-${commandId}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.make(commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.turn-start-requested",
    payload: {
      threadId: THREAD_ID,
      messageId: MessageId.make("user-message"),
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: NOW,
    },
  });

  it.effect("clears tried accounts when the user starts a turn, keeping pause", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          // The reactor's own turn start is not a user turn. Published first,
          // it would be handled first: one read of its own before the user
          // turn's read and write-back re-read.
          yield* PubSub.publish(
            harness.domainEvents,
            turnStartRequested("server:account-fallback:x"),
          );
          yield* harness.publishDomainEvent(turnStartRequested("client:abc"));
          const commands = yield* Ref.get(harness.commands);
          assert.strictEqual(commands.length, 1);
          assert.strictEqual(yield* Queue.size(harness.shellReads), 1);
          const [update] = commandsOfType(commands, "thread.fallback.update");
          assert.strictEqual(update!.reason, "reset-tried");
          assert.deepStrictEqual(update!.fallback, { ...triedState, triedInstanceIds: [] });
          // Already empty: nothing more to write.
          yield* Queue.clear(harness.shellReads);
          yield* harness.publishDomainEvent(turnStartRequested("client:def"));
          assert.strictEqual((yield* Ref.get(harness.commands)).length, 1);
        }),
      {
        settings: settingsWithChain([codexA.instanceId, codexB.instanceId]),
        instances: [codexA, codexB],
        thread: makeThread({ fallback: triedState }),
      },
    ),
  );

  const MINUTE_MS = 60 * 1000;
  const waitingState = (overrides: Partial<ThreadFallbackState> = {}): ThreadFallbackState => ({
    chainId: FallbackChainId.make("work"),
    status: "waiting",
    paused: false,
    resumeAt: null,
    waitingSince: NOW,
    candidateInstanceId: null,
    triedInstanceIds: [claudeWork.instanceId, claudePersonal.instanceId],
    handoffTimes: [],
    continuedToThreadId: null,
    continuedFromThreadId: null,
    ...overrides,
  });

  /** Waits for the sweep that runs at start (or after a clock move) and drains it. */
  const awaitSweep = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
    Effect.gen(function* () {
      const reactor = yield* AccountFallbackReactor.AccountFallbackReactor;
      yield* Queue.take(harness.snapshotReads);
      yield* reactor.drain;
    });

  const advanceAndSweep = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      yield* awaitSweep(harness);
    });

  it.effect("resumes a waiting thread once its reset time arrives", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* awaitSweep(harness);
          yield* advanceAndSweep(harness);
          assert.deepStrictEqual(yield* Ref.get(harness.commands), []);
          assert.deepStrictEqual(yield* Ref.get(harness.refreshedInstances), []);

          yield* advanceAndSweep(harness);
          const commands = yield* Ref.get(harness.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            ["thread.turn.start", "thread.fallback.update"],
          );
          assert.deepStrictEqual(yield* Ref.get(harness.refreshedInstances), [
            claudeWork.instanceId,
            claudePersonal.instanceId,
          ]);
          const [turnStart] = commandsOfType(commands, "thread.turn.start");
          assert.strictEqual(turnStart!.threadId, THREAD_ID);
          assert.isTrue(turnStart!.commandId.startsWith("server:account-fallback:"));
          assert.strictEqual(
            turnStart!.message.text,
            "You were interrupted by an account usage limit. Continue where you left off.",
          );
          assert.deepStrictEqual(turnStart!.modelSelection, {
            instanceId: claudeWork.instanceId,
            model: "claude-opus-4",
          });
          const [update] = commandsOfType(commands, "thread.fallback.update");
          assert.strictEqual(update!.reason, "resumed");
          assert.strictEqual(update!.fallback.status, "idle");
          assert.strictEqual(update!.fallback.resumeAt, null);
          assert.strictEqual(update!.fallback.waitingSince, null);
          assert.deepStrictEqual(update!.fallback.triedInstanceIds, []);
          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), [
            { url: WEBHOOK_URL, text: 'T3 "Fix login": resumed on Claude Work (same thread)' },
          ]);

          // Idle now: later sweeps leave it alone.
          yield* advanceAndSweep(harness);
          assert.strictEqual((yield* Ref.get(harness.commands)).length, 2);
          assert.strictEqual((yield* Ref.get(harness.webhooks)).length, 1);
        }),
      {
        settings: settingsWithChain([claudeWork.instanceId, claudePersonal.instanceId]),
        instances: [
          { ...claudeWork, exhaustedUntil: iso(NOW_MS + 2 * MINUTE_MS) },
          { ...claudePersonal, exhaustedUntil: iso(NOW_MS + 3 * 60 * MINUTE_MS) },
          // Outside the chain: never refreshed by the sweep.
          codexA,
        ],
        thread: makeThread({
          fallback: waitingState({
            resumeAt: iso(NOW_MS + 2 * MINUTE_MS),
            candidateInstanceId: claudeWork.instanceId,
          }),
        }),
      },
    ),
  );

  it.effect("re-checks a wait with an unknown reset after 15 minutes", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* awaitSweep(harness);
          for (let minute = 1; minute < 15; minute += 1) {
            yield* advanceAndSweep(harness);
          }
          assert.deepStrictEqual(yield* Ref.get(harness.commands), []);
          assert.deepStrictEqual(yield* Ref.get(harness.refreshedInstances), []);

          yield* advanceAndSweep(harness);
          const commands = yield* Ref.get(harness.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            ["thread.fallback.update"],
          );
          assert.deepStrictEqual(yield* Ref.get(harness.refreshedInstances), [
            claudeWork.instanceId,
            claudePersonal.instanceId,
          ]);
          const [update] = commandsOfType(commands, "thread.fallback.update");
          assert.strictEqual(update!.reason, "waiting");
          assert.strictEqual(update!.fallback.status, "waiting");
          assert.strictEqual(update!.fallback.resumeAt, iso(NOW_MS + 2 * 60 * MINUTE_MS));
          assert.strictEqual(update!.fallback.waitingSince, iso(NOW_MS + 15 * MINUTE_MS));
          assert.strictEqual(update!.fallback.candidateInstanceId, claudePersonal.instanceId);
          assert.deepStrictEqual(update!.fallback.triedInstanceIds, []);
          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), [
            {
              url: WEBHOOK_URL,
              text: `T3 "Fix login": all accounts in Work are out, resuming around ${iso(NOW_MS + 2 * 60 * MINUTE_MS)}`,
            },
          ]);
        }),
      {
        settings: settingsWithChain([claudeWork.instanceId, claudePersonal.instanceId]),
        instances: [
          { ...claudeWork, exhaustedUntil: iso(NOW_MS + 3 * 60 * MINUTE_MS) },
          { ...claudePersonal, exhaustedUntil: iso(NOW_MS + 2 * 60 * MINUTE_MS) },
        ],
        thread: makeThread({ fallback: waitingState() }),
      },
    ),
  );

  it.effect("re-waits quietly when the reset is still unknown", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* awaitSweep(harness);
          const commands = yield* Ref.get(harness.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            ["thread.fallback.update"],
          );
          const [update] = commandsOfType(commands, "thread.fallback.update");
          assert.strictEqual(update!.reason, "waiting");
          assert.strictEqual(update!.fallback.resumeAt, null);
          assert.strictEqual(update!.fallback.waitingSince, NOW);
          assert.deepStrictEqual(update!.fallback.triedInstanceIds, []);
          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), []);
        }),
      {
        settings: settingsWithChain([claudeWork.instanceId, claudePersonal.instanceId]),
        instances: [
          { ...claudeWork, authenticated: false },
          { ...claudePersonal, authenticated: false },
        ],
        thread: makeThread({
          latestUserMessageAt: iso(NOW_MS - 20 * MINUTE_MS),
          fallback: waitingState({ waitingSince: iso(NOW_MS - 15 * MINUTE_MS) }),
        }),
      },
    ),
  );

  it.effect("resumes a thread already waiting at startup on the first sweep", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* awaitSweep(harness);
          const commands = yield* Ref.get(harness.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            [
              "thread.create",
              "thread.fallback.update",
              "thread.turn.start",
              "thread.fallback.update",
            ],
          );
          assert.deepStrictEqual(yield* Ref.get(harness.refreshedInstances), [
            claudeWork.instanceId,
            claudePersonal.instanceId,
          ]);
          const [create] = commandsOfType(commands, "thread.create");
          assert.strictEqual(create!.modelSelection.instanceId, claudePersonal.instanceId);
          assert.strictEqual(create!.worktreePath, "/work/tree");
          const [turnStart] = commandsOfType(commands, "thread.turn.start");
          assert.strictEqual(turnStart!.threadId, create!.threadId);
          const [newUpdate, oldUpdate] = commandsOfType(commands, "thread.fallback.update");
          assert.strictEqual(newUpdate!.threadId, create!.threadId);
          assert.strictEqual(newUpdate!.reason, "resumed");
          assert.strictEqual(newUpdate!.fallback.continuedFromThreadId, THREAD_ID);
          assert.deepStrictEqual(newUpdate!.fallback.triedInstanceIds, []);
          assert.strictEqual(oldUpdate!.threadId, THREAD_ID);
          assert.strictEqual(oldUpdate!.reason, "resumed");
          assert.strictEqual(oldUpdate!.fallback.status, "idle");
          assert.strictEqual(oldUpdate!.fallback.continuedToThreadId, create!.threadId);
          assert.deepStrictEqual(oldUpdate!.fallback.triedInstanceIds, []);
          assert.strictEqual(oldUpdate!.fromInstanceId, claudeWork.instanceId);
          assert.strictEqual(oldUpdate!.toInstanceId, claudePersonal.instanceId);
          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), [
            { url: WEBHOOK_URL, text: 'T3 "Fix login": resumed on Claude Personal (new thread)' },
          ]);
        }),
      {
        settings: settingsWithChain([claudeWork.instanceId, claudePersonal.instanceId]),
        instances: [
          { ...claudeWork, exhaustedUntil: iso(NOW_MS + 3 * 60 * MINUTE_MS) },
          claudePersonal,
        ],
        thread: makeThread({
          latestUserMessageAt: iso(NOW_MS - 90 * MINUTE_MS),
          fallback: waitingState({
            resumeAt: iso(NOW_MS - 5 * MINUTE_MS),
            waitingSince: iso(NOW_MS - 60 * MINUTE_MS),
            candidateInstanceId: claudePersonal.instanceId,
          }),
        }),
      },
    ),
  );

  it.effect("a user turn cancels a wait, so the sweep leaves the thread alone", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* awaitSweep(harness);
          yield* harness.publishDomainEvent(turnStartRequested("client:abc"));
          const commands = yield* Ref.get(harness.commands);
          assert.strictEqual(commands.length, 1);
          const [update] = commandsOfType(commands, "thread.fallback.update");
          assert.strictEqual(update!.reason, "cancelled");
          assert.deepStrictEqual(update!.fallback, {
            ...waitingState({ paused: false }),
            status: "idle",
            resumeAt: null,
            waitingSince: null,
            candidateInstanceId: null,
            triedInstanceIds: [],
          });

          yield* advanceAndSweep(harness);
          yield* advanceAndSweep(harness);
          assert.strictEqual((yield* Ref.get(harness.commands)).length, 1);
          assert.deepStrictEqual(yield* Ref.get(harness.refreshedInstances), []);
          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), []);
        }),
      {
        settings: settingsWithChain([claudeWork.instanceId, claudePersonal.instanceId]),
        instances: [claudeWork, claudePersonal],
        thread: makeThread({
          fallback: waitingState({
            resumeAt: iso(NOW_MS + 2 * MINUTE_MS),
            candidateInstanceId: claudeWork.instanceId,
          }),
        }),
      },
    ),
  );

  it.effect("does not resume a paused waiting thread", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* awaitSweep(harness);
          yield* advanceAndSweep(harness);
          assert.deepStrictEqual(yield* Ref.get(harness.commands), []);
          assert.deepStrictEqual(yield* Ref.get(harness.refreshedInstances), []);
        }),
      {
        settings: settingsWithChain([claudeWork.instanceId, claudePersonal.instanceId]),
        instances: [claudeWork, claudePersonal],
        thread: makeThread({
          fallback: waitingState({
            paused: true,
            resumeAt: iso(NOW_MS - 5 * MINUTE_MS),
          }),
        }),
      },
    ),
  );

  it.effect("waits for the hand-off cap to clear, naming the account it will resume on", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* harness.publishLimit(limitEvent(claudeWork.instanceId, null));
          const commands = yield* Ref.get(harness.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            ["thread.turn.interrupt", "thread.fallback.update"],
          );
          const [update] = commandsOfType(commands, "thread.fallback.update");
          const clearsAt = iso(NOW_MS + 10 * MINUTE_MS);
          assert.strictEqual(update!.reason, "waiting");
          assert.strictEqual(update!.fallback.status, "waiting");
          assert.strictEqual(update!.fallback.waitReason, "handoff-cap");
          assert.strictEqual(update!.fallback.resumeAt, clearsAt);
          assert.strictEqual(update!.fallback.candidateInstanceId, claudePersonal.instanceId);
          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), [
            {
              url: WEBHOOK_URL,
              text: `T3 "Fix login": hand-off limit reached, resuming on Claude Personal around ${clearsAt}`,
            },
          ]);
        }),
      {
        settings: settingsWithChain([claudeWork.instanceId, claudePersonal.instanceId]),
        instances: [claudeWork, claudePersonal],
        thread: makeThread({
          fallback: {
            ...waitingState(),
            status: "idle",
            waitingSince: null,
            triedInstanceIds: [],
            handoffTimes: [
              iso(NOW_MS - 50 * MINUTE_MS),
              iso(NOW_MS - 30 * MINUTE_MS),
              iso(NOW_MS - 5 * MINUTE_MS),
            ],
          },
        }),
      },
    ),
  );

  it.effect("falls back from an account outside the chain, from the chain's start", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* harness.publishLimit(limitEvent(claudeWork.instanceId, null));
          const commands = yield* Ref.get(harness.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            [
              "thread.turn.interrupt",
              "thread.create",
              "thread.fallback.update",
              "thread.turn.start",
              "thread.fallback.update",
            ],
          );
          const [create] = commandsOfType(commands, "thread.create");
          assert.strictEqual(create!.modelSelection.instanceId, claudePersonal.instanceId);
        }),
      {
        settings: settingsWithChain([claudePersonal.instanceId, codexA.instanceId]),
        instances: [claudeWork, claudePersonal, codexA],
        thread: makeThread(),
      },
    ),
  );

  it.effect("skips the sweep entirely when no chain is configured", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          const reactor = yield* AccountFallbackReactor.AccountFallbackReactor;
          yield* Queue.take(harness.settingsReads);
          yield* reactor.drain;
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(harness.settingsReads);
          yield* reactor.drain;
          assert.strictEqual(yield* Queue.size(harness.snapshotReads), 0);
          assert.deepStrictEqual(yield* Ref.get(harness.refreshedInstances), []);
          assert.deepStrictEqual(yield* Ref.get(harness.commands), []);
        }),
      {
        settings: DEFAULT_SERVER_SETTINGS,
        instances: [claudeWork, claudePersonal],
        thread: makeThread({
          fallback: waitingState({ resumeAt: iso(NOW_MS - 5 * MINUTE_MS) }),
        }),
      },
    ),
  );

  it.effect("cancels a due wait instead of resuming when the user wrote since it began", () =>
    run(
      (harness) =>
        Effect.gen(function* () {
          yield* awaitSweep(harness);
          const commands = yield* Ref.get(harness.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            ["thread.fallback.update"],
          );
          const [update] = commandsOfType(commands, "thread.fallback.update");
          assert.strictEqual(update!.reason, "cancelled");
          assert.strictEqual(update!.fallback.status, "idle");
          assert.strictEqual(update!.fallback.resumeAt, null);
          assert.deepStrictEqual(yield* Ref.get(harness.webhooks), []);
        }),
      {
        settings: settingsWithChain([claudeWork.instanceId, claudePersonal.instanceId]),
        instances: [claudeWork, claudePersonal],
        thread: makeThread({
          latestUserMessageAt: iso(NOW_MS - MINUTE_MS),
          fallback: waitingState({
            resumeAt: iso(NOW_MS - 5 * MINUTE_MS),
            waitingSince: iso(NOW_MS - 30 * MINUTE_MS),
            candidateInstanceId: claudeWork.instanceId,
          }),
        }),
      },
    ),
  );
});
