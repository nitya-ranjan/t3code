import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const FallbackChainId = TrimmedNonEmptyString.pipe(Schema.brand("FallbackChainId"));
export type FallbackChainId = typeof FallbackChainId.Type;

/** An ordered list of provider instances to try when one runs out of usage. */
export const AccountFallbackChain = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  instanceIds: Schema.Array(ProviderInstanceId).check(Schema.isMinLength(1)),
});
export type AccountFallbackChain = typeof AccountFallbackChain.Type;

export const AccountFallbackSettings = Schema.Struct({
  chains: Schema.Record(FallbackChainId, AccountFallbackChain).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  maxHandoffsPerThreadPerHour: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(3)),
  ),
  webhookUrl: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type AccountFallbackSettings = typeof AccountFallbackSettings.Type;

export const ThreadFallbackReason = Schema.Literals([
  "handed-off",
  "switched-account",
  "waiting",
  "resumed",
  // A user turn cleared the accounts already tried, so each may be tried again.
  "reset-tried",
  "paused",
  "unpaused",
  "cancelled",
]);
export type ThreadFallbackReason = typeof ThreadFallbackReason.Type;

/**
 * Per-thread fallback state. `triedInstanceIds` resets when a user turn starts;
 * `handoffTimes` carries across a continuation lineage for the hourly cap.
 */
export const ThreadFallbackState = Schema.Struct({
  chainId: FallbackChainId,
  status: Schema.Literals(["idle", "waiting"]),
  paused: Schema.Boolean,
  resumeAt: Schema.NullOr(IsoDateTime),
  waitingSince: Schema.NullOr(IsoDateTime),
  // Why a waiting thread waits: every account is out of usage, or the hourly
  // hand-off cap stopped a switch to an account that still has usage. Absent
  // when idle, and on states recorded before it existed (read as exhausted).
  waitReason: Schema.optional(Schema.Literals(["usage-exhausted", "handoff-cap"])),
  candidateInstanceId: Schema.NullOr(ProviderInstanceId),
  triedInstanceIds: Schema.Array(ProviderInstanceId),
  handoffTimes: Schema.Array(IsoDateTime),
  continuedToThreadId: Schema.NullOr(ThreadId),
  continuedFromThreadId: Schema.NullOr(ThreadId),
});
export type ThreadFallbackState = typeof ThreadFallbackState.Type;

/** The state a thread starts with the first time fallback records anything for it. */
export function initialThreadFallbackState(chainId: FallbackChainId): ThreadFallbackState {
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

/** The state with no wait reason, for a thread leaving (or not in) a wait. */
export function withoutWaitReason(state: ThreadFallbackState): ThreadFallbackState {
  const { waitReason: _waitReason, ...rest } = state;
  return rest;
}
