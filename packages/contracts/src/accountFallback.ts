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
  candidateInstanceId: Schema.NullOr(ProviderInstanceId),
  triedInstanceIds: Schema.Array(ProviderInstanceId),
  handoffTimes: Schema.Array(IsoDateTime),
  continuedToThreadId: Schema.NullOr(ThreadId),
  continuedFromThreadId: Schema.NullOr(ThreadId),
});
export type ThreadFallbackState = typeof ThreadFallbackState.Type;
