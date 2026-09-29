import { describe, expect, it } from "vitest";

import { buildHandoffPrompt } from "./handoffPrompt.ts";

const wordCount = (text: string) => text.split(/\s+/).filter((word) => word.length > 0).length;

const contentSections = (prompt: string) => {
  const asked = prompt.split("## What the user asked\n")[1]!.split("\n\n## Where the previous")[0]!;
  const gotTo = prompt
    .split("## Where the previous agent got to\n")[1]!
    .split("\n\n## Before you continue")[0]!;
  return [asked, gotTo] as const;
};

describe("buildHandoffPrompt", () => {
  it("builds the full structure from a small conversation", () => {
    expect(
      buildHandoffPrompt({
        threadTitle: "Fix login",
        fromAccount: "Claude Work",
        messages: [
          { role: "user", text: "Fix the login bug." },
          { role: "assistant", text: "Looking at auth.ts." },
          { role: "user", text: "Also add a test." },
          { role: "assistant", text: "Added the fix." },
        ],
      }),
    ).toBe(
      [
        "You are continuing a task that another agent started in this same working directory. Its account ran out of usage, so the conversation moved to you.",
        "",
        "Task: Fix login (was running on Claude Work)",
        "",
        "## What the user asked",
        "Fix the login bug.",
        "",
        "Also add a test.",
        "",
        "## Where the previous agent got to",
        "Looking at auth.ts.",
        "",
        "Added the fix.",
        "",
        "## Before you continue",
        "1. Run `git status --short` and `git log --oneline -5` to see the current state of the files.",
        "2. Read PROGRESS.md if it exists.",
        "3. Continue the task from where it stopped. Do not redo finished work.",
      ].join("\n"),
    );
  });

  it("keeps only the last three assistant messages", () => {
    const prompt = buildHandoffPrompt({
      threadTitle: "T",
      fromAccount: "A",
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: "one" },
        { role: "assistant", text: "two" },
        { role: "assistant", text: "three" },
        { role: "assistant", text: "four" },
      ],
    });
    const [, gotTo] = contentSections(prompt);
    expect(gotTo).toBe("two\n\nthree\n\nfour");
  });

  it("truncates an oversized first message with an ellipsis within the word budget", () => {
    const huge = Array.from({ length: 10_000 }, (_, i) => `w${i}`).join(" ");
    const prompt = buildHandoffPrompt({
      threadTitle: "T",
      fromAccount: "A",
      maxWords: 100,
      messages: [
        { role: "user", text: huge },
        { role: "assistant", text: "some progress here" },
      ],
    });
    expect(prompt).toContain("## What the user asked");
    expect(prompt).toContain("## Where the previous agent got to");
    expect(prompt).toContain("## Before you continue");
    const [asked, gotTo] = contentSections(prompt);
    expect(asked).toContain("…");
    expect(wordCount(asked) + wordCount(gotTo)).toBeLessThanOrEqual(100);
  });

  it("drops the oldest later user messages before assistant messages", () => {
    const prompt = buildHandoffPrompt({
      threadTitle: "T",
      fromAccount: "A",
      maxWords: 6,
      messages: [
        { role: "user", text: "first ask" },
        { role: "user", text: "second ask" },
        { role: "user", text: "third ask" },
        { role: "assistant", text: "done" },
      ],
    });
    const [asked, gotTo] = contentSections(prompt);
    expect(asked).toBe("first ask\n\nthird ask");
    expect(gotTo).toBe("done");
  });
});
