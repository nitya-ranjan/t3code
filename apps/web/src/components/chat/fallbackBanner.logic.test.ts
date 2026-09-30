import {
  FallbackChainId,
  ProviderInstanceId,
  ThreadId,
  type ThreadFallbackState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatUpcomingTimestamp } from "../../timestampFormat";
import { nowMinuteIso } from "../../hooks/useNowMinute";
import { fallbackBannerModel } from "./fallbackBanner.logic";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const RESUME_AT = "2026-09-29T15:30:00.000Z";

const idle: ThreadFallbackState = {
  chainId: FallbackChainId.make("chain-1"),
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

const labels: ReadonlyMap<string, string> = new Map([
  ["claude-work", "Claude (work)"],
  ["claude-home", "Claude (home)"],
]);

describe("fallbackBannerModel", () => {
  it("shows nothing for a thread without fallback state", () => {
    expect(fallbackBannerModel({}, NOW, labels)).toBeNull();
    expect(fallbackBannerModel({ fallback: null }, NOW, labels)).toBeNull();
  });

  it("shows nothing for an idle thread with no continuation", () => {
    expect(fallbackBannerModel({ fallback: idle }, NOW, labels)).toBeNull();
  });

  it("names the account and local resume time while waiting", () => {
    const model = fallbackBannerModel(
      {
        fallback: {
          ...idle,
          status: "waiting",
          resumeAt: RESUME_AT,
          waitingSince: "2026-09-29T11:00:00.000Z",
          candidateInstanceId: ProviderInstanceId.make("claude-work"),
        },
      },
      NOW,
      labels,
    );
    expect(model).toEqual({
      kind: "waiting",
      text: `All accounts in this chain are out of usage. Resumes on Claude (work) around ${formatUpcomingTimestamp(RESUME_AT, "locale", NOW)}.`,
      canCancel: true,
    });
  });

  it("says the hand-off cap, not exhaustion, is why a capped thread waits", () => {
    const model = fallbackBannerModel(
      {
        fallback: {
          ...idle,
          status: "waiting",
          waitReason: "handoff-cap",
          resumeAt: RESUME_AT,
          waitingSince: "2026-09-29T11:00:00.000Z",
          candidateInstanceId: ProviderInstanceId.make("claude-home"),
        },
      },
      NOW,
      labels,
    );
    expect(model?.text).toBe(
      `Reached the limit on account switches this hour. Resumes on Claude (home) around ${formatUpcomingTimestamp(RESUME_AT, "locale", NOW)}.`,
    );
    expect(model?.text).not.toContain("out of usage");
  });

  it("does not promise a resume while fallback is paused", () => {
    const model = fallbackBannerModel(
      {
        fallback: {
          ...idle,
          status: "waiting",
          paused: true,
          resumeAt: RESUME_AT,
          waitingSince: "2026-09-29T11:00:00.000Z",
          candidateInstanceId: ProviderInstanceId.make("claude-work"),
        },
      },
      NOW,
      labels,
    );
    expect(model?.text).toBe(
      "All accounts in this chain are out of usage. Account fallback is paused for this thread, so it will not resume on its own.",
    );
    expect(model?.text).not.toContain("Resumes");
  });

  it("formats the resume time with the user's timestamp format", () => {
    const model = fallbackBannerModel(
      {
        fallback: {
          ...idle,
          status: "waiting",
          resumeAt: RESUME_AT,
          candidateInstanceId: ProviderInstanceId.make("claude-work"),
        },
      },
      NOW,
      labels,
      "24-hour",
    );
    expect(model?.text).toContain(formatUpcomingTimestamp(RESUME_AT, "24-hour", NOW));
  });

  it("says it resumes when usage returns when the reset time is unknown", () => {
    const model = fallbackBannerModel({ fallback: { ...idle, status: "waiting" } }, NOW, labels);
    expect(model).toEqual({
      kind: "waiting",
      text: "All accounts in this chain are out of usage. Resumes when an account has usage again.",
      canCancel: true,
    });
  });

  it("falls back to the instance id when it has no label", () => {
    const model = fallbackBannerModel(
      {
        fallback: {
          ...idle,
          status: "waiting",
          resumeAt: RESUME_AT,
          candidateInstanceId: ProviderInstanceId.make("gone-instance"),
        },
      },
      NOW,
      labels,
    );
    expect(model?.text).toContain("Resumes on gone-instance around");
  });

  it("points to the continuation thread with its account", () => {
    const model = fallbackBannerModel(
      {
        fallback: { ...idle, continuedToThreadId: ThreadId.make("thread-next") },
        continuedToInstanceId: "claude-home",
      },
      NOW,
      labels,
    );
    expect(model).toEqual({
      kind: "continued-to",
      threadId: ThreadId.make("thread-next"),
      text: "Continued in a new thread on Claude (home).",
    });
  });

  it("drops the account from the continuation text when it is unknown", () => {
    const model = fallbackBannerModel(
      { fallback: { ...idle, continuedToThreadId: ThreadId.make("thread-next") } },
      NOW,
      labels,
    );
    expect(model?.text).toBe("Continued in a new thread.");
  });

  it("points back to the thread this one continues", () => {
    const model = fallbackBannerModel(
      { fallback: { ...idle, continuedFromThreadId: ThreadId.make("thread-prev") } },
      NOW,
      labels,
    );
    expect(model).toEqual({
      kind: "continued-from",
      threadId: ThreadId.make("thread-prev"),
      text: "Continued from an earlier thread that ran out of usage.",
    });
  });

  it("prefers waiting over continuation links, and continued-to over continued-from", () => {
    const both = {
      ...idle,
      continuedToThreadId: ThreadId.make("thread-next"),
      continuedFromThreadId: ThreadId.make("thread-prev"),
    };
    expect(fallbackBannerModel({ fallback: both }, NOW, labels)?.kind).toBe("continued-to");
    expect(
      fallbackBannerModel(
        {
          fallback: {
            ...idle,
            status: "waiting",
            continuedFromThreadId: both.continuedFromThreadId,
          },
        },
        NOW,
        labels,
      )?.kind,
    ).toBe("waiting");
  });
});

describe("fallbackBannerModel with the minute clock", () => {
  it("says tomorrow only when the reset is on the next local day", () => {
    // 23:30 UTC the same day as the reset; read as UTC the reset is ~16h
    // away, so the day label must match the helper fed the true instant.
    const now = Date.parse(nowMinuteIso("2026-09-29T23:30"));
    const resumeAt = "2026-09-30T15:30:00.000Z";
    const model = fallbackBannerModel(
      {
        fallback: {
          ...idle,
          status: "waiting",
          resumeAt,
          candidateInstanceId: ProviderInstanceId.make("claude-work"),
        },
      },
      now,
      labels,
    );
    expect(now).toBe(Date.UTC(2026, 8, 29, 23, 30));
    expect(model?.text).toContain(formatUpcomingTimestamp(resumeAt, "locale", now));
  });
});
