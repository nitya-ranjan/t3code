import type {
  FallbackChainId,
  ProjectId,
  ProviderInstanceId,
  ServerProviderUsageLimits,
  ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
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
      readonly resumeAt: string | null;
      readonly candidateInstanceId: ProviderInstanceId | null;
    };

function parseMs(iso: string): number | null {
  const parsed = DateTime.make(iso);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
}

/** The chain configured for the project, or null when none is selected or it no longer exists. */
export function resolveFallbackChain(
  settings: ServerSettings,
  projectId: ProjectId,
): {
  readonly chainId: FallbackChainId;
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
} | null {
  const resolved = resolveProjectSettings(settings, projectId).settings;
  const chainId = resolved.accountFallbackChainId;
  if (chainId === null || chainId === undefined) return null;
  const chain = resolved.accountFallback.chains[chainId];
  if (chain === undefined) return null;
  return { chainId, instanceIds: chain.instanceIds };
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

  const currentIndex = chain.indexOf(input.currentInstanceId);
  const ordered: ReadonlyArray<ProviderInstanceId> = isLimit
    ? [...chain.slice(currentIndex + 1), ...chain.slice(0, Math.max(currentIndex, 0))]
    : chain;
  // An instance missing from the chain starts the walk at the beginning, and
  // is never a candidate itself in limit mode.
  const walk =
    isLimit && currentIndex < 0
      ? chain.filter((instanceId) => instanceId !== input.currentInstanceId)
      : ordered;

  const isExhausted = (candidate: FallbackCandidate): boolean => {
    if (candidate.exhaustedUntil === null) return false;
    const untilMs = parseMs(candidate.exhaustedUntil);
    return untilMs !== null && untilMs > nowMs;
  };

  for (const instanceId of walk) {
    if (isLimit && instanceId === input.currentInstanceId) continue;
    if (input.tried.has(instanceId)) continue;
    const candidate = candidates.get(instanceId);
    if (candidate === undefined || !candidate.usable || isExhausted(candidate)) continue;

    // The cap only limits hand-offs caused by a limit event; resuming is exempt.
    if (isLimit) {
      const recent = input.handoffTimes.filter((time) => {
        const ms = parseMs(time);
        return ms !== null && nowMs - ms < HOUR_MS;
      }).length;
      if (recent >= input.maxHandoffsPerHour) {
        return { _tag: "Wait", resumeAt: null, candidateInstanceId: null };
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
    resumeAt: earliest?.iso ?? null,
    candidateInstanceId: earliest?.instanceId ?? null,
  };
}
