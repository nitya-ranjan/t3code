import {
  FallbackChainId,
  ProviderInstanceId,
  ThreadId,
  type ThreadFallbackState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatUpcomingTimestamp } from "../../timestampFormat";
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
