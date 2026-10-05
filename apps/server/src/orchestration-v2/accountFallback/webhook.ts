import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";

/** Host only: webhook URLs often embed secrets in the path or query. */
export function webhookLogTarget(url: string): string {
  return URL.canParse(url) ? new URL(url).host : "invalid-url";
}

function failureReason(cause: Cause.Cause<unknown>): string {
  if (Cause.hasDies(cause)) return "defect";
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (error === undefined) return "interrupt";
  const status = HttpClientError.isHttpClientError(error) ? error.response?.status : undefined;
  return status === undefined ? "error" : `status ${status}`;
}

/** Best-effort notification for account fallback events. Never fails. */
export class FallbackWebhook extends Context.Service<
  FallbackWebhook,
  {
    readonly notify: (url: string | null, text: string) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/accountFallback/webhook/FallbackWebhook") {
  static readonly layer = Layer.effect(
    FallbackWebhook,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      // A non-2xx answer (a 401 or 404 from ntfy, say) fails like a transport error.
      const client = httpClient.pipe(HttpClient.filterStatusOk);
      const notify = (url: string | null, text: string): Effect.Effect<void> => {
        if (url === null) return Effect.void;
        return client
          .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText(text, "text/plain")))
          .pipe(
            Effect.asVoid,
            Effect.timeout("5 seconds"),
            Effect.catchCause((cause) =>
              Effect.logWarning("Account fallback webhook failed", {
                host: webhookLogTarget(url),
                // The raw cause can embed the request URL, so log only its shape.
                reason: failureReason(cause),
              }),
            ),
          );
      };
      return FallbackWebhook.of({ notify });
    }),
  );
}
