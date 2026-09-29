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

const authenticatedClaude = (instanceId: ProviderInstanceId): ServerProvider => ({
  instanceId,
  driver: CLAUDE,
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
      providers: [authenticatedClaude(CLAUDE_WORK), authenticatedClaude(CLAUDE_PERSONAL)],
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
