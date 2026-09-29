import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  ThreadId,
  type FallbackChainId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type RuntimeUsageLimit,
  type ServerSettings as ServerSettingsValue,
  type ThreadFallbackReason,
  type ThreadFallbackState,
  type TurnId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import type { ProviderInstanceRoutingInfo } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import {
  decideFallback,
  resolveFallbackChain,
  usageExhaustedUntil,
  type FallbackCandidate,
  type FallbackDecision,
} from "./accountFallback/policy.ts";
import { buildHandoffPrompt } from "./accountFallback/handoffPrompt.ts";
import {
  parseSimulatedInstanceIds,
  simulateUsageLimits,
} from "./accountFallback/simulateUsageLimit.ts";
import { FallbackWebhook } from "./accountFallback/webhook.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

export class AccountFallbackReactor extends Context.Service<
  AccountFallbackReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/AccountFallbackReactor") {}

const COMMAND_TAG = "account-fallback";
const OWN_COMMAND_PREFIX = `server:${COMMAND_TAG}:`;
const HOUR_MS = 60 * 60 * 1000;
/** How long a wait with an unknown reset lasts before it is checked again. */
const UNKNOWN_RESET_RECHECK_MS = 15 * 60 * 1000;
const MAX_HANDLED_LIMITS = 512;
const SWITCH_ACCOUNT_TEXT =
  "You were interrupted by an account usage limit. Continue where you left off.";

type Job =
  | {
      readonly _tag: "Limit";
      readonly threadId: ThreadId;
      readonly turnId: TurnId | undefined;
      readonly instanceId: ProviderInstanceId;
      readonly resetsAt: string | null;
    }
  | { readonly _tag: "UserTurn"; readonly threadId: ThreadId }
  | { readonly _tag: "Sweep" };

/** The blocking usage limit an event reports, if any. */
function blockingUsageLimit(event: ProviderRuntimeEvent): RuntimeUsageLimit | null {
  if (event.type !== "runtime.warning" && event.type !== "runtime.error") return null;
  const usageLimit = event.payload.usageLimit;
  return usageLimit?.blocking === true ? usageLimit : null;
}

function initialFallbackState(chainId: FallbackChainId): ThreadFallbackState {
  return {
    chainId,
    status: "idle",
    paused: false,
    resumeAt: null,
    waitingSince: null,
    candidateInstanceId: null,
    triedInstanceIds: [],
    handoffTimes: [],
    continuedToThreadId: null,
    continuedFromThreadId: null,
  };
}

const isoToMillis = (iso: string): number | null => {
  const parsed = DateTime.make(iso);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
};

/**
 * Whether a waiting thread is due for a resume check: its reset time has
 * passed, or its reset is unknown and it has waited long enough to look again.
 */
function isResumeDue(fallback: ThreadFallbackState, nowMs: number): boolean {
  if (fallback.status !== "waiting" || fallback.paused) return false;
  if (fallback.resumeAt !== null) {
    const resumeMs = isoToMillis(fallback.resumeAt);
    return resumeMs === null || resumeMs <= nowMs;
  }
  if (fallback.waitingSince === null) return true;
  const sinceMs = isoToMillis(fallback.waitingSince);
  return sinceMs === null || nowMs - sinceMs >= UNKNOWN_RESET_RECHECK_MS;
}

const appendUnique = <A>(values: ReadonlyArray<A>, value: A): ReadonlyArray<A> =>
  values.includes(value) ? values : [...values, value];

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const webhook = yield* FallbackWebhook;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;

  // Limits already handled, oldest first. Only touched by the worker fiber.
  const handledLimits = new Set<string>();

  const serverCommandId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => CommandId.make(`${OWN_COMMAND_PREFIX}${uuid}`)),
  );

  const readThread = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(Effect.map(Option.getOrNull));

  const instanceInfo = (instanceId: ProviderInstanceId) =>
    providerService.getInstanceInfo(instanceId).pipe(
      Effect.map((info): ProviderInstanceRoutingInfo | null => info),
      Effect.orElseSucceed(() => null),
    );

  const accountName = (instanceId: ProviderInstanceId, info: ProviderInstanceRoutingInfo | null) =>
    info?.displayName ?? instanceId;

  /**
   * Writes a thread's fallback state. Re-reads the thread first and applies
   * `change` to its current state, so a pause (or any other field) written
   * since the caller's read is never overwritten.
   */
  const updateFallback = Effect.fn("AccountFallbackReactor.updateFallback")(function* (input: {
    readonly threadId: ThreadId;
    readonly chainId: FallbackChainId;
    readonly reason: ThreadFallbackReason;
    readonly fromInstanceId?: ProviderInstanceId;
    readonly toInstanceId?: ProviderInstanceId;
    readonly change: (current: ThreadFallbackState) => ThreadFallbackState;
  }) {
    const thread = yield* readThread(input.threadId);
    if (thread === null) return;
    const current = thread.fallback ?? initialFallbackState(input.chainId);
    yield* engine.dispatch({
      type: "thread.fallback.update",
      commandId: yield* serverCommandId,
      threadId: input.threadId,
      fallback: input.change(current),
      reason: input.reason,
      ...(input.fromInstanceId !== undefined ? { fromInstanceId: input.fromInstanceId } : {}),
      ...(input.toInstanceId !== undefined ? { toInstanceId: input.toInstanceId } : {}),
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  const notify = (settings: ServerSettingsValue, text: string) =>
    webhook.notify(settings.accountFallback.webhookUrl, text);

  const notifyWaiting = (
    settings: ServerSettingsValue,
    title: string,
    chainId: FallbackChainId,
    resumeAt: string | null,
  ) => {
    const chainName = settings.accountFallback.chains[chainId]?.displayName ?? chainId;
    return notify(
      settings,
      `T3 "${title}": all accounts in ${chainName} are out, resuming around ${resumeAt ?? "unknown"}`,
    );
  };

  /** Candidates for every chain instance, keyed by instance id. */
  const buildCandidates = Effect.fn("AccountFallbackReactor.buildCandidates")(function* (input: {
    readonly chain: ReadonlyArray<ProviderInstanceId>;
    /** The instance that just reported a limit; null when resuming. */
    readonly limited: {
      readonly instanceId: ProviderInstanceId;
      readonly resetsAt: string | null;
    } | null;
    readonly nowMs: number;
  }) {
    const providers = yield* providerRegistry.getProviders;
    const infos = new Map<ProviderInstanceId, ProviderInstanceRoutingInfo | null>();
    const candidates = new Map<ProviderInstanceId, FallbackCandidate>();
    for (const instanceId of input.chain) {
      const info = yield* instanceInfo(instanceId);
      infos.set(instanceId, info);
      const provider = providers.find((entry) => entry.instanceId === instanceId);
      const exhaustedUntil = usageExhaustedUntil(provider?.usageLimits, input.nowMs);
      candidates.set(instanceId, {
        instanceId,
        usable: info !== null && info.enabled && provider?.auth.status === "authenticated",
        continuationKey: info?.continuationIdentity.continuationKey ?? "",
        exhaustedUntil:
          instanceId === input.limited?.instanceId
            ? (input.limited.resetsAt ??
              exhaustedUntil ??
              DateTime.formatIso(DateTime.makeUnsafe(input.nowMs + HOUR_MS)))
            : exhaustedUntil,
      });
    }
    return { candidates, infos };
  });

  /** Continue the same thread on another account that shares its conversation home. */
  const switchAccount = Effect.fn("AccountFallbackReactor.switchAccount")(function* (input: {
    readonly thread: OrchestrationThreadShell;
    readonly chainId: FallbackChainId;
    readonly fromInstanceId: ProviderInstanceId;
    readonly toInstanceId: ProviderInstanceId;
    readonly reason: ThreadFallbackReason;
    /** A resume clears the tried accounts: every account may be tried again. */
    readonly resume: boolean;
  }) {
    const { thread } = input;
    const now = DateTime.formatIso(yield* DateTime.now);
    const changesAccount = input.toInstanceId !== input.fromInstanceId;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId,
      threadId: thread.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        text: SWITCH_ACCOUNT_TEXT,
        attachments: [],
      },
      // Same driver and home: the model and its options still apply.
      modelSelection: { ...thread.modelSelection, instanceId: input.toInstanceId },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: now,
    });
    yield* updateFallback({
      threadId: thread.id,
      chainId: input.chainId,
      reason: input.reason,
      fromInstanceId: input.fromInstanceId,
      toInstanceId: input.toInstanceId,
      change: (current) => ({
        ...current,
        status: "idle",
        resumeAt: null,
        waitingSince: null,
        candidateInstanceId: null,
        triedInstanceIds: input.resume
          ? []
          : appendUnique(current.triedInstanceIds, input.fromInstanceId),
        // Picking up again on the same account is not a hand-off.
        handoffTimes: changesAccount ? [...current.handoffTimes, now] : current.handoffTimes,
      }),
    });
  });

  /** Continue in a new thread on another account, in the same worktree and branch. */
  const continueInNewThread = Effect.fn("AccountFallbackReactor.continueInNewThread")(
    function* (input: {
      readonly thread: OrchestrationThreadShell;
      readonly chainId: FallbackChainId;
      readonly fromInstanceId: ProviderInstanceId;
      readonly fromAccount: string;
      readonly toInstanceId: ProviderInstanceId;
      readonly toInfo: ProviderInstanceRoutingInfo | null;
      readonly reason: ThreadFallbackReason;
      /** A resume clears the tried accounts: every account may be tried again. */
      readonly resume: boolean;
    }) {
      const { thread } = input;
      const now = DateTime.formatIso(yield* DateTime.now);
      const newThreadId = ThreadId.make(yield* crypto.randomUUIDv4);
      const detail = Option.getOrNull(yield* snapshots.getThreadDetailById(thread.id));
      const prompt = buildHandoffPrompt({
        threadTitle: thread.title,
        fromAccount: input.fromAccount,
        messages: (detail?.messages ?? []).flatMap((message) =>
          message.role === "user" || message.role === "assistant"
            ? [{ role: message.role, text: message.text }]
            : [],
        ),
      });
      const driverKind = input.toInfo?.driverKind;
      yield* engine.dispatch({
        type: "thread.create",
        commandId: yield* serverCommandId,
        threadId: newThreadId,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: {
          instanceId: input.toInstanceId,
          model:
            (driverKind !== undefined ? DEFAULT_MODEL_BY_PROVIDER[driverKind] : undefined) ??
            DEFAULT_MODEL,
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        createdAt: now,
      });
      // Carry the lineage's tried accounts and hand-off times so the hourly
      // cap and the no-cycle guard hold across the continuation.
      const previous = (yield* readThread(thread.id))?.fallback ?? null;
      yield* updateFallback({
        threadId: newThreadId,
        chainId: input.chainId,
        reason: input.reason,
        fromInstanceId: input.fromInstanceId,
        toInstanceId: input.toInstanceId,
        change: (current) => ({
          ...current,
          status: "idle",
          resumeAt: null,
          waitingSince: null,
          candidateInstanceId: null,
          triedInstanceIds: input.resume
            ? []
            : appendUnique(previous?.triedInstanceIds ?? [], input.fromInstanceId),
          handoffTimes: [...(previous?.handoffTimes ?? []), now],
          continuedFromThreadId: thread.id,
        }),
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId,
        threadId: newThreadId,
        message: {
          messageId: MessageId.make(yield* crypto.randomUUIDv4),
          role: "user",
          text: prompt,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: now,
      });
      yield* updateFallback({
        threadId: thread.id,
        chainId: input.chainId,
        reason: input.reason,
        fromInstanceId: input.fromInstanceId,
        toInstanceId: input.toInstanceId,
        change: (current) => ({
          ...current,
          status: "idle",
          resumeAt: null,
          waitingSince: null,
          candidateInstanceId: null,
          triedInstanceIds: input.resume
            ? []
            : appendUnique(current.triedInstanceIds, input.fromInstanceId),
          continuedToThreadId: newThreadId,
        }),
      });
    },
  );

  /** Park the thread until an account in its chain resets. */
  const park = Effect.fn("AccountFallbackReactor.park")(function* (input: {
    readonly threadId: ThreadId;
    readonly chainId: FallbackChainId;
    readonly resumeAt: string | null;
    readonly candidateInstanceId: ProviderInstanceId | null;
    /** A resume clears the tried accounts: every account may be tried again. */
    readonly resume: boolean;
  }) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* updateFallback({
      threadId: input.threadId,
      chainId: input.chainId,
      reason: "waiting",
      change: (current) => ({
        ...current,
        status: "waiting",
        resumeAt: input.resumeAt,
        waitingSince: now,
        candidateInstanceId: input.candidateInstanceId,
        ...(input.resume ? { triedInstanceIds: [] } : {}),
      }),
    });
  });

  const handleLimit = Effect.fn("AccountFallbackReactor.handleLimit")(function* (
    job: Extract<Job, { readonly _tag: "Limit" }>,
  ) {
    const thread = yield* readThread(job.threadId);
    if (thread === null || thread.archivedAt !== null) return;
    const fallback = thread.fallback ?? null;
    if (fallback?.paused === true || fallback?.status === "waiting") return;
    // A provider can report one limit twice (warning, then error). Handle
    // each reporting turn once; without a turn id there is nothing to key on.
    if (job.turnId !== undefined) {
      const key = `${job.threadId}\u0000${job.turnId}\u0000${job.instanceId}`;
      if (handledLimits.has(key)) return;
      handledLimits.add(key);
      if (handledLimits.size > MAX_HANDLED_LIMITS) {
        handledLimits.delete(handledLimits.values().next().value!);
      }
    }

    const settings = yield* settingsService.getSettings;
    const chain = resolveFallbackChain(settings, thread.projectId);
    if (chain === null || !chain.instanceIds.includes(job.instanceId)) return;

    const interruptedAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine
      .dispatch({
        type: "thread.turn.interrupt",
        commandId: yield* serverCommandId,
        threadId: thread.id,
        ...(job.turnId !== undefined ? { turnId: job.turnId } : {}),
        createdAt: interruptedAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("account fallback could not interrupt the limited turn", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );

    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const { candidates, infos } = yield* buildCandidates({
      chain: chain.instanceIds,
      limited: { instanceId: job.instanceId, resetsAt: job.resetsAt },
      nowMs,
    });
    const decision: FallbackDecision = decideFallback({
      mode: "limit",
      chain: chain.instanceIds,
      currentInstanceId: job.instanceId,
      currentContinuationKey: candidates.get(job.instanceId)?.continuationKey ?? "",
      candidates,
      tried: new Set([...(fallback?.triedInstanceIds ?? []), job.instanceId]),
      handoffTimes: fallback?.handoffTimes ?? [],
      maxHandoffsPerHour: settings.accountFallback.maxHandoffsPerThreadPerHour,
      nowMs,
    });

    const fromAccount = accountName(job.instanceId, infos.get(job.instanceId) ?? null);
    switch (decision._tag) {
      case "SwitchAccount": {
        yield* switchAccount({
          thread,
          chainId: chain.chainId,
          fromInstanceId: job.instanceId,
          toInstanceId: decision.instanceId,
          reason: "switched-account",
          resume: false,
        });
        yield* notify(
          settings,
          `T3 "${thread.title}": ${fromAccount} hit its usage limit → ${accountName(decision.instanceId, infos.get(decision.instanceId) ?? null)} (same thread)`,
        );
        return;
      }
      case "ContinueInNewThread": {
        const toInfo = infos.get(decision.instanceId) ?? null;
        yield* continueInNewThread({
          thread,
          chainId: chain.chainId,
          fromInstanceId: job.instanceId,
          fromAccount,
          toInstanceId: decision.instanceId,
          toInfo,
          reason: "handed-off",
          resume: false,
        });
        yield* notify(
          settings,
          `T3 "${thread.title}": ${fromAccount} hit its usage limit → ${accountName(decision.instanceId, toInfo)} (new thread)`,
        );
        return;
      }
      case "Wait": {
        yield* park({
          threadId: thread.id,
          chainId: chain.chainId,
          resumeAt: decision.resumeAt,
          candidateInstanceId: decision.candidateInstanceId,
          resume: false,
        });
        yield* notifyWaiting(settings, thread.title, chain.chainId, decision.resumeAt);
        return;
      }
    }
  });

  /**
   * A user turn starts a fresh attempt: every account may be tried again, and
   * a wait is over (the user has moved on; the sweep must not start a turn too).
   */
  const handleUserTurn = Effect.fn("AccountFallbackReactor.handleUserTurn")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* readThread(threadId);
    const fallback = thread?.fallback ?? null;
    if (fallback === null) return;
    if (fallback.status === "waiting") {
      yield* updateFallback({
        threadId,
        chainId: fallback.chainId,
        reason: "cancelled",
        change: (current) => ({
          ...current,
          status: "idle",
          resumeAt: null,
          waitingSince: null,
          candidateInstanceId: null,
          triedInstanceIds: [],
        }),
      });
      return;
    }
    if (fallback.triedInstanceIds.length === 0) return;
    yield* updateFallback({
      threadId,
      chainId: fallback.chainId,
      reason: "resumed",
      change: (current) => ({ ...current, triedInstanceIds: [] }),
    });
  });

  /** Try a waiting thread again, walking its chain from the start. */
  const resumeThread = Effect.fn("AccountFallbackReactor.resumeThread")(function* (
    threadId: ThreadId,
  ) {
    // Re-read: a pause or user turn may have landed since the snapshot.
    const thread = yield* readThread(threadId);
    if (thread === null || thread.archivedAt !== null) return;
    const fallback = thread.fallback ?? null;
    if (fallback === null) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (!isResumeDue(fallback, nowMs)) return;

    const settings = yield* settingsService.getSettings;
    const chain = resolveFallbackChain(settings, thread.projectId);
    if (chain === null) {
      // The chain was removed or deselected: nothing left to wait for.
      yield* updateFallback({
        threadId: thread.id,
        chainId: fallback.chainId,
        reason: "cancelled",
        change: (current) => ({
          ...current,
          status: "idle",
          resumeAt: null,
          waitingSince: null,
          candidateInstanceId: null,
          triedInstanceIds: [],
        }),
      });
      return;
    }

    const currentInstanceId = thread.modelSelection.instanceId;
    const { candidates, infos } = yield* buildCandidates({
      chain: chain.instanceIds,
      limited: null,
      nowMs,
    });
    const currentContinuationKey =
      candidates.get(currentInstanceId)?.continuationKey ??
      (yield* instanceInfo(currentInstanceId))?.continuationIdentity.continuationKey ??
      "";
    const decision = decideFallback({
      mode: "resume",
      chain: chain.instanceIds,
      currentInstanceId,
      currentContinuationKey,
      candidates,
      tried: new Set(),
      handoffTimes: fallback.handoffTimes,
      maxHandoffsPerHour: settings.accountFallback.maxHandoffsPerThreadPerHour,
      nowMs,
    });

    switch (decision._tag) {
      case "SwitchAccount":
        yield* switchAccount({
          thread,
          chainId: chain.chainId,
          fromInstanceId: currentInstanceId,
          toInstanceId: decision.instanceId,
          reason: "resumed",
          resume: true,
        });
        yield* notify(
          settings,
          `T3 "${thread.title}": resumed on ${accountName(decision.instanceId, infos.get(decision.instanceId) ?? null)} (same thread)`,
        );
        return;
      case "ContinueInNewThread": {
        const toInfo = infos.get(decision.instanceId) ?? null;
        yield* continueInNewThread({
          thread,
          chainId: chain.chainId,
          fromInstanceId: currentInstanceId,
          fromAccount: accountName(
            currentInstanceId,
            infos.get(currentInstanceId) ?? (yield* instanceInfo(currentInstanceId)),
          ),
          toInstanceId: decision.instanceId,
          toInfo,
          reason: "resumed",
          resume: true,
        });
        yield* notify(
          settings,
          `T3 "${thread.title}": resumed on ${accountName(decision.instanceId, toInfo)} (new thread)`,
        );
        return;
      }
      case "Wait":
        // `waitingSince: now` makes an unknown reset re-check in 15 minutes.
        yield* park({
          threadId: thread.id,
          chainId: chain.chainId,
          resumeAt: decision.resumeAt,
          candidateInstanceId: decision.candidateInstanceId,
          resume: true,
        });
        yield* notifyWaiting(settings, thread.title, chain.chainId, decision.resumeAt);
        return;
    }
  });

  /** Resume every waiting thread whose reset is due. */
  const sweep = Effect.fn("AccountFallbackReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const due = snapshot.threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.fallback !== undefined &&
        thread.fallback !== null &&
        isResumeDue(thread.fallback, nowMs),
    );
    if (due.length === 0) return;
    // Fresh usage for every account before deciding, once per sweep.
    yield* providerRegistry.refresh();
    for (const thread of due) {
      yield* resumeThread(thread.id).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("account fallback could not resume a waiting thread", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }),
        ),
      );
    }
  });

  const runJob = (job: Job) => {
    switch (job._tag) {
      case "Limit":
        return handleLimit(job);
      case "UserTurn":
        return handleUserTurn(job.threadId);
      case "Sweep":
        return sweep();
    }
  };

  const processJob = (job: Job) =>
    runJob(job).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("account fallback failed", {
            ...(job._tag === "Sweep" ? {} : { threadId: job.threadId }),
            job: job._tag,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  const worker = yield* makeDrainableWorker(processJob);

  const processRuntimeEvent = (event: ProviderRuntimeEvent) => {
    const usageLimit = blockingUsageLimit(event);
    if (usageLimit === null) return Effect.void;
    return worker.enqueue({
      _tag: "Limit",
      threadId: event.threadId,
      turnId: event.turnId,
      instanceId: usageLimit.instanceId,
      resetsAt: usageLimit.resetsAt,
    });
  };

  const processDomainEvent = (event: OrchestrationEvent) => {
    if (event.type !== "thread.turn-start-requested") return Effect.void;
    if (event.commandId?.startsWith(OWN_COMMAND_PREFIX) === true) return Effect.void;
    return worker.enqueue({ _tag: "UserTurn", threadId: event.payload.threadId });
  };

  const start: AccountFallbackReactor["Service"]["start"] = Effect.fn(
    "AccountFallbackReactor.start",
  )(function* () {
    const domainEvents = yield* engine.subscribeDomainEvents;
    const simulated =
      serverConfig.devUrl === undefined
        ? new Set<ProviderInstanceId>()
        : parseSimulatedInstanceIds(
            yield* Config.String("T3CODE_DEV_SIMULATE_USAGE_LIMIT").pipe(
              Config.option,
              Config.map(Option.getOrUndefined),
              Effect.orElseSucceed(() => undefined),
            ),
          );
    const clock = yield* Effect.clockWith(Effect.succeed);
    const source = simulateUsageLimits(providerService.streamEvents, simulated, () =>
      clock.currentTimeMillisUnsafe(),
    );
    yield* forkParked(Stream.runForEach(source, processRuntimeEvent));
    yield* forkParked(Stream.runForEach(domainEvents, processDomainEvent));
    // Runs at activation too, so threads left waiting across a restart resume.
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue({ _tag: "Sweep" });
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies AccountFallbackReactor["Service"];
});

export const layer = Layer.effect(AccountFallbackReactor, make);
