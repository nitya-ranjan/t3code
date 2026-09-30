import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  FallbackChainId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

const NOW = "2026-09-29T12:00:00.000Z";
const RESETS_AT = "2026-09-29T17:00:00.000Z";
const PROJECT_ID = ProjectId.make("fallback-project");
const THREAD_ID = ThreadId.make("fallback-thread");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_WORK = ProviderInstanceId.make("claude_work");
const CLAUDE_PERSONAL = ProviderInstanceId.make("claude_personal");
const MODEL = DEFAULT_MODEL_BY_PROVIDER[CLAUDE]!;
const CODEX = ProviderDriverKind.make("codex");
const CODEX_A = ProviderInstanceId.make("codex_a");
const CODEX_B = ProviderInstanceId.make("codex_b");
const CODEX_MODEL = DEFAULT_MODEL_BY_PROVIDER[CODEX]!;
const SHARED_CODEX_HOME = "codex:home:/shared";

const authenticated = (
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind = CLAUDE,
): ServerProvider => ({
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [],
  slashCommands: [],
  skills: [],
});

it.live("hands a limited thread to the next account in a new thread", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({
      provider: CLAUDE,
      // The mock registry gives each instance its own continuation key, so
      // the two accounts cannot share a conversation and must hand off.
      instanceIds: [CLAUDE_WORK, CLAUDE_PERSONAL],
      providers: [authenticated(CLAUDE_WORK), authenticated(CLAUDE_PERSONAL)],
      serverSettings: {
        accountFallback: {
          chains: {
            [FallbackChainId.make("work")]: {
              displayName: "Work",
              instanceIds: [CLAUDE_WORK, CLAUDE_PERSONAL],
            },
          },
        },
        accountFallbackChainId: FallbackChainId.make("work"),
      },
      accountFallback: true,
    }),
    (harness) =>
      Effect.gen(function* () {
        const work = harness.instanceAdapterHarnesses.get(CLAUDE_WORK)!;
        const personal = harness.instanceAdapterHarnesses.get(CLAUDE_PERSONAL)!;

        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-create"),
          projectId: PROJECT_ID,
          title: "Fallback Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId: CLAUDE_WORK, model: MODEL },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Fix login",
          modelSelection: { instanceId: CLAUDE_WORK, model: MODEL },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });

        yield* work.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              eventId: EventId.make("evt-limit-started"),
              provider: CLAUDE,
              createdAt: NOW,
              threadId: THREAD_ID,
              turnId: "fixture-turn",
            },
            {
              type: "runtime.warning",
              eventId: EventId.make("evt-limit-warning"),
              provider: CLAUDE,
              createdAt: NOW,
              threadId: THREAD_ID,
              turnId: "fixture-turn",
              payload: {
                message: "Usage limit reached.",
                usageLimit: { instanceId: CLAUDE_WORK, blocking: true, resetsAt: RESETS_AT },
              },
            },
          ],
        });
        // The continuation's first turn runs on the personal account.
        yield* personal.queueTurnResponseForNextSession({ events: [] });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("msg-user-1"),
            role: "user",
            text: "Fix the login redirect",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: NOW,
        });

        const original = yield* harness.waitForThread(
          THREAD_ID,
          (thread) => thread.fallback?.continuedToThreadId != null,
        );
        yield* harness.drainAccountFallback;
        yield* harness.drainProviderRuntime;

        const continuationId = original.fallback!.continuedToThreadId!;
        const continuation = yield* harness.waitForThread(continuationId, (thread) =>
          thread.messages.some((message) => message.role === "user"),
        );

        assert.equal(continuation.projectId, PROJECT_ID);
        assert.equal(continuation.modelSelection.instanceId, CLAUDE_PERSONAL);
        const firstUserMessage = continuation.messages.find((message) => message.role === "user");
        assert.include(firstUserMessage?.text ?? "", "## What the user asked");
        assert.include(firstUserMessage?.text ?? "", "Fix the login redirect");
        assert.equal(continuation.fallback?.continuedFromThreadId, THREAD_ID);
        assert.equal(original.fallback?.continuedToThreadId, continuation.id);
        assert.deepEqual(original.fallback?.triedInstanceIds, [CLAUDE_WORK]);
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("switches a limited Codex thread to an account sharing its home, in place", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({
      provider: CODEX,
      instanceIds: [CODEX_A, CODEX_B],
      // One CODEX_HOME behind both accounts: the conversation carries over.
      continuationKeys: { [CODEX_A]: SHARED_CODEX_HOME, [CODEX_B]: SHARED_CODEX_HOME },
      providers: [authenticated(CODEX_A, CODEX), authenticated(CODEX_B, CODEX)],
      serverSettings: {
        accountFallback: {
          chains: {
            [FallbackChainId.make("codex")]: {
              displayName: "Codex",
              instanceIds: [CODEX_A, CODEX_B],
            },
          },
        },
        accountFallbackChainId: FallbackChainId.make("codex"),
      },
      accountFallback: true,
    }),
    (harness) =>
      Effect.gen(function* () {
        const accountA = harness.instanceAdapterHarnesses.get(CODEX_A)!;
        const accountB = harness.instanceAdapterHarnesses.get(CODEX_B)!;

        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-create"),
          projectId: PROJECT_ID,
          title: "Fallback Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId: CODEX_A, model: CODEX_MODEL },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Fix login",
          modelSelection: { instanceId: CODEX_A, model: CODEX_MODEL },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });

        yield* accountA.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              eventId: EventId.make("evt-codex-limit-started"),
              provider: CODEX,
              createdAt: NOW,
              threadId: THREAD_ID,
              turnId: "fixture-turn",
            },
            {
              type: "runtime.error",
              eventId: EventId.make("evt-codex-limit-error"),
              provider: CODEX,
              createdAt: NOW,
              threadId: THREAD_ID,
              turnId: "fixture-turn",
              payload: {
                message: "You've hit your usage limit.",
                usageLimit: { instanceId: CODEX_A, blocking: true, resetsAt: RESETS_AT },
              },
            },
          ],
        });
        // The switched-in turn runs on account B, in the same thread.
        yield* accountB.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              eventId: EventId.make("evt-codex-b-started"),
              provider: CODEX,
              createdAt: NOW,
              threadId: THREAD_ID,
              turnId: "fixture-turn",
            },
            {
              type: "content.delta",
              eventId: EventId.make("evt-codex-b-delta"),
              provider: CODEX,
              createdAt: NOW,
              threadId: THREAD_ID,
              turnId: "fixture-turn",
              payload: { streamKind: "assistant_text", delta: "Picking up on account B." },
            },
          ],
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("msg-user-1"),
            role: "user",
            text: "Fix the login redirect",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: NOW,
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (thread) => (thread.fallback?.handoffTimes.length ?? 0) > 0,
        );
        yield* harness.drainAccountFallback;
        const thread = yield* harness.waitForThread(THREAD_ID, (candidate) =>
          candidate.messages.some(
            (message) => message.role === "assistant" && message.text.includes("account B"),
          ),
        );
        yield* harness.drainProviderRuntime;

        // Same thread, now on account B, with no continuation thread.
        assert.equal(thread.modelSelection.instanceId, CODEX_B);
        assert.equal(thread.fallback?.continuedToThreadId, null);
        assert.deepEqual(thread.fallback?.triedInstanceIds, [CODEX_A]);
        const userTexts = thread.messages
          .filter((message) => message.role === "user")
          .map((message) => message.text);
        assert.deepEqual(userTexts, [
          "Fix the login redirect",
          "You were interrupted by an account usage limit. Continue where you left off.",
        ]);
        // The next turn really ran on account B's adapter.
        assert.equal(accountB.getStartCount(), 1);
        const turnsOnB = yield* accountB.adapter.readThread(THREAD_ID);
        assert.equal(turnsOnB.turns.length, 1);
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);
