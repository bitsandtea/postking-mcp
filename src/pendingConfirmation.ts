/**
 * Email-confirmed deletes.
 *
 * The server answers 202 `{ status: "pending_email_confirmation", ... }` to a
 * destructive call made with an API key / OAuth token: NOTHING was deleted
 * yet; the account owner must click the emailed link. That is a success, not
 * an error, and must never be retried (a retry just dedupes server-side).
 *
 * `client.ts` throws `PendingEmailConfirmation` for that 202 and the central
 * tool wrapper in `server.ts` turns it into a normal tool result, so none of
 * the delete tools need their own handling.
 */

export interface PendingActionAccepted {
  status: "pending_email_confirmation";
  pendingActionId: string;
  expiresAt: string;
  message: string;
}

export class PendingEmailConfirmation extends Error {
  readonly pending: PendingActionAccepted;
  constructor(pending: PendingActionAccepted) {
    super(pending.message);
    this.name = "PendingEmailConfirmation";
    this.pending = pending;
  }
}

export function isPendingAccepted(data: unknown): data is PendingActionAccepted {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { status?: unknown }).status === "pending_email_confirmation" &&
    typeof (data as { pendingActionId?: unknown }).pendingActionId === "string"
  );
}

/** Tool result text for the agent. Not an error. */
export function pendingToolText(p: PendingActionAccepted): string {
  return [
    "Check your email to confirm; nothing was deleted yet.",
    p.message,
    `pendingActionId: ${p.pendingActionId}`,
    `expiresAt: ${p.expiresAt}`,
    "Do not retry this delete. Tell the user to click the link in the email, then call get_pending_action to see the outcome.",
  ].join("\n");
}

/** Tools whose server route is email-confirmed for API-key callers (whole landing page; there is no MCP tool for brand delete). */
export const EMAIL_CONFIRMED_DELETE_TOOLS = new Set(["delete_landing_page"]);

export const EMAIL_CONFIRMED_DESCRIPTION_SUFFIX =
  " Needs email confirmation: this call does NOT delete yet. It emails the account owner a confirm link and returns status pending_email_confirmation (with a pendingActionId). The delete runs only after the link is clicked. Do not retry; use get_pending_action to check the outcome.";
