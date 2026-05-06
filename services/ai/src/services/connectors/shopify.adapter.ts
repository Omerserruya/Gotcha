/**
 * Shopify adapter — production-grade.
 *
 * Auth: Shopify Admin OAuth. Each tenant connects ONE shop; the shop
 * domain is stored in `config.shopDomain` (e.g. "my-store.myshopify.com").
 * Access tokens don't expire (offline mode is the default for app
 * installs), so we don't refresh — but we do detect 401 and mark BROKEN.
 *
 * Tools (top use-cases for support + sales bots):
 *   - shopify.get_orders               — list recent orders (filterable)
 *   - shopify.get_order                — single order detail
 *   - shopify.get_customer             — by id or email
 *   - shopify.search_customers         — by email/phone/name fragment
 *   - shopify.create_discount_code     — Price Rule + Discount Code
 *   - shopify.update_order_fulfillment — note + tag (most flexible non-destructive write)
 *
 * API: 2024-04 REST endpoints (stable, supported through 2025-04).
 */

import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";

const API_VERSION = "2024-04";

const TOOLS: ToolDefinition[] = [
  {
    name: "shopify.get_orders",
    description: "List recent Shopify orders, optionally filtered by status / customer.",
    whenToUse: "Customer asks 'where's my order?' or you need order context to support a refund/dispute.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "closed", "any"], description: "Default 'open'." },
        email: { type: "string", description: "Filter by customer email." },
        limit: { type: "number", description: "Default 10, max 250." },
      },
    },
  },
  {
    name: "shopify.get_order",
    description: "Retrieve a single Shopify order by id or order number (e.g. 1001).",
    whenToUse: "Customer gave you an order number / id and you need full detail (items, shipment, totals).",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Shopify order id (preferred)." },
        order_name: { type: "string", description: "Human order name like #1001." },
      },
    },
  },
  {
    name: "shopify.get_customer",
    description: "Get a Shopify customer by id or email.",
    whenToUse: "You need recent purchases / lifetime spend / order count for a customer.",
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
    name: "shopify.search_customers",
    description: "Search Shopify customers by email/phone/name fragment.",
    whenToUse: "You're trying to identify a customer with partial info.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Default 10, max 250." },
      },
      required: ["query"],
    },
  },
  {
    name: "shopify.create_discount_code",
    description: "Create a one-shot percentage-off discount code (uses an existing or new Price Rule).",
    whenToUse: "Customer is being offered a documented discount AND you have approval to issue it.",
    whenNotToUse: "Speculative discount offers — discounts are real money.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Creates a Price Rule + Discount Code that affects every customer using the code.",
    idempotencyNotes: "Codes are unique strings — re-running with the same code is a no-op (Shopify rejects).",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The discount code customers will type (e.g. WELCOME10)." },
        percentage: { type: "number", description: "0-100." },
        usage_limit: { type: "number", description: "Total redemptions allowed. Default 1." },
        ends_at_iso: { type: "string", description: "ISO8601 expiry." },
      },
      required: ["code", "percentage"],
    },
  },
  {
    name: "shopify.update_order_fulfillment",
    description: "Add a note + a tag to an order (non-destructive, used for human handoffs).",
    whenToUse: "Recording a customer interaction or flagging an order for the ops team.",
    category: "WRITE",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        note: { type: "string" },
        tag: { type: "string", description: "Tag to add (existing tags are preserved)." },
      },
      required: ["order_id"],
    },
  },
];

const ShopifyAdapter: ProviderAdapter = {
  slug: "shopify",
  tools: () => TOOLS,

  async execute({ toolName, args, credentials, config }) {
    const token = credentials.accessToken;
    const shop = config.shopDomain || credentials.shopDomain;
    if (!token) throw new Error("no_access_token");
    if (!shop) throw new Error("no_shop_domain");

    const base = `https://${shop}/admin/api/${API_VERSION}`;
    switch (toolName) {
      case "get_orders": {
        const params = new URLSearchParams();
        params.set("status", String(args.status || "open"));
        params.set("limit", String(Math.min(250, Number(args.limit ?? 10))));
        if (args.email) params.set("email", String(args.email));
        const r: any = await shopifyRequest(token, "GET", `${base}/orders.json?${params}`);
        return r.orders;
      }
      case "get_order": {
        if (args.order_id) {
          const r: any = await shopifyRequest(token, "GET", `${base}/orders/${encodeURIComponent(String(args.order_id))}.json`);
          return r.order;
        }
        if (args.order_name) {
          const r: any = await shopifyRequest(
            token,
            "GET",
            `${base}/orders.json?name=${encodeURIComponent(String(args.order_name).replace(/^#/, ""))}&status=any&limit=1`,
          );
          return r.orders?.[0] ?? null;
        }
        throw new Error("order_id_or_name_required");
      }
      case "get_customer": {
        if (args.customer_id) {
          const r: any = await shopifyRequest(token, "GET", `${base}/customers/${encodeURIComponent(String(args.customer_id))}.json`);
          return r.customer;
        }
        if (args.email) {
          const r: any = await shopifyRequest(token, "GET", `${base}/customers/search.json?query=${encodeURIComponent("email:" + String(args.email))}&limit=1`);
          return r.customers?.[0] ?? null;
        }
        throw new Error("customer_id_or_email_required");
      }
      case "search_customers": {
        const limit = Math.min(250, Number(args.limit ?? 10));
        const r: any = await shopifyRequest(token, "GET", `${base}/customers/search.json?query=${encodeURIComponent(String(args.query))}&limit=${limit}`);
        return r.customers || [];
      }
      case "create_discount_code": {
        // 1. price rule
        const pr: any = await shopifyRequest(token, "POST", `${base}/price_rules.json`, {
          price_rule: {
            title: `Bot ${args.code}`,
            target_type: "line_item",
            target_selection: "all",
            allocation_method: "across",
            value_type: "percentage",
            value: String(-Math.abs(Number(args.percentage))),
            customer_selection: "all",
            usage_limit: Number(args.usage_limit ?? 1),
            starts_at: new Date().toISOString(),
            ...(args.ends_at_iso ? { ends_at: args.ends_at_iso } : {}),
          },
        });
        const priceRuleId = pr.price_rule.id;
        // 2. discount code
        const code: any = await shopifyRequest(token, "POST", `${base}/price_rules/${priceRuleId}/discount_codes.json`, {
          discount_code: { code: args.code },
        });
        return { code: code.discount_code.code, price_rule_id: priceRuleId };
      }
      case "update_order_fulfillment": {
        // Preserve existing tags by merging.
        const orderId = String(args.order_id);
        const tagStr = args.tag != null ? String(args.tag) : "";
        const cur: any = await shopifyRequest(token, "GET", `${base}/orders/${orderId}.json`);
        const existingTags = String(cur.order.tags || "").split(",").map((s: string) => s.trim()).filter(Boolean);
        const tags = tagStr && !existingTags.includes(tagStr) ? [...existingTags, tagStr] : existingTags;
        const updated: any = await shopifyRequest(token, "PUT", `${base}/orders/${orderId}.json`, {
          order: {
            id: orderId,
            note: args.note ?? cur.order.note,
            tags: tags.join(", "),
          },
        });
        return updated.order;
      }
      default:
        throw new Error(`unknown_shopify_tool:${toolName}`);
    }
  },
};

async function shopifyRequest(token: string, method: string, url: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`shopify_${res.status}: ${text.slice(0, 240)}`);
  }
  return await res.json();
}

registerAdapter(ShopifyAdapter);
export default ShopifyAdapter;
