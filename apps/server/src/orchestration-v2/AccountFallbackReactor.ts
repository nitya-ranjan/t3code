import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  ThreadId,
  type FallbackChainId,
  type OrchestrationV2ThreadShell as OrchestrationThreadShell,
  type ProviderInstanceId,
  type ServerSettings as ServerSettingsValue,
  type ThreadFallbackReason,
  type ThreadFallbackState,
  type RunId,
  initialThreadFallbackState,
  withoutWaitReason,
} from "@t3tools/contracts";
import { resolveProjectFallbackChain } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ProviderInstance as ProviderInstanceRoutingInfo } from "../provider/ProviderDriver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  decideFallback,
  usageExhaustedUntil,
  type FallbackCandidate,
  type FallbackDecision,
} from "./accountFallback/policy.ts";
import { buildHandoffPrompt } from "./accountFallback/handoffPrompt.ts";
import { FallbackWebhook } from "./accountFallback/webhook.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class AccountFallbackReactor extends Context.Service<
  AccountFallbackReactor,
  {
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/AccountFallbackReactor") {}

const COMMAND_TAG = "account-fallback";
const OWN_COMMAND_PREFIX = `server:${COMMAND_TAG}:`;
const HOUR_MS = 60 * 60 * 1000;
/** How long a wait with an unknown reset lasts before it is checked again. */
const UNKNOWN_RESET_RECHECK_MS = 15 * 60 * 1000;
const SWITCH_ACCOUNT_TEXT =
  "You were interrupted by an account usage limit. Continue where you left off.";

type Limit = {
  readonly threadId: ThreadId;
  readonly turnId: RunId;
  readonly instanceId: ProviderInstanceId;
  readonly resetsAt: string | null;
};

/** The state with any wait cleared. */
function idleFallback(current: ThreadFallbackState): ThreadFallbackState {
  return {
    ...withoutWaitReason(current),
    status: "idle",
    resumeAt: null,
    waitingSince: null,
    candidateInstanceId: null,
  };
}

const isoToMillis = (iso: string): number | null => {
  const parsed = DateTime.make(iso);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
};

/**
 * Whether the user has written to the thread since its wait began, so the
 * wait is over even if the user turn has not been handled yet.
 */
function hasUserActivitySince(thread: OrchestrationThreadShell, sinceIso: string | null): boolean {
  if (sinceIso === null) return false;
  const sinceMs = isoToMillis(sinceIso);
  if (sinceMs === null) return false;
  const authored = thread.latestUserAuthoredMessageAt;
  return authored != null && DateTime.toEpochMillis(authored) > sinceMs;
}

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

const make = Effect.gen(function* () {
  const engine = yield* ThreadManagement.ThreadManagementService;
  const snapshots = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerService = yield* ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry;
  const webhook = yield* FallbackWebhook;
  const crypto = yield* Crypto.Crypto;

  const serverCommandId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => CommandId.make(`${OWN_COMMAND_PREFIX}${uuid}`)),
  );

  const readThread = (threadId: ThreadId) => snapshots.getThreadShell(threadId);

  const instanceInfo = (instanceId: ProviderInstanceId) =>
    providerService.getInstance(instanceId).pipe(Effect.map((info) => info ?? null));

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
    readonly reason?: ThreadFallbackReason;
    readonly fromInstanceId?: ProviderInstanceId;
    readonly toInstanceId?: ProviderInstanceId;
    readonly change: (current: ThreadFallbackState) => ThreadFallbackState;
  }) {
    const thread = yield* readThread(input.threadId);
    if (thread === null) return;
    const current = thread.fallback ?? initialThreadFallbackState(input.chainId);
    yield* engine.dispatch({
      type: "thread.metadata.update",
      commandId: yield* serverCommandId,
      threadId: input.threadId,
      fallback: input.change(current),
    });
  });

  const notify = (settings: ServerSettingsValue, text: string) =>
    webhook.notify(settings.accountFallback.webhookUrl, text);

  const notifyWaiting = (
    settings: ServerSettingsValue,
    title: string,
    chainId: FallbackChainId,
    decision: Extract<FallbackDecision, { readonly _tag: "Wait" }>,
    candidateAccount: string | null,
  ) => {
    const resumeAt = decision.resumeAt ?? "unknown";
    if (decision.reason === "handoff-cap" && candidateAccount !== null) {
      return notify(
        settings,
        `T3 "${title}": hand-off limit reached, resuming on ${candidateAccount} around ${resumeAt}`,
      );
    }
    const chainName = settings.accountFallback.chains[chainId]?.displayName ?? chainId;
    return notify(
      settings,
      `T3 "${title}": all accounts in ${chainName} are out, resuming around ${resumeAt}`,
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
    readonly reason?: ThreadFallbackReason;
    /** A resume clears the tried accounts: every account may be tried again. */
    readonly resume: boolean;
  }) {
    const { thread } = input;
    const now = DateTime.formatIso(yield* DateTime.now);
    const changesAccount = input.toInstanceId !== input.fromInstanceId;
    // Same driver and home: the model and its options still apply.
    const modelSelection = { ...thread.modelSelection, instanceId: input.toInstanceId };
    // V2 saves the account selection with the new run in one transaction.
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: yield* serverCommandId,
      threadId: thread.id,
      messageId: MessageId.make(yield* crypto.randomUUIDv4),
      text: SWITCH_ACCOUNT_TEXT,
      accountFallbackSource: {
        threadId: thread.id,
        ...(thread.latestRunId ? { runId: thread.latestRunId } : {}),
      },
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "system",
      creationSource: "server",
    });
    yield* updateFallback({
      threadId: thread.id,
      chainId: input.chainId,
      fromInstanceId: input.fromInstanceId,
      toInstanceId: input.toInstanceId,
      change: (current) => ({
        ...idleFallback(current),
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
      readonly reason?: ThreadFallbackReason;
      /** A resume clears the tried accounts: every account may be tried again. */
      readonly resume: boolean;
    }) {
      const { thread } = input;
      const now = DateTime.formatIso(yield* DateTime.now);
      const newThreadId = ThreadId.make(yield* crypto.randomUUIDv4);
      const detail = yield* engine.getThreadProjection(thread.id);
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
        createdBy: "system",
        creationSource: "server",
      });
      // Carry the lineage's tried accounts and hand-off times so the hourly
      // cap and the no-cycle guard hold across the continuation.
      const previous = (yield* readThread(thread.id))?.fallback ?? null;
      yield* updateFallback({
        threadId: newThreadId,
        chainId: input.chainId,
        fromInstanceId: input.fromInstanceId,
        toInstanceId: input.toInstanceId,
        change: (current) => ({
          ...idleFallback(current),
          triedInstanceIds: input.resume
            ? []
            : appendUnique(previous?.triedInstanceIds ?? [], input.fromInstanceId),
          handoffTimes: [...(previous?.handoffTimes ?? []), now],
          continuedFromThreadId: thread.id,
        }),
      });
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: yield* serverCommandId,
        threadId: newThreadId,
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        text: prompt,
        accountFallbackSource: {
          threadId: thread.id,
          ...(thread.latestRunId ? { runId: thread.latestRunId } : {}),
        },
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "system",
        creationSource: "server",
      });
      yield* updateFallback({
        threadId: thread.id,
        chainId: input.chainId,
        fromInstanceId: input.fromInstanceId,
        toInstanceId: input.toInstanceId,
        change: (current) => ({
          ...idleFallback(current),
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
    readonly decision: Extract<FallbackDecision, { readonly _tag: "Wait" }>;
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
        waitReason: input.decision.reason,
        resumeAt: input.decision.resumeAt,
        waitingSince: now,
        candidateInstanceId: input.decision.candidateInstanceId,
        ...(input.resume ? { triedInstanceIds: [] } : {}),
      }),
    });
  });

  const handleLimit = Effect.fn("AccountFallbackReactor.handleLimit")(function* (job: Limit) {
    const thread = yield* readThread(job.threadId);
    if (
      thread === null ||
      thread.archivedAt !== null ||
      thread.settledOverride === "settled" ||
      thread.activeRunId !== null ||
      thread.pendingRuntimeRequest !== null
    )
      return;
    if (
      thread.latestRunId !== job.turnId ||
      thread.status !== "failed" ||
      thread.lastErrorClass !== "usage_limit"
    )
      return;
    const records = yield* engine.getThreadRecords(thread.id, ["runs"]);
    const failedRun = records.runs.find((run) => run.id === job.turnId);
    if (
      failedRun?.providerInstanceId !== job.instanceId ||
      thread.modelSelection.instanceId !== job.instanceId
    )
      return;
    const fallback = thread.fallback ?? null;
    if (
      fallback?.paused === true ||
      fallback?.status === "waiting" ||
      fallback?.continuedToThreadId != null
    )
      return;
    const settings = yield* settingsService.getSettings;
    const chain = resolveProjectFallbackChain(settings, thread.projectId);
    // An account outside the chain still falls back: the walk starts at the
    // chain's first account.
    if (chain === null) return;

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
      currentContinuationKey:
        candidates.get(job.instanceId)?.continuationKey ??
        (yield* instanceInfo(job.instanceId))?.continuationIdentity.continuationKey ??
        "",
      candidates,
      tried: new Set([...(fallback?.triedInstanceIds ?? []), job.instanceId]),
      handoffTimes: fallback?.handoffTimes ?? [],
      maxHandoffsPerHour: settings.accountFallback.maxHandoffsPerThreadPerHour,
      nowMs,
    });

    const fromAccount = accountName(
      job.instanceId,
      infos.get(job.instanceId) ?? (yield* instanceInfo(job.instanceId)),
    );
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
        yield* park({ threadId: thread.id, chainId: chain.chainId, decision, resume: false });
        yield* notifyWaiting(
          settings,
          thread.title,
          chain.chainId,
          decision,
          decision.candidateInstanceId === null
            ? null
            : accountName(
                decision.candidateInstanceId,
                infos.get(decision.candidateInstanceId) ?? null,
              ),
        );
        return;
      }
    }
  });

  /** Try a waiting thread again, walking its chain from the start. */
  const resumeThread = Effect.fn("AccountFallbackReactor.resumeThread")(function* (
    threadId: ThreadId,
  ) {
    // Re-read: a pause or user turn may have landed since the snapshot.
    const thread = yield* readThread(threadId);
    if (
      thread === null ||
      thread.archivedAt !== null ||
      thread.settledOverride === "settled" ||
      thread.activeRunId !== null ||
      thread.pendingRuntimeRequest !== null
    )
      return;
    const fallback = thread.fallback ?? null;
    if (fallback === null) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (!isResumeDue(fallback, nowMs)) return;

    const settings = yield* settingsService.getSettings;
    const chain = resolveProjectFallbackChain(settings, thread.projectId);
    // Nothing left to wait for when the chain was removed or deselected, or
    // when the user has written since the wait began (their turn, queued
    // behind this sweep, must not get a second turn on top of it).
    if (chain === null || hasUserActivitySince(thread, fallback.waitingSince)) {
      yield* updateFallback({
        threadId: thread.id,
        chainId: fallback.chainId,
        reason: "cancelled",
        change: (current) => ({ ...idleFallback(current), triedInstanceIds: [] }),
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
        yield* park({ threadId: thread.id, chainId: chain.chainId, decision, resume: true });
        // Re-checking an unchanged wait (say, unknown → unknown) stays quiet.
        if (decision.resumeAt !== fallback.resumeAt) {
          yield* notifyWaiting(settings, thread.title, chain.chainId, decision, null);
        }
        return;
    }
  });

  /** Resume every waiting thread whose reset is due. */
  const sweep = Effect.fn("AccountFallbackReactor.sweep")(function* () {
    // Off by default: with no chain configured, skip the snapshot entirely.
    const settings = yield* settingsService.getSettings;
    if (Object.keys(settings.accountFallback.chains).length === 0) return;
    const candidates = yield* snapshots.getAccountFallbackCandidates();
    for (const thread of candidates) {
      if (
        thread.status === "failed" &&
        thread.lastErrorClass === "usage_limit" &&
        thread.latestRunId != null
      ) {
        yield* handleLimit({
          threadId: thread.id,
          turnId: thread.latestRunId,
          instanceId: thread.modelSelection.instanceId,
          resetsAt: thread.usageLimitResetAt ?? null,
        });
      }
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const due = candidates.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.fallback !== undefined &&
        thread.fallback !== null &&
        isResumeDue(thread.fallback, nowMs),
    );
    if (due.length === 0) return;
    // Fresh usage before deciding, once per sweep, for the due threads' chain
    // accounts only.
    const instanceIds = new Set(
      due.flatMap(
        (thread) => resolveProjectFallbackChain(settings, thread.projectId)?.instanceIds ?? [],
      ),
    );
    yield* Effect.forEach(
      instanceIds,
      (instanceId) => providerRegistry.refreshInstance(instanceId),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
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

  return AccountFallbackReactor.of({
    sweep: sweep().pipe(
      Effect.catchCause((cause) => Effect.logWarning("account fallback failed", { cause })),
    ),
  });
});

export const layer = Layer.effect(AccountFallbackReactor, make);
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* AccountFallbackReactor;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("account-fallback", reactor.sweep);
  }),
);
