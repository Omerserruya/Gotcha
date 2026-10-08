/**
 * WooCommerce adapter - production-grade.
 *
 * Auth: REST API consumer key + consumer secret (no OAuth). The store
 * URL is stored in `config.storeUrl` (e.g. "https://shop.example.com").
 * Credentials hold `{ consumerKey, consumerSecret }`. The REST client
 * uses HTTP Basic auth with these values per Woo's standard auth flow.
 *
 * Tools (top support + sales use-cases on WooCommerce):
 *   - woocommerce.list_orders          - recent orders (filterable)
 *   - woocommerce.get_order            - single order detail
 *   - woocommerce.update_order_status  - change status (processing/completed/cancelled/refunded)
 *   - woocommerce.get_customer         - by id or email
 *   - woocommerce.search_customers     - by partial fields
 *   - woocommerce.list_products        - search by name
 *   - woocommerce.create_coupon        - issue a discount coupon (HIGH risk)
 *
 * API: WC REST v3 - /wp-json/wc/v3/
 */

import { assertPublicUrl } from "@chatcenter/shared";
import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";

const TOOLS: ToolDefinition[] = [
  {
    name: "woocommerce.list_orders",
    description: "List recent WooCommerce orders, filterable by status or customer email.",
    whenToUse: "Customer asks about an order or you need order context.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "checkout-draft", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "any"] },
        email: { type: "string", description: "Filter by billing email." },
        per_page: { type: "number", description: "Default 10, max 100." },
      },
    },
  },
  {
    name: "woocommerce.get_order",
    description: "Get one WooCommerce order by id.",
    whenToUse: "You have an order id and need full detail (line items, totals, addresses, fulfillment).",
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
    name: "woocommerce.update_order_status",
    description: "Change the status of an existing WooCommerce order.",
    whenToUse: "Order needs a status transition (cancel, mark complete, etc.) and the action is approved.",
    whenNotToUse: "You're guessing at status - confirm the customer's intent first.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Updates the order status visible to merchant + customer; may trigger emails.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        status: { type: "string", enum: ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] },
        note: { type: "string", description: "Optional customer-visible note." },
      },
      required: ["order_id", "status"],
    },
  },
  {
    name: "woocommerce.get_customer",
    description: "Get a WooCommerce customer by id or email.",
    whenToUse: "You need standing context (lifetime spend, recent orders) for a known customer.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        email: { type: "string" },
      },
    },
  },
  {
    name: "woocommerce.search_customers",
    description: "Search WooCommerce customers by partial email/name.",
    whenToUse: "Identifying a customer with partial info.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        per_page: { type: "number", description: "Default 10, max 100." },
      },
      required: ["query"],
    },
  },
  {
    name: "woocommerce.list_products",
    description: "Search WooCommerce products by name/SKU.",
    whenToUse: "Customer asks about a product, or you need to surface options.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product name or SKU fragment." },
        per_page: { type: "number", description: "Default 10, max 100." },
      },
    },
  },
  {
    name: "woocommerce.create_coupon",
    description: "Create a percentage-off discount coupon.",
    whenToUse: "Customer is being offered a documented discount. Approval is handled by the system: calling this tool is what RAISES the approval, so call it whenever the customer's request warrants it. Never wait for approval before calling, and never hand the conversation to a human merely because approval is needed.",
    whenNotToUse: "Speculative or unconfirmed discount offers.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Creates a coupon code that can be used by anyone who knows the code.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Coupon code customers will type." },
        amount: { type: "string", description: "Percentage (e.g. '10' for 10%)." },
        usage_limit: { type: "number", description: "Max redemptions. Default 1." },
        expires_iso: { type: "string", description: "ISO8601 expiry date." },
      },
      required: ["code", "amount"],
    },
  },
];


const VALIDATE_TIMEOUT_MS = 10_000;

/**
 * The store address, normalised: scheme + host (+ port) + a sub-directory
 * install path, no query, no fragment, no credentials. https only, except
 * http outside production (a local dev store). Returns null when unusable.
 */
export function normalizeStoreUrl(raw: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const allowHttp = env.NODE_ENV !== "production";
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) return null;
  if (u.username || u.password) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/**
 * Prove the keys work against THIS store before calling the connection
 * CONNECTED. system_status needs the manage_woocommerce capability the
 * read_write key of an administrator carries; orders is the fallback for a
 * shop manager. Either one answering 200 with JSON is proof.
 */
export async function validateWooKeys(
  storeUrl: string,
  consumerKey: string,
  consumerSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const auth = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;
  let lastReason = "no_response";
  for (const path of ["/wp-json/wc/v3/system_status", "/wp-json/wc/v3/orders?per_page=1"]) {
    const url = `${storeUrl}${path}`;
    try {
      await assertPublicUrl(url);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
      const res = await fetchImpl(url, { headers: { Authorization: auth, Accept: "application/json" }, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        await res.json();
        return { ok: true };
      }
      lastReason = `http_${res.status}`;
    } catch (err: any) {
      lastReason = err?.name === "AbortError" ? "timeout" : String(err?.message || "fetch_failed").slice(0, 80);
    }
  }
  return { ok: false, reason: lastReason };
}


const WooCommerceAdapter: ProviderAdapter = {
  slug: "woocommerce",
  tools: () => TOOLS,

  /**
   * Prove a key pair works against THIS store before anything calls the
   * connection CONNECTED - the generic connect route and /test both run it.
   * A pasted key that is wrong, read-only for orders, or for another store
   * used to be stored as CONNECTED and fail on the first customer question.
   */
  async validate({ credentials, config }) {
    const consumerKey = credentials.consumerKey || credentials.consumer_key;
    const consumerSecret = credentials.consumerSecret || credentials.consumer_secret;
    if (!consumerKey || !consumerSecret) return { ok: false, error: "Enter both the consumer key and the consumer secret." };
    const storeUrl = normalizeStoreUrl(config.storeUrl || credentials.storeUrl || credentials.store_url);
    if (!storeUrl) return { ok: false, error: "Enter the store's https:// address." };
    const v = await validateWooKeys(storeUrl, String(consumerKey), String(consumerSecret));
    return v.ok
      ? { ok: true }
      : { ok: false, error: v.reason === "http_401" || v.reason === "http_403"
          ? "The store rejected these keys. Check that they are Read/Write keys for this store."
          : `The store could not be reached to check the keys (${v.reason}).` };
  },

  async execute({ toolName, args, credentials, config }) {
    const consumerKey = credentials.consumerKey || credentials.consumer_key;
    const consumerSecret = credentials.consumerSecret || credentials.consumer_secret;
    const storeUrl = String(config.storeUrl || credentials.storeUrl || credentials.store_url || "").replace(/\/$/, "");
    if (!consumerKey || !consumerSecret) throw new Error("no_woo_credentials");
    if (!storeUrl) throw new Error("no_store_url");
    const base = `${storeUrl}/wp-json/wc/v3`;
    const auth = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;

    switch (toolName) {
      case "list_orders": {
        const params = new URLSearchParams();
        params.set("per_page", String(Math.min(100, Number(args.per_page ?? 10))));
        if (args.status && args.status !== "any") params.set("status", String(args.status));
        if (args.email) params.set("search", String(args.email));
        // A period (WC REST takes ISO8601 after/before) and a page, for the
        // assistant's "orders this week".
        const iso = (v: unknown) => (typeof v === "string" && !isNaN(Date.parse(v)) ? new Date(v).toISOString().slice(0, 19) : null);
        const after = iso(args.after), before = iso(args.before);
        if (after) params.set("after", after);
        if (before) params.set("before", before);
        // The values are UTC; without this WooCommerce reads them in the site's zone.
        if (after || before) params.set("dates_are_gmt", "true");
        if (Number(args.page) > 1) params.set("page", String(Math.floor(Number(args.page))));
        return await wooRequest(auth, "GET", `${base}/orders?${params}`);
      }
      case "get_order":
        return await wooRequest(auth, "GET", `${base}/orders/${encodeURIComponent(String(args.order_id))}`);
      case "update_order_status": {
        const body: any = { status: String(args.status) };
        if (args.note) body.customer_note = String(args.note);
        return await wooRequest(auth, "PUT", `${base}/orders/${encodeURIComponent(String(args.order_id))}`, body);
      }
      case "get_customer": {
        if (args.customer_id) {
          return await wooRequest(auth, "GET", `${base}/customers/${encodeURIComponent(String(args.customer_id))}`);
        }
        if (args.email) {
          const list: any = await wooRequest(auth, "GET", `${base}/customers?email=${encodeURIComponent(String(args.email))}`);
          return Array.isArray(list) ? (list[0] ?? null) : list;
        }
        throw new Error("customer_id_or_email_required");
      }
      case "search_customers": {
        const params = new URLSearchParams();
        params.set("per_page", String(Math.min(100, Number(args.per_page ?? 10))));
        params.set("search", String(args.query));
        return await wooRequest(auth, "GET", `${base}/customers?${params}`);
      }
      case "list_products": {
        const params = new URLSearchParams();
        params.set("per_page", String(Math.min(100, Number(args.per_page ?? 10))));
        if (args.query) params.set("search", String(args.query));
        return await wooRequest(auth, "GET", `${base}/products?${params}`);
      }
      case "create_coupon": {
        const body: any = {
          code: String(args.code),
          discount_type: "percent",
          amount: String(args.amount),
          usage_limit: Number(args.usage_limit ?? 1),
          individual_use: true,
        };
        if (args.expires_iso) body.date_expires = String(args.expires_iso);
        return await wooRequest(auth, "POST", `${base}/coupons`, body);
      }
      default:
        throw new Error(`unknown_woocommerce_tool:${toolName}`);
    }
  },
};

async function wooRequest(authHeader: string, method: string, url: string, body?: unknown): Promise<unknown> {
  // SSRF guard: storeUrl is free-form tenant config. Block private/metadata
  // targets at DNS resolution before dispatching.
  await assertPublicUrl(url);
  const init: RequestInit = {
    method,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`woocommerce_${res.status}: ${text.slice(0, 240)}`);
  }
  if (res.status === 204) return null;
  return await res.json();
}

registerAdapter(WooCommerceAdapter);
export default WooCommerceAdapter;
