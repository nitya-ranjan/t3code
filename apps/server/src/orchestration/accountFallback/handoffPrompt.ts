const DEFAULT_MAX_WORDS = 4000;
const MAX_ASSISTANT_MESSAGES = 3;

export interface HandoffMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

const countWords = (text: string): number => text.split(/\s+/).filter((w) => w.length > 0).length;

const truncateWords = (text: string, maxWords: number): string => {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) return text;
  const kept = words.slice(0, Math.max(maxWords, 1));
  kept[kept.length - 1] = `${kept[kept.length - 1]}…`;
  return kept.join(" ");
};

/**
 * The first message a fallback agent receives after another account ran out of
 * usage. Trims to `maxWords` across the two content sections: oldest later user
 * messages go first, then oldest assistant messages, then the first user
 * message is truncated.
 */
export function buildHandoffPrompt(input: {
  readonly threadTitle: string;
  readonly fromAccount: string;
  readonly messages: ReadonlyArray<HandoffMessage>;
  readonly maxWords?: number;
}): string {
  const maxWords = input.maxWords ?? DEFAULT_MAX_WORDS;
  const userTexts = input.messages.filter((m) => m.role === "user").map((m) => m.text);
  let firstUser = userTexts[0] ?? "";
  const laterUsers = userTexts.slice(1);
  const assistants = input.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.text)
    .slice(-MAX_ASSISTANT_MESSAGES);

  const total = () =>
    [firstUser, ...laterUsers, ...assistants].reduce((sum, text) => sum + countWords(text), 0);

  while (total() > maxWords && laterUsers.length > 0) laterUsers.shift();
  while (total() > maxWords && assistants.length > 0) assistants.shift();
  if (total() > maxWords) firstUser = truncateWords(firstUser, maxWords);

  return [
    "You are continuing a task that another agent started in this same working directory. Its account ran out of usage, so the conversation moved to you.",
    "",
    `Task: ${input.threadTitle} (was running on ${input.fromAccount})`,
    "",
    "## What the user asked",
    [firstUser, ...laterUsers].join("\n\n"),
    "",
    "## Where the previous agent got to",
    assistants.join("\n\n"),
    "",
    "## Before you continue",
    "1. Run `git status --short` and `git log --oneline -5` to see the current state of the files.",
    "2. Read PROGRESS.md if it exists.",
    "3. Continue the task from where it stopped. Do not redo finished work.",
  ].join("\n");
}
