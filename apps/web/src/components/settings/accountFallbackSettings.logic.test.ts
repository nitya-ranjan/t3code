import { describe, expect, it } from "vite-plus/test";
import { FallbackChainId, ProviderInstanceId } from "@t3tools/contracts";

import {
  chainIdFromName,
  describeChain,
  moveInstance,
  unknownInstanceIds,
  withoutChain,
} from "./accountFallbackSettings.logic";

const ids = (...values: string[]) => values.map((value) => ProviderInstanceId.make(value));

describe("chainIdFromName", () => {
  it("slugs the name", () => {
    expect(chainIdFromName("Claude Work → Personal!", new Set())).toBe("claude-work-personal");
    expect(chainIdFromName("  Éclair  ", new Set())).toBe("eclair");
  });

  it("falls back to a stable id when the name has no usable characters", () => {
    expect(chainIdFromName("→ ★", new Set())).toBe("chain");
  });

  it("de-duplicates against existing ids with -2, -3", () => {
    expect(chainIdFromName("Main", new Set(["main"]))).toBe("main-2");
    expect(chainIdFromName("Main", new Set(["main", "main-2"]))).toBe("main-3");
  });
});

describe("moveInstance", () => {
  const list = ids("a", "b", "c");

  it("swaps with the neighbour in the given direction", () => {
    expect(moveInstance(list, 1, -1)).toEqual(ids("b", "a", "c"));
    expect(moveInstance(list, 1, 1)).toEqual(ids("a", "c", "b"));
  });

  it("leaves the order alone at the ends and does not mutate the input", () => {
    expect(moveInstance(list, 0, -1)).toEqual(list);
    expect(moveInstance(list, 2, 1)).toEqual(list);
    moveInstance(list, 1, 1);
    expect(list).toEqual(ids("a", "b", "c"));
  });
});

describe("describeChain", () => {
  it("joins instance labels in order, falling back to the raw id", () => {
    const labels = new Map([
      ["claude_work", "Claude Work"],
      ["claude_personal", "Claude Personal"],
      ["codex", "Codex"],
    ]);
    expect(
      describeChain({ instanceIds: ids("claude_work", "claude_personal", "codex") }, labels),
    ).toBe("Claude Work → Claude Personal → Codex");
    expect(describeChain({ instanceIds: ids("claude_work", "gone") }, labels)).toBe(
      "Claude Work → gone",
    );
  });
});

describe("unknownInstanceIds", () => {
  it("lists ids that no longer name a configured instance", () => {
    expect(
      unknownInstanceIds({ instanceIds: ids("a", "gone", "b", "lost") }, new Set(["a", "b"])),
    ).toEqual(["gone", "lost"]);
    expect(unknownInstanceIds({ instanceIds: ids("a") }, new Set(["a"]))).toEqual([]);
  });
});

describe("withoutChain", () => {
  const work = FallbackChainId.make("work");
  const other = FallbackChainId.make("other");
  const settings = {
    accountFallback: {
      chains: {
        [work]: { displayName: "Work", instanceIds: ids("a") },
        [other]: { displayName: "Other", instanceIds: ids("b") },
      },
      maxHandoffsPerThreadPerHour: 3,
      webhookUrl: null,
    },
    accountFallbackChainId: work,
  };

  it("removes the chain and clears the environment default that named it", () => {
    expect(withoutChain(settings, work)).toEqual({
      accountFallback: {
        chains: { [other]: { displayName: "Other", instanceIds: ids("b") } },
        maxHandoffsPerThreadPerHour: 3,
        webhookUrl: null,
      },
      accountFallbackChainId: null,
    });
  });

  it("keeps a default that names another chain", () => {
    expect(withoutChain(settings, other)).toEqual({
      accountFallback: {
        chains: { [work]: { displayName: "Work", instanceIds: ids("a") } },
        maxHandoffsPerThreadPerHour: 3,
        webhookUrl: null,
      },
    });
  });
});
