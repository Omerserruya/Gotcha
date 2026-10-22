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
import { orderPhoneSearchTerms } from "../../lib/order-phone-search";
export { orderPhoneSearchTerms };
import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";
import { SHIPMENT_TRACKING_NAMESPACE, recordShipmentTracking } from "./woo-shipment-tracking";

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
    description: "Search REGISTERED WooCommerce customers by partial email/name. Guest checkouts are not customers and phone is not searched: to find someone's orders use woocommerce.list_customer_orders.",
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
    description: "Search the store's published WooCommerce products by name/SKU, optionally within a price range or in stock only.",
    whenToUse: "Customer asks about a product, or you need to surface options.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product name or SKU fragment." },
        per_page: { type: "number", description: "Default 10, max 100." },
        price_min: { type: "number", description: "Lowest price, in the store's currency." },
        price_max: { type: "number", description: "Highest price (the customer's budget), in the store's currency." },
        in_stock: { type: "boolean", description: "true = only products in stock." },
      },
    },
  },
  {
    name: "woocommerce.create_coupon",
    description: "Create a discount coupon: a percentage off, or a fixed amount off the cart.",
    whenToUse: "Customer is being offered a documented discount. Approval is handled by the system: calling this tool is what RAISES the approval, so call it whenever the customer's request warrants it. Never wait for approval before calling, and never hand the conversation to a human merely because approval is needed.",
    whenNotToUse: "Speculative or unconfirmed discount offers.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Creates a coupon code that can be used by anyone who knows the code.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "For a store credit (instead of a refund): the order it replaces. The coupon is then usable only by that order's customer. Required from a customer conversation." },
        code: { type: "string", description: "Coupon code customers will type." },
        amount: { type: "string", description: "Percentage ('10' = 10%), or a fixed amount in the store's currency when discount_type is fixed_cart." },
        discount_type: { type: "string", enum: ["percent", "fixed_cart"], description: "percent (default) or a fixed amount off the cart." },
        usage_limit: { type: "number", description: "Max redemptions. Default 1." },
        expires_iso: { type: "string", description: "ISO8601 expiry date." },
      },
      required: ["code", "amount"],
    },
  },
  // ── Added 2026-10-13 (Omer: "everything that's missing") ──────────────
  {
    name: "woocommerce.list_order_notes",
    description: "The notes on an order: what the store and the customer wrote, and system notes.",
    whenToUse: "The customer asks what happened with their order, or you need the store's notes on it.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
  {
    name: "woocommerce.add_order_note",
    description: "Add a note to an order. A customer-visible note is emailed to the customer by WooCommerce.",
    whenToUse: "Something about the order should be recorded for the store, or told to the customer in writing.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Adds a note to the order; a customer note is emailed to the customer.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        note: { type: "string" },
        customer_visible: { type: "boolean", description: "true = the customer sees it (and gets an email). Default false." },
      },
      required: ["order_id", "note"],
    },
  },
  {
    name: "woocommerce.list_refunds",
    description: "The refunds already made on an order, with amounts and reasons.",
    whenToUse: "The customer asks whether, or how much, they were refunded.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
  {
    name: "woocommerce.create_refund",
    description: "Refund an order, fully or partly, through the store's payment gateway.",
    whenToUse: "A refund the store's policy allows has been agreed. Approval is handled by the system: calling this tool is what raises it.",
    whenNotToUse: "The amount or the order is not confirmed with the customer.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Moves money back to the customer through the payment gateway and records a refund on the order.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        amount: { type: "string", description: "Amount to refund in the order's currency, e.g. '49.90'." },
        reason: { type: "string" },
      },
      required: ["order_id", "amount"],
    },
  },
  {
    name: "woocommerce.cancel_order",
    description: "Cancel an order that has not been fulfilled.",
    whenToUse: "The customer asks to cancel and the order can still be cancelled. Approval is handled by the system.",
    whenNotToUse: "The order already shipped or completed: offer a return or a refund instead.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Sets the order to cancelled; stock is restored and the customer may be emailed.",
    parameters: {
      type: "object",
      properties: { order_id: { type: "string" }, note: { type: "string", description: "Optional customer-visible note." } },
      required: ["order_id"],
    },
  },
  {
    name: "woocommerce.update_shipping_address",
    description: "Change the shipping address of an order that has not shipped.",
    whenToUse: "The customer gives a corrected delivery address before the order ships.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Changes where the order is delivered.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        address_1: { type: "string" }, address_2: { type: "string" }, city: { type: "string" },
        postcode: { type: "string" }, country: { type: "string" }, state: { type: "string" },
        first_name: { type: "string" }, last_name: { type: "string" }, phone: { type: "string" },
      },
      required: ["order_id", "address_1", "city"],
    },
  },
  {
    name: "woocommerce.update_customer",
    description: "Update a customer's name, email or phone.",
    whenToUse: "The customer asks to correct their details.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Changes the customer's record in the store.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "woocommerce.create_customer",
    description: "Create a customer account in the store.",
    whenToUse: "A new customer asks to be registered and gave at least an email.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Creates a customer account (WooCommerce may email them).",
    parameters: {
      type: "object",
      properties: { email: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" }, phone: { type: "string" } },
      required: ["email"],
    },
  },
  {
    name: "woocommerce.get_product",
    description: "One product with its price and stock (quantity and in-stock status).",
    whenToUse: "The customer asks about a specific product, its price or whether it is in stock.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
  },
  {
    name: "woocommerce.list_product_variations",
    description: "The variations of a product (size, color...) with price and stock for each.",
    whenToUse: "The customer asks which sizes or colors are available, or in stock.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { product_id: { type: "string" }, per_page: { type: "number" } }, required: ["product_id"] },
  },
  {
    name: "woocommerce.list_coupons",
    description: "The store's coupons.",
    whenToUse: "You need to see which coupons exist.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        per_page: { type: "number" },
        page: { type: "number", description: "Page of results, from 1." },
        ids: { type: "array", items: { type: "string" }, description: "Only these coupon ids." },
      },
    },
  },
  {
    name: "woocommerce.get_coupon",
    description: "Check a coupon code: whether it exists and is still valid (expiry, usage left), and what it gives.",
    whenToUse: "The customer asks whether a coupon code works.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
  {
    name: "woocommerce.disable_coupon",
    description: "Stop a coupon from being used.",
    whenToUse: "The store asks to withdraw a coupon.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "The coupon can no longer be applied.",
    parameters: { type: "object", properties: { coupon_id: { type: "string" }, code: { type: "string" } } },
  },
  {
    name: "woocommerce.list_customer_orders",
    description: "The customer's orders, newest first, found by their phone and/or email on the order itself: this finds guest-checkout orders too.",
    whenToUse: "The customer asks about their orders without an order number. Call it with no arguments to search by the customer's own phone and email; never by a phone or email given for someone else.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        phone: { type: "string", description: "The customer's phone, any format (05x, +972, with dashes)." },
        email: { type: "string" },
        customer_id: { type: "string", description: "A registered customer's id. Guest orders have none." },
        per_page: { type: "number" },
      },
    },
  },
  {
    name: "woocommerce.get_shipment_tracking",
    description: "Tracking numbers and links for an order (needs the WooCommerce Shipment Tracking extension).",
    whenToUse: "The customer asks where their package is.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
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
        const id = encodeURIComponent(String(args.order_id));
        const order = await wooRequest(auth, "PUT", `${base}/orders/${id}`, { status: String(args.status) });
        // The note is an order note the customer sees (POST /orders/:id/notes).
        // It was written into customer_note, which OVERWROTE the note the
        // customer left on their own order (2026-10-13).
        if (args.note) {
          const note = await wooRequest(auth, "POST", `${base}/orders/${id}/notes`, { note: String(args.note), customer_note: true });
          return { ...(order as Record<string, unknown>), added_note: note };
        }
        return order;
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
        // Only what the store itself shows: published, not hidden (W9).
        params.set("status", "publish");
        const price = (v: unknown) => (typeof v === "number" || typeof v === "string") && Number.isFinite(Number(v)) && Number(v) >= 0 ? String(Number(v)) : null;
        if (price(args.price_min)) params.set("min_price", price(args.price_min)!);
        if (price(args.price_max)) params.set("max_price", price(args.price_max)!);
        if (args.in_stock === true) params.set("stock_status", "instock");
        const list: any = await wooRequest(auth, "GET", `${base}/products?${params}`);
        return Array.isArray(list) ? list.filter((p: any) => p?.catalog_visibility !== "hidden") : list;
      }
      case "create_coupon": {
        const body: any = {
          code: String(args.code),
          discount_type: args.discount_type === "fixed_cart" ? "fixed_cart" : "percent",
          amount: String(args.amount),
          usage_limit: Number(args.usage_limit ?? 1),
          individual_use: true,
        };
        if (args.expires_iso) body.date_expires = String(args.expires_iso);
        // A store credit for an order (2026-10-14: "credit575" was a ₪549
        // code anyone could redeem): usable only by that order's customer.
        // The address is the order's own billing email, read here, never one
        // the model passes; no billing email, no credit.
        if (args.order_id != null && String(args.order_id).trim()) {
          const order: any = await wooRequest(auth, "GET", `${base}/orders/${encodeURIComponent(String(args.order_id).trim())}`);
          const email = typeof order?.billing?.email === "string" ? order.billing.email.trim().toLowerCase() : "";
          if (!email.includes("@")) {
            throw new Error("credit_needs_billing_email: this order has no billing email, so a store credit could not be limited to its customer. Offer a refund instead, or hand over to a person.");
          }
          body.email_restrictions = [email];
          body.description = `store credit for order #${order.number ?? order.id}`;
        }
        return await wooRequest(auth, "POST", `${base}/coupons`, body);
      }
      case "list_order_notes":
        return await wooRequest(auth, "GET", `${base}/orders/${encodeURIComponent(String(args.order_id))}/notes`);
      case "add_order_note":
        return await wooRequest(auth, "POST", `${base}/orders/${encodeURIComponent(String(args.order_id))}/notes`, {
          note: String(args.note),
          customer_note: args.customer_visible === true,
        });
      case "list_refunds":
        return await wooRequest(auth, "GET", `${base}/orders/${encodeURIComponent(String(args.order_id))}/refunds`);
      case "create_refund": {
        const amount = String(args.amount ?? "").trim();
        if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw new Error("invalid_refund_amount");
        // api_refund: through the payment gateway, so money actually moves
        // (false would only record a manual refund in WooCommerce).
        return await wooRequest(auth, "POST", `${base}/orders/${encodeURIComponent(String(args.order_id))}/refunds`, {
          amount,
          reason: args.reason ? String(args.reason) : undefined,
          api_refund: true,
        });
      }
      case "cancel_order": {
        const id = encodeURIComponent(String(args.order_id));
        const current: any = await wooRequest(auth, "GET", `${base}/orders/${id}`);
        if (current && ["completed", "cancelled", "refunded"].includes(String(current.status))) {
          throw new Error(`order_not_cancellable:${current.status}`);
        }
        const order = await wooRequest(auth, "PUT", `${base}/orders/${id}`, { status: "cancelled" });
        if (args.note) {
          await wooRequest(auth, "POST", `${base}/orders/${id}/notes`, { note: String(args.note), customer_note: true });
        }
        return order;
      }
      case "update_shipping_address": {
        const id = encodeURIComponent(String(args.order_id));
        const current: any = await wooRequest(auth, "GET", `${base}/orders/${id}`);
        if (current && ["completed", "cancelled", "refunded"].includes(String(current.status))) {
          throw new Error(`order_already_${current.status}`);
        }
        const shipping: Record<string, string> = {};
        for (const k of ["first_name", "last_name", "address_1", "address_2", "city", "postcode", "country", "state", "phone"]) {
          if (args[k] != null && String(args[k]).trim()) shipping[k] = String(args[k]).trim();
        }
        return await wooRequest(auth, "PUT", `${base}/orders/${id}`, { shipping });
      }
      case "update_customer": {
        const body: any = {};
        if (args.first_name) body.first_name = String(args.first_name);
        if (args.last_name) body.last_name = String(args.last_name);
        if (args.email) body.email = String(args.email);
        if (args.phone) body.billing = { phone: String(args.phone) };
        if (!Object.keys(body).length) throw new Error("nothing_to_update");
        return await wooRequest(auth, "PUT", `${base}/customers/${encodeURIComponent(String(args.customer_id))}`, body);
      }
      case "create_customer": {
        const body: any = { email: String(args.email) };
        if (args.first_name) body.first_name = String(args.first_name);
        if (args.last_name) body.last_name = String(args.last_name);
        if (args.phone) body.billing = { phone: String(args.phone), email: String(args.email) };
        return await wooRequest(auth, "POST", `${base}/customers`, body);
      }
      case "get_product": {
        // Internal callers may look a product up by its slug (a page's URL
        // names it, often in Hebrew); the model's schema still takes the id.
        if (!args.product_id && typeof args.slug === "string" && args.slug.trim()) {
          const params = new URLSearchParams({ slug: args.slug.trim(), status: "publish", per_page: "1" });
          const list: any = await wooRequest(auth, "GET", `${base}/products?${params}`);
          if (!Array.isArray(list) || !list[0]) throw new Error("woocommerce_404: product_not_found");
          return list[0];
        }
        return await wooRequest(auth, "GET", `${base}/products/${encodeURIComponent(String(args.product_id))}`);
      }
      case "list_product_variations": {
        const per = Math.min(100, Number(args.per_page ?? 50));
        return await wooRequest(auth, "GET", `${base}/products/${encodeURIComponent(String(args.product_id))}/variations?per_page=${per}`);
      }
      case "list_coupons": {
        const params = new URLSearchParams();
        params.set("per_page", String(Math.min(100, Math.max(1, Number(args.per_page ?? 20) || 20))));
        if (Number(args.page) > 1) params.set("page", String(Math.floor(Number(args.page))));
        // Only these ids (the widget's chosen promotions, W9): numeric only.
        const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map((v) => String(v ?? "").trim()).filter((v) => /^\d{1,12}$/.test(v)) : [];
        if (Array.isArray(args.ids)) {
          if (!ids.length) return [];
          params.set("include", ids.join(","));
        }
        return await wooRequest(auth, "GET", `${base}/coupons?${params}`);
      }
      case "get_coupon": {
        const list: any = await wooRequest(auth, "GET", `${base}/coupons?code=${encodeURIComponent(String(args.code))}`);
        const c = Array.isArray(list) ? list[0] : null;
        if (!c) return { code: String(args.code), exists: false, valid: false, reason: "not_found" };
        const expired = !!c.date_expires_gmt && Date.parse(`${c.date_expires_gmt}Z`) < Date.now();
        const usedUp = c.usage_limit != null && Number(c.usage_count ?? 0) >= Number(c.usage_limit);
        const active = (c.status ?? "publish") === "publish";
        return {
          code: c.code, exists: true,
          valid: active && !expired && !usedUp,
          reason: !active ? "disabled" : expired ? "expired" : usedUp ? "used_up" : null,
          discount_type: c.discount_type, amount: c.amount,
          expires: c.date_expires ?? null, usage_count: c.usage_count ?? 0, usage_limit: c.usage_limit ?? null,
          minimum_amount: c.minimum_amount ?? null,
        };
      }
      case "disable_coupon": {
        let id = args.coupon_id ? String(args.coupon_id) : null;
        if (!id && args.code) {
          const list: any = await wooRequest(auth, "GET", `${base}/coupons?code=${encodeURIComponent(String(args.code))}`);
          id = Array.isArray(list) && list[0] ? String(list[0].id) : null;
        }
        if (!id) throw new Error("coupon_not_found");
        // Draft = cannot be applied, and can be published again (not deleted).
        return await wooRequest(auth, "PUT", `${base}/coupons/${encodeURIComponent(id)}`, { status: "draft" });
      }
      case "list_customer_orders": {
        const per = Math.min(100, Math.max(1, Number(args.per_page ?? 10) || 10));
        const query = (extra: Record<string, string>) => {
          const params = new URLSearchParams({ per_page: String(per), orderby: "date", order: "desc", ...extra });
          return wooRequest(auth, "GET", `${base}/orders?${params}`) as Promise<any>;
        };
        if (args.customer_id) return await query({ customer: String(args.customer_id) });
        // A guest checkout has no customer: its phone and email live only on
        // the order. Woo's order search reads billing/shipping, so search
        // those, in every way a phone is commonly stored, and merge.
        const terms = [...orderPhoneSearchTerms(args.phone), ...(args.email ? [String(args.email).trim()] : [])];
        if (!terms.length) throw new Error("phone_email_or_customer_id_required");
        const found = new Map<string, any>();
        for (const term of terms) {
          const rows = await query({ search: term });
          for (const o of Array.isArray(rows) ? rows : []) if (o?.id != null) found.set(String(o.id), o);
        }
        return [...found.values()]
          .sort((a, b) => String(b?.date_created_gmt ?? "").localeCompare(String(a?.date_created_gmt ?? "")))
          .slice(0, per);
      }
      case "get_shipment_tracking": {
        // The extension serves its own namespace, not wc/v3: the wc/v3 path
        // answered 404 on a store that HAS the extension, so the tool said
        // "no tracking" everywhere.
        try {
          const out = await wooRequest(auth, "GET", `${storeUrl}/wp-json/${SHIPMENT_TRACKING_NAMESPACE}/orders/${encodeURIComponent(String(args.order_id))}/shipment-trackings`);
          void recordShipmentTracking(storeUrl, true);
          return out;
        } catch (err: any) {
          // No such route = no Shipment Tracking extension on the store: say so,
          // do not fail, and stop offering the tool. A 404 for an unknown order
          // is a different answer and is thrown as it is.
          if (/woocommerce_404/.test(String(err?.message)) && /rest_no_route/.test(String(err?.message))) {
            void recordShipmentTracking(storeUrl, false);
            return { supported: false, reason: "The store does not have the WooCommerce Shipment Tracking extension, so no tracking is available." };
          }
          throw err;
        }
      }
      default:
        throw new Error(`unknown_woocommerce_tool:${toolName}`);
    }
  },
};

/**
 * The store's currency (ISO code), for pricing product cards and comparing a
 * budget. Internal only (not a tool the model can call): read once, cached on
 * the connection by the caller. Null when the store does not answer.
 */
export async function fetchWooStoreCurrency(credentials: Record<string, any>, config: Record<string, any>): Promise<string | null> {
  const consumerKey = credentials.consumerKey || credentials.consumer_key;
  const consumerSecret = credentials.consumerSecret || credentials.consumer_secret;
  const storeUrl = String(config.storeUrl || credentials.storeUrl || credentials.store_url || "").replace(/\/$/, "");
  if (!consumerKey || !consumerSecret || !storeUrl) return null;
  const auth = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;
  try {
    const cur: any = await wooRequest(auth, "GET", `${storeUrl}/wp-json/wc/v3/data/currencies/current`);
    const code = typeof cur?.code === "string" ? cur.code.toUpperCase() : "";
    return /^[A-Z]{3}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

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
