import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { FallbackWebhook } from "./webhook.ts";

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly contentType: string | undefined;
  readonly body: string;
}

const recordingClient = (requests: Array<Recorded>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          method: request.method,
          url: request.url,
          contentType: request.headers["content-type"],
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    ),
  );

const failingClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die(new Error("boom"))),
);

describe("FallbackWebhook", () => {
  it.effect("posts the text as text/plain once", () =>
    Effect.gen(function* () {
      const requests: Array<Recorded> = [];
      yield* Effect.gen(function* () {
        const webhook = yield* FallbackWebhook;
        yield* webhook.notify("https://hooks.example.test/x", "switched to codex");
      }).pipe(Effect.provide(FallbackWebhook.layer.pipe(Layer.provide(recordingClient(requests)))));
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]!.method, "POST");
      assert.strictEqual(requests[0]!.url, "https://hooks.example.test/x");
      assert.strictEqual(requests[0]!.body, "switched to codex");
      assert.isTrue(requests[0]!.contentType?.startsWith("text/plain") ?? false);
    }),
  );

  it.effect("sends nothing when the url is null", () =>
    Effect.gen(function* () {
      const requests: Array<Recorded> = [];
      yield* Effect.gen(function* () {
        const webhook = yield* FallbackWebhook;
        yield* webhook.notify(null, "ignored");
      }).pipe(Effect.provide(FallbackWebhook.layer.pipe(Layer.provide(recordingClient(requests)))));
      assert.strictEqual(requests.length, 0);
    }),
  );

  it.effect("resolves without error when the client fails", () =>
    Effect.gen(function* () {
      const webhook = yield* FallbackWebhook;
      yield* webhook.notify("https://hooks.example.test/x", "text");
    }).pipe(Effect.provide(FallbackWebhook.layer.pipe(Layer.provide(failingClient)))),
  );
});
