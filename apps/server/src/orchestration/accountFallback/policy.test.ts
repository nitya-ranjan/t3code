import { describe, expect, it } from "vitest";
import {
  ProjectId,
  ProviderInstanceId,
  DEFAULT_SERVER_SETTINGS,
  FallbackChainId,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  decideFallback,
  resolveFallbackChain,
  usageExhaustedUntil,
  type FallbackCandidate,
} from "./policy.ts";

const id = ProviderInstanceId.make;
const candidate = (instanceId: string, key: string, overrides: Partial<FallbackCandidate> = {}) =>
  [
    id(instanceId),
    {
      instanceId: id(instanceId),
      usable: true,
      continuationKey: key,
      exhaustedUntil: null,
      ...overrides,
    },
  ] as const;
const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const base = {
  mode: "limit" as const,
  chain: [id("claude_work"), id("claude_personal"), id("codex")],
  currentInstanceId: id("claude_work"),
  currentContinuationKey: "claude:home:/w",
  tried: new Set<ProviderInstanceId>(),
  handoffTimes: [],
  maxHandoffsPerHour: 3,
  nowMs: NOW,
};

describe("decideFallback", () => {
  it("hands off to the next account in a new thread when homes differ", () => {
    expect(
      decideFallback({
        ...base,
        candidates: new Map([
          candidate("claude_work", "claude:home:/w"),
          candidate("claude_personal", "claude:home:/p"),
          candidate("codex", "codex:home:/c"),
        ]),
      }),
    ).toEqual({ _tag: "ContinueInNewThread", instanceId: "claude_personal" });
  });
  it("switches accounts in place when the continuation key matches", () => {
    expect(
      decideFallback({
        ...base,
        chain: [id("codex_a"), id("codex_b")],
        currentInstanceId: id("codex_a"),
        currentContinuationKey: "codex:home:/c",
        candidates: new Map([
          candidate("codex_a", "codex:home:/c"),
          candidate("codex_b", "codex:home:/c"),
        ]),
      }),
    ).toEqual({ _tag: "SwitchAccount", instanceId: "codex_b" });
  });
  it("skips exhausted, unusable and already tried accounts", () => {
    expect(
      decideFallback({
        ...base,
        tried: new Set([id("codex")]),
        candidates: new Map([
          candidate("claude_work", "k1"),
          candidate("claude_personal", "k2", { exhaustedUntil: "2026-09-29T15:00:00.000Z" }),
          candidate("codex", "k3"),
        ]),
      }),
    ).toEqual({
      _tag: "Wait",
      resumeAt: "2026-09-29T15:00:00.000Z",
      candidateInstanceId: "claude_personal",
    });
  });
  it("waits with unknown resume time when nothing reports a reset", () => {
    expect(
      decideFallback({
        ...base,
        candidates: new Map([
          candidate("claude_work", "k1"),
          candidate("claude_personal", "k2", { usable: false }),
          candidate("codex", "k3", { usable: false }),
        ]),
      }),
    ).toEqual({ _tag: "Wait", resumeAt: null, candidateInstanceId: null });
  });
  it("wraps around the chain", () => {
    expect(
      decideFallback({
        ...base,
        currentInstanceId: id("codex"),
        candidates: new Map([
          candidate("claude_work", "k1"),
          candidate("claude_personal", "k2"),
          candidate("codex", "k3"),
        ]),
      }),
    ).toEqual({ _tag: "ContinueInNewThread", instanceId: "claude_work" });
  });
  it("waits instead of handing off past the hourly cap", () => {
    const recent = [
      "2026-09-29T11:10:00.000Z",
      "2026-09-29T11:20:00.000Z",
      "2026-09-29T11:30:00.000Z",
    ];
    expect(
      decideFallback({
        ...base,
        handoffTimes: recent,
        candidates: new Map([
          candidate("claude_work", "k1"),
          candidate("claude_personal", "k2"),
          candidate("codex", "k3"),
        ]),
      })._tag,
    ).toBe("Wait");
  });
  it("ignores hand-offs older than an hour when applying the cap", () => {
    expect(
      decideFallback({
        ...base,
        handoffTimes: [
          "2026-09-29T10:10:00.000Z",
          "2026-09-29T10:20:00.000Z",
          "2026-09-29T10:30:00.000Z",
        ],
        candidates: new Map([
          candidate("claude_work", "k1"),
          candidate("claude_personal", "k2"),
          candidate("codex", "k3"),
        ]),
      })._tag,
    ).toBe("ContinueInNewThread");
  });
  it("resume mode prefers chain order and may stay on the current account", () => {
    expect(
      decideFallback({
        ...base,
        mode: "resume",
        currentContinuationKey: "k1",
        candidates: new Map([
          candidate("claude_work", "k1"),
          candidate("claude_personal", "k2"),
          candidate("codex", "k3"),
        ]),
      }),
    ).toEqual({ _tag: "SwitchAccount", instanceId: "claude_work" });
  });
  it("resume mode is not subject to the hourly cap", () => {
    expect(
      decideFallback({
        ...base,
        mode: "resume",
        currentContinuationKey: "k1",
        handoffTimes: [
          "2026-09-29T11:10:00.000Z",
          "2026-09-29T11:20:00.000Z",
          "2026-09-29T11:30:00.000Z",
        ],
        candidates: new Map([
          candidate("claude_work", "k1"),
          candidate("claude_personal", "k2"),
          candidate("codex", "k3"),
        ]),
      }),
    ).toEqual({ _tag: "SwitchAccount", instanceId: "claude_work" });
  });
});

describe("usageExhaustedUntil", () => {
  it("reads exhaustion from usage windows", () => {
    expect(
      usageExhaustedUntil(
        {
          checkedAt: "2026-09-29T12:00:00.000Z",
          windows: [
            {
              id: "s",
              kind: "session",
              label: "5h",
              usedPercent: 100,
              resetsAt: "2026-09-29T14:00:00.000Z",
            },
            {
              id: "w",
              kind: "weekly",
              label: "Week",
              usedPercent: 40,
              resetsAt: "2026-10-02T00:00:00.000Z",
            },
          ],
        } as never,
        NOW,
      ),
    ).toBe("2026-09-29T14:00:00.000Z");
    expect(usageExhaustedUntil(undefined, NOW)).toBeNull();
  });
  it("ignores exhausted windows whose reset has passed", () => {
    expect(
      usageExhaustedUntil(
        {
          checkedAt: "2026-09-29T12:00:00.000Z",
          windows: [
            {
              id: "s",
              kind: "session",
              label: "5h",
              usedPercent: 100,
              resetsAt: "2026-09-29T11:00:00.000Z",
            },
          ],
        } as never,
        NOW,
      ),
    ).toBeNull();
  });
});

describe("resolveFallbackChain", () => {
  const projectId = ProjectId.make("p1");
  const settingsWith = (chainId: string | null): ServerSettings => ({
    ...DEFAULT_SERVER_SETTINGS,
    accountFallback: {
      ...DEFAULT_SERVER_SETTINGS.accountFallback,
      chains: {
        [FallbackChainId.make("work")]: {
          displayName: "Work",
          instanceIds: [id("claude_work"), id("codex")],
        },
      },
    },
    accountFallbackChainId: chainId === null ? null : FallbackChainId.make(chainId),
  });
  it("resolves the project's chain and ignores unknown chains", () => {
    expect(resolveFallbackChain(settingsWith("work"), projectId)).toEqual({
      chainId: "work",
      instanceIds: ["claude_work", "codex"],
    });
    expect(resolveFallbackChain(settingsWith("missing"), projectId)).toBeNull();
    expect(resolveFallbackChain(settingsWith(null), projectId)).toBeNull();
  });
});
