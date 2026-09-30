import {
  CommandId,
  FallbackChainId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadFallbackState,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";
const RESUME_AT = "2026-01-01T05:00:00.000Z";

const IDLE_STATE: ThreadFallbackState = {
  chainId: FallbackChainId.make("chain-1"),
  status: "idle",
  paused: false,
  resumeAt: null,
  waitingSince: null,
  candidateInstanceId: null,
  triedInstanceIds: [ProviderInstanceId.make("claude-a")],
  handoffTimes: [],
  continuedToThreadId: null,
  continuedFromThreadId: null,
};

const WAITING_STATE: ThreadFallbackState = {
  ...IDLE_STATE,
  status: "waiting",
  resumeAt: RESUME_AT,
  waitingSince: NOW,
  candidateInstanceId: ProviderInstanceId.make("claude-a"),
};

function makeReadModel(input: {
  readonly fallback?: ThreadFallbackState | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        fallback: input.fallback ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const events = (event: Effect.Success<ReturnType<typeof decideOrchestrationCommand>>) =>
  Array.isArray(event) ? event : [event];

it.layer(NodeServices.layer)("thread fallback decider", (it) => {
  it.effect("emits the new fallback state for an internal update", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.fallback.update",
            commandId: CommandId.make("cmd-update"),
            threadId: ThreadId.make("thread-1"),
            fallback: WAITING_STATE,
            reason: "waiting",
            fromInstanceId: ProviderInstanceId.make("claude-a"),
            createdAt: LATER,
          },
          readModel: makeReadModel({}),
        }),
      );
      expect(event?.type).toBe("thread.fallback-updated");
      if (event?.type === "thread.fallback-updated") {
        expect(event.payload.threadId).toBe("thread-1");
        expect(event.payload.fallback).toEqual(WAITING_STATE);
        expect(event.payload.reason).toBe("waiting");
        expect(event.payload.fromInstanceId).toBe("claude-a");
        expect(event.payload.toInstanceId).toBeUndefined();
        expect(event.payload.updatedAt).toBe(LATER);
        expect(event.occurredAt).toBe(LATER);
      }
    }),
  );

  it.effect("pauses fallback on a thread that has fallback state", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.fallback.set-paused",
            commandId: CommandId.make("cmd-pause"),
            threadId: ThreadId.make("thread-1"),
            paused: true,
            createdAt: LATER,
          },
          readModel: makeReadModel({ fallback: IDLE_STATE }),
        }),
      );
      expect(event?.type).toBe("thread.fallback-updated");
      if (event?.type === "thread.fallback-updated") {
        expect(event.payload.fallback).toEqual({ ...IDLE_STATE, paused: true });
        expect(event.payload.reason).toBe("paused");
      }
    }),
  );

  it.effect("unpauses fallback with reason unpaused", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.fallback.set-paused",
            commandId: CommandId.make("cmd-unpause"),
            threadId: ThreadId.make("thread-1"),
            paused: false,
            createdAt: LATER,
          },
          readModel: makeReadModel({ fallback: { ...IDLE_STATE, paused: true } }),
        }),
      );
      expect(event?.type).toBe("thread.fallback-updated");
      if (event?.type === "thread.fallback-updated") {
        expect(event.payload.fallback.paused).toBe(false);
        expect(event.payload.reason).toBe("unpaused");
      }
    }),
  );

  it.effect("keeps the recorded pause when an internal update carries a stale one", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.fallback.update",
            commandId: CommandId.make("cmd-update-stale"),
            threadId: ThreadId.make("thread-1"),
            fallback: { ...WAITING_STATE, paused: false },
            reason: "waiting",
            createdAt: LATER,
          },
          readModel: makeReadModel({ fallback: { ...IDLE_STATE, paused: true } }),
        }),
      );
      expect(event?.type).toBe("thread.fallback-updated");
      if (event?.type === "thread.fallback-updated") {
        expect(event.payload.fallback).toEqual({ ...WAITING_STATE, paused: true });
      }
    }),
  );

  it.effect("takes the pause from an internal update whose reason is a pause change", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.fallback.update",
            commandId: CommandId.make("cmd-update-unpause"),
            threadId: ThreadId.make("thread-1"),
            fallback: { ...IDLE_STATE, paused: false },
            reason: "unpaused",
            createdAt: LATER,
          },
          readModel: makeReadModel({ fallback: { ...IDLE_STATE, paused: true } }),
        }),
      );
      if (event?.type === "thread.fallback-updated") {
        expect(event.payload.fallback.paused).toBe(false);
      } else {
        expect.fail("expected thread.fallback-updated");
      }
    }),
  );

  it.effect("pauses a thread with no fallback state yet when given its chain", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.fallback.set-paused",
            commandId: CommandId.make("cmd-pause-fresh"),
            threadId: ThreadId.make("thread-1"),
            paused: true,
            chainId: FallbackChainId.make("chain-2"),
            createdAt: LATER,
          },
          readModel: makeReadModel({ fallback: null }),
        }),
      );
      if (event?.type === "thread.fallback-updated") {
        expect(event.payload.fallback).toEqual({
          chainId: "chain-2",
          status: "idle",
          paused: true,
          resumeAt: null,
          waitingSince: null,
          candidateInstanceId: null,
          triedInstanceIds: [],
          handoffTimes: [],
          continuedToThreadId: null,
          continuedFromThreadId: null,
        });
        expect(event.payload.reason).toBe("paused");
      } else {
        expect.fail("expected thread.fallback-updated");
      }
    }),
  );

  it.effect("keeps existing state's chain when pausing with a chain id", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.fallback.set-paused",
            commandId: CommandId.make("cmd-pause-existing"),
            threadId: ThreadId.make("thread-1"),
            paused: true,
            chainId: FallbackChainId.make("chain-2"),
            createdAt: LATER,
          },
          readModel: makeReadModel({ fallback: IDLE_STATE }),
        }),
      );
      if (event?.type === "thread.fallback-updated") {
        expect(event.payload.fallback).toEqual({ ...IDLE_STATE, paused: true });
      } else {
        expect.fail("expected thread.fallback-updated");
      }
    }),
  );

  it.effect("rejects pausing a thread without fallback state", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.fallback.set-paused",
            commandId: CommandId.make("cmd-pause-none"),
            threadId: ThreadId.make("thread-1"),
            paused: true,
            createdAt: LATER,
          },
          readModel: makeReadModel({ fallback: null }),
        }),
      );
      expect(error).toBeInstanceOf(OrchestrationCommandInvariantError);
    }),
  );

  it.effect("cancels a wait back to idle", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.fallback.cancel-wait",
            commandId: CommandId.make("cmd-cancel"),
            threadId: ThreadId.make("thread-1"),
            createdAt: LATER,
          },
          readModel: makeReadModel({
            fallback: { ...WAITING_STATE, waitReason: "handoff-cap" },
          }),
        }),
      );
      expect(event?.type).toBe("thread.fallback-updated");
      if (event?.type === "thread.fallback-updated") {
        expect(event.payload.fallback).toEqual({
          ...WAITING_STATE,
          status: "idle",
          resumeAt: null,
          waitingSince: null,
          candidateInstanceId: null,
        });
        expect(event.payload.fallback.status).toBe("idle");
        expect(event.payload.fallback.resumeAt).toBeNull();
        expect(event.payload.reason).toBe("cancelled");
      }
    }),
  );

  it.effect("rejects cancel-wait when the thread is not waiting", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.fallback.cancel-wait",
            commandId: CommandId.make("cmd-cancel-idle"),
            threadId: ThreadId.make("thread-1"),
            createdAt: LATER,
          },
          readModel: makeReadModel({ fallback: IDLE_STATE }),
        }),
      );
      expect(error).toBeInstanceOf(OrchestrationCommandInvariantError);
    }),
  );

  it.effect("rejects cancel-wait when the thread has no fallback state", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.fallback.cancel-wait",
            commandId: CommandId.make("cmd-cancel-none"),
            threadId: ThreadId.make("thread-1"),
            createdAt: LATER,
          },
          readModel: makeReadModel({ fallback: null }),
        }),
      );
      expect(error).toBeInstanceOf(OrchestrationCommandInvariantError);
    }),
  );
});
