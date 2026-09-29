import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { parseSimulatedInstanceIds, simulateUsageLimits } from "./simulateUsageLimit.ts";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const id = ProviderInstanceId.make;

const turnStarted = (instanceId: string, eventId: string): ProviderRuntimeEvent => ({
  eventId: EventId.make(eventId),
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: id(instanceId),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-09-29T11:59:00.000Z",
  type: "turn.started",
  payload: {},
});

const run = (
  events: ReadonlyArray<ProviderRuntimeEvent>,
  instanceIds: ReadonlySet<ProviderInstanceId>,
) =>
  Stream.runCollect(simulateUsageLimits(Stream.fromIterable(events), instanceIds, () => NOW)).pipe(
    Effect.map((chunk) => Array.from(chunk)),
  );

describe("simulateUsageLimits", () => {
  it.effect("emits a blocking usage-limit warning after turn start for listed instances", () =>
    Effect.gen(function* () {
      const original = turnStarted("claude_work", "e1");
      const out = yield* run(
        [original],
        new Set([id("claude_work")]) as ReadonlySet<ProviderInstanceId>,
      );
      assert.strictEqual(out.length, 2);
      assert.strictEqual(out[0], original);
      const warning = out[1]!;
      assert.strictEqual(warning.type, "runtime.warning");
      if (warning.type !== "runtime.warning") return;
      assert.notStrictEqual(warning.eventId, original.eventId);
      assert.strictEqual(warning.threadId, original.threadId);
      assert.strictEqual(warning.turnId, original.turnId);
      assert.strictEqual(warning.providerInstanceId, original.providerInstanceId);
      assert.strictEqual(warning.createdAt, "2026-09-29T12:00:00.000Z");
      assert.strictEqual(
        warning.payload.message,
        "Simulated usage limit (T3CODE_DEV_SIMULATE_USAGE_LIMIT).",
      );
      assert.deepStrictEqual(warning.payload.usageLimit, {
        instanceId: id("claude_work"),
        blocking: true,
        resetsAt: "2026-09-29T12:02:00.000Z",
      });
    }),
  );

  it.effect("leaves other instances' events untouched", () =>
    Effect.gen(function* () {
      const events = [turnStarted("codex", "e1")];
      const out = yield* run(
        events,
        new Set([id("claude_work")]) as ReadonlySet<ProviderInstanceId>,
      );
      assert.deepStrictEqual(out, events);
    }),
  );
});

describe("parseSimulatedInstanceIds", () => {
  it("returns an empty set for empty or blank values", () => {
    assert.strictEqual(parseSimulatedInstanceIds(undefined).size, 0);
    assert.strictEqual(parseSimulatedInstanceIds("").size, 0);
    assert.strictEqual(parseSimulatedInstanceIds("  ").size, 0);
  });
  it("splits a comma list and trims entries", () => {
    assert.deepStrictEqual(
      [...parseSimulatedInstanceIds(" claude_work, codex ,,")],
      ["claude_work", "codex"],
    );
  });
});
