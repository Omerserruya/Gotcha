/**
 * Shopify adapter - production-grade, full support surface.
 *
 * Auth: Shopify Admin OAuth. Each tenant connects ONE shop; the shop domain
 * lives in `config.shopDomain` (e.g. "my-store.myshopify.com"). Shopify now
 * requires EXPIRING offline tokens (non-expiring ones are rejected with a 403
 * "no longer accepted"): the OAuth callback requests `expiring=1`, and
 * refreshTokens() below rotates via the refresh grant. Connections that still
 * hold a legacy non-expiring token are migrated in place through the one-way
 * token-exchange grant on their first failing call - no re-connect needed.
 *
 * Two roles:
 *   1. ECOMMERCE integration - the rich tool surface below (customer, orders,
 *      fulfillment, discounts, products, returns) the AI employee can call.
 *   2. CRM source of truth (opt-in) - a thin CRM projection lives in
 *      crm-adapter.impl.ts (ShopifyCRMAdapter) and reuses the customer tools
 *      here. See crm-adapter-resolver (config.useAsCrm).
 *
 * Coverage notes - a few requested capabilities are NOT available through the
 * REST Admin API (or live in a separate product) and would silently mislead
 * if we faked them. Those tools are real catalog entries but DEGRADE
 * GRACEFULLY: they throw a clear, LLM-readable reason instead of inventing a
 * result. Specifically:
 *   - Customer SEGMENTS membership add/remove - Shopify segments are dynamic,
 *     query-defined (GraphQL `segments`). You can't imperatively add/remove a
 *     member. We point the model at customer TAGS (add_tag/remove_tag) as the
 *     supported proxy.
 *   - EDIT ORDER / ORDER TIMELINE / RESEND CONFIRMATION - GraphQL `orderEdit`
 *     / events API / no REST endpoint. Degrade gracefully.
 *
 * API: 2024-04 REST endpoints, plus the GraphQL Admin API for the Returns/RMA
 * object (get_returns / get_return_reason), which has no REST equivalent.
 */

import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";
import { assertPublicUrl } from "@chatcenter/shared";

const API_VERSION = "2024-04";

// ─── Tool-definition helper (cuts boilerplate) ──────────────

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
    name: `shopify.${slug}`,
    description,
    whenToUse,
    category,
    riskLevel,
    parameters: { type: "object", properties, ...(required && required.length ? { required } : {}) },
    ...extra,
  };
}

// Reusable parameter fragments.
const P = {
  customerSel: {
    customer_id: { type: "string", description: "Shopify customer id (preferred)." },
    email: { type: "string", description: "Customer email." },
    phone: { type: "string", description: "Customer phone (E.164 preferred)." },
  },
  orderSel: {
    order_id: { type: "string", description: "Shopify order id (preferred)." },
    order_name: { type: "string", description: "Human order name like #1001." },
  },
};

const TOOLS: ToolDefinition[] = [
  // ── Customer (read) ──
  t("get_customer", "READ", "LOW", "Get a Shopify customer by id, email, or phone.",
    "You need lifetime spend / order count / tags / addresses for a customer.", P.customerSel),
  t("search_customers", "READ", "LOW", "Search Shopify customers by email/phone/name fragment.",
    "You're identifying a customer from partial info.",
    { query: { type: "string" }, limit: { type: "number", description: "Default 10, max 250." } }, ["query"]),
  t("get_customer_by_email", "READ", "LOW", "Find a single Shopify customer by exact email.",
    "You have the customer's email and want their record.", { email: { type: "string" } }, ["email"]),
  t("get_customer_by_phone", "READ", "LOW", "Find a single Shopify customer by phone.",
    "You have the customer's phone and want their record.", { phone: { type: "string" } }, ["phone"]),
  t("get_customer_orders", "READ", "LOW", "List a customer's recent orders.",
    "Customer asks about their order history.",
    { ...P.customerSel, limit: { type: "number", description: "Default 10, max 100." } }),
  t("get_customer_addresses", "READ", "LOW", "List a customer's saved addresses.",
    "You need the customer's shipping/billing addresses.", P.customerSel),
  t("get_customer_tags", "READ", "LOW", "Get the tags on a customer record.",
    "You need to know a customer's segments/labels (VIP, etc.).", P.customerSel),
  t("get_customer_metafields", "READ", "LOW", "Get a customer's metafields (custom data).",
    "You need custom attributes stored on the customer.", P.customerSel),

  // ── Customer (write) ──
  t("create_customer", "WRITE", "MEDIUM", "Create a new Shopify customer.",
    "The customer doesn't exist yet and you need to record them (used by CRM source-of-truth too).",
    { email: { type: "string" }, phone: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" }, tags: { type: "array", items: { type: "string" } } }),
  t("update_customer", "WRITE", "MEDIUM", "Update fields on a customer (name, email, phone, note, tags).",
    "You need to correct or enrich a customer's profile.",
    { ...P.customerSel, fields: { type: "object", description: "Fields to set: first_name, last_name, email, phone, note, tags." } }, undefined,
    { sideEffects: "Mutates the customer record." }),
  t("add_tag", "WRITE", "LOW", "Add a tag to a customer (existing tags preserved).",
    "You want to label/segment a customer (e.g. VIP, retention).",
    { ...P.customerSel, tag: { type: "string" } }, ["tag"]),
  t("remove_tag", "WRITE", "LOW", "Remove a tag from a customer.",
    "A customer no longer belongs to a tag-based segment.",
    { ...P.customerSel, tag: { type: "string" } }, ["tag"]),
  t("update_metafield", "WRITE", "MEDIUM", "Set a customer metafield (custom data).",
    "You need to store a custom attribute on the customer.",
    { ...P.customerSel, namespace: { type: "string" }, key: { type: "string" }, value: { type: "string" }, type: { type: "string", description: "Metafield type, default single_line_text_field." } }, ["namespace", "key", "value"]),
  t("create_note", "WRITE", "LOW", "Append a note to a customer's note field (timeline-style).",
    "Record a customer interaction on their profile.",
    { ...P.customerSel, note: { type: "string" } }, ["note"]),

  // ── Orders (read) ──
  t("get_orders", "READ", "LOW", "List recent shop orders, optionally filtered.",
    "Triage recent orders, or you need order context.",
    { status: { type: "string", enum: ["open", "closed", "any"] }, email: { type: "string" }, limit: { type: "number" } }),
  t("get_order", "READ", "LOW", "Retrieve a single order by id or order name (e.g. #1001).",
    "Customer gave an order number and you need full detail.", P.orderSel),
  t("search_orders", "READ", "LOW", "Search orders by status, financial/fulfillment status, name, or email.",
    "You're looking for orders matching criteria.",
    { name: { type: "string" }, email: { type: "string" }, status: { type: "string", enum: ["open", "closed", "any"] }, financial_status: { type: "string" }, fulfillment_status: { type: "string" }, limit: { type: "number" } }),
  t("get_order_items", "READ", "LOW", "Get the line items of an order.",
    "Customer asks what's in their order.", P.orderSel),
  t("get_financial_status", "READ", "LOW", "Get an order's payment / financial status.",
    "Customer asks 'has my payment gone through?'.", P.orderSel),
  t("get_fulfillment_status", "READ", "LOW", "Get an order's fulfillment status + fulfillments.",
    "Customer asks 'has my order shipped?'.", P.orderSel),

  // ── Orders (actions) ──
  t("cancel_order", "ACTION", "HIGH", "Cancel an order (optionally refund + restock).",
    "Customer requests cancellation AND you have approval.",
    { ...P.orderSel, reason: { type: "string", enum: ["customer", "fraud", "inventory", "declined", "other"] }, refund: { type: "boolean" }, restock: { type: "boolean" } }, undefined,
    { sideEffects: "Cancels the order - may trigger a refund. Irreversible." }),
  t("send_invoice", "ACTION", "MEDIUM", "Send/resend the order invoice email to the customer.",
    "Customer didn't receive their invoice / needs the payment link again.",
    { ...P.orderSel, to: { type: "string", description: "Override recipient email." } }),
  t("resend_confirmation", "ACTION", "MEDIUM", "Resend the order confirmation email.",
    "Customer says they never got the confirmation email.", P.orderSel),
  t("edit_order", "ACTION", "HIGH", "Edit an order's line items (add/remove/adjust).",
    "You must change what's on an existing order and editing is allowed.",
    { ...P.orderSel, changes: { type: "object" } }, undefined,
    { sideEffects: "Mutates a placed order. Requires GraphQL orderEdit." }),

  // ── Fulfillment / shipping (read) ──
  t("get_shipment_status", "READ", "LOW", "Get the shipment status of an order's fulfillments.",
    "Customer asks 'where is my package?'.", P.orderSel),
  t("get_tracking_number", "READ", "LOW", "Get the tracking number(s) for an order.",
    "Customer wants their tracking number.", P.orderSel),
  t("get_tracking_url", "READ", "LOW", "Get the tracking URL(s) for an order.",
    "Customer wants a link to track their package.", P.orderSel),
  t("get_fulfillment_events", "READ", "LOW", "Get the fulfillment/shipping events timeline for an order.",
    "Customer asks 'when was it shipped / where is it now?'.", P.orderSel),

  // ── Discounts ──
  t("list_discounts", "READ", "LOW", "List the shop's price rules / discounts.",
    "You need to see active discounts.", { limit: { type: "number" } }),
  t("validate_discount", "READ", "LOW", "Look up a discount code and whether it's valid.",
    "Customer asks 'is code X still valid?'.", { code: { type: "string" } }, ["code"]),
  t("get_customer_discounts", "READ", "LOW", "List discounts targeted at a specific customer.",
    "Customer asks what discounts they personally have.", P.customerSel),
  t("create_discount_code", "WRITE", "HIGH", "Create a percentage-off discount code.",
    "Customer is offered a documented discount AND you have approval.",
    { code: { type: "string" }, percentage: { type: "number" }, usage_limit: { type: "number" }, ends_at_iso: { type: "string" } }, ["code", "percentage"],
    { sideEffects: "Creates a real discount - affects revenue." }),
  t("create_one_time_coupon", "WRITE", "HIGH", "Create a single-use coupon code.",
    "You owe the customer a one-off coupon.",
    { code: { type: "string" }, percentage: { type: "number" }, ends_at_iso: { type: "string" } }, ["code", "percentage"],
    { sideEffects: "Creates a real single-use discount." }),
  t("create_vip_coupon", "WRITE", "HIGH", "Create a VIP coupon (higher value, optionally customer-restricted).",
    "Rewarding a VIP/high-value customer with approval.",
    { code: { type: "string" }, percentage: { type: "number" }, customer_id: { type: "string", description: "Restrict to this customer." }, usage_limit: { type: "number" }, ends_at_iso: { type: "string" } }, ["code", "percentage"],
    { sideEffects: "Creates a real discount." }),
  t("disable_coupon", "WRITE", "MEDIUM", "Disable a coupon by expiring its price rule now.",
    "A coupon must be deactivated.", { code: { type: "string" } }, ["code"],
    { sideEffects: "Ends the discount immediately." }),

  // ── Segments (graceful - tags are the supported proxy) ──
  t("list_segments", "READ", "LOW", "List customer segments (GraphQL - degrades gracefully).",
    "You want the store's segments. Prefer customer tags for membership ops.", { limit: { type: "number" } }),
  t("check_segment_membership", "READ", "LOW", "Check whether a customer is in a segment (degrades gracefully).",
    "You want to know a customer's segment. Prefer get_customer_tags.", { ...P.customerSel, segment: { type: "string" } }),
  t("add_customer_to_segment", "WRITE", "LOW", "Add a customer to a (tag-based) segment.",
    "Place a customer into a segment. Implemented via customer tags.",
    { ...P.customerSel, segment: { type: "string" } }, ["segment"]),
  t("remove_customer_from_segment", "WRITE", "LOW", "Remove a customer from a (tag-based) segment.",
    "Take a customer out of a segment. Implemented via customer tags.",
    { ...P.customerSel, segment: { type: "string" } }, ["segment"]),

  // ── Products ──
  t("get_product", "READ", "LOW", "Get a product by id or handle.",
    "Customer asks about a specific product.", { product_id: { type: "string" }, handle: { type: "string" } }),
  t("search_products", "READ", "LOW", "Search products by title fragment.",
    "Customer asks 'do you sell X?'.", { query: { type: "string" }, limit: { type: "number" } }, ["query"]),
  t("inventory_status", "READ", "LOW", "Check stock for a product or variant.",
    "Customer asks 'is X in stock?'.", { product_id: { type: "string" }, variant_id: { type: "string" } }),
  t("variant_information", "READ", "LOW", "Get variant details (price, SKU, options, inventory).",
    "Customer asks about sizes/colors/price of a variant.", { variant_id: { type: "string" }, product_id: { type: "string" } }),

  // ── Returns (refund status is REST; Returns/RMA object is GraphQL) ──
  t("get_refund_status", "READ", "LOW", "Get refunds recorded against an order (Shopify's native refund record).",
    "Customer asks 'has my refund been processed?'. This is the money movement in Shopify. If returngo.* tools are also available, ALSO call returngo.get_return_status - combine both for the full refund/return picture.", P.orderSel),
  t("get_returns", "READ", "LOW", "List Shopify Returns (RMAs) for an order with status + line items (GraphQL - Shopify's native return object).",
    "Customer asks about a return request / 'what's the status of my return?'. This is Shopify's native RMA. If returngo.* tools are also available, ALSO call returngo.get_return_status and synthesize both - neither source alone is complete.", P.orderSel),
  t("get_return_reason", "READ", "LOW", "Get the per-line return reason(s) for an order's returns (GraphQL).",
    "You need why a customer returned an item. Pair with returngo.get_return_status when ReturnGO is the returns platform.", P.orderSel),

  // ── High-level AI composites ──
  t("summarize_customer", "READ", "LOW", "One-call customer snapshot: profile + recent orders + tags.",
    "You need a quick, complete picture of a customer.", P.customerSel),
  t("get_customer_health", "READ", "LOW", "Compute a customer health summary (spend, frequency, recency, refunds).",
    "You need to gauge a customer's value/risk.", P.customerSel),
  t("find_latest_order", "READ", "LOW", "Find a customer's most recent order.",
    "Customer asks about 'my last order'.", P.customerSel),
  t("find_delayed_order", "READ", "LOW", "Find a customer's unfulfilled orders older than N days.",
    "Customer complains an order is late.", { ...P.customerSel, older_than_days: { type: "number", description: "Default 5." } }),
  t("check_payment_status", "READ", "LOW", "Check an order's payment status (alias of get_financial_status).",
    "Customer asks if payment went through.", P.orderSel),
  t("track_shipment", "READ", "LOW", "Get shipment status + tracking number + URL in one call.",
    "Customer asks 'where's my package?'.", P.orderSel),
  t("check_delivery_eta", "READ", "LOW", "Get the estimated delivery window for an order, if available.",
    "Customer asks 'when will it arrive?'.", P.orderSel),
  t("check_pickup_point", "READ", "LOW", "Get local-pickup details for an order, if applicable.",
    "Customer asks about picking up in store.", P.orderSel),
  t("check_refund", "READ", "LOW", "Check refund status for an order (alias of get_refund_status).",
    "Customer asks about their refund.", P.orderSel),
  t("check_return_status", "READ", "LOW", "Check return status for an order (degrades to refunds + graceful note).",
    "Customer asks about their return.", P.orderSel),
  t("issue_compensation_coupon", "WRITE", "HIGH", "Issue a compensation coupon and tag the customer 'compensation'.",
    "You're compensating a customer for an issue, with approval.",
    { ...P.customerSel, code: { type: "string" }, percentage: { type: "number" }, ends_at_iso: { type: "string" } }, ["code", "percentage"],
    { sideEffects: "Creates a real discount + tags the customer." }),
  t("add_vip_tag", "WRITE", "LOW", "Tag a customer 'VIP'.",
    "Promote a customer to VIP.", P.customerSel),
  t("add_retention_segment", "WRITE", "LOW", "Add a customer to the 'retention' segment (tag-based).",
    "Flag a churn-risk customer for retention.", P.customerSel),

  // ── Refund (money movement - always behind approval) ──
  t("process_refund", "ACTION", "HIGH", "Refund an order: full refund by default, partial via `amount` or `line_items`.",
    "Customer wants money back on an order (with approval). Verifies the refundable maximum, executes via Shopify's refund calculate+create flow, and reports whether the gateway transaction is processed or still pending.",
    {
      ...P.orderSel,
      amount: { type: "number", description: "Partial refund amount in the order currency. Omit for a full refund of the remaining balance." },
      line_items: { type: "array", items: { type: "object", properties: { line_item_id: { type: "string" }, quantity: { type: "number" } } }, description: "Specific line items (and quantities) to refund. Omit for all remaining items." },
      restock: { type: "boolean", description: "Restock refunded items (default false)." },
      refund_shipping: { type: "boolean", description: "Also refund shipping (default true on full refunds, false on partial)." },
      reason: { type: "string" }, note: { type: "string" },
      notify: { type: "boolean", description: "Send Shopify's refund notification email (default true)." },
    }, [],
    { sideEffects: "Moves real money back to the customer through the payment gateway." }),

  // ── Legacy (kept for back-compat) ──
  t("update_order_fulfillment", "WRITE", "LOW", "Add a note + tag to an order (non-destructive handoff).",
    "Flag an order for the ops team.", { order_id: { type: "string" }, note: { type: "string" }, tag: { type: "string" } }, ["order_id"]),
  t("order_lookup", "READ", "LOW", "Look up an order by id or name (alias of get_order).",
    "Legacy alias - prefer get_order.", P.orderSel),
];

// ─── Required OAuth scopes per tool ─────────────────────────
//
// Drives two enforcement layers in the integration framework: the pre-flight
// short-circuit in executeAdapterTool (a known-missing scope fails locally,
// no HTTP) and the bot tool-surface filter (a tool the shop can't execute is
// never offered to the model, so no impossible HITL can be opened). Tools
// absent from this map (the degraded-by-design ones) need no scope - they
// throw their honest "unsupported" reason before any API call.
const TOOL_SCOPES: Record<string, string[]> = {
  // customer read
  get_customer: ["read_customers"], search_customers: ["read_customers"],
  get_customer_by_email: ["read_customers"], get_customer_by_phone: ["read_customers"],
  get_customer_addresses: ["read_customers"], get_customer_tags: ["read_customers"],
  get_customer_metafields: ["read_customers"],
  get_customer_orders: ["read_customers", "read_orders"],
  summarize_customer: ["read_customers", "read_orders"],
  get_customer_health: ["read_customers", "read_orders"],
  find_latest_order: ["read_customers", "read_orders"],
  find_delayed_order: ["read_customers", "read_orders"],
  // customer write
  create_customer: ["write_customers"], update_customer: ["write_customers"],
  add_tag: ["write_customers"], remove_tag: ["write_customers"],
  update_metafield: ["write_customers"], create_note: ["write_customers"],
  add_customer_to_segment: ["write_customers"], remove_customer_from_segment: ["write_customers"],
  add_vip_tag: ["write_customers"], add_retention_segment: ["write_customers"],
  // orders read
  get_orders: ["read_orders"], get_order: ["read_orders"], order_lookup: ["read_orders"],
  search_orders: ["read_orders"], get_order_items: ["read_orders"],
  get_financial_status: ["read_orders"], check_payment_status: ["read_orders"],
  get_fulfillment_status: ["read_orders"], get_shipment_status: ["read_orders"],
  track_shipment: ["read_orders"], get_tracking_number: ["read_orders"],
  get_tracking_url: ["read_orders"], get_fulfillment_events: ["read_orders"],
  check_delivery_eta: ["read_orders"], check_pickup_point: ["read_orders"],
  get_refund_status: ["read_orders"], check_refund: ["read_orders"],
  check_return_status: ["read_orders"],
  // order actions
  cancel_order: ["write_orders"], process_refund: ["write_orders"],
  send_invoice: ["write_orders"], update_order_fulfillment: ["write_orders"],
  // products
  get_product: ["read_products"], search_products: ["read_products"],
  inventory_status: ["read_products"], variant_information: ["read_products"],
  // discounts
  list_discounts: ["read_price_rules"], validate_discount: ["read_price_rules"],
  get_customer_discounts: ["read_customers", "read_price_rules"],
  create_discount_code: ["write_price_rules"], create_one_time_coupon: ["write_price_rules"],
  create_vip_coupon: ["write_price_rules"], disable_coupon: ["write_price_rules"],
  issue_compensation_coupon: ["write_price_rules"],
  // returns (GraphQL)
  get_returns: ["read_returns"], get_return_reason: ["read_returns"],
};
for (const def of TOOLS) {
  const slug = def.name.slice(def.name.indexOf(".") + 1);
  const scopes = TOOL_SCOPES[slug];
  if (scopes) def.requiredScopes = scopes;
}

// ─── Adapter ────────────────────────────────────────────────

// OAuth scopes the tool surface actually needs. Compared against the shop's
// granted scopes in validate() so a connection missing write access shows a
// precise, actionable error in the integration UI instead of write tools
// silently failing (or worse, opening an approval flow that can never run).
const REQUIRED_SCOPES: Array<{ scope: string; needs: string }> = [
  { scope: "read_customers", needs: "customer lookup tools" },
  { scope: "write_customers", needs: "tags / notes / customer updates" },
  { scope: "read_orders", needs: "order lookup / tracking tools" },
  { scope: "write_orders", needs: "cancel_order and process_refund" },
  { scope: "read_products", needs: "product / inventory tools" },
  { scope: "read_price_rules", needs: "discount lookup tools" },
  { scope: "write_price_rules", needs: "coupon creation tools" },
];

const ShopifyAdapter: ProviderAdapter = {
  slug: "shopify",
  migratesLegacyCredentials: true,
  tools: () => TOOLS,

  /**
   * Live credential + scope probe for the integration "Test" button.
   * `access_scopes.json` is the cheapest authenticated call Shopify has AND
   * tells us exactly which scopes the merchant granted - so a connection
   * whose write scopes are missing fails the test with a message naming the
   * scopes to re-grant, instead of read tools working while every write
   * quietly dies.
   */
  async validate({ credentials, config }) {
    const token = credentials.accessToken;
    const shop = config.shopDomain || credentials.shopDomain;
    if (!token) return { ok: false, error: "no access token stored - re-connect Shopify" };
    if (!shop) return { ok: false, error: "no shop domain stored - re-connect Shopify" };
    const url = `https://${shop}/admin/oauth/access_scopes.json`;
    await assertPublicUrl(url);
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `Shopify rejected the token (${res.status}) - re-connect to re-authorize` };
    }
    if (!res.ok) return { ok: false, error: `Shopify returned ${res.status} while validating` };
    const j: any = await res.json().catch(() => ({}));
    const granted = (j.access_scopes || [])
      .map((s: any) => String(s.handle || ""))
      .filter(Boolean);
    const grantedSet = new Set<string>(granted);
    const missing = REQUIRED_SCOPES.filter((r) => !grantedSet.has(r.scope));
    if (missing.length) {
      return {
        ok: false,
        error:
          `connected, but missing scope(s): ` +
          missing.map((m) => `${m.scope} (${m.needs})`).join(", ") +
          ` - re-connect Shopify to grant them`,
        grantedScopes: granted,
        missingScopes: missing.map((m) => m.scope),
      };
    }
    return { ok: true, grantedScopes: granted, missingScopes: [] };
  },

  /**
   * Rotate the access token. Two shapes, one endpoint:
   *   - refresh grant when we hold a refresh token (the steady state);
   *   - token-exchange (`expiring=1`) when we only hold a legacy non-expiring
   *     token - Shopify revokes the old token on success, so this is the
   *     in-place migration path for pre-expiry connections.
   * The framework persists whatever we return (spread over the old blob, so
   * shopDomain survives).
   */
  async refreshTokens(credentials) {
    const shop = credentials.shopDomain;
    const clientId = process.env.SHOPIFY_API_KEY;
    const clientSecret = process.env.SHOPIFY_API_SECRET;
    if (!shop) throw new Error("shopify_refresh_no_shop_domain");
    if (!clientId || !clientSecret) throw new Error("shopify_refresh_not_configured");

    const body: Record<string, string> = credentials.refreshToken
      ? {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
        }
      : {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: credentials.accessToken,
          subject_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
          requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
          expiring: "1",
        };

    const url = `https://${shop}/admin/oauth/access_token`;
    await assertPublicUrl(url);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`shopify_token_${credentials.refreshToken ? "refresh" : "migration"}_failed_${res.status}: ${text.slice(0, 200)}`);
    }
    const j: any = await res.json();
    if (!j.access_token) throw new Error("shopify_token_rotation_no_access_token");
    console.log(`[shopify] ${credentials.refreshToken ? "refreshed access token" : "migrated legacy token to expiring"} for ${shop}`);
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: j.expires_in ? new Date(Date.now() + Number(j.expires_in) * 1000) : undefined,
      scope: j.scope,
    };
  },

  async execute({ toolName, args, credentials, config }) {
    const token = credentials.accessToken;
    const shop = config.shopDomain || credentials.shopDomain;
    if (!token) throw new Error("no_access_token");
    if (!shop) throw new Error("no_shop_domain");
    const base = `https://${shop}/admin/api/${API_VERSION}`;
    const ctx: Ctx = { token, base };

    switch (toolName) {
      // ── Customer read ──
      case "get_customer": {
        const c = await resolveCustomer(ctx, args);
        return c;
      }
      case "search_customers": {
        const limit = clampLimit(args.limit, 10, 250);
        const r: any = await sreq(ctx, "GET", `/customers/search.json?query=${encodeURIComponent(String(args.query || ""))}&limit=${limit}`);
        return r.customers || [];
      }
      case "get_customer_by_email": {
        return await customerByQuery(ctx, `email:${String(args.email || "")}`);
      }
      case "get_customer_by_phone": {
        return await customerByQuery(ctx, `phone:${String(args.phone || "")}`);
      }
      case "get_customer_orders": {
        const limit = clampLimit(args.limit, 10, 100);
        return await customerOrders(ctx, args, { limit, status: "any" });
      }
      case "get_customer_addresses": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        const r: any = await sreq(ctx, "GET", `/customers/${c.id}/addresses.json`);
        return r.addresses || c.addresses || [];
      }
      case "get_customer_tags": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        return { customer_id: c.id, tags: splitTags(c.tags) };
      }
      case "get_customer_metafields": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        const r: any = await sreq(ctx, "GET", `/customers/${c.id}/metafields.json`);
        return r.metafields || [];
      }

      // ── Customer write ──
      case "create_customer": {
        const body: any = { customer: {} };
        if (args.email) body.customer.email = String(args.email);
        if (args.phone) body.customer.phone = String(args.phone);
        if (args.first_name) body.customer.first_name = String(args.first_name);
        if (args.last_name) body.customer.last_name = String(args.last_name);
        if (Array.isArray(args.tags) && args.tags.length) body.customer.tags = (args.tags as string[]).join(", ");
        const r: any = await sreq(ctx, "POST", `/customers.json`, body);
        return r.customer;
      }
      case "update_customer": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        const f = (args.fields && typeof args.fields === "object" ? args.fields : args) as any;
        const patch: any = { id: c.id };
        for (const k of ["first_name", "last_name", "email", "phone", "note"]) {
          if (f[k] != null && f[k] !== "") patch[k] = String(f[k]);
        }
        if (f.tags != null) patch.tags = Array.isArray(f.tags) ? f.tags.join(", ") : String(f.tags);
        const r: any = await sreq(ctx, "PUT", `/customers/${c.id}.json`, { customer: patch });
        return r.customer;
      }
      case "add_tag": {
        return await mutateCustomerTags(ctx, args, String(args.tag || ""), "add");
      }
      case "remove_tag": {
        return await mutateCustomerTags(ctx, args, String(args.tag || ""), "remove");
      }
      case "update_metafield": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        const r: any = await sreq(ctx, "POST", `/customers/${c.id}/metafields.json`, {
          metafield: {
            namespace: String(args.namespace),
            key: String(args.key),
            value: String(args.value),
            type: String(args.type || "single_line_text_field"),
          },
        });
        return r.metafield;
      }
      case "create_note": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        const existing = String(c.note || "").trim();
        const note = existing ? `${existing}\n\n${String(args.note || "")}` : String(args.note || "");
        const r: any = await sreq(ctx, "PUT", `/customers/${c.id}.json`, { customer: { id: c.id, note } });
        return r.customer;
      }

      // ── Orders read ──
      case "get_orders": {
        const params = new URLSearchParams();
        params.set("status", String(args.status || "open"));
        params.set("limit", String(clampLimit(args.limit, 10, 250)));
        if (args.email) params.set("email", String(args.email));
        const r: any = await sreq(ctx, "GET", `/orders.json?${params}`);
        return r.orders;
      }
      case "get_order":
      case "order_lookup": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        return o;
      }
      case "search_orders": {
        const params = new URLSearchParams();
        params.set("status", String(args.status || "any"));
        params.set("limit", String(clampLimit(args.limit, 10, 100)));
        if (args.email) params.set("email", String(args.email));
        if (args.name) params.set("name", String(args.name).replace(/^#/, ""));
        if (args.financial_status) params.set("financial_status", String(args.financial_status));
        if (args.fulfillment_status) params.set("fulfillment_status", String(args.fulfillment_status));
        const r: any = await sreq(ctx, "GET", `/orders.json?${params}`);
        return r.orders || [];
      }
      case "get_order_items": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        return o.line_items || [];
      }
      case "get_financial_status":
      case "check_payment_status": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        return { order_id: o.id, name: o.name, financial_status: o.financial_status, total_price: o.total_price, currency: o.currency };
      }
      case "get_fulfillment_status": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        return { order_id: o.id, name: o.name, fulfillment_status: o.fulfillment_status, fulfillments: o.fulfillments || [] };
      }

      // ── Orders actions ──
      case "cancel_order": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        // Idempotent retry: an approval re-dispatch (worker retry, FAILED→
        // re-claim, timeout with unknown outcome) must not 422 on an order
        // that is already cancelled - reconcile against current state and
        // report it, flagged so the bot can phrase it honestly.
        if (o.cancelled_at) {
          return {
            id: o.id, name: o.name, cancelled_at: o.cancelled_at,
            financial_status: o.financial_status, already_cancelled: true,
          };
        }
        const body: any = {};
        if (args.reason) body.reason = String(args.reason);
        if (args.restock != null) body.restock = !!args.restock;
        const r: any = await sreq(ctx, "POST", `/orders/${o.id}/cancel.json`, body);
        let cancelled = r.order || r;
        // Shopify can 200 the cancel call while the order stays uncancelled
        // (e.g. gateway-side rejection). Verify the business state changed
        // before letting callers report success to a customer.
        if (!cancelled?.cancelled_at) {
          const check: any = await sreq(ctx, "GET", `/orders/${o.id}.json`);
          if (!check?.order?.cancelled_at) {
            throw new Error("cancel_not_applied: Shopify accepted the request but the order is not cancelled - check payment/fulfillment state in the Shopify admin.");
          }
          cancelled = check.order;
        }
        // `refund: true` means cancel AND return the money. The REST cancel
        // endpoint silently ignores a boolean refund param (live-verified:
        // the order cancels but stays `paid`), so run the real refund flow
        // explicitly. A refund failure after a successful cancel is reported
        // as partial success - never rolled into a fake full success.
        if (args.refund) {
          try {
            const fresh: any = await sreq(ctx, "GET", `/orders/${o.id}.json`);
            const refund = await executeRefund(ctx, fresh.order ?? cancelled, {
              restock: args.restock, reason: args.reason ?? "order cancelled",
            });
            return { ...cancelled, refund };
          } catch (err: any) {
            return {
              ...cancelled,
              refund_error: (err?.message || "refund_failed").slice(0, 240),
              refund_status: "failed",
            };
          }
        }
        return cancelled;
      }
      case "send_invoice": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const invoice: any = {};
        if (args.to) invoice.to = String(args.to);
        const r: any = await sreq(ctx, "POST", `/orders/${o.id}/send_invoice.json`, { order_invoice: invoice });
        return r.order_invoice || { ok: true };
      }
      case "resend_confirmation":
        throw new Error("unsupported_rest: Shopify has no REST endpoint to resend the order confirmation email. Use send_invoice to re-send the invoice/payment link, or resend confirmation from the Shopify admin.");
      case "edit_order":
        throw new Error("unsupported_rest: editing placed orders requires the GraphQL Admin API (orderEditBegin/orderEditCommit). Not available via REST tools.");

      // ── Fulfillment / shipping ──
      case "get_shipment_status":
      case "track_shipment": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const fs = (o.fulfillments || []).map((f: any) => ({
          status: f.status, shipment_status: f.shipment_status,
          tracking_company: f.tracking_company, tracking_number: f.tracking_number,
          tracking_url: f.tracking_url || (f.tracking_urls && f.tracking_urls[0]) || null,
        }));
        return { order_id: o.id, name: o.name, fulfillment_status: o.fulfillment_status, shipments: fs };
      }
      case "get_tracking_number": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        return { order_id: o.id, tracking_numbers: (o.fulfillments || []).flatMap((f: any) => f.tracking_numbers || (f.tracking_number ? [f.tracking_number] : [])) };
      }
      case "get_tracking_url": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        return { order_id: o.id, tracking_urls: (o.fulfillments || []).flatMap((f: any) => f.tracking_urls || (f.tracking_url ? [f.tracking_url] : [])) };
      }
      case "get_fulfillment_events": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const out: any[] = [];
        for (const f of o.fulfillments || []) {
          try {
            const r: any = await sreq(ctx, "GET", `/orders/${o.id}/fulfillments/${f.id}/events.json`);
            out.push({ fulfillment_id: f.id, events: r.fulfillment_events || [] });
          } catch { /* skip */ }
        }
        return { order_id: o.id, fulfillments: out };
      }
      case "check_delivery_eta": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const eta = (o.fulfillments || []).map((f: any) => f.estimated_delivery_at).filter(Boolean);
        if (!eta.length) throw new Error("no_eta: Shopify did not record an estimated delivery date for this order. Use the carrier tracking URL for live ETA.");
        return { order_id: o.id, estimated_delivery_at: eta };
      }
      case "check_pickup_point": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const isPickup = JSON.stringify(o.shipping_lines || []).toLowerCase().includes("pickup")
          || (o.fulfillments || []).some((f: any) => String(f.service || "").toLowerCase().includes("pickup"));
        if (!isPickup) throw new Error("not_a_pickup_order: this order is not a local pickup; no pickup point applies.");
        return { order_id: o.id, pickup: true, shipping_lines: o.shipping_lines, location_id: (o.fulfillments || [])[0]?.location_id ?? null };
      }

      // ── Discounts ──
      case "list_discounts": {
        const limit = clampLimit(args.limit, 20, 250);
        const r: any = await sreq(ctx, "GET", `/price_rules.json?limit=${limit}`);
        return r.price_rules || [];
      }
      case "validate_discount": {
        try {
          const r: any = await sreq(ctx, "GET", `/discount_codes/lookup.json?code=${encodeURIComponent(String(args.code || ""))}`);
          const dc = r.discount_code;
          if (!dc) return { code: args.code, valid: false };
          const pr: any = await sreq(ctx, "GET", `/price_rules/${dc.price_rule_id}.json`);
          const rule = pr.price_rule || {};
          const now = Date.now();
          const valid = (!rule.ends_at || new Date(rule.ends_at).getTime() > now)
            && (!rule.starts_at || new Date(rule.starts_at).getTime() <= now);
          return { code: dc.code, valid, value: rule.value, value_type: rule.value_type, starts_at: rule.starts_at, ends_at: rule.ends_at, usage_count: dc.usage_count };
        } catch (e: any) {
          if (/404/.test(e?.message || "")) return { code: args.code, valid: false };
          throw e;
        }
      }
      case "get_customer_discounts": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        const r: any = await sreq(ctx, "GET", `/price_rules.json?limit=250`);
        const mine = (r.price_rules || []).filter((pr: any) =>
          pr.customer_selection === "prerequisite"
          && Array.isArray(pr.prerequisite_customer_ids)
          && pr.prerequisite_customer_ids.map(String).includes(String(c.id)));
        return { customer_id: c.id, price_rules: mine };
      }
      case "create_discount_code":
      case "create_one_time_coupon": {
        return await createDiscount(ctx, {
          code: String(args.code), percentage: Number(args.percentage),
          usage_limit: toolName === "create_one_time_coupon" ? 1 : (args.usage_limit != null ? Number(args.usage_limit) : 1),
          ends_at_iso: args.ends_at_iso ? String(args.ends_at_iso) : undefined,
        });
      }
      case "create_vip_coupon": {
        return await createDiscount(ctx, {
          code: String(args.code), percentage: Number(args.percentage),
          usage_limit: args.usage_limit != null ? Number(args.usage_limit) : 1,
          ends_at_iso: args.ends_at_iso ? String(args.ends_at_iso) : undefined,
          customer_id: args.customer_id ? String(args.customer_id) : undefined,
          title: `VIP ${args.code}`,
        });
      }
      case "disable_coupon": {
        const r: any = await sreq(ctx, "GET", `/discount_codes/lookup.json?code=${encodeURIComponent(String(args.code || ""))}`);
        const dc = r.discount_code;
        if (!dc) throw new Error("coupon_not_found");
        const upd: any = await sreq(ctx, "PUT", `/price_rules/${dc.price_rule_id}.json`, {
          price_rule: { id: dc.price_rule_id, ends_at: new Date().toISOString() },
        });
        return { code: dc.code, disabled: true, price_rule: upd.price_rule };
      }

      // ── Segments (graceful, tag-based proxy for membership) ──
      case "list_segments":
        throw new Error("unsupported_rest: Shopify customer segments are query-defined and only listable via the GraphQL Admin API (`segments`). For membership use customer tags (get_customer_tags / add_tag / remove_tag).");
      case "check_segment_membership":
        throw new Error("unsupported_rest: segment membership is computed dynamically (GraphQL). Use get_customer_tags to read a customer's tag-based segments.");
      case "add_customer_to_segment":
      case "add_retention_segment": {
        const seg = toolName === "add_retention_segment" ? "retention" : String(args.segment || "");
        if (!seg) throw new Error("segment_required");
        return await mutateCustomerTags(ctx, args, seg, "add");
      }
      case "remove_customer_from_segment": {
        const seg = String(args.segment || "");
        if (!seg) throw new Error("segment_required");
        return await mutateCustomerTags(ctx, args, seg, "remove");
      }
      case "add_vip_tag":
        return await mutateCustomerTags(ctx, args, "VIP", "add");

      // ── Products ──
      case "get_product": {
        if (args.product_id) {
          const r: any = await sreq(ctx, "GET", `/products/${encodeURIComponent(String(args.product_id))}.json`);
          return r.product;
        }
        if (args.handle) {
          const r: any = await sreq(ctx, "GET", `/products.json?handle=${encodeURIComponent(String(args.handle))}&limit=1`);
          return r.products?.[0] ?? null;
        }
        throw new Error("product_id_or_handle_required");
      }
      case "search_products": {
        const limit = clampLimit(args.limit, 20, 250);
        const r: any = await sreq(ctx, "GET", `/products.json?limit=${limit}`);
        const q = String(args.query || "").toLowerCase();
        const products = (r.products || []).filter((p: any) =>
          !q || String(p.title || "").toLowerCase().includes(q) || String(p.handle || "").toLowerCase().includes(q));
        return products.slice(0, limit);
      }
      case "inventory_status": {
        if (args.variant_id) {
          const r: any = await sreq(ctx, "GET", `/variants/${encodeURIComponent(String(args.variant_id))}.json`);
          const v = r.variant || {};
          return { variant_id: v.id, sku: v.sku, inventory_quantity: v.inventory_quantity, inventory_management: v.inventory_management };
        }
        if (args.product_id) {
          const r: any = await sreq(ctx, "GET", `/products/${encodeURIComponent(String(args.product_id))}.json`);
          return (r.product?.variants || []).map((v: any) => ({ variant_id: v.id, title: v.title, sku: v.sku, inventory_quantity: v.inventory_quantity }));
        }
        throw new Error("product_id_or_variant_id_required");
      }
      case "variant_information": {
        if (args.variant_id) {
          const r: any = await sreq(ctx, "GET", `/variants/${encodeURIComponent(String(args.variant_id))}.json`);
          return r.variant;
        }
        if (args.product_id) {
          const r: any = await sreq(ctx, "GET", `/products/${encodeURIComponent(String(args.product_id))}.json`);
          return r.product?.variants || [];
        }
        throw new Error("variant_id_or_product_id_required");
      }

      // ── Returns / refunds ──
      case "get_refund_status":
      case "check_refund": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const r: any = await sreq(ctx, "GET", `/orders/${o.id}/refunds.json`);
        const refunds = (r.refunds || []).map((rf: any) => ({
          id: rf.id, created_at: rf.created_at, note: rf.note,
          amount: (rf.transactions || []).reduce((s: number, tx: any) => s + (Number(tx.amount) || 0), 0),
          restocked: (rf.refund_line_items || []).some((li: any) => li.restock_type && li.restock_type !== "no_restock"),
        }));
        return { order_id: o.id, name: o.name, financial_status: o.financial_status, refunds };
      }
      case "check_return_status": {
        // Best-effort: surface refunds (REST) + a clear note that full return
        // objects need GraphQL/ReturnGO.
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const r: any = await sreq(ctx, "GET", `/orders/${o.id}/refunds.json`);
        return {
          order_id: o.id, name: o.name, fulfillment_status: o.fulfillment_status,
          refunds_count: (r.refunds || []).length,
          note: "Refund records shown. Full Shopify Returns (RMA) objects require the GraphQL Admin API or ReturnGO; not available via REST tools.",
        };
      }
      case "get_returns": {
        // Real RMA data via the GraphQL Admin API. Requires the `read_returns`
        // OAuth scope - stores connected before that scope was requested throw
        // a clear access_denied that prompts a re-connect.
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const data = await shopifyGraphQL(ctx, RETURNS_QUERY, { id: orderGid(o.id) });
        const returns = mapReturns(data?.order?.returns?.nodes);
        return { order_id: o.id, name: o.name, returns_count: returns.length, returns };
      }
      case "get_return_reason": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const data = await shopifyGraphQL(ctx, RETURNS_QUERY, { id: orderGid(o.id) });
        const reasons: any[] = [];
        for (const rn of mapReturns(data?.order?.returns?.nodes)) {
          for (const li of rn.line_items) {
            reasons.push({ return_id: rn.id, return_status: rn.status, title: li.title, sku: li.sku, quantity: li.quantity, reason: li.reason, reason_note: li.reason_note });
          }
        }
        if (!reasons.length) return { order_id: o.id, name: o.name, reasons: [], note: "No returns are recorded against this order." };
        return { order_id: o.id, name: o.name, reasons };
      }

      // ── Composites ──
      case "get_customer": // already handled above, but keep exhaustive
        return await resolveCustomer(ctx, args);
      case "summarize_customer": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        const orders = await customerOrders(ctx, { customer_id: String(c.id) }, { limit: 5, status: "any" });
        return {
          customer: { id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" "), email: c.email, phone: c.phone, tags: splitTags(c.tags), note: c.note, orders_count: c.orders_count, total_spent: c.total_spent, currency: c.currency },
          recent_orders: (orders as any[]).map((o) => ({ id: o.id, name: o.name, created_at: o.created_at, total_price: o.total_price, financial_status: o.financial_status, fulfillment_status: o.fulfillment_status })),
        };
      }
      case "get_customer_health": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        const orders = (await customerOrders(ctx, { customer_id: String(c.id) }, { limit: 50, status: "any" })) as any[];
        const ordersCount = Number(c.orders_count ?? orders.length) || 0;
        const totalSpent = Number(c.total_spent ?? 0) || 0;
        const last = orders[0];
        const lastDays = last?.created_at ? Math.floor((Date.now() - new Date(last.created_at).getTime()) / 86400000) : null;
        const refunded = orders.filter((o) => o.financial_status === "refunded" || o.financial_status === "partially_refunded").length;
        let health: "strong" | "healthy" | "at_risk" | "dormant" | "new" = "new";
        if (ordersCount === 0) health = "new";
        else if (lastDays != null && lastDays > 180) health = "dormant";
        else if (lastDays != null && lastDays > 90) health = "at_risk";
        else if (ordersCount >= 3 || totalSpent > 300) health = "strong";
        else health = "healthy";
        return { customer_id: c.id, health, orders_count: ordersCount, total_spent: totalSpent, currency: c.currency, days_since_last_order: lastDays, refunded_orders: refunded, tags: splitTags(c.tags) };
      }
      case "find_latest_order": {
        const orders = (await customerOrders(ctx, args, { limit: 1, status: "any" })) as any[];
        if (!orders.length) throw new Error("no_orders_found");
        return orders[0];
      }
      case "find_delayed_order": {
        const olderDays = args.older_than_days != null ? Number(args.older_than_days) : 5;
        const cutoff = Date.now() - olderDays * 86400000;
        const orders = (await customerOrders(ctx, args, { limit: 50, status: "any" })) as any[];
        const delayed = orders.filter((o) =>
          (o.fulfillment_status == null || o.fulfillment_status === "partial")
          && o.created_at && new Date(o.created_at).getTime() < cutoff
          && o.cancelled_at == null);
        return { older_than_days: olderDays, delayed_count: delayed.length, orders: delayed };
      }
      case "issue_compensation_coupon": {
        const c = await resolveCustomer(ctx, args).catch(() => null);
        // Idempotent retry: if the code already exists (a prior attempt
        // succeeded but its result was lost), return it instead of failing
        // the whole approval on Shopify's duplicate-code 422.
        const existing = await lookupDiscountCode(ctx, String(args.code));
        if (existing) {
          return {
            code: existing.code, price_rule_id: existing.price_rule_id,
            percentage: Number(args.percentage), customer_id: c?.id ?? null,
            already_existed: true,
          };
        }
        const disc = await createDiscount(ctx, {
          code: String(args.code), percentage: Number(args.percentage),
          usage_limit: 1, ends_at_iso: args.ends_at_iso ? String(args.ends_at_iso) : undefined,
          customer_id: c ? String(c.id) : undefined, title: `Compensation ${args.code}`,
        });
        let tagged = false;
        if (c) { await mutateCustomerTags(ctx, { customer_id: String(c.id) }, "compensation", "add").catch(() => {}); tagged = true; }
        return { ...disc, customer_id: c?.id ?? null, tagged_compensation: tagged };
      }

      case "update_order_fulfillment": {
        // Declared for years but never implemented - calls fell through to
        // unknown_shopify_tool. Non-destructive ops handoff: append a note
        // and/or add a tag on the order.
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const note = args.note ? String(args.note) : "";
        const tag = args.tag ? String(args.tag) : "";
        if (!note && !tag) throw new Error("note_or_tag_required");
        const upd: any = { id: o.id };
        if (note) upd.note = o.note ? `${o.note}\n${note}` : note;
        if (tag) {
          const cur = splitTags(o.tags);
          upd.tags = (cur.includes(tag) ? cur : [...cur, tag]).join(", ");
        }
        const r: any = await sreq(ctx, "PUT", `/orders/${o.id}.json`, { order: upd });
        return { order_id: o.id, name: o.name, note: r.order?.note ?? null, tags: splitTags(r.order?.tags) };
      }

      case "process_refund": {
        // Real money movement: Shopify's two-step calculate → create flow.
        // Full refund by default; partial via `amount` or `line_items`.
        // Success is verified against the created refund object and the
        // re-fetched order, and gateway transaction status is reported so
        // callers can distinguish "processed" from "pending".
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        if (o.cancelled_at && String(o.financial_status) === "refunded") {
          return { order_id: o.id, name: o.name, already_refunded: true, financial_status: o.financial_status };
        }
        if (String(o.financial_status) === "refunded") {
          return { order_id: o.id, name: o.name, already_refunded: true, financial_status: o.financial_status };
        }
        return await executeRefund(ctx, o, args);
      }

      default:
        throw new Error(`unknown_shopify_tool:${toolName}`);
    }
  },
};

// ─── Internal helpers ───────────────────────────────────────

interface Ctx { token: string; base: string; }

/**
 * Shopify's two-step refund flow (calculate → create) with refundable-maximum
 * validation and gateway-transaction verification. Shared by `process_refund`
 * and by `cancel_order {refund:true}` - the REST cancel endpoint silently
 * IGNORES a boolean `refund` param (live-verified 2026-07-20: order #1004
 * cancelled but stayed `paid`), so cancel-with-refund must run this flow
 * explicitly after the cancellation.
 */
async function executeRefund(ctx: Ctx, o: any, args: Record<string, any>): Promise<any> {
  // Prior refunds → remaining refundable quantities and amount.
  const prior: any = await sreq(ctx, "GET", `/orders/${o.id}/refunds.json`);
  const refundedQty: Record<string, number> = {};
  let refundedAmount = 0;
  for (const rf of prior.refunds || []) {
    for (const rli of rf.refund_line_items || []) {
      refundedQty[String(rli.line_item_id)] = (refundedQty[String(rli.line_item_id)] || 0) + Number(rli.quantity || 0);
    }
    for (const tx of rf.transactions || []) {
      if (tx.kind === "refund" && tx.status !== "failure" && tx.status !== "error") refundedAmount += Number(tx.amount || 0);
    }
  }

  const isPartialAmount = args.amount != null;
  const restockType = args.restock ? "restock" : "no_restock";
  let refundLineItems: Array<{ line_item_id: number; quantity: number; restock_type: string }> = [];
  if (Array.isArray(args.line_items) && args.line_items.length) {
    refundLineItems = args.line_items.map((li: any) => ({
      line_item_id: Number(li.line_item_id),
      quantity: Number(li.quantity || 1),
      restock_type: restockType,
    }));
    for (const li of refundLineItems) {
      if (!Number.isFinite(li.line_item_id) || !(li.quantity > 0)) throw new Error("refund_line_items_invalid");
    }
  } else if (!isPartialAmount) {
    // Full refund: every line item's remaining quantity.
    refundLineItems = (o.line_items || [])
      .map((li: any) => ({
        line_item_id: Number(li.id),
        quantity: Number(li.quantity || 0) - (refundedQty[String(li.id)] || 0),
        restock_type: restockType,
      }))
      .filter((li: { quantity: number }) => li.quantity > 0);
    if (!refundLineItems.length && refundedAmount > 0) {
      return { order_id: o.id, name: o.name, already_refunded: true, refunded_amount: refundedAmount, financial_status: o.financial_status };
    }
  }

  // Ask Shopify what is actually refundable (per-gateway transactions,
  // shipping, taxes) instead of guessing.
  const wantShipping = args.refund_shipping != null ? !!args.refund_shipping : !isPartialAmount;
  const calcBody: any = { refund: { currency: o.currency } };
  if (refundLineItems.length) calcBody.refund.refund_line_items = refundLineItems;
  if (wantShipping) calcBody.refund.shipping = { full_refund: true };
  const calc: any = await sreq(ctx, "POST", `/orders/${o.id}/refunds/calculate.json`, calcBody);
  const suggested = calc.refund;
  if (!suggested) throw new Error("refund_calculate_empty: Shopify returned no suggested refund");

  let transactions: Array<{ parent_id: number; amount: string; kind: string; gateway?: string }> =
    (suggested.transactions || []).map((tx: any) => ({
      parent_id: tx.parent_id, amount: tx.amount, kind: "refund", gateway: tx.gateway,
    }));
  const maxRefundable = transactions.reduce((s, t) => s + Number(t.amount || 0), 0);
  if (isPartialAmount) {
    const requested = Number(args.amount);
    if (!(requested > 0)) throw new Error("refund_amount_invalid");
    if (requested > maxRefundable + 0.005) {
      throw new Error(`refund_exceeds_refundable: requested ${requested} ${o.currency} but only ${maxRefundable.toFixed(2)} ${o.currency} is refundable`);
    }
    if (!transactions.length) throw new Error("refund_no_refundable_transaction");
    transactions = [{ ...transactions[0], amount: requested.toFixed(2) }];
  }
  if (!transactions.length) throw new Error("nothing_to_refund");

  const createBody: any = {
    refund: {
      currency: suggested.currency || o.currency,
      notify: args.notify != null ? !!args.notify : true,
      note: args.note ? String(args.note) : `GOTCHA refund${args.reason ? `: ${String(args.reason)}` : ""}`,
      transactions,
    },
  };
  if (refundLineItems.length) createBody.refund.refund_line_items = refundLineItems;
  if (wantShipping && suggested.shipping?.amount && Number(suggested.shipping.amount) > 0) {
    createBody.refund.shipping = { amount: suggested.shipping.amount };
  }
  const created: any = await sreq(ctx, "POST", `/orders/${o.id}/refunds.json`, createBody);
  const refund = created.refund;
  if (!refund?.id) throw new Error("refund_not_created: Shopify returned no refund object");

  // Verify the business state actually changed before anyone tells a
  // customer their money is on the way.
  const verify: any = await sreq(ctx, "GET", `/orders/${o.id}.json`);
  const txStatuses = (refund.transactions || []).map((tx: any) => ({ id: tx.id, status: tx.status, amount: tx.amount, gateway: tx.gateway }));
  const allProcessed = txStatuses.length > 0 && txStatuses.every((t: any) => t.status === "success");
  return {
    order_id: o.id,
    name: o.name,
    refund_id: refund.id,
    amount: (refund.transactions || []).reduce((s: number, t: any) => s + Number(t.amount || 0), 0),
    currency: suggested.currency || o.currency,
    transactions: txStatuses,
    // "processed" = gateway confirmed; "pending" = accepted but money not moved yet.
    refund_status: allProcessed ? "processed" : "pending",
    financial_status: verify.order?.financial_status ?? null,
    processed_at: refund.processed_at ?? null,
  };
}

async function sreq(ctx: Ctx, method: string, path: string, body?: unknown): Promise<any> {
  return shopifyRequest(ctx.token, method, `${ctx.base}${path}`, body);
}

function clampLimit(v: unknown, def: number, max: number): number {
  const n = Number(v ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function splitTags(tags: unknown): string[] {
  return String(tags || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Resolve a customer record from { customer_id | email | phone }. */
async function resolveCustomer(ctx: Ctx, args: Record<string, any>): Promise<any | null> {
  if (args.customer_id) {
    const r = await sreq(ctx, "GET", `/customers/${encodeURIComponent(String(args.customer_id))}.json`);
    return r.customer ?? null;
  }
  if (args.email) return customerByQuery(ctx, `email:${String(args.email)}`);
  if (args.phone) return customerByQuery(ctx, `phone:${String(args.phone)}`);
  throw new Error("customer_id_email_or_phone_required");
}

async function customerByQuery(ctx: Ctx, query: string): Promise<any | null> {
  const r = await sreq(ctx, "GET", `/customers/search.json?query=${encodeURIComponent(query)}&limit=1`);
  return r.customers?.[0] ?? null;
}

async function customerOrders(ctx: Ctx, args: Record<string, any>, opts: { limit: number; status: string }): Promise<any[]> {
  // Resolve the customer's email (orders are queried by email in REST) unless
  // an email was passed directly.
  let email = args.email ? String(args.email) : null;
  if (!email && (args.customer_id || args.phone)) {
    const c = await resolveCustomer(ctx, args);
    email = c?.email ?? null;
  }
  if (!email) return [];
  const params = new URLSearchParams();
  params.set("email", email);
  params.set("status", opts.status);
  params.set("limit", String(opts.limit));
  const r = await sreq(ctx, "GET", `/orders.json?${params}`);
  return r.orders || [];
}

/** Resolve an order from { order_id | order_name }. */
async function resolveOrder(ctx: Ctx, args: Record<string, any>): Promise<any | null> {
  if (args.order_id) {
    const r = await sreq(ctx, "GET", `/orders/${encodeURIComponent(String(args.order_id))}.json`);
    return r.order ?? null;
  }
  if (args.order_name) {
    const r = await sreq(ctx, "GET", `/orders.json?name=${encodeURIComponent(String(args.order_name).replace(/^#/, ""))}&status=any&limit=1`);
    return r.orders?.[0] ?? null;
  }
  throw new Error("order_id_or_name_required");
}

async function mutateCustomerTags(ctx: Ctx, args: Record<string, any>, tag: string, op: "add" | "remove"): Promise<any> {
  const c = await resolveCustomer(ctx, args);
  if (!c) throw new Error("customer_not_found");
  const cur = splitTags(c.tags);
  let next: string[];
  if (op === "add") next = cur.includes(tag) ? cur : [...cur, tag];
  else next = cur.filter((x) => x.toLowerCase() !== tag.toLowerCase());
  const r = await sreq(ctx, "PUT", `/customers/${c.id}.json`, { customer: { id: c.id, tags: next.join(", ") } });
  return { customer_id: c.id, tags: splitTags(r.customer?.tags) };
}

/** Look up an existing discount code; null when it doesn't exist (404). */
async function lookupDiscountCode(ctx: Ctx, code: string): Promise<{ code: string; price_rule_id: number } | null> {
  try {
    const r: any = await sreq(ctx, "GET", `/discount_codes/lookup.json?code=${encodeURIComponent(code)}`);
    const dc = r.discount_code;
    return dc ? { code: dc.code, price_rule_id: dc.price_rule_id } : null;
  } catch (err: any) {
    if (/404/.test(err?.message || "")) return null;
    throw err;
  }
}

async function createDiscount(ctx: Ctx, opts: { code: string; percentage: number; usage_limit?: number; ends_at_iso?: string; customer_id?: string; title?: string }): Promise<any> {
  const priceRule: any = {
    title: opts.title || `Bot ${opts.code}`,
    target_type: "line_item",
    target_selection: "all",
    allocation_method: "across",
    value_type: "percentage",
    value: String(-Math.abs(Number(opts.percentage))),
    customer_selection: "all",
    usage_limit: opts.usage_limit != null ? opts.usage_limit : 1,
    starts_at: new Date().toISOString(),
    ...(opts.ends_at_iso ? { ends_at: opts.ends_at_iso } : {}),
  };
  if (opts.customer_id) {
    priceRule.customer_selection = "prerequisite";
    priceRule.prerequisite_customer_ids = [Number(opts.customer_id)];
  }
  const pr = await sreq(ctx, "POST", `/price_rules.json`, { price_rule: priceRule });
  const priceRuleId = pr.price_rule.id;
  const code = await sreq(ctx, "POST", `/price_rules/${priceRuleId}/discount_codes.json`, { discount_code: { code: opts.code } });
  return { code: code.discount_code.code, price_rule_id: priceRuleId, percentage: Math.abs(Number(opts.percentage)) };
}

// ─── GraphQL (Returns / RMA) ────────────────────────────────
//
// The Shopify Returns object has no REST endpoint - it only exists on the
// GraphQL Admin API. We use it for get_returns / get_return_reason. Needs the
// `read_returns` scope (requested in the OAuth init); older connections that
// predate it get a clear access_denied that points at re-connecting.

function orderGid(id: string | number): string {
  return `gid://shopify/Order/${id}`;
}

const RETURNS_QUERY = `
  query OrderReturns($id: ID!) {
    order(id: $id) {
      id
      name
      returns(first: 20) {
        nodes {
          id
          name
          status
          totalQuantity
          returnLineItems(first: 50) {
            nodes {
              ... on ReturnLineItem {
                id
                quantity
                returnReason
                returnReasonNote
                fulfillmentLineItem { lineItem { title sku } }
              }
            }
          }
        }
      }
    }
  }`;

/** Normalize the GraphQL returns connection into a flat, LLM-friendly shape. */
function mapReturns(nodes: any[] | undefined): any[] {
  return (nodes || []).map((rn: any) => ({
    id: rn.id,
    name: rn.name,
    status: rn.status, // OPEN | CLOSED | DECLINED | CANCELED | REQUESTED ...
    total_quantity: rn.totalQuantity,
    line_items: (rn.returnLineItems?.nodes || []).map((li: any) => ({
      title: li.fulfillmentLineItem?.lineItem?.title ?? null,
      sku: li.fulfillmentLineItem?.lineItem?.sku ?? null,
      quantity: li.quantity,
      reason: li.returnReason ?? null,
      reason_note: li.returnReasonNote ?? null,
    })),
  }));
}

async function shopifyGraphQL(ctx: Ctx, query: string, variables: Record<string, unknown>): Promise<any> {
  // SSRF guard: ctx.base derives from config.shopDomain (re-validated at the
  // sink, not just at connect time).
  await assertPublicUrl(`${ctx.base}/graphql.json`);
  const res = await fetch(`${ctx.base}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": ctx.token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`shopify_${res.status}: ${text.slice(0, 240)}`);
  }
  const j: any = await res.json();
  if (Array.isArray(j.errors) && j.errors.length) {
    const msg = j.errors.map((e: any) => e?.message).filter(Boolean).join("; ");
    if (/access denied|read_returns|not approved|requires merchant approval/i.test(msg)) {
      throw new Error(`shopify_graphql_access_denied: ${msg.slice(0, 160)} - re-connect Shopify to grant the read_returns scope.`);
    }
    throw new Error(`shopify_graphql_error: ${msg.slice(0, 200)}`);
  }
  return j.data;
}

async function shopifyRequest(token: string, method: string, url: string, body?: unknown): Promise<any> {
  // SSRF guard: url derives from config.shopDomain (per-tenant, stored).
  await assertPublicUrl(url);
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
