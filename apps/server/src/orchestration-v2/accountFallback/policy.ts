import type { ProviderInstanceId, ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const HOUR_MS = 60 * 60 * 1000;

export interface FallbackCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly usable: boolean; // enabled and authenticated
  readonly continuationKey: string;
  readonly exhaustedUntil: string | null; // ISO; null = not known exhausted
}

export type FallbackDecision =
  | { readonly _tag: "SwitchAccount"; readonly instanceId: ProviderInstanceId }
  | { readonly _tag: "ContinueInNewThread"; readonly instanceId: ProviderInstanceId }
  | {
      readonly _tag: "Wait";
      /**
       * `usage-exhausted`: no account can take the work. `handoff-cap`: one
       * can (`candidateInstanceId`), but the hourly cap on hand-offs is spent.
       */
      readonly reason: "usage-exhausted" | "handoff-cap";
      readonly resumeAt: string | null;
      readonly candidateInstanceId: ProviderInstanceId | null;
    };

function parseMs(iso: string): number | null {
  const parsed = DateTime.make(iso);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
}

/** The latest reset among fully used windows that have not reset yet, or null. */
export function usageExhaustedUntil(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
): string | null {
  if (limits === undefined) return null;
  let latestMs: number | null = null;
  let latestIso: string | null = null;
  for (const window of limits.windows) {
    if (window.usedPercent < 100 || window.resetsAt === undefined) continue;
    const resetMs = parseMs(window.resetsAt);
    if (resetMs === null || resetMs <= nowMs) continue;
    if (latestMs === null || resetMs > latestMs) {
      latestMs = resetMs;
      latestIso = window.resetsAt;
    }
  }
  return latestIso;
}

export function decideFallback(input: {
  readonly mode: "limit" | "resume";
  readonly chain: ReadonlyArray<ProviderInstanceId>;
  readonly currentInstanceId: ProviderInstanceId;
  readonly currentContinuationKey: string;
  readonly candidates: ReadonlyMap<ProviderInstanceId, FallbackCandidate>;
  readonly tried: ReadonlySet<ProviderInstanceId>;
  readonly handoffTimes: ReadonlyArray<string>;
  readonly maxHandoffsPerHour: number;
  readonly nowMs: number;
}): FallbackDecision {
  const { chain, candidates, nowMs } = input;
  const isLimit = input.mode === "limit";

  // A limit walks on from the current account and wraps around, never picking
  // it again; an account outside the chain starts the walk at the beginning.
  // A resume walks the chain in order and may pick the current account.
  const currentIndex = chain.indexOf(input.currentInstanceId);
  const walk = isLimit
    ? [...chain.slice(currentIndex + 1), ...chain.slice(0, Math.max(currentIndex, 0))]
    : chain;

  const isExhausted = (candidate: FallbackCandidate): boolean => {
    if (candidate.exhaustedUntil === null) return false;
    const untilMs = parseMs(candidate.exhaustedUntil);
    return untilMs !== null && untilMs > nowMs;
  };

  for (const instanceId of walk) {
    if (input.tried.has(instanceId)) continue;
    const candidate = candidates.get(instanceId);
    if (candidate === undefined || !candidate.usable || isExhausted(candidate)) continue;

    // The cap only limits hand-offs caused by a limit event; resuming is exempt.
    // Past the cap, wait until the oldest hand-off in the hour ages out of it.
    if (isLimit) {
      const recentMs = input.handoffTimes.flatMap((time) => {
        const ms = parseMs(time);
        return ms !== null && nowMs - ms < HOUR_MS ? [ms] : [];
      });
      if (recentMs.length >= input.maxHandoffsPerHour) {
        return {
          _tag: "Wait",
          reason: "handoff-cap",
          resumeAt: DateTime.formatIso(DateTime.makeUnsafe(Math.min(...recentMs) + HOUR_MS)),
          candidateInstanceId: instanceId,
        };
      }
    }
    return candidate.continuationKey === input.currentContinuationKey
      ? { _tag: "SwitchAccount", instanceId }
      : { _tag: "ContinueInNewThread", instanceId };
  }

  let earliestMs: number | null = null;
  let earliest: { iso: string; instanceId: ProviderInstanceId } | null = null;
  for (const instanceId of chain) {
    const candidate = candidates.get(instanceId);
    if (candidate === undefined || candidate.exhaustedUntil === null) continue;
    const untilMs = parseMs(candidate.exhaustedUntil);
    if (untilMs === null || untilMs <= nowMs) continue;
    if (earliestMs === null || untilMs < earliestMs) {
      earliestMs = untilMs;
      earliest = { iso: candidate.exhaustedUntil, instanceId };
    }
  }
  return {
    _tag: "Wait",
    reason: "usage-exhausted",
    resumeAt: earliest?.iso ?? null,
    candidateInstanceId: earliest?.instanceId ?? null,
  };
}
