# Account Fallback Chains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a provider account hits its usage limit mid-turn, T3 Code continues the work on the next account in the project's fallback chain, or parks the thread and resumes it at the earliest reset.

**Architecture:** Adapters tag their existing limit events with a structured `usageLimit` marker. A new server reactor (`AccountFallbackReactor`) watches provider runtime events, asks a pure policy which account to use next, and dispatches ordinary orchestration commands: interrupt, `thread.turn.start` on a compatible account, or `thread.create` + `thread.turn.start` for a continuation thread in the same worktree. Per-thread fallback state is one projected field updated by a single `thread.fallback-updated` event; a one-minute sweep resumes waiting threads, so nothing needs rebuilding after a restart.

**Tech Stack:** TypeScript, Effect (effect-smol, `.repos/effect-smol/LLMS.md`), Effect Schema contracts, SQLite projections, React web client, `vp` (Vite+) for test/lint/fmt.

**Spec:** `docs/superpowers/specs/2026-09-29-account-fallback-design.md` (same branch).

## Global Constraints

- Off by default: with no chain configured, behavior is identical to upstream `v0.0.44`.
- Never relax the continuation-key guard (`ProviderCommandReactor.ts:685-707`, `ProviderService.ts:1464-1481`). Different-key accounts get a continuation thread, never a same-thread switch.
- New persisted event and projection fields are optional, so older events still decode on replay (`docs/internals/overview.md:60-71`).
- Side effects stay out of the decider. The reactor dispatches commands; the decider only emits events.
- Webhook failures are logged and never block or fail fallback.
- Dev-only simulation must be inert unless the server runs under the dev runner (`serverConfig.devUrl !== undefined`).
- Verification per `AGENTS.md`: `vp test run <files>` for touched tests, `vp run typecheck` in touched packages, `vp lint <files>`, `vp fmt <files>`. Never repo-wide checks.
- Do not commit anything to `docs/superpowers/` in the eventual upstream proposal (this plan and the spec are removed first).
- Environment for every command: `. <scratchpad>/env.sh` (nvm Node 24 + vite-plus). zsh does not word-split `$VAR`; use `${=VAR}` for file lists.

### Deviations from the spec (agreed during planning)

1. Pre-turn exhaustion check is deferred; a turn on an exhausted account fails fast with a limit, which the reactor already handles.
2. The handoff message asks the next agent to run `git status --short` and `git log --oneline -5` itself instead of the server shelling out to git.
3. v1 notifications are the in-thread banner plus the generic webhook. Native desktop/mobile notifications are deferred.
4. Mobile gets the new shell fields through `client-runtime` but no new UI in v1.
5. Resume is a one-minute sweep over projected waiting threads (restart-safe by construction).
6. Fallback state is one JSON column (`fallback_json`) updated by one event type.

---

## File Map

| File                                                                                                                                                             | Responsibility                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/accountFallback.ts` (new)                                                                                                                | `FallbackChainId`, `AccountFallbackSettings`, `ThreadFallbackState`, `ThreadFallbackReason` schemas                                                                                      |
| `packages/contracts/src/settings.ts`                                                                                                                             | add `accountFallback` + `accountFallbackChainId` settings, project scope, patch                                                                                                          |
| `packages/shared/src/serverSettings.ts`                                                                                                                          | replace `accountFallback` wholesale on patch                                                                                                                                             |
| `packages/contracts/src/providerRuntime.ts`                                                                                                                      | `RuntimeUsageLimit` marker on warning/error payloads                                                                                                                                     |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`, `CodexAdapter.ts`                                                                                            | set the marker                                                                                                                                                                           |
| `packages/contracts/src/orchestration.ts`                                                                                                                        | `fallback` field on thread + shell; `thread.fallback.update` (internal), `thread.fallback.set-paused` / `thread.fallback.cancel-wait` (client) commands; `thread.fallback-updated` event |
| `apps/server/src/orchestration/decider.ts`, `projector.ts`, `Layers/ProjectionPipeline.ts`, `Layers/ProjectionSnapshotQuery.ts`                                  | handle the event                                                                                                                                                                         |
| `apps/server/src/persistence/Migrations/055_ProjectionThreadsFallback.ts` (new), `Migrations.ts`, `Services/ProjectionThreads.ts`, `Layers/ProjectionThreads.ts` | `fallback_json` column                                                                                                                                                                   |
| `apps/server/src/orchestration/accountFallback/policy.ts` (new)                                                                                                  | pure chain resolution + next-account decision                                                                                                                                            |
| `apps/server/src/orchestration/accountFallback/handoffPrompt.ts` (new)                                                                                           | pure handoff message builder                                                                                                                                                             |
| `apps/server/src/orchestration/accountFallback/webhook.ts` (new)                                                                                                 | `FallbackWebhook` service (HttpClient POST)                                                                                                                                              |
| `apps/server/src/orchestration/accountFallback/simulateUsageLimit.ts` (new)                                                                                      | dev-only stream transform                                                                                                                                                                |
| `apps/server/src/orchestration/AccountFallbackReactor.ts` (new)                                                                                                  | reactor: handoff, switch, wait, sweep                                                                                                                                                    |
| `apps/server/src/orchestration/Layers/OrchestrationReactor.ts`, `apps/server/src/server.ts`, `integration/OrchestrationEngineHarness.integration.ts`             | register reactor                                                                                                                                                                         |
| `packages/client-runtime/src/state/threadReducer.ts`, `threadCommands.ts`                                                                                        | client state + commands                                                                                                                                                                  |
| `apps/web/src/components/settings/AccountFallbackSettings.tsx` (new) + `accountFallbackSettings.logic.ts` (new)                                                  | chains editor on Providers page                                                                                                                                                          |
| `apps/web/src/components/settings/ProjectDefaultsSettings.tsx`                                                                                                   | per-project chain select                                                                                                                                                                 |
| `apps/web/src/components/chat/fallbackBanner.logic.ts` (new), `ChatView.tsx`                                                                                     | waiting / continued banners                                                                                                                                                              |
| `docs/user/account-fallback.md` (new)                                                                                                                            | user doc                                                                                                                                                                                 |

---

### Task 1: Settings contracts for fallback chains

**Files:**

- Create: `packages/contracts/src/accountFallback.ts`
- Modify: `packages/contracts/src/index.ts` (export), `packages/contracts/src/settings.ts` (`ServerSettings` ~1103, `PROJECT_SCOPED_SERVER_SETTING_KEYS` ~1022, `ProjectSettingsOverrides` ~1049, `NULLABLE_PROJECT_SETTINGS_OVERRIDES` ~1080, `ServerSettingsPatch` ~1464)
- Modify: `packages/shared/src/serverSettings.ts` (~372, beside `defaultModelSelection`)
- Test: `packages/contracts/src/settings.test.ts`, `packages/shared/src/serverSettings.test.ts`, `packages/shared/src/projectSettings.test.ts`

**Interfaces:**

- Produces: `FallbackChainId` (branded string), `AccountFallbackChain = { displayName: string; instanceIds: ProviderInstanceId[] }`, `AccountFallbackSettings = { chains: Record<FallbackChainId, AccountFallbackChain>; maxHandoffsPerThreadPerHour: number; webhookUrl: string | null }`, `ServerSettings.accountFallback: AccountFallbackSettings`, `ServerSettings.accountFallbackChainId: FallbackChainId | null` (environment default, project-scoped; `null` = off).

- [ ] **Step 1: Write the failing tests**

In `packages/contracts/src/settings.test.ts` add:

```ts
it("defaults account fallback to off", () => {
  expect(DEFAULT_SERVER_SETTINGS.accountFallback).toEqual({
    chains: {},
    maxHandoffsPerThreadPerHour: 3,
    webhookUrl: null,
  });
  expect(DEFAULT_SERVER_SETTINGS.accountFallbackChainId).toBeNull();
});

it("treats the fallback chain as a nullable project override", () => {
  expect(PROJECT_SCOPED_SERVER_SETTING_KEYS).toContain("accountFallbackChainId");
  expect(NULLABLE_PROJECT_SETTINGS_OVERRIDES).toContain("accountFallbackChainId");
});
```

In `packages/shared/src/serverSettings.test.ts` add:

```ts
it("replaces account fallback settings instead of merging chains", () => {
  const current = {
    ...DEFAULT_SERVER_SETTINGS,
    accountFallback: {
      chains: {
        [FallbackChainId.make("work")]: {
          displayName: "Work",
          instanceIds: [ProviderInstanceId.make("claude_work")],
        },
      },
      maxHandoffsPerThreadPerHour: 3,
      webhookUrl: null,
    },
  };
  const next = applyServerSettingsPatch(current, {
    accountFallback: { chains: {}, maxHandoffsPerThreadPerHour: 5, webhookUrl: null },
  });
  expect(next.accountFallback.chains).toEqual({});
  expect(next.accountFallback.maxHandoffsPerThreadPerHour).toBe(5);
});
```

In `packages/shared/src/projectSettings.test.ts` add:

```ts
it("lets a project turn fallback off or pick another chain", () => {
  const projectId = ProjectId.make("p1");
  const base = {
    ...DEFAULT_SERVER_SETTINGS,
    accountFallbackChainId: FallbackChainId.make("personal"),
  };
  expect(resolveProjectSettings(base, projectId).settings.accountFallbackChainId).toBe("personal");
  const off = {
    ...base,
    projectSettingsOverrides: { [projectId]: { accountFallbackChainId: null } },
  };
  expect(resolveProjectSettings(off, projectId).settings.accountFallbackChainId).toBeNull();
  const work = {
    ...base,
    projectSettingsOverrides: {
      [projectId]: { accountFallbackChainId: FallbackChainId.make("work") },
    },
  };
  expect(resolveProjectSettings(work, projectId).settings.accountFallbackChainId).toBe("work");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/contracts && vp test run src/settings.test.ts` and `cd packages/shared && vp test run src/serverSettings.test.ts src/projectSettings.test.ts`
Expected: FAIL (`accountFallback` undefined / imports missing).

- [ ] **Step 3: Implement**

`packages/contracts/src/accountFallback.ts`:

```ts
import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const FallbackChainId = TrimmedNonEmptyString.pipe(Schema.brand("FallbackChainId"));
export type FallbackChainId = typeof FallbackChainId.Type;

/** An ordered list of provider instances to try when one runs out of usage. */
export const AccountFallbackChain = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  instanceIds: Schema.Array(ProviderInstanceId).check(Schema.isMinLength(1)),
});
export type AccountFallbackChain = typeof AccountFallbackChain.Type;

export const AccountFallbackSettings = Schema.Struct({
  chains: Schema.Record(FallbackChainId, AccountFallbackChain).pipe(
    Schema.withDecodingDefault(() => ({})),
  ),
  maxHandoffsPerThreadPerHour: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).pipe(
    Schema.withDecodingDefault(() => 3),
  ),
  webhookUrl: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
});
export type AccountFallbackSettings = typeof AccountFallbackSettings.Type;

export const ThreadFallbackReason = Schema.Literals([
  "handed-off",
  "switched-account",
  "waiting",
  "resumed",
  "paused",
  "unpaused",
  "cancelled",
]);
export type ThreadFallbackReason = typeof ThreadFallbackReason.Type;

/**
 * Per-thread fallback state. `triedInstanceIds` resets when a user turn starts;
 * `handoffTimes` carries across a continuation lineage for the hourly cap.
 */
export const ThreadFallbackState = Schema.Struct({
  chainId: FallbackChainId,
  status: Schema.Literals(["idle", "waiting"]),
  paused: Schema.Boolean,
  resumeAt: Schema.NullOr(IsoDateTime),
  waitingSince: Schema.NullOr(IsoDateTime),
  candidateInstanceId: Schema.NullOr(ProviderInstanceId),
  triedInstanceIds: Schema.Array(ProviderInstanceId),
  handoffTimes: Schema.Array(IsoDateTime),
  continuedToThreadId: Schema.NullOr(ThreadId),
  continuedFromThreadId: Schema.NullOr(ThreadId),
});
export type ThreadFallbackState = typeof ThreadFallbackState.Type;
```

Before writing, confirm the exact Schema API names in the vendored Effect (`grep -n "export declare function \(isBetween\|brand\|Record\)" node_modules/.pnpm/effect@*/node_modules/effect/dist/Schema.d.ts`) and match how `settings.ts` already brands ids and applies `withDecodingDefault`; copy that form if it differs.

In `settings.ts`: import the new schemas; add to `ServerSettings`:

```ts
  accountFallback: AccountFallbackSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  accountFallbackChainId: Schema.NullOr(FallbackChainId).pipe(Schema.withDecodingDefault(() => null)),
```

Add `"accountFallbackChainId"` to `PROJECT_SCOPED_SERVER_SETTING_KEYS` and `NULLABLE_PROJECT_SETTINGS_OVERRIDES`; add `accountFallbackChainId: Schema.optionalKey(Schema.NullOr(FallbackChainId))` to `ProjectSettingsOverrides`; add both keys as `Schema.optionalKey(...)` to `ServerSettingsPatch`. Export `accountFallback.ts` from `index.ts`.

In `packages/shared/src/serverSettings.ts`, next to the `defaultModelSelection` special case:

```ts
    ...(patch.accountFallback !== undefined ? { accountFallback: patch.accountFallback } : {}),
```

- [ ] **Step 4: Run tests and typecheck**

Run the three test files again (PASS), then `vp run typecheck` in `packages/contracts` and `packages/shared` (no errors).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/shared
git commit -m "feat(contracts): account fallback chain settings"
```

---

### Task 2: Structured usage-limit marker from Claude and Codex

**Files:**

- Modify: `packages/contracts/src/providerRuntime.ts` (~800-816)
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts` (turn state ~278, rate_limit_event ~4078-4136, `handleResultMessage` ~3480-3501)
- Modify: `apps/server/src/provider/Layers/CodexAdapter.ts` (~2446-2505)
- Test: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`, `CodexAdapter.test.ts`

**Interfaces:**

- Produces: `RuntimeUsageLimit = { instanceId: ProviderInstanceId; blocking: true; resetsAt: IsoDateTime | null }`, available as optional `payload.usageLimit` on `runtime.warning` and `runtime.error`.

- [ ] **Step 1: Write failing tests**

In `ClaudeAdapter.test.ts`, extend "surfaces a rejected Claude usage limit once per turn" (~4644) with:

```ts
expect(warning.payload.usageLimit).toEqual({
  instanceId: "claudeAgent",
  blocking: true,
  resetsAt: new Date(RESETS_AT_SECONDS * 1000).toISOString(),
});
```

(use the reset seconds constant that test already feeds the SDK event; name it `RESETS_AT_SECONDS` if it is inline). Extend "fails a usage-limited turn with the limit it parked on" (~2558) to assert the `runtime.error` also carries the same `usageLimit`.

In `CodexAdapter.test.ts`, extend "names the session window for a plan limit" (~2967):

```ts
expect(error.payload.usageLimit).toMatchObject({ instanceId: "codex", blocking: true });
expect(error.payload.usageLimit?.resetsAt).toBe(EXPECTED_RESETS_AT_ISO);
```

and "falls back to the short message without a rate-limit snapshot" (~3035) to assert `resetsAt: null`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server && vp test run src/provider/Layers/ClaudeAdapter.test.ts src/provider/Layers/CodexAdapter.test.ts -t "usage limit|plan limit|short message"`
Expected: FAIL (`usageLimit` undefined).

- [ ] **Step 3: Implement**

`providerRuntime.ts`, above `RuntimeWarningPayload`:

```ts
/** Set when a provider stopped the turn because an account ran out of usage. */
export const RuntimeUsageLimit = Schema.Struct({
  instanceId: ProviderInstanceId,
  blocking: Schema.Literal(true),
  resetsAt: Schema.NullOr(IsoDateTime),
});
export type RuntimeUsageLimit = typeof RuntimeUsageLimit.Type;
```

Add `usageLimit: Schema.optional(RuntimeUsageLimit)` to both `RuntimeWarningPayload` and `RuntimeErrorPayload`.

Claude: add `blockingUsageLimitResetsAt: string | null | undefined` to the per-turn state beside `rejectedRateLimitTypes`. In the rejected/no-overage branch set it to `rateLimitInfo.resetsAt ? new Date(rateLimitInfo.resetsAt * 1000).toISOString() : null` and pass `usageLimit: { instanceId: boundInstanceId, blocking: true, resetsAt }` into the warning payload (`emitRuntimeWarning` gains an optional `usageLimit` argument). In `handleResultMessage`, when the usage-limit hint is chosen, pass `usageLimit: { instanceId: boundInstanceId, blocking: true, resetsAt: turnState.blockingUsageLimitResetsAt ?? null }` to `emitRuntimeError`.

Codex: in the `usageLimitExceeded` branch compute `resetsAt` from the latest exhausted window, the same way `codexUsageLimits.ts:218-235` picks it (export a small `latestExhaustedResetAt(snapshot)` helper there if none exists), and add `usageLimit: { instanceId: boundInstanceId, blocking: true, resetsAt }` to the `runtime.error` payload.

- [ ] **Step 4: Run tests** (same command, PASS), then the full two adapter test files to confirm nothing else broke.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(server): tag blocking usage limits on provider runtime events"
```

---

### Task 3: Thread fallback field, commands, event, projection

**Files:**

- Modify: `packages/contracts/src/orchestration.ts` (thread ~793/~884, command unions ~1427/~1461/~1661, event literals ~1690, events ~2044)
- Modify: `apps/server/src/orchestration/decider.ts` (beside `thread.auto-settle.set` ~856), `projector.ts` (~599)
- Create: `apps/server/src/persistence/Migrations/055_ProjectionThreadsFallback.ts`; Modify: `persistence/Migrations.ts` (~68, ~134), `persistence/Services/ProjectionThreads.ts` (~53), `persistence/Layers/ProjectionThreads.ts` (~57/90/123/163), `orchestration/Layers/ProjectionPipeline.ts` (~636, ~786), `orchestration/Layers/ProjectionSnapshotQuery.ts` (every place `auto_settle_disabled_at` is selected and mapped)
- Modify: `packages/client-runtime/src/state/threadReducer.ts` (~134, ~258), `threadCommands.ts` (~57/~178)
- Test: `apps/server/src/orchestration/decider.fallback.test.ts` (new), `projector.fallback.test.ts` (new), `persistence/Migrations/055_ProjectionThreadsFallback.test.ts` (new), `ProjectionSnapshotQuery.test.ts`

Mirror the auto-settle opt-out feature exactly (its files are listed in `docs/superpowers/specs/...` research: `decider.autoSettleSet.test.ts`, `projector.autoSettleSet.test.ts`, `054_...`). Read each of those first and copy their structure.

**Interfaces:**

- Consumes: `ThreadFallbackState`, `ThreadFallbackReason` (Task 1).
- Produces:
  - Thread field `fallback?: ThreadFallbackState | null` on `OrchestrationThread` and `OrchestrationThreadShell`.
  - Internal command `thread.fallback.update { commandId, threadId, fallback: ThreadFallbackState, reason, fromInstanceId?: ProviderInstanceId, toInstanceId?: ProviderInstanceId, createdAt }`.
  - Client commands `thread.fallback.set-paused { commandId, threadId, paused: boolean, createdAt }` and `thread.fallback.cancel-wait { commandId, threadId, createdAt }`.
  - Event `thread.fallback-updated` payload `{ threadId, fallback: ThreadFallbackState, reason, fromInstanceId?, toInstanceId?, updatedAt }`.

- [ ] **Step 1: Write failing decider tests** (`decider.fallback.test.ts`, copying the setup of `decider.autoSettleSet.test.ts`):

```ts
it("emits the new fallback state for an internal update", () => /* dispatch thread.fallback.update on a created thread; expect one thread.fallback-updated event whose payload.fallback equals the command's */);
it("pauses fallback on a thread that has fallback state", () => /* read model thread.fallback = idle state; dispatch set-paused true; expect payload.fallback.paused === true and reason "paused" */);
it("rejects pausing a thread without fallback state", () => /* fallback null; expect OrchestrationCommandInvariantError */);
it("cancels a wait back to idle", () => /* fallback.status waiting; cancel-wait; expect status "idle", resumeAt null, reason "cancelled" */);
it("rejects cancel-wait when the thread is not waiting", () => /* expect invariant error */);
```

Write each body with concrete read models and `expect` calls in the style of `decider.autoSettleSet.test.ts` (build the thread with `thread.created`, then set `fallback` on the read model directly for the pause/cancel cases).

- [ ] **Step 2: Run to verify failure**: `cd apps/server && vp test run src/orchestration/decider.fallback.test.ts` → FAIL.

- [ ] **Step 3: Implement contracts + decider + in-memory projector**

Contracts: add `fallback: Schema.optional(Schema.NullOr(ThreadFallbackState))` to both thread schemas; add the three command structs; put `thread.fallback.update` in `InternalOrchestrationCommand`, the other two in both client unions; add `"thread.fallback-updated"` to `OrchestrationEventType`; add `ThreadFallbackUpdatedPayload` and the event member.

Decider: `thread.fallback.update` → `requireThread`, emit event with the command's state. `set-paused` → `requireThreadNotArchived`; fail with `OrchestrationCommandInvariantError` if `thread.fallback` is null; emit `{...thread.fallback, paused}`, reason `paused`/`unpaused`. `cancel-wait` → fail unless `status === "waiting"`; emit `{...thread.fallback, status: "idle", resumeAt: null, waitingSince: null, candidateInstanceId: null}`, reason `cancelled`.

Projector: `thread.fallback-updated` → `updateThread(..., { fallback: payload.fallback })`; `thread.created` default `fallback: null`.

- [ ] **Step 4: Decider tests pass.** Add `projector.fallback.test.ts` (created → updated → field set) and run it.

- [ ] **Step 5: SQL projection + migration**

`055_ProjectionThreadsFallback.ts`, copying `054_ProjectionThreadsAutoSettleDisabledAt.ts`: add `fallback_json TEXT` to `projection_threads` if absent. Register `[55, "ProjectionThreadsFallback", Migration0055]`. Add `fallbackJson` to the row schema and repository insert/upsert/select; in `ProjectionPipeline.applyThreadsProjection` set `fallbackJson: null` on created and `JSON` encode on `thread.fallback-updated` (use `Schema.encodeSync(Schema.fromJsonString(ThreadFallbackState))`); in `ProjectionSnapshotQuery` select the column wherever `auto_settle_disabled_at` is selected and decode it (`null` when absent or undecodable).

Tests: `055_...test.ts` (column added once, idempotent — copy `054_...test.ts`), and one `ProjectionSnapshotQuery.test.ts` case asserting a shell read after `thread.fallback-updated` returns the state.

- [ ] **Step 6: Client runtime**: `threadReducer.ts` default `fallback: null` on created and a case for `thread.fallback-updated`; `threadCommands.ts` builders `setThreadFallbackPaused(threadId, paused)` and `cancelThreadFallbackWait(threadId)` shaped like the auto-settle builder. Run `vp test run` on the client-runtime reducer tests.

- [ ] **Step 7: Typecheck** `packages/contracts`, `packages/client-runtime`, `apps/server`, `apps/web` (web must still compile against the new optional field).

- [ ] **Step 8: Commit**

```bash
git commit -am "feat(orchestration): per-thread account fallback state"
```

---

### Task 4: Fallback policy (pure)

**Files:**

- Create: `apps/server/src/orchestration/accountFallback/policy.ts`
- Test: `apps/server/src/orchestration/accountFallback/policy.test.ts`

**Interfaces:**

- Consumes: `ServerSettings`, `resolveProjectSettings`, `ServerProviderUsageLimits`, `ProviderInstanceId`, `FallbackChainId`.
- Produces:

```ts
export interface FallbackCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly usable: boolean; // enabled and authenticated
  readonly continuationKey: string;
  readonly exhaustedUntil: string | null; // ISO; null = not known exhausted
}
export type FallbackDecision =
  | { readonly _tag: "SwitchAccount"; readonly instanceId: ProviderInstanceId }
  | { readonly _tag: "ContinueInNewThread"; readonly instanceId: ProviderInstanceId }
  | {
      readonly _tag: "Wait";
      readonly resumeAt: string | null;
      readonly candidateInstanceId: ProviderInstanceId | null;
    };
export function resolveFallbackChain(
  settings: ServerSettings,
  projectId: ProjectId,
): {
  readonly chainId: FallbackChainId;
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
} | null;
export function usageExhaustedUntil(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
): string | null;
export function decideFallback(input: {
  readonly mode: "limit" | "resume";
  readonly chain: ReadonlyArray<ProviderInstanceId>;
  readonly currentInstanceId: ProviderInstanceId;
  readonly currentContinuationKey: string;
  readonly candidates: ReadonlyMap<ProviderInstanceId, FallbackCandidate>;
  readonly tried: ReadonlySet<ProviderInstanceId>;
  readonly handoffTimes: ReadonlyArray<string>;
  readonly maxHandoffsPerHour: number;
  readonly nowMs: number;
}): FallbackDecision;
```

Rules: `limit` mode walks the chain starting after the current instance and wrapping, skipping the current instance, `tried`, unusable, and candidates with `exhaustedUntil > now`. `resume` mode walks from the start of the chain and does not skip the current instance. The first match is `SwitchAccount` when its key equals `currentContinuationKey`, else `ContinueInNewThread`. A hand-off (any non-Wait decision) is refused, returning Wait, when `handoffTimes` within the last hour already reach the cap (resume mode is exempt: resuming is not a new hand-off unless it moves accounts). With no match: `Wait` with the earliest future `exhaustedUntil` among chain candidates, and that instance as `candidateInstanceId`; both `null` if none is known. `usageExhaustedUntil` returns the latest `resetsAt` among windows with `usedPercent >= 100` and a future reset, or `null`.

- [ ] **Step 1: Write failing tests** covering, each as its own `it`:

```ts
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
      },
      NOW,
    ),
  ).toBe("2026-09-29T14:00:00.000Z");
  expect(usageExhaustedUntil(undefined, NOW)).toBeNull();
});
it("resolves the project's chain and ignores unknown chains", () => {
  /* settings with chains {work}, accountFallbackChainId "work" → {chainId:"work", instanceIds}; "missing" → null; null → null */
});
```

Adjust the `ServerProviderUsageLimits` literal to the real schema fields (`packages/contracts/src/providerUsageLimits.ts:20,50`) if any are required that are not shown.

- [ ] **Step 2: Run** `vp test run src/orchestration/accountFallback/policy.test.ts` → FAIL.
- [ ] **Step 3: Implement** `policy.ts` exactly per the rules above (no Effect needed; plain functions).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(server): account fallback policy"`

---

### Task 5: Handoff message builder (pure)

**Files:** Create `apps/server/src/orchestration/accountFallback/handoffPrompt.ts`, test `handoffPrompt.test.ts`.

**Interfaces:**

- Produces: `buildHandoffPrompt(input: { readonly threadTitle: string; readonly fromAccount: string; readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>; readonly maxWords?: number }): string` (default `maxWords` 4000).

Output shape (exact headings; tests assert them):

```
You are continuing a task that another agent started in this same working directory. Its account ran out of usage, so the conversation moved to you.

Task: <threadTitle> (was running on <fromAccount>)

## What the user asked
<first user message>
<each later user message, in order, separated by a blank line>

## Where the previous agent got to
<last up to 3 assistant messages, oldest first>

## Before you continue
1. Run `git status --short` and `git log --oneline -5` to see the current state of the files.
2. Read PROGRESS.md if it exists.
3. Continue the task from where it stopped. Do not redo finished work.
```

Trimming: count words across both content sections; drop the oldest later-user messages first, then the oldest assistant messages, then truncate the remaining text with `…`. The first user message is kept (truncated last).

- [ ] **Step 1: Failing tests**: (a) full structure with small input equals the exact expected string; (b) drops old assistant messages beyond 3; (c) with a 10,000-word first message and `maxWords: 100`, the output still contains the headings and the first message truncated with `…`, and the total word count of the two content sections is ≤ 100.
- [ ] **Step 2-4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(server): account fallback handoff message"`

---

### Task 6: Webhook notifier

**Files:** Create `apps/server/src/orchestration/accountFallback/webhook.ts`, test `webhook.test.ts`.

**Interfaces:**

- Produces: `class FallbackWebhook extends Context.Service<FallbackWebhook, { readonly notify: (url: string | null, text: string) => Effect.Effect<void> }>()("t3/orchestration/accountFallback/FallbackWebhook")` and `FallbackWebhook.layer` requiring `HttpClient.HttpClient`.

Behavior: `url === null` → no-op. Otherwise `HttpClientRequest.post(url)` with `bodyText(text, "text/plain")`, `Effect.timeout("5 seconds")`, and `Effect.catch` + `Effect.logWarning("Account fallback webhook failed", { url, cause })` so it never fails. Follow `provider/ModelManifest.ts:344-402` for imports and client usage.

- [ ] **Step 1: Failing tests** with a test `HttpClient` layer (`HttpClient.make((request) => ...)` recording requests): posts text/plain body once; null url sends nothing; a failing client resolves without error.
- [ ] **Step 2-4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(server): account fallback webhook"`

---

### Task 7: Dev-only limit simulation (pure stream transform)

**Files:** Create `apps/server/src/orchestration/accountFallback/simulateUsageLimit.ts`, test `simulateUsageLimit.test.ts`.

**Interfaces:**

- Produces: `simulateUsageLimits(events: Stream.Stream<ProviderRuntimeEvent>, instanceIds: ReadonlySet<ProviderInstanceId>, now: () => number): Stream.Stream<ProviderRuntimeEvent>` and `parseSimulatedInstanceIds(value: string | undefined): ReadonlySet<ProviderInstanceId>`.

Behavior: pass every event through; after each `turn.started` event whose `providerInstanceId` is in the set, also emit a `runtime.warning` for the same `threadId`/`turnId`/`providerInstanceId` with message `"Simulated usage limit (T3CODE_DEV_SIMULATE_USAGE_LIMIT)."` and `usageLimit: { instanceId, blocking: true, resetsAt: new Date(now() + 120_000).toISOString() }`. Build the warning by copying base fields (`eventId` new uuid, `createdAt` now) from the triggering event; check the `turn.started` event type name in `providerRuntime.ts` first.

- [ ] **Steps 1-5:** failing test (listed instance gets an extra warning after turn start; others untouched; empty/whitespace env → empty set) → implement → pass → commit `git commit -m "feat(server): dev-only usage limit simulation"`.

---

### Task 8: AccountFallbackReactor — hand-off, switch, wait

**Files:**

- Create: `apps/server/src/orchestration/AccountFallbackReactor.ts`
- Test: `apps/server/src/orchestration/AccountFallbackReactor.test.ts`

Use `ThreadSettlementReactor.ts` as the structural template (service in the same file, `make`, `layer`, `makeDrainableWorker`, `forkParked`) and `ThreadSettlementReactor.test.ts` as the test template (mocked engine with PubSub domain events, `ServerActivation` deferred, `TestClock`).

**Interfaces:**

- Consumes: `ProviderService` (`streamEvents`, `getInstanceInfo`), `ProviderRegistry.getProviders`, `ProjectionSnapshotQuery` (`getThreadShellById`, `getThreadDetailById`, `getProjectShellById`, `getShellSnapshot`), `OrchestrationEngineService.dispatch`, `ServerSettingsService.getSettings`, `FallbackWebhook`, `ServerConfig.devUrl`, `Crypto`, Tasks 4-7.
- Produces: `class AccountFallbackReactor extends Context.Service<AccountFallbackReactor, { readonly start: () => Effect.Effect<void, never, Scope.Scope>; readonly drain: Effect.Effect<void> }>()("t3/orchestration/AccountFallbackReactor")`, `export const layer`.

Handling one blocking limit `{ threadId, turnId, instanceId, resetsAt }` (skip the event unless `payload.usageLimit?.blocking`):

1. Load thread shell; skip when missing, archived, `fallback?.paused`, or `fallback?.status === "waiting"`.
2. `resolveFallbackChain(settings, thread.projectId)`; skip when null or the current instance is not in the chain.
3. Dispatch `thread.turn.interrupt { threadId, turnId, createdAt }`; log and continue on failure.
4. Build candidates for every chain instance: `getInstanceInfo` → `usable = enabled` and matching `ServerProvider.auth.status === "authenticated"` from `getProviders`; `continuationKey` from `continuationIdentity`; `exhaustedUntil = usageExhaustedUntil(provider.usageLimits, now)`, and for the current instance `resetsAt ?? exhaustedUntil ?? now + 1h`.
5. `decideFallback({ mode: "limit", tried: thread.fallback?.triedInstanceIds plus current, handoffTimes: thread.fallback?.handoffTimes ?? [], maxHandoffsPerHour: settings.accountFallback.maxHandoffsPerThreadPerHour, ... })`.
6. `SwitchAccount`: dispatch `thread.turn.start` on the same thread with `modelSelection: { instanceId: next, model: thread.modelSelection.model }`, text `"You were interrupted by an account usage limit. Continue where you left off."`, same runtime/interaction mode; then `thread.fallback.update` reason `switched-account` (tried += current, handoffTimes += now).
7. `ContinueInNewThread`: new `ThreadId` (uuid); `buildHandoffPrompt` from `getThreadDetailById` messages; dispatch `thread.create { projectId, title: thread.title, modelSelection: { instanceId: next, model: DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL }, branch: thread.branch, worktreePath: thread.worktreePath, runtimeMode, interactionMode }`; `thread.fallback.update` on the new thread (`continuedFromThreadId`, carried `triedInstanceIds` + current, `handoffTimes` + now, status idle); `thread.turn.start` on the new thread with the prompt; `thread.fallback.update` on the old thread (`continuedToThreadId`, reason `handed-off`).
8. `Wait`: `thread.fallback.update` with status `waiting`, `resumeAt`, `waitingSince: now`, `candidateInstanceId`, reason `waiting`.
9. Webhook text (one line): `T3 "<title>": <from> hit its usage limit → <to> (new thread|same thread)` or `T3 "<title>": all accounts in <chain> are out, resuming around <resumeAt|unknown>`.

Start: source stream = `providerService.streamEvents`, wrapped by `simulateUsageLimits` when `serverConfig.devUrl !== undefined` and `T3CODE_DEV_SIMULATE_USAGE_LIMIT` is set; `forkParked(Stream.runForEach(source, (event) => isBlocking(event) ? worker.enqueue({ _tag: "Limit", ... }) : Effect.void))`.

Also reset `triedInstanceIds` when the user starts a new turn: subscribe to domain events and on `thread.turn-start-requested` whose command did not come from this reactor (commandId prefix `server:account-fallback:`) dispatch `thread.fallback.update` with `triedInstanceIds: []` only if the list is non-empty. Use `serverCommandId("account-fallback")` for every dispatched command.

- [ ] **Step 1: Failing tests** (drive via a PubSub-backed `streamEvents` and a recording `dispatch`, like the harness in `ProviderCommandReactor.test.ts:170-637`):
  - no chain configured → no commands dispatched;
  - Claude Work limit, chain Work → interrupt, `thread.create` with same `worktreePath`/`branch` and `instanceId: claude_personal`, `thread.turn.start` whose text contains `## What the user asked`, and two `thread.fallback.update` commands linking both ways;
  - Codex shared-home chain → `thread.turn.start` on the same thread with `instanceId: codex_b`, no `thread.create`;
  - every account exhausted → one `thread.fallback.update` with `status: "waiting"` and the earliest `resumeAt`;
  - paused thread → nothing after the event;
  - webhook receives exactly one line per decision.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(server): account fallback reactor hand-off"`

---

### Task 9: Resume sweep

**Files:** Modify `AccountFallbackReactor.ts`; extend its test.

Add a sweep enqueued every minute (`Effect.repeat(Schedule.spaced("1 minute"))` under `forkParked`, as in `ThreadSettlementReactor.start`). The sweep reads `getShellSnapshot()` and, for each thread with `fallback.status === "waiting"` where `resumeAt <= now` or (`resumeAt === null` and `waitingSince` ≥ 15 minutes ago), calls `ProviderRegistry.refresh()` once per sweep, rebuilds candidates, and runs `decideFallback({ mode: "resume", tried: new Set(), ... })`:

- `SwitchAccount` → `thread.turn.start` on the same thread (continue text), then `thread.fallback.update` status idle, reason `resumed`.
- `ContinueInNewThread` → the Task 8 step 7 path, then mark the old thread idle with `continuedToThreadId`.
- `Wait` → `thread.fallback.update` with the new `resumeAt` and `waitingSince: now` (so an unknown reset re-checks in 15 minutes).

- [ ] **Step 1: Failing tests** using `TestClock`: waiting thread with `resumeAt` in 2 minutes → nothing at +1 min, resumed at +2 min (drain after `TestClock.adjust`); `resumeAt: null` → re-evaluated after 15 minutes; a thread waiting at startup is resumed on the first sweep (proves restart safety).
- [ ] **Steps 2-4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(server): resume threads waiting for a usage reset"`

---

### Task 10: Register the reactor and prove it end to end

**Files:**

- Modify: `apps/server/src/orchestration/Layers/OrchestrationReactor.ts` (`yield* accountFallback.start()`), `apps/server/src/server.ts:264-276` (`Layer.provideMerge(AccountFallbackReactor.layer)` and `FallbackWebhook.layer`), `integration/OrchestrationEngineHarness.integration.ts` (~385-420, no-op stub), `OrchestrationReactor.test.ts` (stub).
- Test: `apps/server/integration/accountFallback.integration.test.ts` (new)

- [ ] **Step 1: Failing integration test** using `makeAdapterRegistryMock` with two `makeTestProviderAdapterHarness` adapters (`claudeAgent` instances `claude_work`, `claude_personal`) and settings with a `work` chain: queue a turn response for `claude_work` whose events include a `runtime.warning` with `usageLimit.blocking`, start a turn, `drain`, then assert a second thread exists in the same project with `modelSelection.instanceId === "claude_personal"`, its first user message contains `## What the user asked`, and both threads' `fallback` link to each other.
- [ ] **Step 2:** FAIL. **Step 3:** register layers. **Step 4:** PASS, then run `vp test run src/orchestration` and `vp run typecheck` in `apps/server`.
- [ ] **Step 5: Commit** `git commit -m "feat(server): run the account fallback reactor"`

---

### Task 11: Settings UI — chains and per-project choice

**Files:**

- Create: `apps/web/src/components/settings/accountFallbackSettings.logic.ts` + `.test.ts`, `AccountFallbackSettings.tsx`
- Modify: `apps/web/src/components/settings/ProviderSettingsPanel.tsx` (~1171, between `UsageProviderSettings` and "Advanced"), `ProjectDefaultsSettings.tsx` (after `{modelRow}` ~266-275), `settingsSearch.ts` (+ entries `fallback-chains`, `project-fallback-chain`; update `settingsSearch.test.ts` if it snapshots ids)

**Interfaces:**

- Produces (logic): `chainIdFromName(name: string, existing: ReadonlySet<string>): FallbackChainId` (slug, de-duplicated with `-2`, `-3`), `moveInstance(ids, index, direction: -1 | 1)`, `describeChain(chain, instanceLabels: ReadonlyMap<string,string>): string` ("Claude Work → Claude Personal → Codex"), `unknownInstanceIds(chain, known: ReadonlySet<string>)`.

UI: section "Fallback chains" listing chains (name, `describeChain`, warning for unknown ids), add/edit dialog (name + ordered instance list with up/down/remove + add-instance select), delete; "Default chain" select (None + chains) bound to `accountFallbackChainId`; webhook URL `DraftInput`; handoff cap number input. All writes go through `useUpdateEnvironmentSettings(environmentId)` with the whole `accountFallback` object (Task 1 patch replaces it). Project row: `SettingsRow` with `settingKeys={["accountFallbackChainId"]}` and a select "Inherit / Off / <chains>" following `modelRow`'s scoped-setting pattern (`ScopedSwitch`/`useScopedSettingsMixed` usage in `SettingsPanels.tsx`). Use only `components/ui` variants (lint `shadcn/no-restyle`).

- [ ] **Step 1:** failing logic tests for the four helpers. **Steps 2-4:** FAIL → implement logic → PASS; build the components; `vp run typecheck` + `vp lint` on touched files.
- [ ] **Step 5: Commit** `git commit -m "feat(web): configure account fallback chains"`

---

### Task 12: Thread banners and controls

**Files:**

- Create: `apps/web/src/components/chat/fallbackBanner.logic.ts` + `.test.ts`
- Modify: `apps/web/src/components/chat/ChatView.tsx` (memo beside `parkedThreadBannerItem` ~6347, add to `composerBannerItems` ~6511), the thread action menu (`threadActionMenu.logic.ts` / `useThreadActionMenu.ts`) for "Pause account fallback" / "Resume account fallback".

**Interfaces:**

- Produces: `fallbackBannerModel(thread: { fallback?: ThreadFallbackState | null }, now: number, labels: ReadonlyMap<string,string>): null | { kind: "waiting"; text: string; canCancel: true } | { kind: "continued-to"; threadId: ThreadId; text: string } | { kind: "continued-from"; threadId: ThreadId; text: string }`.

Texts: waiting → `All accounts in this chain are out of usage. Resumes on <label> around <local time>.` (or `Resumes when an account has usage again.` when `resumeAt` is null); continued-to → `Continued in a new thread on <label>.` with an "Open" action navigating to the thread; continued-from → `Continued from an earlier thread that ran out of usage.` with "Open". "Stop waiting" dispatches `cancelThreadFallbackWait`; the menu item dispatches `setThreadFallbackPaused`.

- [ ] **Step 1:** failing logic tests for each banner kind and null. **Steps 2-4:** FAIL → implement → PASS; wire UI; typecheck + lint.
- [ ] **Step 5: Commit** `git commit -m "feat(web): show account fallback in threads"`

---

### Task 13: User doc and test deployment

**Files:** Create `docs/user/account-fallback.md`; link it from `docs/user/providers-claude.md` "Usage limits" and `providers-codex.md` "Codex says I hit a usage limit" (one sentence each).

Doc sections (product voice, no internals): what fallback does; set up chains (Settings → Providers → Fallback chains); pick a chain per project (project settings); what happens (same thread for Codex accounts sharing a Codex home, otherwise a linked new thread in the same worktree); waiting and resuming; pausing a thread; the webhook (works with ntfy: `https://<ntfy host>/<topic>`).

- [ ] **Step 1:** write the doc and links; commit `git commit -m "docs: account fallback"`.
- [ ] **Step 2: Tag and push** `git tag v0.0.44-fallback.1 && git push origin feature/account-fallback v0.0.44-fallback.1` (fork only; `upstream` push is disabled).
- [ ] **Step 3: Test server on forge**, isolated from production `t3code.service`: install Node 24 via nvm and `vp`; clone the fork branch to `/root/t3code-fallback`; `vp i`; run `vp run dev --share --home-dir /root/.t3-fallback-test` under a systemd user unit `t3code-fallback-test.service` with `T3CODE_DEV_SIMULATE_USAGE_LIMIT=claude_work` in its environment; report the pairing URL.
- [ ] **Step 4: Manual check with the owner**: chain Work = Claude Work → Claude Personal → Codex on a scratch project; send a message on Claude Work; expect a linked continuation thread on Claude Personal and one ntfy message.

---

## Self-review notes

- Spec §1 settings → Task 1, 11. §2 limit signal → Task 2. §3 hand-off, guards, pause → Tasks 4, 5, 8, 12 (pre-turn check deferred, deviation 1). §4 waiting/resume/notifications → Tasks 6, 9, 12 (native notifications deferred, deviation 3). §5 components → File Map. §6 simulation → Task 7 (+ wiring in Task 8). §7 testing → each task + Task 10 integration + Task 13 manual. §8 release → Task 13.
- Names used across tasks: `ThreadFallbackState`, `decideFallback`, `resolveFallbackChain`, `usageExhaustedUntil`, `buildHandoffPrompt`, `FallbackWebhook.notify`, `simulateUsageLimits`, `setThreadFallbackPaused`, `cancelThreadFallbackWait`, `thread.fallback.update`, `thread.fallback-updated` — consistent.
