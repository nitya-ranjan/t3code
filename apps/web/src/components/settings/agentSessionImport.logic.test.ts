import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ThreadId,
  type AgentSessionEntry,
  type AgentSessionImportSelectedOutcome,
} from "@t3tools/contracts";

import {
  agentSessionKey,
  describeImportOutcomes,
  filterAgentSessions,
  isAgentSessionImportable,
} from "./agentSessionImport.logic";

const session = (overrides: Partial<AgentSessionEntry> = {}): AgentSessionEntry => ({
  provider: "claudeAgent",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerSessionId: "s1",
  cwd: "/Users/me/projects/app",
  cwdExists: true,
  title: "Fix the login page",
  lastActiveAt: "2026-09-01T00:00:00.000Z",
  size: 100,
  automated: false,
  ...overrides,
});

describe("filterAgentSessions", () => {
  const sessions = [
    session({ providerSessionId: "a", title: "Fix the login page" }),
    session({ providerSessionId: "b", title: "Nightly steward", automated: true }),
    session({ providerSessionId: "c", title: "Dark mode", cwd: "/Users/me/projects/site" }),
  ];

  it("hides automated runs unless asked", () => {
    expect(
      filterAgentSessions(sessions, { query: "", showAutomated: false }).map(
        (s) => s.providerSessionId,
      ),
    ).toEqual(["a", "c"]);
    expect(filterAgentSessions(sessions, { query: "", showAutomated: true })).toHaveLength(3);
  });

  it("matches the query against title and folder, ignoring case", () => {
    expect(
      filterAgentSessions(sessions, { query: "LOGIN", showAutomated: true }).map(
        (s) => s.providerSessionId,
      ),
    ).toEqual(["a"]);
    expect(
      filterAgentSessions(sessions, { query: "site", showAutomated: true }).map(
        (s) => s.providerSessionId,
      ),
    ).toEqual(["c"]);
  });
});

describe("isAgentSessionImportable", () => {
  it("rejects sessions already in T3 Code and sessions whose folder is gone", () => {
    expect(isAgentSessionImportable(session())).toBe(true);
    expect(isAgentSessionImportable(session({ threadId: ThreadId.make("t1") }))).toBe(false);
    expect(isAgentSessionImportable(session({ cwdExists: false }))).toBe(false);
  });
});

describe("agentSessionKey", () => {
  it("keeps accounts apart when session IDs collide", () => {
    expect(agentSessionKey(session())).not.toBe(
      agentSessionKey(session({ providerInstanceId: ProviderInstanceId.make("claude_work") })),
    );
  });
});

describe("describeImportOutcomes", () => {
  const key = {
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerSessionId: "s1",
  };
  it("summarizes imported, existing and skipped sessions", () => {
    const outcomes: AgentSessionImportSelectedOutcome[] = [
      { _tag: "Imported", session: key, threadId: ThreadId.make("t1"), projectId: "p1" as never },
      { _tag: "Imported", session: key, threadId: ThreadId.make("t2"), projectId: "p1" as never },
      { _tag: "AlreadyInT3", session: key, threadId: ThreadId.make("t3") },
      { _tag: "Skipped", session: key, reason: "folder-missing" },
    ];
    expect(describeImportOutcomes(outcomes)).toBe(
      "Imported 2 sessions. 1 was already in T3 Code. 1 was skipped because its folder no longer exists.",
    );
  });

  it("reports a single import plainly", () => {
    expect(
      describeImportOutcomes([
        { _tag: "Imported", session: key, threadId: ThreadId.make("t1"), projectId: "p1" as never },
      ]),
    ).toBe("Imported 1 session.");
  });
});
