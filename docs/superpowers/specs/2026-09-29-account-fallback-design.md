# Account fallback chains — design

Date: 2026-09-29 · Branch: `feature/account-fallback` · Fork: `nitya-ranjan/t3code` · Base: upstream `v0.0.44` (`ff1db030`)

## Goal

When a provider instance (an account) hits its usage limit, work continues on the next account in an
ordered **fallback chain** instead of the thread failing. Example chains:

- `Work`: Claude Work → Claude Personal → Codex
- `Personal`: Claude Personal → Codex → Claude Work

The feature is written to upstream conventions so it can be proposed via GitHub Discussions → Ideas.
It is **off by default**: an environment with no chain configured behaves exactly as today.

## Non-goals

- Cross-environment fallback (moving a thread to another machine). Chains are per environment.
- Model-generated summaries for handoffs (deterministic handoff only).
- Anything specific to the author's homelab (Obsidian, ntfy). ntfy is reached via the generic webhook.

## Constraints found in the code

- Claude threads may only switch between instances with the same `CLAUDE_CONFIG_DIR`; Claude↔Codex
  switches are rejected. Enforced in `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
  (~690–707) and `apps/server/src/provider/.../ProviderService.ts` (~1464–1481) via the instance
  continuation key (`Drivers/ClaudeHome.ts`, `CodexHomeLayout.ts`). **This design does not relax that.**
- Codex instances sharing one `CODEX_HOME` (shadow homes) share a continuation key → same-thread switch is legal.
- Limit detection exists: Claude `rate_limit_event` with `status === "rejected"` and no overage
  (`ClaudeAdapter.ts` ~4078–4102; turn stays stuck in the SDK), Codex `turn/completed` with
  `codexErrorInfo === "usageLimitExceeded"` (`CodexAdapter.ts` ~2446).
- The server already holds per-instance usage (`usageLimits` in provider snapshots: `usedPercent`,
  `resetsAt`, `unavailable`), updated live by `applyUsageLimits`.
- There is no "waiting for reset" state (`OrchestrationSessionStatus`); a limit-stopped thread shows as failed (issue #10545).

## 1. Settings

Environment-level (`ServerSettings`, `packages/contracts/src/settings.ts`):

```ts
accountFallback: {
  chains: Record<FallbackChainId, { displayName: string; instanceIds: ProviderInstanceId[] }>; // default {}
  defaultChainId: FallbackChainId | null;   // default null → fallback off for projects without an override
  maxHandoffsPerThreadPerHour: number;      // default 3
  webhookUrl: string | null;                // default null; sensitive-display like other secrets
}
```

Project-scoped override (added to `PROJECT_SCOPED_SERVER_SETTING_KEYS` / `ProjectSettingsOverrides`):
`accountFallbackChainId: FallbackChainId | null | "off"` — Inherit / a chain / explicitly off.
Resolution follows the existing order (project override → environment → default). Not added to `t3.json`.

Effect on new threads: when a project resolves to a chain and has **no explicit
`defaultModelSelection`**, new threads start on `chain.instanceIds[0]` with that instance's default model.
An explicit model default still wins.

Validation: chain instance ids must exist and be enabled; unknown ids are shown as warnings in the UI and
skipped at runtime (never a hard error). Chains are ordered, duplicates rejected.

UI: Settings → Providers gains a **Fallback chains** section (create/rename/reorder/delete, pick
default chain, webhook URL, handoff cap). Project settings gain a **Fallback chain** select.

## 2. Limit signal (small additive contract change)

Rather than parsing warning text, adapters attach a structured marker to the events they already emit:

```ts
usageLimit?: { instanceId: ProviderInstanceId; blocking: true; resetsAt: string | null }
```

- Claude: on the `rejected`/no-overage branch of `rate_limit_event` (and assistant `error === "rate_limit"`).
- Codex: on the `usageLimitExceeded` `runtime.error`.

Existing banners/messages are unchanged.

## 3. Handoff (mid-turn limit)

`AccountFallbackReactor` (new orchestration layer, `apps/server/src/orchestration/Layers/`) subscribes to
runtime events. On a blocking `usageLimit` for a thread whose project resolves to a chain:

1. **Interrupt** the stuck turn (existing interrupt command).
2. **Select** the next instance via `AccountFallbackPolicy.next(chain, currentInstanceId, snapshots, triedThisTurn)`:
   walk the chain after the current instance, wrapping to the start, skipping instances that are
   disabled, unauthenticated, already tried this turn, or whose usage snapshot shows a window at
   ≥100% with `resetsAt` in the future.
3. **Same-thread switch** if the candidate's continuation key equals the thread's (Codex shadow homes):
   dispatch `thread.turn.start` with the new `modelSelection.instanceId` and the text
   "You were interrupted by an account usage limit. Continue where you left off."
4. **Otherwise, continuation thread**: `thread.create` on the candidate instance, in the **same project,
   worktree and branch** (so uncommitted changes carry over), then `thread.turn.start` with the handoff
   message from `HandoffPromptBuilder`:
   - the original user request and any later user messages (verbatim, capped),
   - the last few assistant messages (total handoff capped at ~4,000 words, oldest trimmed first),
   - `git status --short` and `git diff --stat` of the worktree,
   - "Read PROGRESS.md if present, check `git log`, then continue the task."
5. **Link** both threads: new events `thread.fallback.handed-off { fromThreadId, toThreadId, fromInstanceId, toInstanceId, reason }`.
   Projections expose `continuedToThreadId` / `continuedFromThreadId`; the sidebar and thread header
   show "↪ Continued in …" / "↩ Continued from …".
6. **Notify**: T3's existing notification path + webhook (section 4).

Guards:
- Each instance is tried at most once per originating turn (`triedThisTurn`), so chains cannot cycle.
- `maxHandoffsPerThreadPerHour` (default 3), counted across a continuation lineage; exceeding it → waiting state.
- Per-thread **Pause fallback** toggle (`thread.fallback.paused`): limit behaves exactly as upstream today.
- If starting the candidate fails (auth, spawn error), mark it tried and continue down the chain.

Pre-turn check: when the user sends a message on an instance that the snapshot already shows exhausted,
the same selection runs *before* the turn starts (no wasted interrupted turn).

## 4. Waiting and resume (every account exhausted)

- New event `thread.fallback.waiting { resumeAt: string | null, candidateInstanceId: ProviderInstanceId | null }`;
  projected as a thread-level `fallback.state = "waiting"`. `OrchestrationSessionStatus` is **not** changed.
- Banner: "All accounts in *Work* are out of usage. Resumes on *Claude Personal* around 3:40 PM." with
  **Stop waiting** (`thread.fallback.cancelled`).
- `resumeAt` = earliest future `resetsAt` among chain instances. Unknown → poll provider refresh every 15 min.
- `FallbackResumeScheduler` rebuilds timers from projected waiting threads on server start (survives
  `t3 update` / reboot). On fire: refresh snapshots, re-run selection, then same-thread switch or
  continuation thread per section 3; emit `thread.fallback.resumed`.
- Notifications on handed-off / waiting / resumed:
  - existing T3 notification path (desktop + mobile),
  - optional `webhookUrl`: `POST` with `Content-Type: text/plain`, body one line
    (e.g. `T3 [forge] "fix login" → Claude Personal (Claude Work hit its limit)`), 5 s timeout,
    failures logged and never block. Plain-text POST works with ntfy, Slack-compatible relays, etc.

## 5. Components

| Unit | Location | Kind |
|---|---|---|
| settings + project override schema | `packages/contracts/src/settings.ts` | contract |
| `usageLimit` marker, fallback events/commands, thread projection fields | `packages/contracts/src/providerRuntime.ts`, `orchestration.ts` | contract |
| `AccountFallbackPolicy` | `apps/server/src/orchestration/accountFallback/policy.ts` | pure |
| `HandoffPromptBuilder` | `apps/server/src/orchestration/accountFallback/handoffPrompt.ts` | pure (git output passed in) |
| `AccountFallbackReactor` | `apps/server/src/orchestration/Layers/AccountFallbackReactor.ts` | Effect layer |
| `FallbackResumeScheduler` | `apps/server/src/orchestration/Layers/FallbackResumeScheduler.ts` | Effect layer |
| `FallbackWebhookNotifier` | `apps/server/src/orchestration/accountFallback/webhook.ts` | Effect service |
| adapter markers | `ClaudeAdapter.ts`, `CodexAdapter.ts` | small edits |
| settings UI, project select, banners, sidebar links | `apps/web/src/components/...` | UI |
| user doc | `docs/user/account-fallback.md` | docs |

## 6. Dev-only limit simulation

`T3CODE_DEV_SIMULATE_USAGE_LIMIT=<instanceId>[,<instanceId>…]` — ignored unless the server runs in a
dev build. The named instances emit a blocking `usageLimit` (with `resetsAt` = now + 2 min) on their next
turn. Lets the full flow be tested without spending real quota.

## 7. Testing

Automated (repo test runner, patterns from `ProviderCommandReactor.test.ts`):
- policy: ordering, wrap-around, skip exhausted/disabled/tried, loop guard, handoff cap;
- handoff builder: content, caps, trimming;
- scheduler: fake clock, earliest reset, 15-min poll fallback, rebuild after restart;
- reactor integration with fake Claude/Codex adapters: Codex same-thread switch, Claude continuation
  thread (same worktree), all-exhausted → waiting → resume, pause toggle, start failure skips instance;
- settings resolution: project override vs environment default vs off.

Gate: `typecheck`, `lint`, `fmt:check`, `test` all green.

Manual, on forge, isolated from the production service:
- `t3code-fallback-test.service` (systemd user unit), `--base-dir ~/.t3-fallback-test`, port 3774,
  Tailscale Serve `https://forge.liger-tegus.ts.net:8443`. Production `t3code.service` untouched.
- Test from any tailnet browser (web UI is served by the server).
- Needs Node 24 (installed side by side via nvm on the mini and on forge).

## 8. Release

- Tag `v0.0.44-fallback.1` on `feature/account-fallback` in `nitya-ranjan/t3code` (public fork).
- `docs/user/account-fallback.md` in upstream doc style.
- Draft Discussions → Ideas post (with screenshots) kept at `docs/superpowers/proposal-account-fallback.md`.
- **Nothing is sent upstream** (no PR, no Discussion) until the owner has tested and says so.
  The local `upstream` remote has its push URL disabled.
