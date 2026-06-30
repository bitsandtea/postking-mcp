import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";

/**
 * Billing tools — credit top-ups + subscription.
 *
 * Canonical agent flow (see `provision-and-pay` skill):
 *   One-off:      billing_list_packs → billing_topup → synchronous charge on card on file → announce receipt (done, no poll)
 *   Subscription: billing_list_tiers → billing_subscribe → (human/Link) → billing_wallet (verify credits)
 */

export function registerBillingTools(server: McpServer) {
  // ── billing_list_packs ───────────────────────────────────────────────────────
  server.tool(
    "billing_list_packs",
    [
      "List available credit packs for one-off top-ups.",
      "Returns all packs with their SKU, price in USD, and credit amount.",
      "Call this tool first to show the user their options, then ask which pack they want.",
      "Only after the user explicitly chooses a pack, call billing_topup with that packSku.",
    ].join(" "),
    {},
    async () => {
      const data = await api.get<unknown>("/api/agent/v1/billing/packs");
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── billing_topup ────────────────────────────────────────────────────────────
  server.tool(
    "billing_topup",
    [
      "Top up credits by charging the account's card on file (Stripe off-session). Prefers the headless path — no checkout link required.",
      "IMPORTANT: Only call this tool after the USER has explicitly chosen a specific pack — it triggers a real charge.",
      "To show the user their options first, call billing_list_packs and present the results; do NOT pick a pack on the user's behalf.",
      "The response is ONE OF two shapes:",
      "(1) Headless success (default when a card is on file): { status: 'paid', paymentIntentId, amountUsd, credits, balance, packSku, cardLast4/receiptUrl when available }.",
      "When you receive status === 'paid', the payment has already completed and the credits are in the wallet NOW.",
      "Announce to the user: payment ID, last-4 card digits, credits added, and new balance. You are DONE — do NOT call billing_wallet to poll.",
      "(2) Checkout fallback (only when there is no card on file): { checkoutUrl, sessionId, amountUsd, credits, packSku }.",
      "When you receive checkoutUrl, hand that link to the user so they can complete payment in their browser.",
      "Valid skus: agent_4 ($4 / 160 credits), agent_5 ($5 / 220 credits), agent_25 ($25 / 1200 credits), agent_50 ($50 / 2600 credits).",
    ].join(" "),
    {
      packSku: z
        .enum(["agent_4", "agent_5", "agent_25", "agent_50"])
        .describe("Credit pack SKU to purchase. One of: agent_4, agent_5, agent_25, agent_50."),
    },
    async ({ packSku }) => {
      const data = await api.post<unknown>("/api/agent/v1/billing/topup", { packSku });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── billing_wallet ───────────────────────────────────────────────────────────
  server.tool(
    "billing_wallet",
    [
      "Fetch the user's credit balance and recent usage entries.",
      "Returns { credits, recent } where recent is the last ~10 usage rows.",
      "Poll this to confirm a top-up landed ONLY after a billing_topup CHECKOUT result (one that returned a checkoutUrl), until credits rise.",
      "Do NOT poll after a status:'paid' headless top-up — those credits are already applied and the new balance is in the topup response.",
    ].join(" "),
    {},
    async () => {
      const data = await api.get<unknown>("/api/agent/v1/billing/wallet");
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── billing_list_tiers ───────────────────────────────────────────────────────
  server.tool(
    "billing_list_tiers",
    [
      "List available PostKing subscription tiers (GROWTH, PRO, ENTERPRISE).",
      "Returns each tier's name, price in USD, monthly credits, and billing interval options.",
      "Use billing_subscribe to create a subscription Checkout session for a chosen tier.",
    ].join(" "),
    {},
    async () => {
      const data = await api.get<unknown>("/api/agent/v1/billing/tiers");
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── billing_subscribe ────────────────────────────────────────────────────────
  server.tool(
    "billing_subscribe",
    [
      "Create a Stripe Checkout session for a PostKing subscription.",
      "Returns { checkoutUrl, sessionId, tier, interval, amountUsd }.",
      "Subscription credits refill User.credits each billing period.",
      "The subscription Checkout is best completed by a human; the Link virtual card covers the first invoice only (renewals need a durable payment method).",
    ].join(" "),
    {
      tier: z
        .enum(["GROWTH", "PRO", "ENTERPRISE"])
        .describe("Subscription tier. One of: GROWTH, PRO, ENTERPRISE."),
      interval: z
        .enum(["month", "year"])
        .default("month")
        .describe('Billing interval: "month" (default) or "year".'),
    },
    async ({ tier, interval }) => {
      const data = await api.post<unknown>("/api/agent/v1/billing/subscribe", { tier, interval });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );
}
