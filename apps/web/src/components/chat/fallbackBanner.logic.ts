import type { ThreadFallbackState, ThreadId, TimestampFormat } from "@t3tools/contracts";

import { formatUpcomingTimestamp } from "../../timestampFormat";

export type FallbackBannerModel =
  | { readonly kind: "waiting"; readonly text: string; readonly canCancel: true }
  | { readonly kind: "continued-to"; readonly threadId: ThreadId; readonly text: string }
  | { readonly kind: "continued-from"; readonly threadId: ThreadId; readonly text: string };

/**
 * What the composer banner says about a thread's account fallback chain.
 * Waiting outranks the continuation links (it is the one the user can act on
 * now); a middle thread in a lineage points forward rather than back.
 *
 * `continuedToInstanceId` is the continuation thread's own instance — the
 * fallback state does not record which account the hand-off went to.
 */
export function fallbackBannerModel(
  thread: {
    readonly fallback?: ThreadFallbackState | null;
    readonly continuedToInstanceId?: string | null;
  },
  now: number,
  labels: ReadonlyMap<string, string>,
  timestampFormat: TimestampFormat = "locale",
): FallbackBannerModel | null {
  const fallback = thread.fallback;
  if (!fallback) return null;
  const labelFor = (instanceId: string) => labels.get(instanceId) ?? instanceId;

  if (fallback.status === "waiting") {
    const why =
      fallback.waitReason === "handoff-cap"
        ? "Reached the limit on account switches this hour."
        : "All accounts in this chain are out of usage.";
    return {
      kind: "waiting",
      text: `${why} ${fallback.paused ? "Account fallback is paused for this thread, so it will not resume on its own." : resumesText(fallback, now, labelFor, timestampFormat)}`,
      canCancel: true,
    };
  }
  if (fallback.continuedToThreadId !== null) {
    const instanceId = thread.continuedToInstanceId ?? null;
    return {
      kind: "continued-to",
      threadId: fallback.continuedToThreadId,
      text:
        instanceId === null
          ? "Continued in a new thread."
          : `Continued in a new thread on ${labelFor(instanceId)}.`,
    };
  }
  if (fallback.continuedFromThreadId !== null) {
    return {
      kind: "continued-from",
      threadId: fallback.continuedFromThreadId,
      text: "Continued from an earlier thread that ran out of usage.",
    };
  }
  return null;
}

function resumesText(
  fallback: ThreadFallbackState,
  now: number,
  labelFor: (instanceId: string) => string,
  timestampFormat: TimestampFormat,
): string {
  const resumeTime =
    fallback.resumeAt === null
      ? ""
      : formatUpcomingTimestamp(fallback.resumeAt, timestampFormat, now);
  if (resumeTime === "") return "Resumes when an account has usage again.";
  return fallback.candidateInstanceId === null
    ? `Resumes around ${resumeTime}.`
    : `Resumes on ${labelFor(fallback.candidateInstanceId)} around ${resumeTime}.`;
}
