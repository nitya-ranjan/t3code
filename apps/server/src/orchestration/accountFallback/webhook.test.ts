import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { FallbackWebhook, webhookLogTarget } from "./webhook.ts";

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

const statusClient = (status: number) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status }))),
    ),
  );

/** Collects every log line's message and annotations-free payload as text. */
const capturingLogger = (lines: Array<string>) =>
  Logger.layer([Logger.make(({ message }) => lines.push(JSON.stringify(message)))], {
    mergeWithExisting: false,
  });

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

  it.effect("logs a non-2xx response with the host and status only", () =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      yield* Effect.gen(function* () {
        const webhook = yield* FallbackWebhook;
        yield* webhook.notify("https://hooks.example.test/SECRET?token=abc", "text");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            FallbackWebhook.layer.pipe(Layer.provide(statusClient(404))),
            capturingLogger(lines),
          ),
        ),
      );
      assert.strictEqual(lines.length, 1);
      assert.include(lines[0]!, "Account fallback webhook failed");
      assert.include(lines[0]!, "hooks.example.test");
      assert.include(lines[0]!, "status 404");
      assert.notInclude(lines[0]!, "SECRET");
      assert.notInclude(lines[0]!, "token");
    }),
  );

  it.effect("logs nothing for a 2xx response", () =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      yield* Effect.gen(function* () {
        const webhook = yield* FallbackWebhook;
        yield* webhook.notify("https://hooks.example.test/x", "text");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            FallbackWebhook.layer.pipe(Layer.provide(statusClient(204))),
            capturingLogger(lines),
          ),
        ),
      );
      assert.deepStrictEqual(lines, []);
    }),
  );

  it.effect("resolves without error when the client fails", () =>
    Effect.gen(function* () {
      const webhook = yield* FallbackWebhook;
      yield* webhook.notify("https://hooks.example.test/x", "text");
    }).pipe(Effect.provide(FallbackWebhook.layer.pipe(Layer.provide(failingClient)))),
  );
});

describe("webhookLogTarget", () => {
  it("keeps only the host, never the path or query", () => {
    assert.strictEqual(
      webhookLogTarget("https://hooks.example.test:8443/services/SECRET?token=abc"),
      "hooks.example.test:8443",
    );
  });
  it("falls back for unparseable urls without throwing", () => {
    assert.strictEqual(webhookLogTarget("not a url/SECRET"), "invalid-url");
  });
});
