import { ApiError } from "./client.js";

/**
 * Shared handling for the cannibalization-guard 409 that `seo_write_article`
 * and `generate_blog_post` can now return (docs/124-cannibalization-guard in
 * the main PostKing repo). The server converts a blocked write into a 409
 * with `err.details.cannibalizationGuard` populated with the full
 * `CannibalizationGuardOutcome` — surface that as actionable plain-text
 * guidance instead of letting a generic error propagate, mirroring the
 * `isConcurrentModification`/`concurrentModificationResult` pattern in
 * `src/tools/blocks.ts` and the `already_running` 409 handling in
 * `src/tools/audience.ts`.
 *
 * This must stay narrow: only a 409 carrying `details.cannibalizationGuard`
 * is special-cased here. Any other 409 (e.g. `already_running`,
 * optimistic-concurrency conflicts) is unaffected and continues to be
 * handled — or rethrown — by the caller.
 */
export function isCannibalizationGuardError(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    err.details != null &&
    typeof err.details === "object" &&
    "cannibalizationGuard" in err.details &&
    (err.details as Record<string, unknown>).cannibalizationGuard != null
  );
}

export function cannibalizationGuardResult(err: ApiError) {
  const guard = (err.details as Record<string, unknown>).cannibalizationGuard;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: "cannibalization_guard",
            message: err.message,
            cannibalizationGuard: guard,
            instruction:
              "This write was BLOCKED by the cannibalization guard — no article was created. " +
              "If cannibalizationGuard.decision is 'refresh', call refresh_blog_article with " +
              "cannibalizationGuard.targetArticleId as `blogId` instead of writing a new article. " +
              "If cannibalizationGuard.decision is 'blocked', an in-flight brief already covers this " +
              "keyword (see cannibalizationGuard.conflictingBriefId) — wait for it to resolve, do not " +
              "force. Only retry with forceCannibalization: true when the USER has explicitly said they " +
              "want a duplicate/second article anyway — never decide this on your own initiative.",
          },
          null,
          2
        ),
      },
    ],
  };
}
