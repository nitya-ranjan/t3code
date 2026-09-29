import { EventId, ProviderInstanceId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";

const SIMULATED_RESET_MS = 120_000;

// Event ids only need to be unique per process; the Effect lint forbids
// `crypto.randomUUID()` outside Effect code and this transform is pure.
let sequence = 0;

const isoFromMs = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Parses the comma-separated `T3CODE_DEV_SIMULATE_USAGE_LIMIT` value. */
export function parseSimulatedInstanceIds(
  value: string | undefined,
): ReadonlySet<ProviderInstanceId> {
  if (value === undefined) return new Set();
  return new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => ProviderInstanceId.make(part)),
  );
}

/**
 * Dev-only: after each `turn.started` on a listed instance, also emit a
 * blocking usage-limit warning so the fallback flow can be exercised without
 * a real quota. Every original event passes through unchanged.
 */
export function simulateUsageLimits(
  events: Stream.Stream<ProviderRuntimeEvent>,
  instanceIds: ReadonlySet<ProviderInstanceId>,
  now: () => number,
): Stream.Stream<ProviderRuntimeEvent> {
  if (instanceIds.size === 0) return events;
  return events.pipe(
    Stream.flatMap((event) => {
      const instanceId = event.providerInstanceId;
      if (
        event.type !== "turn.started" ||
        instanceId === undefined ||
        !instanceIds.has(instanceId)
      ) {
        return Stream.make(event);
      }
      const nowMs = now();
      const warning: ProviderRuntimeEvent = {
        eventId: EventId.make(`simulated-usage-limit-${nowMs}-${(sequence += 1)}`),
        provider: event.provider,
        providerInstanceId: instanceId,
        threadId: event.threadId,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        createdAt: isoFromMs(nowMs),
        type: "runtime.warning",
        payload: {
          message: "Simulated usage limit (T3CODE_DEV_SIMULATE_USAGE_LIMIT).",
          usageLimit: {
            instanceId,
            blocking: true,
            resetsAt: isoFromMs(nowMs + SIMULATED_RESET_MS),
          },
        },
      };
      return Stream.make(event, warning);
    }),
  );
}
