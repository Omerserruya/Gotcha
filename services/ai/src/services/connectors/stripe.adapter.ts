/**
 * Stripe adapter - production-grade.
 *
 * Auth: Stripe Connect (OAuth) preferred; API key fallback supported by
 * accepting `secret_key` in credentials. Tokens come from /oauth/token
 * (`refresh_token` flow) for Connect; restricted keys never expire.
 *
 * Tools (highest-frequency real-world usage based on Stripe's docs +
 * commerce bot use-cases):
 *   - stripe.create_payment_link  - generate a checkout URL for a price
 *   - stripe.refund_payment       - refund a charge or PaymentIntent
 *   - stripe.get_customer         - look up by id or email
 *   - stripe.list_transactions    - recent charges for a customer
 *   - stripe.create_invoice       - issue an invoice (Connect or platform)
 *
 * Idempotency: every write call sends an `Idempotency-Key` header derived
 * from (tenantId, conversationId, toolName, args). Stripe enforces idempotency
 * server-side for 24h, so retries within that window are safe.
 *
 * Rate limit posture: caller-side. Stripe permits 100 req/s on live keys
 * and we don't approach that with single-shot bot turns.
 */

import {
  registerAdapter,
  type ProviderAdapter,
  type ToolDefinition,
  idempotencyKey,
} from "./integration-framework";
import { stripeVersionHeader } from "@chatcenter/shared";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_OAUTH_TOKEN = "https://connect.stripe.com/oauth/token";

const TOOLS: ToolDefinition[] = [
  {
    name: "stripe.create_payment_link",
    description: "Create a Stripe Payment Link for a price. Returns a hosted checkout URL.",
    whenToUse: "Customer wants to pay; you have a Price id (or amount + currency for an inline product).",
    whenNotToUse: "Customer hasn't agreed to a price yet OR you don't have a Stripe Price/Product id.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Creates a public payment link the customer can use immediately.",
    idempotencyNotes: "Uses Idempotency-Key derived from args - safe to retry.",
    parameters: {
      type: "object",
      properties: {
        price_id: { type: "string", description: "Stripe Price id (price_…) - preferred path." },
        amount: { type: "number", description: "Inline amount in MINOR units (e.g. cents). Used only if price_id is omitted." },
        currency: { type: "string", description: "ISO 4217 currency (USD, EUR, ILS…). Required if amount is set." },
        description: { type: "string", description: "Item description (used when creating an inline product)." },
        quantity: { type: "number", description: "Default 1." },
      },
    },
  },
  {
    name: "stripe.refund_payment",
    description: "Refund a Stripe charge or PaymentIntent (full or partial).",
    whenToUse: "Customer is approved for a refund - either by policy or human approval.",
    whenNotToUse: "Customer is just inquiring about refund eligibility - DO NOT refund speculatively.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Issues a real refund - irreversible in 24h after capture.",
    idempotencyNotes: "Uses Idempotency-Key derived from args. Same (charge_id, amount) → no duplicate refund.",
    parameters: {
      type: "object",
      properties: {
        charge_id: { type: "string", description: "ch_… or pi_… id to refund." },
        amount: { type: "number", description: "Optional partial-refund amount in minor units. Omit for a full refund." },
        reason: {
          type: "string",
          enum: ["duplicate", "fraudulent", "requested_by_customer"],
          description: "Stripe refund reason.",
        },
      },
      required: ["charge_id"],
    },
  },
  {
    name: "stripe.get_customer",
    description: "Look up a Stripe Customer by id or email.",
    whenToUse: "You need account standing, default payment method, or recent invoices for a customer.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "cus_… id (preferred when known)." },
        email: { type: "string", description: "Email - fallback lookup. May return multiple matches; first is returned." },
      },
    },
  },
  {
    name: "stripe.list_transactions",
    description: "List a customer's recent successful charges.",
    whenToUse: "Customer asks about their last payment, or you need transaction history for refund/dispute context.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "cus_… id" },
        limit: { type: "number", description: "Default 10, max 100." },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "stripe.create_invoice",
    description: "Create a draft invoice for a customer with one line item, then finalize it.",
    whenToUse: "Customer agreed to a billable amount that should be sent as an invoice (rather than a payment link).",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Creates a finalized invoice with the customer notified by email.",
    idempotencyNotes: "Uses Idempotency-Key derived from args - re-runs are no-ops.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "cus_… id." },
        amount: { type: "number", description: "Amount in minor units." },
        currency: { type: "string", description: "ISO 4217 currency." },
        description: { type: "string", description: "Line item description." },
        days_until_due: { type: "number", description: "Default 30." },
      },
      required: ["customer_id", "amount", "currency", "description"],
    },
  },
];

const StripeAdapter: ProviderAdapter = {
  slug: "stripe",
  tools: () => TOOLS,

  async refreshTokens(creds) {
    if (!creds.refreshToken) throw new Error("no_refresh_token");
    const clientId = process.env.STRIPE_CLIENT_ID;
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!clientId || !secret) throw new Error("STRIPE_CLIENT_ID/SECRET_KEY not configured");
    const res = await fetch(STRIPE_OAUTH_TOKEN, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${secret}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
      }).toString(),
    });
    if (!res.ok) throw new Error(`stripe_refresh_${res.status}`);
    const j: any = await res.json();
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || creds.refreshToken,
      scope: j.scope,
      expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : undefined,
    };
  },

  async execute({ ctx, toolName, args, credentials }) {
    // Stripe accepts either a Connect access token (acct_xxx) OR a platform
    // API key. We prefer access_token if present, else fall back to api_key.
    const bearer = credentials.accessToken || credentials.api_key || credentials.apiKey;
    if (!bearer) throw new Error("no_stripe_credentials");

    const idemKey = idempotencyKey({
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      toolName,
      args,
    });

    switch (toolName) {
      case "create_payment_link":
        return await stripeCreatePaymentLink(bearer, args, idemKey);
      case "refund_payment":
        return await stripeRefund(bearer, args, idemKey);
      case "get_customer":
        return await stripeGetCustomer(bearer, args);
      case "list_transactions":
        return await stripeListTransactions(bearer, args);
      case "create_invoice":
        return await stripeCreateInvoice(bearer, args, idemKey);
      default:
        throw new Error(`unknown_stripe_tool:${toolName}`);
    }
  },
};

// ─── Tool implementations ────────────────────────────────────

async function stripeCreatePaymentLink(bearer: string, args: any, idemKey: string) {
  let priceId = args.price_id as string | undefined;
  if (!priceId) {
    if (!args.amount || !args.currency) throw new Error("price_id_or_amount_currency_required");
    // Inline product → price → payment link.
    const product: any = await stripeRequest(bearer, "POST", "/products", {
      name: args.description || "ChatCenter charge",
    }, idemKey + "_p");
    const price: any = await stripeRequest(bearer, "POST", "/prices", {
      currency: String(args.currency).toLowerCase(),
      unit_amount: String(args.amount),
      product: product.id,
    }, idemKey + "_pr");
    priceId = price.id;
  }
  const link: any = await stripeRequest(bearer, "POST", "/payment_links", {
    "line_items[0][price]": priceId!,
    "line_items[0][quantity]": String(args.quantity || 1),
  }, idemKey);
  return { id: link.id, url: link.url, active: link.active };
}

async function stripeRefund(bearer: string, args: any, idemKey: string) {
  const body: Record<string, string> = { charge: args.charge_id };
  if (args.amount) body.amount = String(args.amount);
  if (args.reason) body.reason = args.reason;
  const r: any = await stripeRequest(bearer, "POST", "/refunds", body, idemKey);
  return { id: r.id, status: r.status, amount: r.amount, currency: r.currency };
}

async function stripeGetCustomer(bearer: string, args: any) {
  if (args.customer_id) {
    return await stripeRequest(bearer, "GET", `/customers/${encodeURIComponent(args.customer_id)}`);
  }
  if (args.email) {
    const list: any = await stripeRequest(bearer, "GET", `/customers?email=${encodeURIComponent(args.email)}&limit=1`);
    return list.data?.[0] ?? null;
  }
  throw new Error("customer_id_or_email_required");
}

async function stripeListTransactions(bearer: string, args: any) {
  const limit = Math.min(100, Number(args.limit ?? 10));
  const list: any = await stripeRequest(
    bearer,
    "GET",
    `/charges?customer=${encodeURIComponent(args.customer_id)}&limit=${limit}`,
  );
  return (list.data || []).map((c: any) => ({
    id: c.id,
    amount: c.amount,
    currency: c.currency,
    status: c.status,
    created: c.created,
    payment_intent: c.payment_intent,
    description: c.description,
  }));
}

async function stripeCreateInvoice(bearer: string, args: any, idemKey: string) {
  await stripeRequest(bearer, "POST", "/invoiceitems", {
    customer: args.customer_id,
    amount: String(args.amount),
    currency: String(args.currency).toLowerCase(),
    description: args.description,
  }, idemKey + "_ii");
  const invoice: any = await stripeRequest(bearer, "POST", "/invoices", {
    customer: args.customer_id,
    days_until_due: String(args.days_until_due ?? 30),
    collection_method: "send_invoice",
  }, idemKey + "_inv");
  const finalized: any = await stripeRequest(bearer, "POST", `/invoices/${invoice.id}/finalize`, {}, idemKey + "_fin");
  return {
    id: finalized.id,
    status: finalized.status,
    hosted_invoice_url: finalized.hosted_invoice_url,
    invoice_pdf: finalized.invoice_pdf,
  };
}

// ─── HTTP helper ─────────────────────────────────────────────

async function stripeRequest(
  bearer: string,
  method: string,
  path: string,
  body?: Record<string, string>,
  idemKey?: string,
): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      // Pinned in code. Without this header Stripe uses the ACCOUNT's dashboard
      // default, so the contract would be set in a web console rather than here
      // — invisible to review and changeable with no deploy. Stripe's own
      // guidance is to specify the version you integrate against.
      ...stripeVersionHeader(),
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idemKey ? { "Idempotency-Key": idemKey } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  };
  const res = await fetch(`${STRIPE_API}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`stripe_${res.status}: ${text.slice(0, 240)}`);
  }
  return await res.json();
}

registerAdapter(StripeAdapter);
export default StripeAdapter;
