/**
 * Wix adapter — production-grade.
 *
 * Auth: Wix Headless OAuth (server-side). Each tenant connects ONE site;
 * the site id is stored in `config.siteId`. Wix issues access tokens that
 * expire in ~5 minutes — we refresh via the standard OAuth refresh flow.
 *
 * Tools (top use-cases for support + sales bots on Wix Stores + CRM):
 *   - wix.list_orders       — recent eCommerce orders (filterable by email/status)
 *   - wix.get_order         — single order detail
 *   - wix.list_products     — store products (search by name)
 *   - wix.get_product       — single product detail
 *   - wix.search_contacts   — CRM contact lookup
 *   - wix.create_contact    — add a CRM contact
 *
 * APIs:
 *   - eCommerce v1:    https://www.wixapis.com/ecom/v1
 *   - Stores v1:       https://www.wixapis.com/stores/v1
 *   - Contacts v4:     https://www.wixapis.com/contacts/v4
 *   - OAuth refresh:   https://www.wixapis.com/oauth/access
 */

import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";

const WIX_API = "https://www.wixapis.com";
const WIX_TOKEN = "https://www.wixapis.com/oauth/access";

const TOOLS: ToolDefinition[] = [
  {
    name: "wix.list_orders",
    description: "List recent Wix Stores orders, filterable by buyer email or status.",
    whenToUse: "Customer asks about a recent order or you need order context.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string", description: "Buyer email." },
        status: { type: "string", enum: ["INITIALIZED", "APPROVED", "CANCELED", "PENDING"], description: "Order payment status." },
        limit: { type: "number", description: "Default 10, max 100." },
      },
    },
  },
  {
    name: "wix.get_order",
    description: "Retrieve one Wix Stores order by id.",
    whenToUse: "You have an order id and need full detail (line items, totals, fulfillment).",
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
    name: "wix.list_products",
    description: "List/search Wix Stores products by name fragment.",
    whenToUse: "Customer asks about a product or you need to surface options.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product name fragment." },
        limit: { type: "number", description: "Default 10, max 100." },
      },
    },
  },
  {
    name: "wix.get_product",
    description: "Get one Wix Stores product by id.",
    whenToUse: "You have a product id and need detail (price, stock, options).",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        product_id: { type: "string" },
      },
      required: ["product_id"],
    },
  },
  {
    name: "wix.search_contacts",
    description: "Search Wix CRM contacts by email/phone/name fragment.",
    whenToUse: "Identify a known customer in Wix CRM.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Default 10, max 100." },
      },
      required: ["query"],
    },
  },
  {
    name: "wix.create_contact",
    description: "Create a Wix CRM contact (idempotent on email).",
    whenToUse: "Captured a new lead's email and want them in Wix CRM.",
    category: "WRITE",
    riskLevel: "LOW",
    sideEffects: "Adds a contact visible in the Wix dashboard.",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        phone: { type: "string" },
      },
      required: ["email"],
    },
  },
];

const WixAdapter: ProviderAdapter = {
  slug: "wix",
  tools: () => TOOLS,

  async refreshTokens(creds) {
    const clientId = process.env.WIX_CLIENT_ID;
    if (!clientId) throw new Error("WIX_CLIENT_ID not configured");
    if (!creds.refreshToken) throw new Error("no_refresh_token");
    const res = await fetch(WIX_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: creds.refreshToken,
      }),
    });
    if (!res.ok) throw new Error(`wix_refresh_${res.status}`);
    const j: any = await res.json();
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || creds.refreshToken,
      expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : undefined,
    };
  },

  async execute({ toolName, args, credentials }) {
    const token = credentials.accessToken;
    if (!token) throw new Error("no_access_token");

    switch (toolName) {
      case "list_orders": {
        const limit = Math.min(100, Number(args.limit ?? 10));
        const filter: any = {};
        if (args.email) filter["buyerInfo.email"] = { $eq: String(args.email) };
        if (args.status) filter.paymentStatus = { $eq: String(args.status) };
        const r: any = await wixRequest(token, "POST", `${WIX_API}/ecom/v1/orders/search`, {
          search: { filter, paging: { limit } },
        });
        return r.orders || [];
      }
      case "get_order": {
        const r: any = await wixRequest(token, "GET", `${WIX_API}/ecom/v1/orders/${encodeURIComponent(String(args.order_id))}`);
        return r.order;
      }
      case "list_products": {
        const limit = Math.min(100, Number(args.limit ?? 10));
        const filter = args.query ? { name: { $contains: String(args.query) } } : undefined;
        const r: any = await wixRequest(token, "POST", `${WIX_API}/stores/v1/products/query`, {
          query: { filter, paging: { limit } },
        });
        return r.products || [];
      }
      case "get_product": {
        const r: any = await wixRequest(token, "GET", `${WIX_API}/stores/v1/products/${encodeURIComponent(String(args.product_id))}`);
        return r.product;
      }
      case "search_contacts": {
        const limit = Math.min(100, Number(args.limit ?? 10));
        const r: any = await wixRequest(token, "POST", `${WIX_API}/contacts/v4/contacts/search`, {
          search: {
            search: String(args.query),
            paging: { limit },
          },
        });
        return r.contacts || [];
      }
      case "create_contact": {
        const r: any = await wixRequest(token, "POST", `${WIX_API}/contacts/v4/contacts`, {
          info: {
            name: {
              first: args.first_name,
              last: args.last_name,
            },
            emails: { items: [{ email: String(args.email), primary: true }] },
            phones: args.phone ? { items: [{ phone: String(args.phone), primary: true }] } : undefined,
          },
          allowDuplicates: false,
        });
        return r.contact;
      }
      default:
        throw new Error(`unknown_wix_tool:${toolName}`);
    }
  },
};

async function wixRequest(token: string, method: string, url: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`wix_${res.status}: ${text.slice(0, 240)}`);
  }
  if (res.status === 204) return null;
  return await res.json();
}

registerAdapter(WixAdapter);
export default WixAdapter;
