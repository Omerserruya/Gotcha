/**
 * Square adapter — production-grade.
 *
 * Auth: Square OAuth (Authorization Code grant). Tenants connect their
 * Square account. Tokens last 30 days; we refresh via /oauth2/token.
 * `config.environment` toggles production vs. sandbox.
 *
 *   credentials = { accessToken, refreshToken, expiresAt, merchantId }
 *   config       = { environment: "production"|"sandbox", locationId? }
 *
 * Tools (top patterns for commerce + support):
 *   - square.search_customers      — by email/phone/name
 *   - square.create_customer       — add to address book
 *   - square.list_payments         — recent payments (filter by date/customer)
 *   - square.refund_payment        — refund a payment (full/partial)
 *   - square.create_payment_link   — Checkout Payment Link
 *   - square.list_orders           — recent orders for a location
 */

import {
  registerAdapter,
  persistCredentials,
  type ProviderAdapter,
  type ToolDefinition,
  idempotencyKey,
} from "./integration-framework";

const PROD_BASE = "https://connect.squareup.com";
const SANDBOX_BASE = "https://connect.squareupsandbox.com";

const TOOLS: ToolDefinition[] = [
  {
    name: "square.search_customers",
    description: "Search Square customers by email/phone/name.",
    whenToUse: "Identifying a customer with partial info.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string" },
        phone: { type: "string" },
        limit: { type: "number", description: "Default 10, max 100." },
      },
    },
  },
  {
    name: "square.create_customer",
    description: "Create a Square customer record.",
    whenToUse: "New lead/customer captured during conversation.",
    category: "WRITE",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string" },
        phone: { type: "string" },
        given_name: { type: "string" },
        family_name: { type: "string" },
        company: { type: "string" },
      },
      required: ["email"],
    },
  },
  {
    name: "square.list_payments",
    description: "List recent Square payments, optionally filtered by date or customer.",
    whenToUse: "Customer asks about recent payments or you need transaction context.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        begin_time_iso: { type: "string", description: "ISO datetime — default 30 days ago." },
        end_time_iso: { type: "string" },
        limit: { type: "number", description: "Default 20, max 100." },
      },
    },
  },
  {
    name: "square.refund_payment",
    description: "Refund a Square payment (full or partial).",
    whenToUse: "Customer is approved for a refund.",
    whenNotToUse: "Speculative refunds — confirm policy first.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Issues a real refund — irreversible.",
    idempotencyNotes: "idempotency_key derived from args — safe to retry.",
    parameters: {
      type: "object",
      properties: {
        payment_id: { type: "string" },
        amount: { type: "number", description: "Refund amount in MINOR units (cents). Omit for full." },
        currency: { type: "string", description: "Required if amount is set (e.g. USD)." },
        reason: { type: "string", description: "Free-text reason." },
      },
      required: ["payment_id"],
    },
  },
  {
    name: "square.create_payment_link",
    description: "Create a Square Checkout Payment Link returning a hosted checkout URL.",
    whenToUse: "Customer wants to pay via a checkout URL.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Creates a public payment link.",
    idempotencyNotes: "Uses idempotency_key derived from args.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount in MINOR units (cents)." },
        currency: { type: "string", description: "ISO 4217 (USD/EUR/ILS…)." },
        description: { type: "string" },
        redirect_url: { type: "string" },
      },
      required: ["amount", "currency"],
    },
  },
  {
    name: "square.list_orders",
    description: "List recent Square orders for the configured location.",
    whenToUse: "Customer asks about an order.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        location_id: { type: "string", description: "Override the configured default location." },
        limit: { type: "number", description: "Default 20, max 500." },
      },
    },
  },
];

const SquareAdapter: ProviderAdapter = {
  slug: "square",
  tools: () => TOOLS,

  async refreshTokens(creds) {
    const env = creds.environment === "production" ? "production" : "sandbox";
    const base = env === "production" ? PROD_BASE : SANDBOX_BASE;
    const clientId = process.env.SQUARE_APPLICATION_ID;
    const clientSecret = process.env.SQUARE_APPLICATION_SECRET;
    if (!clientId || !clientSecret) throw new Error("SQUARE_APPLICATION_ID/SECRET not configured");
    if (!creds.refreshToken) throw new Error("no_refresh_token");
    const res = await fetch(`${base}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Square-Version": "2024-08-21" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`square_refresh_${res.status}`);
    const j: any = await res.json();
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || creds.refreshToken,
      expiresAt: j.expires_at ? new Date(j.expires_at) : undefined,
    };
  },

  async execute({ ctx, toolName, args, credentials, config }) {
    const env = (config.environment || credentials.environment) === "production" ? "production" : "sandbox";
    const base = env === "production" ? PROD_BASE : SANDBOX_BASE;
    const token = credentials.accessToken;
    if (!token) throw new Error("no_access_token");

    const idemKey = idempotencyKey({
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      toolName,
      args,
    });

    switch (toolName) {
      case "search_customers": {
        const filter: any = {};
        if (args.email) filter.email_address = { exact: String(args.email) };
        if (args.phone) filter.phone_number = { exact: String(args.phone) };
        const limit = Math.min(100, Number(args.limit ?? 10));
        const r: any = await sqRequest(token, base, "POST", "/v2/customers/search", {
          query: { filter },
          limit,
        });
        return r.customers || [];
      }
      case "create_customer": {
        const r: any = await sqRequest(token, base, "POST", "/v2/customers", {
          idempotency_key: idemKey,
          given_name: args.given_name,
          family_name: args.family_name,
          email_address: String(args.email),
          phone_number: args.phone,
          company_name: args.company,
        });
        return r.customer;
      }
      case "list_payments": {
        const params = new URLSearchParams();
        params.set("limit", String(Math.min(100, Number(args.limit ?? 20))));
        if (args.begin_time_iso) params.set("begin_time", String(args.begin_time_iso));
        if (args.end_time_iso) params.set("end_time", String(args.end_time_iso));
        const r: any = await sqRequest(token, base, "GET", `/v2/payments?${params}`);
        return r.payments || [];
      }
      case "refund_payment": {
        const body: any = {
          idempotency_key: idemKey,
          payment_id: String(args.payment_id),
        };
        if (args.amount && args.currency) {
          body.amount_money = { amount: Math.round(Number(args.amount)), currency: String(args.currency).toUpperCase() };
        }
        if (args.reason) body.reason = String(args.reason);
        const r: any = await sqRequest(token, base, "POST", "/v2/refunds", body);
        return r.refund;
      }
      case "create_payment_link": {
        const r: any = await sqRequest(token, base, "POST", "/v2/online-checkout/payment-links", {
          idempotency_key: idemKey,
          quick_pay: {
            name: args.description || "ChatCenter charge",
            price_money: { amount: Math.round(Number(args.amount)), currency: String(args.currency).toUpperCase() },
            location_id: config.locationId || (await firstLocation(token, base)),
          },
          checkout_options: args.redirect_url ? { redirect_url: String(args.redirect_url) } : undefined,
        });
        return { id: r.payment_link?.id, url: r.payment_link?.url, version: r.payment_link?.version };
      }
      case "list_orders": {
        const locationId = args.location_id || config.locationId || (await firstLocation(token, base));
        const r: any = await sqRequest(token, base, "POST", "/v2/orders/search", {
          location_ids: [locationId],
          limit: Math.min(500, Number(args.limit ?? 20)),
        });
        return r.orders || [];
      }
      default:
        throw new Error(`unknown_square_tool:${toolName}`);
    }
  },
};

async function firstLocation(token: string, base: string): Promise<string> {
  const r: any = await sqRequest(token, base, "GET", "/v2/locations");
  const id = r.locations?.[0]?.id;
  if (!id) throw new Error("no_square_location_found");
  return id;
}

async function sqRequest(token: string, base: string, method: string, path: string, body?: unknown): Promise<any> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Square-Version": "2024-08-21",
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`square_${res.status}: ${text.slice(0, 240)}`);
  }
  if (res.status === 204) return null;
  return await res.json();
}

registerAdapter(SquareAdapter);
export default SquareAdapter;
