import type {
  AgentSessionEntry,
  AgentSessionImportSelectedOutcome,
  AgentSessionImportSkipReason,
  AgentSessionKey,
} from "@t3tools/contracts";

/** Session IDs are only unique within one account, so keys include the instance. */
export function agentSessionKey(session: AgentSessionKey): string {
  return `${session.providerInstanceId}\0${session.providerSessionId}`;
}

/** Already owned by a thread, or its folder is gone so the provider could not resume it. */
export function isAgentSessionImportable(session: AgentSessionEntry): boolean {
  return session.threadId === undefined && session.cwdExists;
}

export function filterAgentSessions(
  sessions: ReadonlyArray<AgentSessionEntry>,
  filter: { readonly query: string; readonly showAutomated: boolean },
): ReadonlyArray<AgentSessionEntry> {
  const query = filter.query.trim().toLowerCase();
  return sessions.filter(
    (session) =>
      (filter.showAutomated || !session.automated) &&
      (query.length === 0 ||
        session.title.toLowerCase().includes(query) ||
        session.cwd.toLowerCase().includes(query)),
  );
}

const SKIP_REASON_TEXT: Record<AgentSessionImportSkipReason, string> = {
  "not-found": "its transcript changed or is gone",
  "folder-missing": "its folder no longer exists",
  unreadable: "its transcript could not be read",
  conflict: "a thread with its history was changed in T3 Code",
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function describeImportOutcomes(
  outcomes: ReadonlyArray<AgentSessionImportSelectedOutcome>,
): string {
  const imported = outcomes.filter((outcome) => outcome._tag === "Imported").length;
  const existing = outcomes.filter((outcome) => outcome._tag === "AlreadyInT3").length;
  const skipped = new Map<AgentSessionImportSkipReason, number>();
  for (const outcome of outcomes) {
    if (outcome._tag === "Skipped") {
      skipped.set(outcome.reason, (skipped.get(outcome.reason) ?? 0) + 1);
    }
  }
  const parts = [`Imported ${plural(imported, "session")}.`];
  if (existing > 0)
    parts.push(`${existing} ${existing === 1 ? "was" : "were"} already in T3 Code.`);
  for (const [reason, count] of skipped) {
    parts.push(
      `${count} ${count === 1 ? "was" : "were"} skipped because ${SKIP_REASON_TEXT[reason]}.`,
    );
  }
  return parts.join(" ");
}
