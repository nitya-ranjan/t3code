import {
  CommandId,
  EventId,
  FallbackChainId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type ThreadFallbackState,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

it.effect("projects thread fallback state from thread.fallback-updated", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-01T01:00:00.000Z";
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    expect(created.threads[0]?.fallback).toBeNull();

    const fallback: ThreadFallbackState = {
      chainId: FallbackChainId.make("chain-1"),
      status: "waiting",
      paused: false,
      resumeAt: "2026-01-01T05:00:00.000Z",
      waitingSince: later,
      candidateInstanceId: ProviderInstanceId.make("claude-a"),
      triedInstanceIds: [ProviderInstanceId.make("claude-a"), ProviderInstanceId.make("claude-b")],
      handoffTimes: [later],
      continuedToThreadId: null,
      continuedFromThreadId: ThreadId.make("thread-0"),
    };
    const updated = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.fallback-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          fallback,
          reason: "waiting",
          fromInstanceId: ProviderInstanceId.make("claude-b"),
          updatedAt: later,
        },
      }),
    );
    expect(updated.threads[0]?.fallback).toEqual(fallback);
  }),
);
