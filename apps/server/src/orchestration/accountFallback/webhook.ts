import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

/** Host only: webhook URLs often embed secrets in the path or query. */
export function webhookLogTarget(url: string): string {
  return URL.canParse(url) ? new URL(url).host : "invalid-url";
}

/** Best-effort notification for account fallback events. Never fails. */
export class FallbackWebhook extends Context.Service<
  FallbackWebhook,
  {
    readonly notify: (url: string | null, text: string) => Effect.Effect<void>;
  }
>()("t3/orchestration/accountFallback/webhook/FallbackWebhook") {
  static readonly layer = Layer.effect(
    FallbackWebhook,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const notify = (url: string | null, text: string): Effect.Effect<void> => {
        if (url === null) return Effect.void;
        return httpClient
          .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText(text, "text/plain")))
          .pipe(
            Effect.asVoid,
            Effect.timeout("5 seconds"),
            Effect.catchCause((cause) =>
              Effect.logWarning("Account fallback webhook failed", {
                host: webhookLogTarget(url),
                // The raw cause can embed the request URL, so log only its shape.
                reason: Cause.hasDies(cause)
                  ? "defect"
                  : Cause.hasFails(cause)
                    ? "error"
                    : "interrupt",
              }),
            ),
          );
      };
      return FallbackWebhook.of({ notify });
    }),
  );
}
