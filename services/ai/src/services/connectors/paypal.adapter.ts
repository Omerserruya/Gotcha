/**
 * PayPal adapter — production-grade.
 *
 * Auth: PayPal uses OAuth 2.0 client_credentials. Each tenant supplies
 * their own client_id + client_secret (created in their PayPal Developer
 * dashboard). We mint app-level access tokens via /v1/oauth2/token and
 * refresh them on expiry (default 9 hours).
 *
 *   credentials = { clientId, clientSecret, environment: "live"|"sandbox" }
 *   config       = { environment }   // mirrored for marketplace UI
 *
 * Tools (top use-cases for support + commerce bots):
 *   - paypal.create_invoice     — issue an invoice and send to email
 *   - paypal.refund_capture     — refund a captured payment (partial/full)
 *   - paypal.get_order          — order detail (v2 Orders API)
 *   - paypal.list_transactions  — recent transactions (Reporting API)
 *   - paypal.create_payment_link — create a checkout order + return approval URL
 */

import {
  registerAdapter,
  persistCredentials,
  type ProviderAdapter,
  type ToolDefinition,
  idempotencyKey,
} from "./integration-framework";

const LIVE_BASE = "https://api-m.paypal.com";
const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

const TOOLS: ToolDefinition[] = [
  {
    name: "paypal.create_invoice",
    description: "Create a PayPal invoice and send it to the customer's email.",
    whenToUse: "Customer agreed to a billable amount you want to deliver via invoice.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Sends an email to the recipient with the invoice + payment link.",
    idempotencyNotes: "Uses PayPal-Request-Id header derived from args — safe to retry.",
    parameters: {
      type: "object",
      properties: {
        recipient_email: { type: "string" },
        amount: { type: "number" },
        currency: { type: "string", description: "ISO 4217 (USD/EUR/ILS…)." },
        description: { type: "string" },
        due_date_iso: { type: "string", description: "ISO date YYYY-MM-DD." },
      },
      required: ["recipient_email", "amount", "currency", "description"],
    },
  },
  {
    name: "paypal.refund_capture",
    description: "Refund a captured PayPal payment (full or partial).",
    whenToUse: "Customer is approved for a refund — by policy or human approval.",
    whenNotToUse: "Customer is just inquiring about refund eligibility.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Issues a real refund — irreversible.",
    idempotencyNotes: "Uses PayPal-Request-Id header — same args never refund twice.",
    parameters: {
      type: "object",
      properties: {
        capture_id: { type: "string", description: "PayPal capture id (different from order id)." },
        amount: { type: "number", description: "Optional partial-refund amount. Omit for full refund." },
        currency: { type: "string", description: "Required if amount is set." },
        note_to_payer: { type: "string" },
      },
      required: ["capture_id"],
    },
  },
  {
    name: "paypal.get_order",
    description: "Retrieve a PayPal order by id (v2 Orders API).",
    whenToUse: "You have an order/checkout id and need detail.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "paypal.list_transactions",
    description: "List recent PayPal transactions in a date range (Reporting API).",
    whenToUse: "Customer asks about a recent transaction or you need history for a dispute.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        start_date_iso: { type: "string", description: "ISO datetime — default 30 days ago." },
        end_date_iso: { type: "string", description: "ISO datetime — default now." },
        page_size: { type: "number", description: "Default 20, max 500." },
      },
    },
  },
  {
    name: "paypal.create_payment_link",
    description: "Create a PayPal checkout order and return the customer-approval URL.",
    whenToUse: "Customer wants to pay with PayPal.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Creates an order PayPal will hold open until paid or expires.",
    idempotencyNotes: "Uses PayPal-Request-Id header — same args never duplicate.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number" },
        currency: { type: "string" },
        description: { type: "string" },
        return_url: { type: "string", description: "Where PayPal sends the buyer after approval." },
        cancel_url: { type: "string" },
      },
      required: ["amount", "currency"],
    },
  },
];

const PayPalAdapter: ProviderAdapter = {
  slug: "paypal",
  tools: () => TOOLS,

  async refreshTokens(creds) {
    const env = creds.environment === "live" ? "live" : "sandbox";
    const base = env === "live" ? LIVE_BASE : SANDBOX_BASE;
    if (!creds.clientId || !creds.clientSecret) throw new Error("no_paypal_app_credentials");
    const auth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`paypal_token_${res.status}`);
    const j: any = await res.json();
    return {
      accessToken: j.access_token,
      expiresAt: j.expires_in ? new Date(Date.now() + (Number(j.expires_in) - 60) * 1000) : undefined,
    };
  },

  async execute({ ctx, toolName, args, credentials }) {
    const env = credentials.environment === "live" ? "live" : "sandbox";
    const base = env === "live" ? LIVE_BASE : SANDBOX_BASE;
    let token = credentials.accessToken;
    if (!token) {
      // First call after connect — mint a token now.
      const refreshed = await PayPalAdapter.refreshTokens!(credentials);
      token = refreshed.accessToken;
      await persistCredentials({
        tenantIntegrationId: ctx.tenantIntegrationId,
        credentials: {
          ...credentials,
          accessToken: refreshed.accessToken,
          expiresAt: refreshed.expiresAt?.toISOString(),
        },
      });
    }

    const idemKey = idempotencyKey({
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      toolName,
      args,
    });

    switch (toolName) {
      case "create_invoice": {
        const draft: any = await ppRequest(token, "POST", `${base}/v2/invoicing/invoices`, {
          detail: {
            invoice_number: idemKey,
            currency_code: String(args.currency).toUpperCase(),
            note: args.description,
            payment_term: args.due_date_iso ? { due_date: String(args.due_date_iso) } : undefined,
          },
          primary_recipients: [{ billing_info: { email_address: String(args.recipient_email) } }],
          items: [{
            name: args.description,
            quantity: "1",
            unit_amount: { currency_code: String(args.currency).toUpperCase(), value: String(args.amount) },
          }],
        }, idemKey);
        const invoiceId = draft.id || draft.href?.split("/").pop();
        if (invoiceId) await ppRequest(token, "POST", `${base}/v2/invoicing/invoices/${invoiceId}/send`, { send_to_recipient: true });
        return { id: invoiceId, status: "SENT" };
      }
      case "refund_capture": {
        const body: any = {};
        if (args.amount && args.currency) {
          body.amount = { value: String(args.amount), currency_code: String(args.currency).toUpperCase() };
        }
        if (args.note_to_payer) body.note_to_payer = String(args.note_to_payer);
        const r: any = await ppRequest(
          token, "POST",
          `${base}/v2/payments/captures/${encodeURIComponent(String(args.capture_id))}/refund`,
          body, idemKey,
        );
        return { id: r.id, status: r.status, amount: r.amount };
      }
      case "get_order":
        return await ppRequest(token, "GET", `${base}/v2/checkout/orders/${encodeURIComponent(String(args.order_id))}`);
      case "list_transactions": {
        const start = args.start_date_iso ? new Date(String(args.start_date_iso)) : new Date(Date.now() - 30 * 86400_000);
        const end = args.end_date_iso ? new Date(String(args.end_date_iso)) : new Date();
        const params = new URLSearchParams({
          start_date: start.toISOString(),
          end_date: end.toISOString(),
          page_size: String(Math.min(500, Number(args.page_size ?? 20))),
          fields: "all",
        });
        return await ppRequest(token, "GET", `${base}/v1/reporting/transactions?${params}`);
      }
      case "create_payment_link": {
        const body: any = {
          intent: "CAPTURE",
          purchase_units: [{
            amount: { currency_code: String(args.currency).toUpperCase(), value: String(args.amount) },
            description: args.description,
          }],
          application_context: {
            return_url: args.return_url || "https://example.com/return",
            cancel_url: args.cancel_url || "https://example.com/cancel",
            user_action: "PAY_NOW",
          },
        };
        const r: any = await ppRequest(token, "POST", `${base}/v2/checkout/orders`, body, idemKey);
        const approve = (r.links || []).find((l: any) => l.rel === "approve");
        return { id: r.id, status: r.status, approve_url: approve?.href };
      }
      default:
        throw new Error(`unknown_paypal_tool:${toolName}`);
    }
  },
};

async function ppRequest(token: string, method: string, url: string, body?: unknown, idemKey?: string): Promise<any> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(idemKey ? { "PayPal-Request-Id": idemKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`paypal_${res.status}: ${text.slice(0, 240)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

registerAdapter(PayPalAdapter);
export default PayPalAdapter;
