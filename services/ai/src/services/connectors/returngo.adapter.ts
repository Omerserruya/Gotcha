/**
 * ReturnGO adapter - returns/RMA platform that fronts Shopify (and others) for
 * post-purchase return management. Complements the Shopify adapter: Shopify's
 * GraphQL Returns object gives the native RMA status + reasons, while ReturnGO
 * owns the richer returns workflow + the financial transactions (refunds,
 * payment auth/capture, invoice payments) when a store runs its returns through
 * ReturnGO.
 *
 * Auth: API key. Two headers on every call:
 *   - `x-api-key`   - secret key from ReturnGO → Settings → Integrations → API
 *   - `x-shop-name` - the store, e.g. "my-store.myshopify.com" (multi-portal
 *     stores use "my-store.myshopify.com@PortalName").
 * Stored as credentials.apiKey + credentials.shopName. The API base defaults to
 * https://api.returngo.ai and is overridable via config.baseUrl for sandboxes.
 *
 * Confirmed REST surface (per ReturnGO API docs):
 *   - GET  /transactions              - list transactions by criteria
 *   - PUT  /transaction/{transactionId} - update a transaction (refund/payment status)
 * Rate limit: 2000/day, 5/sec (provider 429s surface as ok:false to the LLM).
 *
 * Tools return the RAW provider payload (plus a light, defensive normalization
 * where the shape is well-known) - we never fabricate fields the API didn't
 * return.
 */

import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";
import { assertPublicUrl } from "@chatcenter/shared";

const DEFAULT_BASE_URL = "https://api.returngo.ai";

type Cat = "READ" | "WRITE" | "DELETE" | "ACTION";
type Risk = "LOW" | "MEDIUM" | "HIGH";

function t(
  slug: string,
  category: Cat,
  riskLevel: Risk,
  description: string,
  whenToUse: string,
  properties: Record<string, unknown> = {},
  required?: string[],
  extra?: Partial<ToolDefinition>,
): ToolDefinition {
  return {
    name: `returngo.${slug}`,
    description,
    whenToUse,
    category,
    riskLevel,
    parameters: { type: "object", properties, ...(required && required.length ? { required } : {}) },
    ...extra,
  };
}

const orderSel = {
  order_id: { type: "string", description: "Store order id (preferred)." },
  order_name: { type: "string", description: "Human order name like #1001." },
  email: { type: "string", description: "Customer email." },
};

const TOOLS: ToolDefinition[] = [
  t("get_transactions", "READ", "LOW",
    "List ReturnGO transactions (refunds, payment auth/capture, invoice payments) for an order or customer.",
    "Customer asks about their refund/return transaction status and the store runs returns through ReturnGO. This is ReturnGO's view of the money/workflow; if shopify.* tools are also available, ALSO call shopify.get_refund_status for Shopify's native refund record and combine both.",
    { ...orderSel, status: { type: "string", description: "Filter by transaction status." }, limit: { type: "number", description: "Default 20, max 100." } }),
  t("get_return_status", "READ", "LOW",
    "Summarize the latest return/refund transaction status for an order from ReturnGO.",
    "Customer asks 'what's the status of my return/refund?' and ReturnGO is the returns platform. ReturnGO owns the return WORKFLOW; for the native order/refund state ALSO call shopify.get_returns + shopify.get_refund_status when available, and synthesize a single answer from both - neither source alone is complete.",
    { ...orderSel }),
  t("update_transaction", "WRITE", "HIGH",
    "Update a ReturnGO transaction (e.g. refund/payment status) by transaction id.",
    "You have approval to change a return transaction's status in ReturnGO.",
    { transaction_id: { type: "string", description: "ReturnGO transaction id." }, fields: { type: "object", description: "Fields to set, e.g. { refundStatus, paymentStatus }." } },
    ["transaction_id", "fields"],
    { sideEffects: "Mutates a return transaction in ReturnGO. Requires approval." }),
];

interface Ctx { apiKey: string; shopName: string; base: string; }

const ReturnGoAdapter: ProviderAdapter = {
  slug: "returngo",
  tools: () => TOOLS,

  async execute({ toolName, args, credentials, config }) {
    const apiKey = credentials.apiKey || credentials.api_key;
    const shopName = credentials.shopName || credentials.shop_name || config.shopName || config.shop_name;
    if (!apiKey) throw new Error("no_api_key");
    if (!shopName) throw new Error("no_shop_name: set the store domain (e.g. my-store.myshopify.com).");
    const base = String(config.baseUrl || config.base_url || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const ctx: Ctx = { apiKey, shopName: String(shopName), base };

    switch (toolName) {
      case "get_transactions": {
        return await listTransactions(ctx, args);
      }
      case "get_return_status": {
        const txns = await listTransactions(ctx, { ...args, limit: 50 });
        const list: any[] = Array.isArray(txns) ? txns : (txns?.transactions || txns?.data || []);
        if (!list.length) {
          return { order: args.order_id || args.order_name || args.email || null, transactions_count: 0, note: "No ReturnGO transactions found for this order." };
        }
        // Defensive projection - only surface fields the payload actually has.
        const summary = list.map((tx: any) => ({
          id: tx.id ?? tx.transactionId ?? null,
          type: tx.type ?? tx.transactionType ?? null,
          status: tx.status ?? tx.refundStatus ?? tx.paymentStatus ?? null,
          amount: tx.amount ?? tx.total ?? null,
          currency: tx.currency ?? null,
          created_at: tx.createdAt ?? tx.created_at ?? null,
        }));
        return { order: args.order_id || args.order_name || args.email || null, transactions_count: summary.length, latest: summary[0], transactions: summary };
      }
      case "update_transaction": {
        const id = String(args.transaction_id || "");
        if (!id) throw new Error("transaction_id_required");
        const fields = (args.fields && typeof args.fields === "object") ? args.fields : {};
        return await rgRequest(ctx, "PUT", `/transaction/${encodeURIComponent(id)}`, fields);
      }
      default:
        throw new Error(`unknown_returngo_tool:${toolName}`);
    }
  },
};

// ─── Internal helpers ───────────────────────────────────────

async function listTransactions(ctx: Ctx, args: Record<string, any>): Promise<any> {
  const qs = new URLSearchParams();
  // ReturnGO filters transactions by criteria; forward the common ones. Unknown
  // params are ignored by the API, so over-supplying is safe.
  if (args.order_id) qs.set("orderId", String(args.order_id));
  if (args.order_name) qs.set("orderName", String(args.order_name).replace(/^#/, ""));
  if (args.email) qs.set("email", String(args.email));
  if (args.status) qs.set("status", String(args.status));
  qs.set("limit", String(clampLimit(args.limit, 20, 100)));
  const query = qs.toString();
  return await rgRequest(ctx, "GET", `/transactions${query ? `?${query}` : ""}`);
}

function clampLimit(v: unknown, def: number, max: number): number {
  const n = Number(v ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

async function rgRequest(ctx: Ctx, method: string, path: string, body?: unknown): Promise<any> {
  // SSRF guard: ctx.base derives from free-form tenant config.baseUrl.
  await assertPublicUrl(`${ctx.base}${path}`);
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      "x-api-key": ctx.apiKey,
      "x-shop-name": ctx.shopName,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 401/403 → framework flips the connection to ERROR (re-auth needed).
    throw new Error(`returngo_${res.status}: ${text.slice(0, 240)}`);
  }
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 2000) }; }
}

registerAdapter(ReturnGoAdapter);
export default ReturnGoAdapter;
