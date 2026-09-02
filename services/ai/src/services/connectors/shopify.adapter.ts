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
 * TRANSPORT: Admin GraphQL, everywhere. App Store requirement 2.2.4 forbids
 * core Admin REST, and the sixty REST calls this file used to make now live in
 * six focused modules - shopify-gql-{shop,products,customers,orders,fulfillment,
 * discounts,refunds}.ts - behind mappers that keep the REST-era shapes their
 * callers already read. There is no REST fallback anywhere: a GraphQL failure
 * surfaces as a failure rather than degrading into a second, quieter code path
 * with different behaviour. The only Shopify call left outside GraphQL is the
 * OAuth `access_scopes.json` probe in validate(), which is not an Admin API
 * resource - see the note there.
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
import { assertPublicUrl, shopifyApiVersion, checkShopifyResponseVersion } from "@chatcenter/shared";
import { orderIdentifierFromArgs } from "./shopify-order-identifier";
import { reconcile } from "./shopify-item-reconciliation";
import { validateProfilePatch, verifyReadBack, detectDuplicate } from "./shopify-profile-update";
import { SELF_SCOPE_KEY } from "./customer-access-guard";
import { normalizeGrantedScopes } from "./shopify-scopes";
import {
  assessMutability,
  validateShippingAddress,
  verifyShippingAddress,
} from "./shopify-order-mutability";
import { quoteExchange, verifyExchange } from "./shopify-exchange";
import { getShop } from "./shopify-gql-shop";
import { escapeSearchValue } from "./shopify-graphql";
import {
  getOrderById,
  getOrderByName,
  searchOrders,
  updateOrder,
  // Aliased: the adapter has its own same-named handler wrapping validation,
  // approval and read-back around this one mutation.
  updateOrderShippingAddress as writeOrderShippingAddress,
} from "./shopify-gql-orders";
import {
  getDiscountByCode,
  listDiscounts,
  createDiscount as createGqlDiscount,
  deactivateDiscount,
} from "./shopify-gql-discounts";
import { suggestRefund, createRefund, listOrderRefunds } from "./shopify-gql-refunds";
import { getFulfillmentOrders, getFulfillmentEvents, listLocations, getFulfillmentLocations } from "./shopify-gql-fulfillment";
import {
  getCustomerById,
  searchCustomers,
  findCustomerByField,
  getCustomerMetafields,
  createCustomer,
  updateCustomer,
  mutateTags,
  writeCustomerAddress,
  setCustomerMetafield,
} from "./shopify-gql-customers";
import {
  getProductById,
  getProductByHandle,
  getProductImages,
  getVariantById,
  findProductByTitle,
} from "./shopify-gql-products";

/**
 * Resolved from the ONE shared declaration, not pinned here. This used to be a
 * local `const API_VERSION = "2024-04"` - roughly 15 months past end of support,
 * which Shopify served by silently falling forward to whatever its oldest
 * accessible version happened to be that quarter. See
 * packages/shared/src/lib/shopify-api-version.ts for the full reasoning.
 *
 * Read lazily: `shopifyApiVersion()` throws on a malformed override, and doing
 * that at module-import time would take the whole service down at boot for a
 * typo in an env var rather than at the first Shopify call.
 */
const apiVersion = (): string => shopifyApiVersion();

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

/**
 * Say, in prose, that one of the two identifiers is required.
 *
 * This CANNOT be expressed in the schema. JSON Schema's `anyOf` is the natural
 * way to write "one of these two", and OpenAI rejects it outright:
 *
 *   400 Invalid schema for function 'shopify__cancel_order': schema must have
 *   type 'object' and not have 'oneOf'/'anyOf'/'allOf'/... at the top level
 *
 * I shipped `anyOf` first and it broke every turn for this tenant - the whole
 * request 400s, so the model gets no tools at all and can only hand the
 * customer to a human. Exactly the failure it was meant to prevent, by a
 * different route.
 *
 * `required` cannot express it either (it is AND, not OR), so the constraint
 * lives in two places that DO work: the description the model reads, and the
 * dispatch-time check in agent-tools.ts that refuses to raise an approval for
 * a call with no arguments. Prose plus enforcement, rather than a schema the
 * API will not accept.
 */
function withOrderTarget(def: ToolDefinition): ToolDefinition {
  const params = def.parameters as Record<string, unknown>;
  const props = { ...(params.properties as Record<string, any> | undefined) };
  const note = " REQUIRED: supply either order_id or order_name (the customer's order number, e.g. #1006).";
  if (props.order_id) props.order_id = { ...props.order_id, description: `${props.order_id.description ?? ""} One of order_id or order_name is REQUIRED.`.trim() };
  if (props.order_name) props.order_name = { ...props.order_name, description: `${props.order_name.description ?? ""} One of order_id or order_name is REQUIRED.`.trim() };
  return {
    ...def,
    description: `${def.description}${note}`,
    parameters: { ...params, properties: props },
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
  // The customer editing THEIR OWN details.
  //
  // Note what is NOT in the schema: there is no customer_id, no email and no
  // phone selector. That is the whole security design - the record acted on is
  // derived from the authenticated channel by customer-access-guard.ts, so a
  // model that wanted to edit someone else's profile has no argument through
  // which to say so. `update_customer` above keeps its selector and stays for
  // internal and human-agent use, where the operator legitimately picks who.
  t("update_my_profile", "WRITE", "MEDIUM",
    "Update the CURRENT customer's own Shopify profile: name, email, phone and default address. Reads the record back afterwards and reports exactly which fields changed.",
    "The customer asks to change their own details (\"תעדכנו לי את המייל\", \"הכתובת שלי השתנתה\", \"change my phone number\"). You do NOT need their customer id, and you must not ask for one - the system knows who they are. Confirm the NEW value with them before calling, then report only the fields the read-back confirms.",
    {
      first_name: { type: "string" },
      last_name: { type: "string" },
      email: { type: "string", description: "New email. Sensitive: it can change how this customer is identified later." },
      phone: { type: "string", description: "New phone. Sensitive: it can change how this customer is identified later." },
      address: {
        type: "object",
        description: "Default address fields to change: address1, address2, city, province, zip, country, company, phone. This is the customer's SAVED address, not the shipping address of an existing order.",
      },
    }, undefined,
    { sideEffects: "Mutates the customer's own Shopify record.", priority: 80 }),
  t("add_tag", "WRITE", "LOW", "Add a tag to a customer (existing tags preserved).",
    "You want to label/segment a customer (e.g. VIP, retention).",
    { ...P.customerSel, tag: { type: "string" } }, ["tag"]),
  t("remove_tag", "WRITE", "LOW", "Remove a tag from a customer.",
    "A customer no longer belongs to a tag-based segment.",
    { ...P.customerSel, tag: { type: "string" } }, ["tag"]),
  t("update_metafield", "WRITE", "MEDIUM", "Set a customer metafield (custom data).",
    "You need to store a custom attribute on the customer.",
    { ...P.customerSel, namespace: { type: "string" }, key: { type: "string" }, value: { type: "string" }, type: { type: "string", description: "Metafield type, default single_line_text_field." } }, ["namespace", "key", "value"]),
  t("create_note", "WRITE", "LOW", "Append a note to the CUSTOMER's profile note field (not an order).",
    "Record something about the PERSON that is true across all their orders. If the customer is talking about a specific order, use add_order_note instead - this tool writes the customer record and the order will still show no note.",
    { ...P.customerSel, note: { type: "string" } }, ["note"]),
  t("add_order_note", "WRITE", "LOW", "Add a note and/or tags to a specific ORDER, then verify it was applied.",
    "Customer asks you to write something on their order (\"תרשמו בהזמנה ש...\", \"add a note to my order\"). This is the tool for anything order-specific. A note RECORDS information on the order - it does not notify anyone, create a task, or guarantee a callback, so never describe it as telling a team.",
    { ...P.orderSel, note: { type: "string" }, tags: { type: "string", description: "Comma-separated tags to add. Existing tags are preserved." } },
    undefined, { priority: 80 }),

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
  // A missing-item complaint is an ARITHMETIC question - ordered minus shipped
  // minus refunded, per line - and the model was answering it by asking the
  // customer which item they meant, or by re-verifying an identity it already
  // had. One call now returns the whole comparison, including which item (if
  // any) is unambiguously the one being complained about.
  t("reconcile_order_items", "READ", "LOW",
    "Compare what was ORDERED against what was actually shipped, still pending, cancelled or refunded, line by line. Returns per-item quantities plus which item the complaint can only be about.",
    "Customer says something is missing, short, or did not arrive (\"חסר לי פריט\", \"קיבלתי רק חלק מההזמנה\", \"item missing from my order\"). Call this FIRST - before asking the customer which item they mean, and without asking them to verify their identity again. Only ask which item is missing if `ambiguous` is true.",
    P.orderSel, undefined, { priority: 90 }),

  // ── Orders (actions) ──
  withOrderTarget(t("cancel_order", "ACTION", "HIGH", "Cancel an order (optionally refund + restock).",
    "Customer asks to cancel their order. FIRST check the order is not already fulfilled (get_fulfillment_status or get_order): a fulfilled order CANNOT be cancelled, and process_refund plus a return is the correct action instead - proposing a cancel anyway wastes a human approval on something that will be refused. Approval is handled by the system: calling this tool is what RAISES the approval, so call it whenever the customer's request warrants it. Never wait for approval before calling, and never hand the conversation to a human merely because approval is needed.",
    { ...P.orderSel, reason: { type: "string", enum: ["customer", "fraud", "inventory", "declined", "other"] }, refund: { type: "boolean" }, restock: { type: "boolean" } }, undefined,
    { sideEffects: "Cancels the order - may trigger a refund. Irreversible." })),
  // Changing where an order is going, which is only possible before it goes.
  //
  // Separate from the customer's SAVED address (update_my_profile) on purpose:
  // they are different objects with different consequences, and a customer who
  // has moved usually wants both. Conflating them silently changes one and
  // reports the other.
  withOrderTarget(t("update_order_shipping_address", "ACTION", "HIGH",
    "Change the shipping address of an order that has NOT been dispatched, then read the order back and verify the address.",
    "Customer asks to change where an existing order is being sent (\"תשנו לי את הכתובת בהזמנה\", \"change the delivery address for order 1011\"). Eligibility is checked from fulfillment orders, not from fulfillment_status - if the order is already being prepared this tool refuses, and you must NOT claim the address was changed or that a carrier was contacted. Approval is handled by the system: calling this tool is what RAISES the approval, so call it whenever the customer's request warrants it.",
    {
      ...P.orderSel,
      address: {
        type: "object",
        description: "The FULL new address: address1, address2, city, province, zip, country, phone, first_name, last_name. address1, city and country are required.",
      },
    }, undefined,
    { sideEffects: "Changes where a placed order will be delivered.", priority: 84 })),
  withOrderTarget(t("send_invoice", "ACTION", "MEDIUM", "Send/resend the order invoice email to the customer.",
    "Customer didn't receive their invoice / needs the payment link again.",
    { ...P.orderSel, to: { type: "string", description: "Override recipient email." } })),
  // No longer `unsupported`. That flag was set on the strength of the REST gap,
  // and the GraphQL mutation that does work went unnoticed behind it - so a
  // capability the product HAS was declared missing, and the tool short-
  // circuited before ever reaching an API.
  withOrderTarget(t("resend_confirmation", "ACTION", "MEDIUM", "Resend the order confirmation email to the address on the order.",
    "Customer says they never got the confirmation email. It goes to the address already on the order - you cannot redirect it, and must not ask where to send it. This is an order confirmation, NOT a tax invoice.", P.orderSel)),
  // "156 → 159", before anything ships.
  //
  // Narrower than edit_order on purpose: one line item, one replacement
  // variant, a quantity. A general order editor in a customer conversation is
  // a way to rewrite someone's order by accident; this can only ever swap one
  // thing the customer already bought for another thing in the same shop.
  withOrderTarget(t("exchange_order_item", "ACTION", "HIGH",
    "Replace one line item on an UNDISPATCHED order with a different variant or product, then read the order back and verify both sides of the swap.",
    "Customer wants a different size, colour or variant of something they already ordered and it has not shipped (\"אפשר להחליף למידה 159?\", \"can I swap it for the black one?\"). Call variant_information FIRST so you know the replacement exists and is in stock. This refuses when the price differs - an order edit does not settle its own payment, so a cheaper or dearer swap has to be handled by a person. It also refuses once fulfillment has started, where the correct route is a return plus a replacement. Approval is handled by the system: calling this tool is what RAISES the approval.",
    {
      ...P.orderSel,
      line_item_id: { type: "string", description: "The order line to replace. Omit on a single-line order." },
      current_variant_id: { type: "string", description: "Alternative to line_item_id: the variant currently on the order." },
      new_variant_id: { type: "string", description: "The replacement variant id (from variant_information)." },
      // Accepting the NAME as well as the id, for the same reason
      // variant_information had to: a tool that only takes an id makes the
      // model do a lookup first, and when it skips the lookup it raises an
      // approval that cannot succeed. Live (2026-08-02): a human approved an
      // exchange whose arguments were `{quantity: 1, order_name: "1012"}` -
      // no replacement at all - and it failed with variant_not_found.
      new_variant_name: { type: "string", description: "The replacement option as the customer said it, e.g. \"Dawn\" or \"159\". Use this when you do not have an id." },
      quantity: { type: "number", description: "How many units to swap. Default: all of that line." },
    }, undefined,
    { sideEffects: "Rewrites what a placed order contains.", priority: 84 })),
  // `edit_order` used to sit here. It was declared in June, never implemented -
  // its whole execution branch was `throw new Error("unsupported_rest: ...")` -
  // and `exchange_order_item` above replaced it in August. Both stayed in the
  // catalogue as equals, so an agent created later was granted the dead one and
  // not its replacement. On 2026-08-26 a customer asked to change the colour of
  // an unshipped order, the model reached for the only tool it had been given,
  // was refused at dispatch, and was escalated to a human for a swap the store
  // could have made. Deleted rather than left declared-unsupported: a tool that
  // cannot run has no business being grantable.
  //
  // If a general order editor is ever needed, it needs orderEditBegin /
  // orderEditCommit over GraphQL, and it should still not be handed to a
  // customer-facing agent - see the note on exchange_order_item.

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
    "Customer asks 'is code X still valid?'.", { code: { type: "string" } }, ["code"],
    { priority: 85 }),
  t("get_customer_discounts", "READ", "LOW", "List discounts targeted at a specific customer.",
    "Customer asks what discounts they personally have.", P.customerSel),
  t("create_discount_code", "WRITE", "HIGH", "Create a percentage-off discount code.",
    "Customer is being offered a documented discount. Approval is handled by the system: calling this tool is what RAISES the approval, so call it whenever the customer's request warrants it. Never wait for approval before calling, and never hand the conversation to a human merely because approval is needed.",
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
  // Documented as unsupported over REST, so these are the cheapest thing to
  // lose when the surface has to be cut - and they were surviving on nothing
  // but an early letter while live shopper tools were dropped.
  t("list_segments", "READ", "LOW", "List customer segments (GraphQL - degrades gracefully).",
    "You want the store's segments. Prefer customer tags for membership ops.", { limit: { type: "number" } }, undefined, { unsupported: "Segments are not exposed over the REST Admin API.", priority: 10 }),
  t("check_segment_membership", "READ", "LOW", "Check whether a customer is in a segment (degrades gracefully).",
    "You want to know a customer's segment. Prefer get_customer_tags.", { ...P.customerSel, segment: { type: "string" } }, undefined, { unsupported: "Segments are not exposed over the REST Admin API.", priority: 10 }),
  t("add_customer_to_segment", "WRITE", "LOW", "Add a customer to a (tag-based) segment.",
    "Place a customer into a segment. Implemented via customer tags.",
    { ...P.customerSel, segment: { type: "string" } }, ["segment"]),
  t("remove_customer_from_segment", "WRITE", "LOW", "Remove a customer from a (tag-based) segment.",
    "Take a customer out of a segment. Implemented via customer tags.",
    { ...P.customerSel, segment: { type: "string" } }, ["segment"]),

  // ── Shop ──
  t("get_shop", "READ", "LOW", "Get the store's name, primary domain and currency.",
    "You need the shop's currency or canonical storefront domain (e.g. to build a product link or price a card).", {}),

  // ── Products ──
  t("get_product", "READ", "LOW", "Get a product by id or handle.",
    "Customer asks about a specific product.", { product_id: { type: "string" }, handle: { type: "string" } }),
  // The price bounds are not decoration. Without them this tool could only be
  // asked "find me snowboards", never "find me snowboards under 600", so a
  // shopper who named a budget got the catalogue in Shopify's own order and was
  // then TOLD, in prose, that none of it fitted. Live on the Urban Supply
  // store: three boards at 949.95 / 885.95 / 749.95 offered against a 600
  // budget, four turns running, while the one board at 600.00 was never shown.
  t("search_products", "READ", "LOW",
    "Search products by title, vendor, product type, tag or SKU, optionally bounded by price and stock.",
    "Customer asks 'do you sell X?' or you need candidates to recommend. When the customer has named a budget, ALWAYS pass price_max - do not filter it yourself afterwards and do not claim to have searched within a budget you did not pass.",
    {
      query: { type: "string" },
      limit: { type: "number" },
      status: { type: "string", enum: ["active", "any"], description: "Default 'active' - only products a shopper can actually buy." },
      price_max: { type: "number", description: "Upper bound on price, in the STORE's currency. Inclusive." },
      price_min: { type: "number", description: "Lower bound on price, in the STORE's currency. Inclusive." },
      in_stock_only: { type: "boolean", description: "Default true - exclude products with no buyable variant." },
      product_type: { type: "string", description: "Exact category, from the store's own list. See the catalogue block in your context." },
      vendor: { type: "string", description: "Exact brand, from the store's own list." },
      tag: { type: "string", description: "Exact tag, from the store's own list." },
      option_name: { type: "string", description: "A variant option to filter on, e.g. 'Color' or 'Size'. Use the store's exact option name." },
      option_value: { type: "string", description: "The value for option_name, e.g. 'Powder'. Use the store's exact value." },
      sort: {
        type: "string",
        enum: ["relevance", "price_asc"],
        description: "Default 'relevance'. Use 'price_asc' ONLY when showing alternatives ABOVE a budget, together with price_min set to that budget, so the customer sees the nearest-priced options first.",
      },
    }, ["query"]),
  // "is it in stock?" and "do you have it in a 159?" are the two most common
  // pre-purchase questions there are. Both were being dropped by the 128-tool
  // truncation, leaving the model to answer a specific size question with a
  // generic catalogue list.
  t("inventory_status", "READ", "LOW", "Check stock for a product or variant.",
    "Customer asks 'is X in stock?'.", { product_id: { type: "string" }, variant_id: { type: "string" } },
    undefined, { priority: 92 }),
  t("variant_information", "READ", "LOW",
    "Get a product's variants: sizes/colours/options, price, SKU and stock for each. Accepts a product NAME, so no prior lookup is needed.",
    "ANY question about a specific size, length, colour, option, SKU or 'do you have this in X'. Call this FIRST with product_name - do not run a product search and do not ask the customer which version they mean until you have seen the real options. If the product has no options, say so.",
    {
      variant_id: { type: "string" },
      product_id: { type: "string" },
      product_name: { type: "string", description: "Product title, e.g. 'The Minimal Snowboard'." },
    },
    undefined, { priority: 92 }),
  // Internal enrichment for the agent panel - never something a customer
  // conversation needs, so it should be among the first to go.
  // Cross-sell, and ONLY after the customer has settled on something. The
  // anchor product is required precisely so this cannot be used as a generic
  // "show me stuff" call: there is nothing to complement until there is a
  // choice, and an accessory pushed before the main question is answered is
  // the behaviour the quality rules already forbid.
  t("complementary_products", "READ", "LOW",
    "Products that go WITH one the customer has chosen: accessories, consumables, add-ons. Uses the merchant's own curated list when they have set one.",
    "The customer has settled on a specific product (said they will take it, asked to buy it, or asked what else they need for it). Never call this while they are still choosing between products, and never as a way to list the catalogue.",
    { product_id: { type: "string", description: "The product the customer chose. Required - this is what the results complement." },
      limit: { type: "number", description: "Default 3." } },
    ["product_id"], { priority: 60 }),
  t("get_product_images", "READ", "LOW", "Batch-fetch featured image URLs for a set of product ids (store-scoped).",
    "Internal: enrich order line items with product images for the agent panel.", { product_ids: { type: "array", items: { type: "string" } } }, ["product_ids"],
    { priority: 10 }),

  // ── Returns (refund status is REST; Returns/RMA object is GraphQL) ──
  t("get_refund_status", "READ", "LOW", "Get refunds recorded against an order (Shopify's native refund record).",
    "Customer asks 'has my refund been processed?'. This is the money movement in Shopify. If returngo.* tools are also available, ALSO call returngo.get_return_status - combine both for the full refund/return picture.", P.orderSel),
  t("get_returns", "READ", "LOW", "List Shopify Returns (RMAs) for an order with status + line items (GraphQL - Shopify's native return object).",
    "Customer asks about a return request / 'what's the status of my return?'. This is Shopify's native RMA. If returngo.* tools are also available, ALSO call returngo.get_return_status and synthesize both - neither source alone is complete.", P.orderSel),
  // The one that did not exist.
  //
  // Part 3's scope matrix recorded `write_returns` as "granted but no tool uses
  // it", and scenario 21 was UNSUPPORTED for exactly that reason - the store
  // could read every RMA it had and open none. `returnCreate` is GraphQL-only
  // and works against FULFILLMENT line items, not order line items, which is
  // why an unfulfilled order genuinely has nothing to return.
  withOrderTarget(t("create_return", "ACTION", "HIGH",
    "Open a Shopify Return (RMA) against an order's fulfilled line items, then read it back and report the real return id.",
    "Customer wants to return or replace something that has been delivered, and Shopify is this store's return provider. Call get_returns FIRST - never open a second return for items already covered by one. Only an item that was actually fulfilled can be returned. Approval is handled by the system: calling this tool is what RAISES the approval.",
    {
      ...P.orderSel,
      line_items: {
        type: "array",
        description: "Items to return: [{ line_item_id, quantity, reason }]. Omit to return everything fulfilled on the order.",
        items: {
          type: "object",
          properties: {
            line_item_id: { type: "string" },
            quantity: { type: "number" },
            reason: { type: "string", description: "One of: DEFECTIVE, WRONG_ITEM, NOT_AS_DESCRIBED, SIZE_TOO_SMALL, SIZE_TOO_LARGE, STYLE, UNWANTED, UNKNOWN, OTHER." },
          },
        },
      },
      note: { type: "string", description: "The customer's own description of the problem." },
    }, undefined,
    { sideEffects: "Opens a real return against the merchant's order.", priority: 86 })),
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
  withOrderTarget(t("process_refund", "ACTION", "HIGH", "Refund an order: full refund by default, partial via `amount` or `line_items`.",
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
    { sideEffects: "Moves real money back to the customer through the payment gateway." })),

  // ── Legacy (kept for back-compat) ──
  // Description rewritten to match what this actually does.
  //
  // It used to say "non-destructive handoff" / "Flag an order for the ops
  // team", and it notifies nobody: it writes a note and a tag onto the Shopify
  // order and stops. The model relayed the tool's own claim to a customer as
  // "אני פונה לצוות המשלוחים" - I am contacting the shipping team - which was
  // never true. A tool description is a promise the model will repeat verbatim.
  //
  // Selector is P.orderSel like every other order tool. Hand-rolling
  // `order_id`-only is what forced "#1006" into the id namespace.
  withOrderTarget(t("update_order_fulfillment", "WRITE", "LOW",
    "Adds a note and optional tag to the Shopify order. Records context on the order only: it does NOT notify, assign or contact any person or team.",
    "Use when order context should be recorded in Shopify. Never tell the customer a team, carrier or person was contacted on the strength of this tool - it reaches no one. Say a team was contacted only after a notification, task or assignment tool returns success.",
    { ...P.orderSel, note: { type: "string" }, tag: { type: "string" } })),
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
  update_my_profile: ["read_customers", "write_customers"],
  add_tag: ["write_customers"], remove_tag: ["write_customers"],
  update_metafield: ["write_customers"], create_note: ["write_customers"],
  add_customer_to_segment: ["write_customers"], remove_customer_from_segment: ["write_customers"],
  add_vip_tag: ["write_customers"], add_retention_segment: ["write_customers"],
  // orders read
  get_orders: ["read_orders"], get_order: ["read_orders"], order_lookup: ["read_orders"],
  search_orders: ["read_orders"], get_order_items: ["read_orders"],
  get_financial_status: ["read_orders"], check_payment_status: ["read_orders"],
  // Fulfillment questions read FULFILLMENT ORDERS, which are a separate
  // permission from the order itself. Without them `fulfillment_status` is
  // null on orders that are demonstrably in fulfillment, and the honest answer
  // ("I cannot see") was being rendered as "nothing has shipped".
  get_fulfillment_status: ["read_orders", "read_merchant_managed_fulfillment_orders"],
  // The whole point of the reconciliation is the fulfillment side of the
  // comparison. Without the scope it can still read the order, and it says so
  // rather than reporting "nothing shipped".
  reconcile_order_items: ["read_orders", "read_merchant_managed_fulfillment_orders"],
  get_shipment_status: ["read_orders", "read_merchant_managed_fulfillment_orders"],
  track_shipment: ["read_orders", "read_merchant_managed_fulfillment_orders"],
  get_tracking_number: ["read_orders", "read_merchant_managed_fulfillment_orders"],
  get_tracking_url: ["read_orders", "read_merchant_managed_fulfillment_orders"],
  get_fulfillment_events: ["read_orders", "read_merchant_managed_fulfillment_orders"],
  check_delivery_eta: ["read_orders", "read_merchant_managed_fulfillment_orders"],
  check_pickup_point: ["read_orders"],
  get_refund_status: ["read_orders"], check_refund: ["read_orders"],
  check_return_status: ["read_orders"],
  // order actions
  // cancel_order READS fulfillment orders before it writes: an order in
  // fulfillment cannot be cancelled, and finding that out from Shopify's
  // refusal rather than from a pre-flight read is how an impossible action
  // reached a human's approval.
  cancel_order: ["write_orders", "read_merchant_managed_fulfillment_orders"],
  process_refund: ["write_orders"],
  // Same reasoning as cancel_order: eligibility is a fulfillment-order READ,
  // and getting it from the legacy field is how a parcel already in a box gets
  // its address "changed".
  update_order_shipping_address: ["write_orders", "read_merchant_managed_fulfillment_orders"],
  // An exchange reads the replacement's stock before it decides anything, so
  // inventory is as required as the order write itself.
  // `write_order_edits` is the one that actually gates orderEditBegin, and it
  // was missing here. Without it the capability gate saw a store that could do
  // this, so nothing short-circuited: eligibility passed, the price was quoted,
  // a human approved, and Shopify refused at the last GraphQL call. A required
  // scope left off this map is a wasted human decision.
  exchange_order_item: [
    "write_orders", "write_order_edits",
    "read_merchant_managed_fulfillment_orders", "read_products", "read_inventory",
  ],
  send_invoice: ["write_orders"],
  add_order_note: ["write_orders"],
  // Creating/updating a fulfillment is a fulfillment-order write, not an
  // order write - `write_orders` alone has never been sufficient here.
  update_order_fulfillment: ["write_orders", "write_merchant_managed_fulfillment_orders"],
  // products
  get_product: ["read_products"], search_products: ["read_products"],
  // Stock questions need inventory, not just the product record: the variant's
  // `inventory_quantity` is an aggregate and says nothing per-location.
  inventory_status: ["read_products", "read_inventory"],
  variant_information: ["read_products", "read_inventory"],
  get_product_images: ["read_products"],
  // Reads the anchor, its collections and the merchant's recommendation
  // metafield - all product-surface data.
  complementary_products: ["read_products"],
  // discounts
  list_discounts: ["read_price_rules"], validate_discount: ["read_price_rules"],
  get_customer_discounts: ["read_customers", "read_price_rules"],
  create_discount_code: ["write_price_rules"], create_one_time_coupon: ["write_price_rules"],
  create_vip_coupon: ["write_price_rules"], disable_coupon: ["write_price_rules"],
  issue_compensation_coupon: ["write_price_rules"],
  // returns (GraphQL)
  get_returns: ["read_returns"], get_return_reason: ["read_returns"],
  // read_returns does NOT imply write_returns - they are separate grants, and
  // a store can read every RMA it has while being unable to open one. The
  // fulfillment scope is here because returnCreate works against FULFILLMENT
  // line items, which have to be read before anything can be returned.
  create_return: ["read_returns", "write_returns", "read_merchant_managed_fulfillment_orders"],
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
  // Added after a live incident: without fulfillment orders the connection
  // still "tested green" while every shipping, tracking and cancellability
  // answer was quietly wrong - the order read as unfulfilled because the only
  // field we could see was null. A connection missing this is not healthy, it
  // is confidently misinformed, so it must fail the test and say so.
  { scope: "read_merchant_managed_fulfillment_orders", needs: "fulfillment state, tracking, and cancellability" },
  { scope: "read_inventory", needs: "stock and variant availability answers" },
  { scope: "read_returns", needs: "return status lookups" },
  // Both were "granted but unused" until this round gave each a tool. They are
  // in the connection test now so a merchant is told BEFORE a customer asks,
  // rather than at the last GraphQL call of an already-approved action.
  { scope: "write_returns", needs: "opening a return (RMA) for a customer" },
  { scope: "write_order_edits", needs: "exchanging an item on an unshipped order" },
];

const ShopifyAdapter: ProviderAdapter = {
  slug: "shopify",
  migratesLegacyCredentials: true,
  tools: () => TOOLS,

  /**
   * Is this order action still possible? Asked BEFORE an approval is raised.
   *
   * Live failures this prevents, both seen on the dev store:
   *   - "תבטלו לי את הזמנה 1007" for an order cancelled minutes earlier. The
   *     bot answered "מטפלת עכשיו בביטול" and raised an approval, putting a
   *     real decision in front of a person that could not change anything.
   *   - the same shape for a fulfilled order, which Shopify refuses outright.
   *
   * Only READS happen here, and only for the two money/state actions where a
   * wasted approval is expensive. Anything unrecognised is eligible.
   */
  async precheckEligibility({ toolName, args, call }) {
    const PRECHECKED = [
      "cancel_order", "process_refund", "update_order_shipping_address", "exchange_order_item",
      "create_return",
    ];
    if (!PRECHECKED.includes(toolName)) return { eligible: true };
    const target = args.order_id ?? args.order_name;
    if (!target) return { eligible: true }; // resolution failure is the executor's job to report

    const order: any = await call("get_order", args.order_id ? { order_id: args.order_id } : { order_name: args.order_name });
    if (!order?.id) return { eligible: true };

    // Nothing shipped, nothing to return. `returnCreate` works against
    // FULFILLMENT line items, so an unfulfilled order has no returnable items
    // at all - and a human approving a return for one is deciding something
    // the answer cannot change. Live (2026-08-02): a return was approved for
    // an unfulfilled order and failed at the provider.
    if (toolName === "create_return") {
      const shipped = (order.fulfillments ?? []).filter(
        (f: any) => String(f?.status ?? "").toLowerCase() !== "cancelled",
      );
      if (!shipped.length) {
        return {
          eligible: false,
          reason:
            `nothing on order ${order.name ?? ""} has shipped yet, so there is nothing to return - a return covers items ` +
            `the customer has actually received. Say that plainly. If they want to stop the order instead, a cancellation ` +
            `or a refund is the right request. Do NOT say a return was opened.`,
        };
      }
      return { eligible: true };
    }

    // An exchange that is out of stock, or whose price differs, cannot be
    // completed by anyone approving it - so no approval is raised. The refusal
    // reasons are the tool's own, so the answer here and the answer at
    // execution time are the same sentence.
    if (toolName === "exchange_order_item") {
      // An exchange that names no replacement cannot succeed, so no human
      // should be asked about it. Live (2026-08-02): a person approved
      // `{quantity: 1, order_name: "1012"}` - a swap with nothing to swap TO -
      // and it failed with variant_not_found after the decision was spent.
      if (!args.new_variant_id && !args.new_variant_name) {
        // The options are named HERE rather than left to a lookup. Live
        // (2026-08-02) the model called variant_information with a product
        // name it guessed from the customer's word for the item, landed on a
        // different single-variant snowboard, and told the customer their
        // product came in one version only - while the order in front of it
        // held a product with five colours. The order knows which product it
        // is; nothing else has to guess.
        const options = await exchangeOptionsForOrder(call, order);
        return {
          eligible: false,
          reason:
            `no replacement option was named for order ${order.name ?? ""}. ${options} ` +
            `Ask the customer which of those they want and pass it as new_variant_name. ` +
            `Do NOT run a product search - the order already says which product this is - and do NOT say the item was exchanged.`,
        };
      }
      const fs: any = await call(
        "get_fulfillment_status",
        args.order_id ? { order_id: args.order_id } : { order_name: args.order_name },
      );
      const m = assessMutability(order, {
        orders: fs?.fulfillment_orders ?? [],
        readable: fs?.fulfillment_orders_readable !== false,
      });
      if (m.verdict !== "editable") {
        return {
          eligible: false,
          reason:
            `${m.customer_explanation} An exchange at this point has to be a RETURN plus a replacement, not an order edit. ` +
            `Explain that and offer the return route. Do NOT say the item was exchanged.`,
        };
      }
      return { eligible: true };
    }

    // An address change on an order already in the warehouse is the clearest
    // case there is for asking BEFORE a human is asked: nobody should be
    // approving a redirection that Shopify will apply to a parcel that has
    // already been packed against the old label.
    if (toolName === "update_order_shipping_address") {
      const fs: any = await call(
        "get_fulfillment_status",
        args.order_id ? { order_id: args.order_id } : { order_name: args.order_name },
      );
      const m = assessMutability(order, {
        orders: fs?.fulfillment_orders ?? [],
        readable: fs?.fulfillment_orders_readable !== false,
      });
      if (m.verdict === "editable") {
        const addr = validateShippingAddress((args.address as Record<string, unknown>) ?? {});
        if (addr.missing.length) {
          return {
            eligible: false,
            reason:
              `the new address for order ${order.name ?? ""} is incomplete - ${addr.missing.join(", ")} still needed. ` +
              `Ask the customer for the missing part and do NOT say the address was changed.`,
          };
        }
        if (addr.errors.length) {
          return {
            eligible: false,
            reason:
              `the new address for order ${order.name ?? ""} was not accepted (${addr.errors.join(", ")}). ` +
              `Ask the customer to confirm it and do NOT say the address was changed.`,
          };
        }
        return { eligible: true };
      }
      return {
        eligible: false,
        reason:
          `${m.customer_explanation} ` +
          `Tell the customer exactly that. Do NOT say the address was changed, and do NOT claim the carrier, courier or ` +
          `warehouse has been contacted - nothing here reaches them. Offer a real handover to a person if they need one.`,
      };
    }

    if (toolName === "cancel_order") {
      if (order.cancelled_at) {
        return {
          eligible: false,
          alreadySatisfied: true,
          reason: `order ${order.name ?? ""} was already cancelled. Tell the customer it is already cancelled and offer to check the refund status; do NOT propose cancelling it again.`.trim(),
        };
      }
      // FULFILLMENT ORDERS are the authority here, not the legacy fields.
      // Order #1006 reports fulfillment_status=null and fulfillments=[] while
      // carrying a fulfillment order in `in_progress` - and Shopify refuses
      // the cancellation with "Cannot cancel an order that has outstanding
      // fulfillments". Reading only the legacy fields is what let that
      // impossible action reach a human's approval twice.
      const fs: any = await call(
        "get_fulfillment_status",
        args.order_id ? { order_id: args.order_id } : { order_name: args.order_name },
      );
      if (fs?.fulfillment_orders_readable === false) {
        // We cannot see. Say so - do NOT infer "cancellable" from silence.
        // A confident false negative here spends a human's approval on an
        // action Shopify will refuse.
        return {
          eligible: false,
          reason:
            `cannot read the fulfillment state of order ${order.name ?? ""}, so whether it can still be cancelled is unknown. ` +
            `Tell the customer you do not currently have access to the information needed to determine this, and offer a human agent.`,
        };
      }
      if (fs?.has_outstanding_fulfillments === true) {
        return {
          eligible: false,
          reason: `order ${order.name ?? ""} has already been handed to fulfillment and cannot be cancelled. Offer a return plus a refund instead.`.trim(),
        };
      }
      // Legacy fields remain a secondary signal for shops whose fulfillment
      // orders are empty but whose order still shows fulfillments.
      const legacyFulfilled =
        ["fulfilled", "partial"].includes(String(order.fulfillment_status || "").toLowerCase()) ||
        (Array.isArray(order.fulfillments) && order.fulfillments.length > 0);
      if (legacyFulfilled) {
        return {
          eligible: false,
          reason: `order ${order.name ?? ""} has already been fulfilled and cannot be cancelled. Offer a return plus a refund instead.`.trim(),
        };
      }
      return { eligible: true };
    }

    // process_refund: a fully refunded order has no money left to return.
    if (String(order.financial_status || "").toLowerCase() === "refunded") {
      return {
        eligible: false,
        alreadySatisfied: true,
        reason: `order ${order.name ?? ""} is already fully refunded. Tell the customer the refund has already been issued; do NOT propose another one.`.trim(),
      };
    }
    return { eligible: true };
  },

  /**
   * Live credential + scope probe for the integration "Test" button.
   * `access_scopes.json` is the cheapest authenticated call Shopify has AND
   * tells us exactly which scopes the merchant granted - so a connection
   * whose write scopes are missing fails the test with a message naming the
   * scopes to re-grant, instead of read tools working while every write
   * quietly dies.
   *
   * The ONE Shopify call in this integration that is not Admin GraphQL, and
   * deliberately so: `/admin/oauth/access_scopes.json` is an OAuth endpoint,
   * not a REST Admin API resource. App Store requirement 2.2.4 is about the
   * Admin API (`/admin/api/<version>/*.json`), which this integration no
   * longer touches at all. There is no GraphQL equivalent - `currentAppInstallation
   * { accessScopes }` reports what the APP asks for, not what this shop granted,
   * which is the entire question being asked here.
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
    const raw = (j.access_scopes || [])
      .map((s: any) => String(s.handle || ""))
      .filter(Boolean);
    // Shopify returns the COLLAPSED grant: a granted `write_orders` is listed
    // without the `read_orders` it confers. Comparing REQUIRED_SCOPES against
    // the raw response therefore reports read scopes as missing on a store
    // that holds them - a live read of the demo store returned 19 handles for
    // a 26-scope grant, with all 7 absent entries being implied reads.
    // Expand before comparing, and persist the expanded form so every
    // downstream `includes()` check is asking the same question.
    const granted = normalizeGrantedScopes(raw);
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
    const base = `https://${shop}/admin/api/${apiVersion()}`;
    const ctx: Ctx = { token, base };

    switch (toolName) {
      // ── Customer read ──
      case "get_customer": {
        const c = await resolveCustomer(ctx, args);
        return c;
      }
      case "search_customers": {
        const limit = clampLimit(args.limit, 10, 250);
        // The query is Shopify's search grammar and is passed through as
        // written, exactly as it was to REST's search.json.
        return await searchCustomers(ctx, String(args.query || ""), limit);
      }
      case "get_customer_by_email": {
        return await findCustomerByField(ctx, "email", String(args.email || ""));
      }
      case "get_customer_by_phone": {
        return await findCustomerByField(ctx, "phone", String(args.phone || ""));
      }
      case "get_customer_orders": {
        const limit = clampLimit(args.limit, 10, 100);
        return await customerOrders(ctx, args, { limit, status: "any" });
      }
      case "get_customer_addresses": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        // The customer read already carries the address book, so the separate
        // REST address call has no GraphQL counterpart worth making.
        return c.addresses || [];
      }
      case "get_customer_tags": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        return { customer_id: c.id, tags: splitTags(c.tags) };
      }
      case "get_customer_metafields": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        return await getCustomerMetafields(ctx, String(c.id));
      }

      // ── Customer write ──
      case "create_customer": {
        const fields: any = {};
        if (args.email) fields.email = String(args.email);
        if (args.phone) fields.phone = String(args.phone);
        if (args.first_name) fields.first_name = String(args.first_name);
        if (args.last_name) fields.last_name = String(args.last_name);
        if (Array.isArray(args.tags) && args.tags.length) fields.tags = (args.tags as string[]).map(String);
        return await createCustomer(ctx, fields);
      }
      case "update_customer": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        const f = (args.fields && typeof args.fields === "object" ? args.fields : args) as any;
        const patch: any = {};
        for (const k of ["first_name", "last_name", "email", "phone", "note"]) {
          if (f[k] != null && f[k] !== "") patch[k] = String(f[k]);
        }
        // REST took a comma string; CustomerInput takes a list, and this is a
        // REPLACE either way - add_tag / remove_tag are the additive path.
        if (f.tags != null) patch.tags = Array.isArray(f.tags) ? f.tags.map(String) : splitTags(f.tags);
        return await updateCustomer(ctx, String(c.id), patch);
      }
      case "update_my_profile": {
        return await updateOwnProfile(ctx, args);
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
        return await setCustomerMetafield(ctx, String(c.id), {
          namespace: String(args.namespace),
          key: String(args.key),
          value: String(args.value),
          type: String(args.type || "single_line_text_field"),
        });
      }
      case "create_note": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        const existing = String(c.note || "").trim();
        const incoming = String(args.note || "");

        // Idempotency. This field is a single free-text blob that every note
        // APPENDS to, and this handler is reached by retried background work
        // (the post-chat pipeline) as well as by the model. Callers stamp the
        // body with a `[gotcha_source_interaction_id=...]` marker; if that
        // exact marker is already in the customer's note, the write landed on
        // a previous attempt and appending again would duplicate it forever.
        //
        // Matching on the marker rather than the whole body is deliberate: an
        // LLM-written summary is not byte-stable across retries, so comparing
        // bodies would dedup nothing.
        const marker = incoming.match(/\[gotcha_source_interaction_id=[^\]]*\]/)?.[0];
        if (marker && existing.includes(marker)) {
          return { ...c, note: existing, deduped: true };
        }

        const note = existing ? `${existing}\n\n${incoming}` : incoming;
        return await updateCustomer(ctx, String(c.id), { note });
      }

      // Notes on the ORDER, which is a different object from the customer.
      //
      // There was no such tool. Asked to "write it on order #1011" the model
      // reached for `create_note`, which writes the CUSTOMER record - so a note
      // really was saved, the honesty check saw a successful write and allowed
      // "ההערה נוספה להזמנה 1011", and Shopify's order still read note: null.
      // A true claim about the wrong object is harder to catch than a false one.
      case "add_order_note": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const text = String(args.note ?? "").trim();
        const addTags = String(args.tags ?? "").trim();
        if (!text && !addTags) throw new Error("note_or_tags_required");
        // Bounded: an order note is a record for staff, not a transcript, and
        // an unbounded field is an injection surface.
        if (text.length > 900) throw new Error("note_too_long");

        const patch: { note?: string; tags?: string[] } = {};
        if (text) {
          const existing = String(o.note || "").trim();
          patch.note = existing ? `${existing}\n\n${text}` : text;
        }
        if (addTags) {
          const have = String(o.tags || "").split(",").map((s) => s.trim()).filter(Boolean);
          const want = addTags.split(",").map((s) => s.trim()).filter(Boolean);
          patch.tags = Array.from(new Set([...have, ...want]));
        }
        await updateOrder(ctx, String(o.id), patch);

        // Read back. "Shopify accepted the write" and "the note is on the
        // order" are different claims, and only the second one may reach a
        // customer - which is why this is a SEPARATE read and not the
        // mutation's own echo of what it thinks it saved.
        const after = (await getOrderById(ctx, String(o.id))) ?? {};
        const noteApplied = !text || String(after.note || "").includes(text);
        const tagsApplied =
          !addTags ||
          addTags.split(",").map((s) => s.trim()).filter(Boolean)
            .every((t) => String(after.tags || "").toLowerCase().includes(t.toLowerCase()));
        if (!noteApplied || !tagsApplied) {
          throw new Error("order_note_not_applied: Shopify accepted the update but the order does not show it");
        }
        return {
          order_id: o.id,
          name: after.name ?? o.name,
          note_added: !!text,
          tags_added: addTags ? addTags.split(",").map((s) => s.trim()).filter(Boolean) : [],
          note: after.note ?? null,
          tags: after.tags ?? null,
          // Said explicitly because the model kept conflating the two.
          notified_anyone: false,
          // Live (2026-08-02): the note was written, Shopify showed it, and the
          // bot told the customer it had failed. The turn ledger records a
          // success with no external id as `succeeded_unverified` - deduped but
          // not confidently claimable - so the committed-outcome block told the
          // model it could not claim the write, and the model reported the
          // opposite of what happened. A note is a FIELD on the order, so the
          // order is its identifier; that is what the ledger was asking for.
          externalRef: { type: "shopify_order_note", id: String(o.id) },
        };
      }

      // ── Orders read ──
      case "get_orders": {
        const orders = await searchOrders(ctx, {
          limit: clampLimit(args.limit, 10, 250),
          status: String(args.status || "open"),
          email: args.email ? String(args.email) : undefined,
          full: true,
        });
        return orders.map(projectOrderForAgent);
      }
      case "get_order":
      case "order_lookup": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        return projectOrderForAgent(o);
      }
      case "search_orders": {
        return await searchOrders(ctx, {
          limit: clampLimit(args.limit, 10, 100),
          status: String(args.status || "any"),
          email: args.email ? String(args.email) : undefined,
          name: args.name ? String(args.name) : undefined,
          financialStatus: args.financial_status ? String(args.financial_status) : undefined,
          fulfillmentStatus: args.fulfillment_status ? String(args.fulfillment_status) : undefined,
          full: true,
        });
      }
      case "get_order_items": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        // A WRAPPER, not a bare array, and that is a security fix rather than
        // a tidy-up. The cross-customer guard filters arrays to entries it can
        // prove belong to the requester; a Shopify line item has a `name` -
        // the PRODUCT name - which makes it look customer-scoped, and no
        // phone, email or customer id to match on. So every row was filtered
        // out and the whole read was denied as another customer's data. Live
        // (2026-08-02): "I could not access your order without verifying your
        // identity", for the customer's own order.
        //
        // The wrapper shape is the one the guard already understands: the
        // order was authorized when it was resolved, and the items under it
        // carry no separate ownership.
        return {
          order_id: o.id,
          name: o.name,
          line_items: (o.line_items || []).map((li: any) => ({
            id: li.id,
            product_id: li.product_id,
            variant_id: li.variant_id,
            title: li.title,
            variant_title: li.variant_title ?? null,
            sku: li.sku ?? null,
            quantity: li.quantity,
            fulfillable_quantity: li.fulfillable_quantity ?? null,
            price: li.price,
          })),
        };
      }
      case "exchange_order_item": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        return await exchangeOrderItem(ctx, o, args);
      }
      case "update_order_shipping_address": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        return await updateOrderShippingAddress(ctx, o, (args.address as Record<string, unknown>) ?? {});
      }
      case "reconcile_order_items": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        return await reconcileOrderItems(ctx, o);
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
        // FULFILLMENT ORDERS are included because the legacy fields lie by
        // omission: an order can report fulfillment_status=null with an empty
        // `fulfillments` array while Shopify still considers it to have
        // outstanding fulfillments (live-verified on #1006). Anything deciding
        // "has this shipped / can this be cancelled" needs the real object.
        const fos = await fetchFulfillmentOrders(ctx, o.id);
        return {
          order_id: o.id,
          name: o.name,
          fulfillment_status: o.fulfillment_status,
          fulfillments: o.fulfillments || [],
          fulfillment_orders: fos.orders.map((f: any) => ({
            id: f.id,
            status: f.status,
            request_status: f.request_status,
            assigned_location_id: f.assigned_location_id,
            line_items: (f.line_items || []).length,
          })),
          // `null`, not `false`, when the scope is missing: "we cannot see"
          // must never be rendered as "there are none".
          has_outstanding_fulfillments: fos.readable ? hasOutstandingFulfillments(fos.orders) : null,
          fulfillment_orders_readable: fos.readable,
          ...(fos.readable ? {} : { fulfillment_orders_error: fos.error }),
        };
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
        // A fulfilled order cannot be cancelled - Shopify answers
        // `422 Cannot cancel a paid and fulfilled order`.
        //
        // The human-agent path (commerce-actions.service.ts) has always
        // checked this. This path did not, so the AI proposed a cancellation
        // that could never succeed, a human APPROVED it, and only then did
        // Shopify refuse. The customer had already been told "I'm handling
        // your cancellation now", and the failed execution handed them to an
        // agent with no explanation.
        //
        // Failing here rather than at Shopify makes the reason legible and
        // names the action that WOULD work, so the model can offer it instead
        // of apologising.
        // Same authority as the precheck: fulfillment ORDERS first, legacy
        // fields only as a secondary signal. `fulfillment_status` is null on
        // orders Shopify still refuses to cancel.
        const fos = await fetchFulfillmentOrders(ctx, o.id);
        const outstandingNow = fos.readable && hasOutstandingFulfillments(fos.orders);
        const legacyFulfilledNow =
          ["fulfilled", "partial"].includes(String(o.fulfillment_status || "").toLowerCase()) ||
          (Array.isArray(o.fulfillments) && o.fulfillments.length > 0);
        if (outstandingNow || legacyFulfilledNow) {
          throw new Error(
            "order_not_cancellable: this order has already been fulfilled and cannot be cancelled. " +
            "Use process_refund (and a return) instead.",
          );
        }
        // CANCEL VIA GRAPHQL, not REST.
        //
        // `POST /orders/{id}/cancel.json` answers 422 "Cannot cancel a paid and
        // fulfilled order" for orders that are neither - live-verified against
        // #1006 on the dev store, which reports fulfillment_status=null and
        // fulfillments=[] and still gets that exact refusal. The REST message is
        // simply wrong, and because it names a state the order is not in, the
        // guard above cannot pre-empt it and the model cannot explain it.
        //
        // REST has been legacy since 2024-10; `orderCancel` is the supported
        // mutation on 2026-07 and it accepts a PAID order, which is the whole
        // point. It is ASYNCHRONOUS - it returns a Job, so the order is not
        // cancelled the moment the mutation returns and the state must be read
        // back before anyone tells a customer it happened.
        const reasonRaw = String(args.reason ?? "OTHER").toUpperCase();
        const reason = ["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "STAFF", "OTHER"].includes(reasonRaw)
          ? reasonRaw
          : "OTHER";
        const gql = await shopifyGraphQL(ctx, ORDER_CANCEL_MUTATION, {
          orderId: orderGid(o.id),
          reason,
          // `refund: true` returns the money as part of the cancellation.
          refund: !!args.refund,
          restock: args.restock != null ? !!args.restock : true,
          notifyCustomer: false,
        });
        const userErrors = gql?.orderCancel?.orderCancelUserErrors ?? [];
        if (userErrors.length) {
          throw new Error(
            `cancel_rejected: ${userErrors.map((e: any) => e?.message).filter(Boolean).join("; ").slice(0, 240)}`,
          );
        }

        // Read the business state back. The job is async, so poll briefly
        // rather than trusting the mutation's acknowledgement - "Shopify
        // accepted the request" and "the order is cancelled" are different
        // claims and only the second one may reach a customer.
        let cancelled: any = null;
        for (let attempt = 0; attempt < 6; attempt++) {
          await new Promise((r) => setTimeout(r, attempt === 0 ? 400 : 800));
          const check: any = await getOrderById(ctx, String(o.id));
          if (check?.cancelled_at) {
            cancelled = check;
            break;
          }
        }
        if (!cancelled) {
          throw new Error(
            "cancel_not_applied: Shopify accepted the cancellation but the order is still not cancelled - check the order in the Shopify admin before retrying.",
          );
        }
        // `refund: true` means cancel AND return the money, and the GraphQL
        // mutation ABOVE already did that - unlike the old REST call, which
        // silently ignored the flag and left the order `paid`, forcing a
        // second explicit refund call here.
        //
        // That explicit call must NOT survive the move to GraphQL: it would
        // now be a SECOND refund on an order Shopify has already refunded.
        // What replaces it is verification, not another mutation - read the
        // financial state back and report what is actually true, so a refund
        // that did not land is never reported as though it did.
        if (args.refund) {
          const fin = String(cancelled.financial_status ?? "").toLowerCase();
          const refunded = fin === "refunded" || fin === "partially_refunded";
          return {
            ...cancelled,
            refund_status: refunded ? fin : "not_refunded",
            // Surfaced so the model says "cancelled, and the refund is still
            // settling" rather than inventing a completed refund.
            refund_verified: refunded,
          };
        }
        return cancelled;
      }
      case "send_invoice":
      case "resend_confirmation": {
        // GraphQL, because REST `send_invoice` answers 406 on the current API
        // and answered it to a live customer in Part 4. `orderInvoiceSend` is
        // the supported operation and it works - which makes this a capability
        // the product HAS, not one it lacks. `resend_confirmation` was declared
        // unsupported on the strength of the REST gap; it is the same mutation.
        //
        // No recipient is ever passed. The email goes to the address already on
        // the order, and customer-access-guard.ts refuses a chat-supplied `to`
        // outright - a financial document is not something a conversation gets
        // to redirect.
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const data = await shopifyGraphQL(ctx, ORDER_INVOICE_SEND, { id: orderGid(o.id) });
        const err = firstUserError(data?.orderInvoiceSend);
        if (err) throw new Error(`shopify_order_invoice_send: ${err}`);
        if (!data?.orderInvoiceSend?.order?.id) {
          throw new Error("shopify_order_invoice_send: the provider did not confirm the send");
        }
        return {
          order_id: String(o.id),
          name: o.name,
          document_type: "order_confirmation",
          delivery_channel: "email",
          sent: true,
          // The stored address, echoed so the model can say WHERE it went
          // without ever having been given a choice about it.
          sent_to: o.email ?? o.contact_email ?? null,
          externalRef: { type: "shopify_order_invoice", id: String(o.id) },
          model_instruction:
            `The order confirmation email was sent by Shopify to the address on the order. Tell the customer it was sent and to which address. ` +
            `It is an order confirmation, NOT a tax invoice - do not call it one.`,
        };
      }
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
        return {
          order_id: o.id, name: o.name, fulfillment_status: o.fulfillment_status, shipments: fs,
          ...(await shipmentVisibility(ctx, o, fs.length)),
        };
      }
      case "get_tracking_number": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const nums = (o.fulfillments || []).flatMap((f: any) => f.tracking_numbers || (f.tracking_number ? [f.tracking_number] : []));
        return { order_id: o.id, tracking_numbers: nums, ...(await shipmentVisibility(ctx, o, nums.length)) };
      }
      case "get_tracking_url": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const urls = (o.fulfillments || []).flatMap((f: any) => f.tracking_urls || (f.tracking_url ? [f.tracking_url] : []));
        return { order_id: o.id, tracking_urls: urls, ...(await shipmentVisibility(ctx, o, urls.length)) };
      }
      case "get_fulfillment_events": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        // One call for the whole order now: REST needed one per fulfillment.
        const out = await getFulfillmentEvents(ctx, String(o.id)).catch(() => []);
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
        return await listDiscounts(ctx, limit);
      }
      case "validate_discount": {
        try {
          // ONE call: the code and its terms are the same object in GraphQL,
          // where REST needed the code lookup and then the price rule behind it.
          const d = await getDiscountByCode(ctx, String(args.code || ""));
          if (!d) return { code: args.code, valid: false };
          const now = Date.now();
          const valid = (!d.ends_at || new Date(d.ends_at).getTime() > now)
            && (!d.starts_at || new Date(d.starts_at).getTime() <= now)
            // Shopify's own verdict, which REST's date arithmetic could not see:
            // a deactivated code is not active however its dates read.
            && d.status !== "expired";
          return { code: d.code, valid, value: d.value, value_type: d.value_type, starts_at: d.starts_at, ends_at: d.ends_at, usage_count: d.usage_count };
        } catch (e: any) {
          if (/404/.test(e?.message || "")) return { code: args.code, valid: false };
          throw e;
        }
      }
      case "get_customer_discounts": {
        const c = await resolveCustomer(ctx, args);
        if (!c) throw new Error("customer_not_found");
        const all = await listDiscounts(ctx, 250);
        const mine = all.filter((d) =>
          d.customer_selection === "prerequisite"
          && d.prerequisite_customer_ids.map(String).includes(String(c.id)));
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
        const dc = await getDiscountByCode(ctx, String(args.code || ""));
        if (!dc) throw new Error("coupon_not_found");
        // The supported operation, rather than back-dating the expiry. Same
        // outcome for the customer; a clearer one in the merchant's admin.
        const after = await deactivateDiscount(ctx, String(dc.price_rule_id));
        return { code: dc.code, disabled: true, price_rule: after };
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
        // Admin GraphQL; the return shape is unchanged - see mapProduct.
        if (args.product_id) return await getProductById(ctx, String(args.product_id));
        // REST filtered `/products.json?handle=` and took the first row;
        // `productByIdentifier` is a direct lookup, so an unknown handle is null
        // rather than the first product of the catalogue.
        if (args.handle) return await getProductByHandle(ctx, String(args.handle));
        throw new Error("product_id_or_handle_required");
      }
      case "get_product_images": {
        // Batch featured-image lookup: order line items carry product_id but no
        // image, so the agent panel enriches images here in ONE call.
        const ids = Array.isArray(args.product_ids) ? args.product_ids.map(String).filter(Boolean) : [];
        if (!ids.length) return {};
        // Still ONE call: `nodes(ids:)` is GraphQL's batch read, and asks for
        // the thumbnail alone rather than the whole product.
        return await getProductImages(ctx, ids);
      }
      case "search_products": {
        const limit = clampLimit(args.limit, 20, 250);
        const q = String(args.query || "").trim();
        const activeOnly = String(args.status || "active") !== "any";
        const bounds = priceBounds(args);
        const inStockOnly = args.in_stock_only !== false;
        const option = optionFilter(args);
        // product_type / vendor / tag are first-class in Shopify's own search
        // grammar, so they go to the server and narrow before we page. A
        // variant OPTION has no such predicate and is narrowed here.
        const facets = [
          termClause("product_type", args.product_type),
          termClause("vendor", args.vendor),
          termClause("tag", args.tag),
        ].filter(Boolean).join(" ");
        // Price and stock are applied HERE, over the widest page we are willing
        // to read, rather than by the caller over whatever happened to come
        // back. Shopify's Admin product query has no price predicate - price
        // lives on the variant - so a narrowing filter applied after a 3-item
        // slice would keep throwing away the very products the shopper asked
        // for. Over-fetch first, narrow second, slice last.
        const wide = bounds || inStockOnly || option ? Math.max(limit, 50) : limit;
        // `products(query:)` is a real full-text search over
        // title/vendor/type/tag/sku. The REST fallback that used to sit under
        // this is gone: it could not search at all - it paged the catalogue and
        // filtered client-side, silently missing anything past the first page -
        // so falling back to it turned a transient GraphQL error into confident
        // wrong answers. A failure now surfaces as a failure.
        const data = await shopifyGraphQL(ctx, PRODUCT_SEARCH_QUERY, {
          q: [q, facets, activeOnly ? "status:active" : ""].filter(Boolean).join(" ").trim(),
          n: Math.min(wide, 50),
          // RELEVANCE is only meaningful WITH a search term; without one
          // Shopify rejects it, so an empty query keeps the default order.
          // Its absence is why "the first three rows of the catalogue" was
          // the answer to every question.
          sort: q ? "RELEVANCE" : null,
        });
        const narrowed = narrowProducts((data?.products?.nodes || []).map(mapGraphQLProduct), bounds, inStockOnly);
        return sortProducts(filterByOption(narrowed, option), args.sort, inStockOnly).slice(0, limit);
      }
      case "complementary_products": {
        const anchorId = String(args.product_id || "").trim();
        if (!anchorId) throw new Error("product_id_required");
        const want = clampLimit(args.limit, 3, 10);
        const gid = anchorId.startsWith("gid://")
          ? anchorId
          : `gid://shopify/Product/${encodeURIComponent(anchorId)}`;

        const info = await shopifyGraphQL(ctx, PRODUCT_COMPLEMENTS_QUERY, { id: gid });
        const anchor = info?.product;
        if (!anchor) throw new Error("product_not_found");

        const anchorType = String(anchor.productType || "").toLowerCase();
        const anchorPrices = (anchor?.variants?.nodes || [])
          .map((v: any) => Number(v?.price))
          .filter((n: number) => Number.isFinite(n));
        const anchorPrice = anchorPrices.length ? Math.min(...anchorPrices) : null;

        const drop = (list: any[]) =>
          narrowProducts(list, null, true).filter(
            (p: any) => String(p?.id ?? "") !== String(anchor.legacyResourceId ?? ""),
          );

        // ── 1. What the merchant said. ────────────────────────────────
        const curatedIds: string[] = (() => {
          try {
            const raw = anchor?.metafield?.value;
            const parsed = raw ? JSON.parse(raw) : null;
            return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
          } catch {
            // A metafield we cannot parse is a merchant setting we do not
            // understand, not a reason to fail the call.
            return [];
          }
        })();

        if (curatedIds.length > 0) {
          const data = await shopifyGraphQL(ctx, PRODUCTS_BY_ID_QUERY, { ids: curatedIds.slice(0, 25) });
          const curated = drop(
            (data?.nodes || []).filter(Boolean).map(mapGraphQLProduct),
          );
          if (curated.length > 0) {
            return curated.slice(0, want).map((p: any) => ({ ...p, recommendation_source: "merchant" }));
          }
        }

        // ── 2. Otherwise, infer. ──────────────────────────────────────
        //
        // Same collection, DIFFERENT product type, and not more expensive than
        // the thing it accompanies. The product-type rule is what stops a
        // second snowboard being offered as an accessory to the first: another
        // item from the category the customer just chose from is a competitor,
        // not a complement.
        const collectionIds: string[] = (anchor?.collections?.nodes || [])
          .map((c: any) => c?.id)
          .filter(Boolean);

        const anchorRef: ComplementAnchor = {
          id: String(anchor.legacyResourceId ?? ""),
          type: anchorType,
          price: anchorPrice,
        };
        const seen = new Set<string>();
        const inferred: any[] = [];
        for (const cid of collectionIds) {
          if (inferred.length >= want) break;
          let nodes: any[] = [];
          try {
            const data = await shopifyGraphQL(ctx, COLLECTION_PRODUCTS_QUERY, { id: cid, n: 50 });
            nodes = data?.collection?.products?.nodes || [];
          } catch (err: any) {
            console.warn("[shopify] collection read failed for complements:", err?.message);
            continue;
          }
          const picked = selectComplements(nodes.map(mapGraphQLProduct), anchorRef, {
            want: want - inferred.length,
            seen,
          });
          inferred.push(...picked.map((p: any) => ({ ...p, recommendation_source: "inferred" })));
        }
        if (inferred.length > 0) return inferred.slice(0, want);

        // ── 3. Last resort: the accessories, wherever they live. ──────
        //
        // Verified against the live Urban Supply store: every collection the
        // anchor belongs to contains ONLY snowboards, so rule 2 returns
        // nothing there while the store does stock wax. Merchants group by
        // category far more often than by "what goes with what", so a
        // collection is a weak signal for accessories and its absence must not
        // be the end of the search.
        //
        // The price ratio is what keeps this from becoming "any other product":
        // an accessory is materially cheaper than the thing it accompanies, so
        // wax at 24.95 accompanies a 600 board and a 585 board does not.
        try {
          const data = await shopifyGraphQL(ctx, PRODUCT_SEARCH_QUERY, {
            q: "status:active",
            n: 50,
            sort: null,
          });
          const picked = selectComplements((data?.products?.nodes || []).map(mapGraphQLProduct), anchorRef, {
            want: want - inferred.length,
            maxRatio: ACCESSORY_PRICE_RATIO,
            seen,
          });
          inferred.push(...picked.map((p: any) => ({ ...p, recommendation_source: "inferred" })));
        } catch (err: any) {
          console.warn("[shopify] store-wide complement scan failed:", err?.message);
        }

        // An empty list is a real answer: this store has nothing that goes
        // with it. Saying so beats padding the reply with a competitor.
        return inferred.slice(0, want);
      }
      case "get_shop": {
        // Admin GraphQL (App Store requirement 2.2.4 forbids core Admin REST).
        // The return shape is unchanged - see mapShop.
        return await getShop(ctx, shop);
      }
      case "inventory_status": {
        if (args.variant_id) {
          const v = (await getVariantById(ctx, String(args.variant_id))) || ({} as any);
          return { variant_id: v.id, sku: v.sku, inventory_quantity: v.inventory_quantity, inventory_management: v.inventory_management };
        }
        if (args.product_id) {
          const p = await getProductById(ctx, String(args.product_id), true);
          return (p?.variants || []).map((v) => ({ variant_id: v.id, title: v.title, sku: v.sku, inventory_quantity: v.inventory_quantity }));
        }
        throw new Error("product_id_or_variant_id_required");
      }
      case "variant_information": {
        if (args.variant_id) {
          return await getVariantById(ctx, String(args.variant_id));
        }
        // Accept a product NAME, not just an id.
        //
        // "יש את הדגם הזה במידה 159?" needs two calls otherwise - search for
        // the product, then read its variants - and the model would give up at
        // the first step and ask the customer which version they meant. On a
        // store whose products have a single `Default Title` variant that
        // question has no answer, so the customer was interrogated about
        // options that do not exist.
        // `true` asks for the inventory field too - this tool declares
        // read_inventory, and the stock answer is the point of the call.
        const product = args.product_id
          ? await getProductById(ctx, String(args.product_id), true)
          : args.product_name || args.title || args.query
            ? await findProductByTitle(ctx, String(args.product_name ?? args.title ?? args.query), true)
            : null;
        if (!product) throw new Error("variant_id_or_product_id_or_product_name_required");

        const variants = (product.variants || []).map((v: any) => ({
          variant_id: v.id, title: v.title, sku: v.sku, price: v.price,
          inventory_quantity: v.inventory_quantity,
          inventory_management: v.inventory_management,
          in_stock: v.inventory_management == null || Number(v.inventory_quantity) > 0,
          option1: v.option1, option2: v.option2, option3: v.option3,
        }));
        // `options` names what the product actually varies BY. A product whose
        // only variant is "Default Title" varies by nothing, and saying so is
        // the whole answer to a size question - not a follow-up question.
        const optionNames = (product.options || []).map((o: any) => o?.name).filter(Boolean);
        const hasRealOptions =
          optionNames.length > 0 &&
          !(variants.length === 1 && String(variants[0]?.title ?? "").toLowerCase() === "default title");
        return {
          product_id: product.id,
          product_title: product.title,
          option_names: optionNames,
          has_variant_options: hasRealOptions,
          variants,
          ...(hasRealOptions
            ? {}
            : {
                model_instruction:
                  "This product is sold in ONE version only - it has no size, colour or other options. Answer the customer's size/variant question by saying the product does not come in different sizes, and give its stock status. Do NOT ask which version or colour they want, and do NOT list other products.",
              }),
        };
      }

      // ── Returns / refunds ──
      case "get_refund_status":
      case "check_refund": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        const refunds = (await listOrderRefunds(ctx, String(o.id))).map((rf: any) => ({
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
        const refunds = await listOrderRefunds(ctx, String(o.id));
        return {
          order_id: o.id, name: o.name, fulfillment_status: o.fulfillment_status,
          refunds_count: refunds.length,
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
      case "create_return": {
        const o = await resolveOrder(ctx, args);
        if (!o) throw new Error("order_not_found");
        return await createShopifyReturn(ctx, o, args);
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
          customer: {
            id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" "), email: c.email, phone: c.phone,
            tags: splitTags(c.tags), note: c.note, orders_count: c.orders_count, total_spent: c.total_spent, currency: c.currency,
            // Additive: the agent panel shows "customer since", the default
            // address and marketing consent. Read-only fields the account
            // already returns; nothing new is requested from Shopify.
            created_at: c.created_at, default_address: c.default_address,
            accepts_marketing: c.email_marketing_consent?.state === "subscribed",
          },
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
        const upd: { note?: string; tags?: string[] } = {};
        if (note) upd.note = o.note ? `${o.note}\n${note}` : note;
        if (tag) {
          const cur = splitTags(o.tags);
          upd.tags = cur.includes(tag) ? cur : [...cur, tag];
        }
        const r: any = await updateOrder(ctx, String(o.id), upd);
        // Explicit negatives, not just the positive result.
        //
        // The model previously saw `{order_id, name, note, tags}` - a success
        // shape with nothing saying what did NOT happen - and filled the gap
        // with "I contacted the shipping team". These four false flags close
        // that gap at the data layer rather than hoping a prompt sentence
        // holds.
        return {
          order_id: o.id,
          name: o.name,
          orderResolved: true,
          noteAdded: !!note,
          tagAdded: !!tag,
          notificationSent: false,
          assignmentCreated: false,
          followUpScheduled: false,
          recordedOnOrderOnly: true,
          note: r?.note ?? null,
          tags: splitTags(r?.tags),
        };
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

/**
 * The part of a Shopify error body a human can act on.
 *
 * Shopify's 422 for a failed cancel echoes the ENTIRE order object, so a blind
 * `text.slice(0, 240)` captured `{"order":{"id":...,"browser_ip":...` and cut
 * off before the actual reason - the operator saw a wall of JSON that did not
 * say what went wrong. `errors` is where the reason lives, in any of three
 * shapes Shopify uses.
 */
function shopifyErrorSummary(text: string): string {
  let body: any;
  try { body = JSON.parse(text); } catch { return text.slice(0, 240); }
  const errs = body?.errors ?? body?.error;
  if (typeof errs === "string") return errs.slice(0, 240);
  if (Array.isArray(errs)) return errs.join("; ").slice(0, 240);
  if (errs && typeof errs === "object") {
    return Object.entries(errs)
      .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : String(msgs)}`)
      .join("; ")
      .slice(0, 240);
  }
  // No `errors` key at all - Shopify echoed the resource. Say that plainly
  // rather than pasting the object.
  if (body?.order) return "Shopify rejected the request and returned the order unchanged (check its fulfillment and payment state).";
  return text.slice(0, 240);
}

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
  const prior = await listOrderRefunds(ctx, String(o.id));
  const refundedQty: Record<string, number> = {};
  let refundedAmount = 0;
  for (const rf of prior) {
    for (const rli of rf.refund_line_items || []) {
      refundedQty[String(rli.line_item_id)] = (refundedQty[String(rli.line_item_id)] || 0) + Number(rli.quantity || 0);
    }
    for (const tx of rf.transactions || []) {
      if (tx.kind === "refund" && tx.status !== "failure" && tx.status !== "error") refundedAmount += Number(tx.amount || 0);
    }
  }

  const isPartialAmount = args.amount != null;

  /**
   * WHERE the goods go back to.
   *
   * Restocking is refused with `refund_line_items.base: You need to set a
   * location to restock items` unless each restocked line carries a
   * location_id. Note that refunds/calculate does NOT enforce this - only the
   * create call does - so a dry run alone will not catch it.
   *
   * The fulfillment that shipped a line item is the correct source: that is
   * where the stock left from, and it is on the order we already have.
   */
  //
  // A SEPARATE read, because `Fulfillment.location` costs a `read_locations`
  // grant and GraphQL applies scopes to the whole document - asking for it on
  // the order query would break every order read on a shop without it. It
  // degrades to an empty map, and the lines that wanted restocking are reported
  // as skipped rather than silently dropped.
  const { byLineItem: locationByLineItem, fallback: fulfillmentLocationId } =
    await getFulfillmentLocations(ctx, String(o.id));
  let fallbackLocationId: number | undefined = fulfillmentLocationId;
  if (fallbackLocationId === undefined) {
    // Unfulfilled orders have no fulfillment to learn from. This needs
    // read_locations; when the scope is absent Shopify returns an empty list
    // rather than an error, so treat "no locations" as "cannot restock".
    const locs = await listLocations(ctx);
    const active = locs.find((l) => l.active) ?? locs[0];
    if (active?.id != null) fallbackLocationId = Number(active.id);
  }

  /** Line items we were asked to restock but could not place. */
  const restockSkipped: string[] = [];

  /**
   * Shopify's restock_type is an ENUM, not a boolean.
   *
   * Valid values are no_restock / cancel / return / legacy_restock. We were
   * sending the literal string "restock", which Shopify rejects outright with
   * `refund_line_items: ["invalid restock type"]` - so every refund that asked
   * to restock failed, and the agent saw a raw 422.
   *
   * Which of the two restocking values is correct depends on the line item:
   * an UNFULFILLED item is being cancelled back into stock, a FULFILLED one is
   * being returned. Sending the wrong one is not cosmetic - it decides whether
   * Shopify treats the unit as never-shipped or as physically returned.
   */
  const restockFor = (lineItemId: unknown): { restock_type: string; location_id?: number } => {
    if (!args.restock) return { restock_type: "no_restock" };
    const li = (o.line_items || []).find((x: any) => String(x.id) === String(lineItemId));
    const fulfillable = Number(li?.fulfillable_quantity ?? 0);
    const locationId = locationByLineItem.get(String(lineItemId)) ?? fallbackLocationId;
    if (locationId === undefined) {
      // Refuse to restock rather than fail the whole refund: the money going
      // back is the primary intent, and a silent no-op would be worse than
      // either. The caller is told which lines were skipped.
      restockSkipped.push(String(li?.title ?? lineItemId));
      return { restock_type: "no_restock" };
    }
    return { restock_type: fulfillable > 0 ? "cancel" : "return", location_id: locationId };
  };

  let refundLineItems: Array<{ line_item_id: number; quantity: number; restock_type: string; location_id?: number }> = [];
  if (Array.isArray(args.line_items) && args.line_items.length) {
    refundLineItems = args.line_items.map((li: any) => ({
      line_item_id: Number(li.line_item_id),
      quantity: Number(li.quantity || 1),
      ...restockFor(li.line_item_id),
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
        ...restockFor(li.id),
      }))
      .filter((li: { quantity: number }) => li.quantity > 0);
    if (!refundLineItems.length && refundedAmount > 0) {
      return { order_id: o.id, name: o.name, already_refunded: true, refunded_amount: refundedAmount, financial_status: o.financial_status };
    }
  }

  // Ask Shopify what is actually refundable (per-gateway transactions,
  // shipping, taxes) instead of guessing.
  const wantShipping = args.refund_shipping != null ? !!args.refund_shipping : !isPartialAmount;

  // An amount-only partial refund names no line items, so the calculate call
  // was being sent `{currency}` and nothing else - asking Shopify to price a
  // refund of NOTHING. It dutifully answered 0.00, and every partial refund
  // died on "requested 200 USD but only 0.00 USD is refundable" against a
  // fully paid, unrefunded order.
  //
  // The ceiling for an arbitrary amount is what the ORDER can still bear, so
  // price it as though everything remaining were going back. This is for the
  // CEILING and the gateway parent transaction only - the refund created below
  // stays amount-only, which is what Shopify wants when the money is not tied
  // to specific lines. `no_restock` because nothing is physically returning.
  const ceilingLineItems =
    isPartialAmount && !refundLineItems.length
      ? (o.line_items || [])
          .map((li: any) => ({
            line_item_id: Number(li.id),
            quantity: Number(li.quantity || 0) - (refundedQty[String(li.id)] || 0),
            restock_type: "no_restock",
          }))
          .filter((li: { quantity: number }) => li.quantity > 0)
      : [];

  // `suggestedRefund` is a QUERY: it prices the refund and creates nothing, so
  // unlike REST's calculate endpoint there is no version of this call that can
  // move money by accident.
  const pricingLines = refundLineItems.length ? refundLineItems : ceilingLineItems;
  const suggested = await suggestRefund(
    ctx,
    String(o.id),
    pricingLines,
    wantShipping || ceilingLineItems.length > 0,
  );
  if (!suggested) throw new Error("refund_calculate_empty: Shopify returned no suggested refund");

  let transactions: Array<{ parent_id: string | null; amount: string; gateway?: string | null }> =
    suggested.transactions.map((tx) => ({ parent_id: tx.parent_id, amount: tx.amount, gateway: tx.gateway }));
  const maxRefundable = transactions.reduce((s, t) => s + Number(t.amount || 0), 0);
  if (isPartialAmount) {
    const requested = Number(args.amount);
    if (!Number.isFinite(requested) || !(requested > 0)) throw new Error("refund_amount_invalid");
    // A currency that is not the order's is never a unit conversion - it is a
    // different amount of money. Refuse rather than quietly refunding 200 of
    // whatever the ORDER happens to be denominated in.
    if (args.currency && String(args.currency).toUpperCase() !== String(o.currency).toUpperCase()) {
      throw new Error(
        `refund_currency_mismatch: order ${o.name} is in ${o.currency}, cannot refund in ${String(args.currency).toUpperCase()}`,
      );
    }
    if (requested > maxRefundable + 0.005) {
      throw new Error(`refund_exceeds_refundable: requested ${requested} ${o.currency} but only ${maxRefundable.toFixed(2)} ${o.currency} is refundable`);
    }
    if (!transactions.length) throw new Error("refund_no_refundable_transaction");
    transactions = [{ ...transactions[0], amount: requested.toFixed(2) }];
  }
  if (!transactions.length) throw new Error("nothing_to_refund");

  const createInput = {
    currency: suggested.currency || o.currency,
    notify: args.notify != null ? !!args.notify : true,
    note: args.note ? String(args.note) : `GOTCHA refund${args.reason ? `: ${String(args.reason)}` : ""}`,
    transactions,
    ...(refundLineItems.length ? { refund_line_items: refundLineItems } : {}),
    ...(wantShipping && suggested.shipping?.amount && Number(suggested.shipping.amount) > 0
      ? { shipping: { amount: suggested.shipping.amount } }
      : {}),
  };
  // Keyed by the refund's own contents, so a redelivered job or a retried
  // approval gets back the refund that already exists instead of creating a
  // second one - see refundIdempotencyKey.
  const refund = await createRefund(ctx, String(o.id), createInput);
  if (!refund?.id) throw new Error("refund_not_created: Shopify returned no refund object");

  // Verify the business state actually changed before anyone tells a
  // customer their money is on the way.
  const verify: any = await getOrderById(ctx, String(o.id));
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
    financial_status: verify?.financial_status ?? null,
    processed_at: refund.processed_at ?? null,
    // Reported, never silent: the agent asked for a restock and did not get
    // one on these lines because no location could be resolved.
    ...(restockSkipped.length ? { restock_skipped: restockSkipped } : {}),
  };
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
  if (args.customer_id) return await getCustomerById(ctx, String(args.customer_id));
  if (args.email) return await findCustomerByField(ctx, "email", String(args.email));
  if (args.phone) return await findCustomerByField(ctx, "phone", String(args.phone));
  throw new Error("customer_id_email_or_phone_required");
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
  // `full` because callers read line items off these rows (find_delayed_order
  // reasons about them, and the commerce panel renders them).
  return await searchOrders(ctx, { limit: opts.limit, status: opts.status, email, full: true });
}

/** Resolve an order from { order_id | order_name }. */
/** Look an order up by its internal id. Returns null on 404 rather than throwing. */
async function orderById(ctx: Ctx, id: string): Promise<any | null> {
  try {
    return await getOrderById(ctx, id);
  } catch (err: any) {
    // A wrong-namespace guess must be recoverable, not fatal: 404 means "not
    // this id", and 400 means Shopify rejected the value as an id at all -
    // which is exactly what "#1006" produced. Both fall through to the name
    // lookup. Anything else (auth, rate limit, 5xx) is a real failure.
    const m = String(err?.message ?? "");
    if (/shopify_404|shopify_400/.test(m)) return null;
    throw err;
  }
}

/** Look an order up by its human-facing name. `#` is optional. */
async function orderByName(ctx: Ctx, name: string): Promise<{ order: any | null; ambiguous: boolean }> {
  const clean = name.replace(/^#/, "").trim();
  try {
    // Two are asked for so a duplicate name is DETECTED rather than silently
    // taking the first match. Acting on the wrong order is worse than refusing.
    return await getOrderByName(ctx, clean);
  } catch (err: any) {
    // Same reasoning as orderById: "no order by that name" must be a miss the
    // other namespace can still answer, not a hard failure. Shopify normally
    // returns 200 with an empty array, but a 404/400 here is still just a miss.
    const m = String(err?.message ?? "");
    if (/shopify_404|shopify_400/.test(m)) return { order: null, ambiguous: false };
    throw err;
  }
}

/**
 * THE canonical order resolver. Every Shopify order tool goes through here.
 *
 * It used to trust `args.order_id` as an internal id and issue a direct GET.
 * A customer's "#1006" is an order NAME, so that produced
 * `GET /orders/%231006.json` → 400, and the tool had no second path. See
 * shopify-order-identifier.ts for the full account.
 *
 * Now the value is classified first, and when the classification is uncertain
 * both namespaces are tried. A wrong guess costs one extra GET instead of
 * failing the operation.
 */
async function resolveOrder(ctx: Ctx, args: Record<string, any>): Promise<any | null> {
  const ident = orderIdentifierFromArgs(args ?? {});

  switch (ident.kind) {
    case "missing":
      throw new Error("order_id_or_name_required");
    case "malformed":
      throw new Error(`order_identifier_invalid: ${ident.detail ?? "unrecognised"}`);

    case "internal_id": {
      const byId = await orderById(ctx, ident.id!);
      if (byId) return byId;
      // A long numeric that is not an id is unusual but harmless to re-check
      // as a name before giving up.
      const byName = await orderByName(ctx, ident.id!);
      if (byName.ambiguous) throw new Error("order_ambiguous");
      return byName.order;
    }

    case "order_name": {
      const byName = await orderByName(ctx, ident.name!);
      if (byName.ambiguous) throw new Error("order_ambiguous");
      if (byName.order) return byName.order;
      // Only worth an id attempt when the name could BE an id.
      if (/^\d+$/.test(ident.name!)) return await orderById(ctx, ident.name!);
      return null;
    }

    case "ambiguous": {
      // Short numeric - could be either namespace. The FIELD the caller used
      // decides which to try first (see orderIdentifierFromArgs); the other is
      // still tried, so a wrong guess costs one extra GET, never a failure.
      if (ident.preferred === "name") {
        const byName = await orderByName(ctx, ident.name!);
        if (byName.ambiguous) throw new Error("order_ambiguous");
        if (byName.order) return byName.order;
        return await orderById(ctx, ident.id!);
      }
      const byId = await orderById(ctx, ident.id!);
      if (byId) return byId;
      const byName = await orderByName(ctx, ident.name!);
      if (byName.ambiguous) throw new Error("order_ambiguous");
      return byName.order;
    }
  }
}

async function mutateCustomerTags(ctx: Ctx, args: Record<string, any>, tag: string, op: "add" | "remove"): Promise<any> {
  const c = await resolveCustomer(ctx, args);
  if (!c) throw new Error("customer_not_found");
  // Atomic. The read-modify-write this replaces wrote the WHOLE tag field
  // back, so a tag added by anything else between the read and the write was
  // erased - and the post-chat pipeline tags the same customer from a queue.
  const tags = await mutateTags(ctx, String(c.id), [tag], op);
  return { customer_id: c.id, tags };
}

/** Look up an existing discount code; null when it doesn't exist (404). */
async function lookupDiscountCode(ctx: Ctx, code: string): Promise<{ code: string; price_rule_id: number } | null> {
  try {
    const d = await getDiscountByCode(ctx, code);
    return d?.code ? { code: d.code, price_rule_id: Number(d.price_rule_id ?? 0) } : null;
  } catch (err: any) {
    if (/404/.test(err?.message || "")) return null;
    throw err;
  }
}

async function createDiscount(ctx: Ctx, opts: { code: string; percentage: number; usage_limit?: number; ends_at_iso?: string; customer_id?: string; title?: string }): Promise<any> {
  // ONE mutation where REST needed two calls - a price rule, then a code hung
  // off it - so the half-created state REST could leave behind (a rule with no
  // code, invisible to every lookup) no longer exists.
  return await createGqlDiscount(ctx, opts);
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

/**
 * The order's FulfillmentOrders - the object Shopify actually reasons about.
 *
 * `order.fulfillment_status` and `order.fulfillments` describe fulfillments
 * that have been CREATED. They say nothing about work that has been requested
 * from, or accepted by, a fulfillment service, which is what Shopify means by
 * "outstanding fulfillments" when it refuses a cancellation. Reading only the
 * legacy fields is why a demonstrably unfulfilled-looking order still could
 * not be cancelled, with no signal anywhere that explained it.
 *
 * Best-effort: a shop without the fulfillment scopes returns nothing rather
 * than throwing, so a read path degrades to the legacy fields instead of
 * failing outright.
 */
async function fetchFulfillmentOrders(
  ctx: Ctx,
  orderId: string | number,
): Promise<{ orders: any[]; readable: boolean; error?: string }> {
  // The denial-vs-empty distinction lives in the GraphQL module: collapsing a
  // missing scope into an empty array would report
  // `has_outstanding_fulfillments: false` for an order Shopify refuses to
  // cancel for exactly that reason - a confident false negative, which is the
  // one failure mode this integration must never have.
  return await getFulfillmentOrders(ctx, orderId);
}

/**
 * Does this order have fulfillment work Shopify will refuse to cancel over?
 *
 * OPEN and SCHEDULED fulfillment orders are cancelled along with the order and
 * are NOT blocking. What blocks is work already handed to a fulfillment
 * service: IN_PROGRESS, or a request that has been submitted or accepted.
 */
/**
 * Why a tracking answer is empty - which is a completely different fact from
 * "there is no tracking".
 *
 * The legacy `order.fulfillments` array is `[]` on an order that Shopify is
 * actively fulfilling (verified on #1006, which carries an `in_progress`
 * fulfillment order). Read alone it produced "no tracking exists" for a parcel
 * being packed, and - when the scope was missing - the same sentence for an
 * order we simply could not see. Three states, one answer, two of them false.
 *
 * `tracking_state` names which one it is:
 *   available    - there is tracking, use it
 *   not_yet      - genuinely in fulfillment, no tracking number issued yet
 *   none         - nothing is being fulfilled; there is nothing to track
 *   unknown      - WE CANNOT SEE. Never render this as any of the above.
 */
async function shipmentVisibility(
  ctx: Ctx,
  order: any,
  legacyCount: number,
): Promise<Record<string, unknown>> {
  if (legacyCount > 0) return { tracking_state: "available", fulfillment_visibility: "readable" };
  const fos = await fetchFulfillmentOrders(ctx, order.id);
  if (!fos.readable) {
    return {
      tracking_state: "unknown",
      fulfillment_visibility: "unreadable",
      fulfillment_orders_error: fos.error,
      model_instruction:
        "You do NOT have access to this order's fulfillment information. Say exactly that you cannot currently see what is needed to answer with certainty, and offer a human agent. Do NOT say the order has not shipped, that no tracking exists, or that nothing is being fulfilled.",
    };
  }
  if (hasOutstandingFulfillments(fos.orders)) {
    return {
      tracking_state: "not_yet",
      fulfillment_visibility: "readable",
      model_instruction:
        "The order IS being fulfilled but no tracking number has been issued yet. Do not say it has not shipped or that there is no tracking; say it is being prepared and tracking follows.",
    };
  }
  return { tracking_state: "none", fulfillment_visibility: "readable" };
}

/**
 * The order, as a support agent needs it - not as Shopify stores it.
 *
 * `GET /orders/{id}.json` returns several thousand tokens: presentment money
 * sets duplicated for every total, client_details, discount_applications,
 * per-line tax and duty arrays. Handing that to the model was expensive on
 * every single lookup, and a turn that read one order then tried to reason
 * about it produced NO REPLY AT ALL - the customer's message simply went
 * unanswered, with nothing logged.
 *
 * It is also more than we should be putting in a prompt. The raw payload
 * carries `browser_ip`, `checkout_token`, the order `token`, and an
 * `order_status_url` with a live `authenticate?key=` in it. None of that helps
 * anyone answer a question about a snowboard, and a model that can see a
 * credential can repeat one.
 *
 * Everything a customer conversation actually uses survives: status, money,
 * what was bought, where it is going, what came back, and how to reach them.
 */
function projectOrderForAgent(o: any): Record<string, unknown> {
  if (!o || typeof o !== "object") return o;
  const addr = (a: any) =>
    a
      ? {
          name: a.name ?? null, address1: a.address1 ?? null, address2: a.address2 ?? null,
          city: a.city ?? null, province: a.province ?? null, zip: a.zip ?? null,
          country: a.country ?? null, phone: a.phone ?? null,
        }
      : null;
  return {
    id: o.id,
    name: o.name,
    order_number: o.order_number,
    created_at: o.created_at,
    currency: o.currency,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    cancelled_at: o.cancelled_at ?? null,
    cancel_reason: o.cancel_reason ?? null,
    total_price: o.total_price,
    subtotal_price: o.subtotal_price,
    total_tax: o.total_tax,
    total_discounts: o.total_discounts,
    // What is still owed vs already settled - the number a refund conversation
    // keeps coming back to.
    total_outstanding: o.total_outstanding ?? null,
    note: o.note ?? null,
    tags: o.tags ?? null,
    // `product_id` and `variant_id` are here because acting on a line needs
    // them. This projection was written to strip credentials out of the raw
    // payload and it also stripped these - so an exchange resolved the order,
    // found the line, and could not look up the product it belonged to. Live
    // (2026-08-02) that made a five-colour snowboard report as "sold in one
    // version only", from the order that contained it.
    //
    // Neither is a secret: both are public catalogue identifiers that appear in
    // every storefront URL. The things worth stripping - tokens, checkout
    // sessions, the authenticated status URL - are stripped elsewhere and by
    // name.
    line_items: (o.line_items || []).map((li: any) => ({
      id: li.id, product_id: li.product_id ?? null, variant_id: li.variant_id ?? null,
      title: li.title, variant_title: li.variant_title ?? null,
      sku: li.sku ?? null, quantity: li.quantity,
      fulfillable_quantity: li.fulfillable_quantity ?? null,
      price: li.price, total_discount: li.total_discount ?? null,
    })),
    shipping_address: addr(o.shipping_address),
    billing_address: addr(o.billing_address),
    customer: o.customer
      ? {
          id: o.customer.id, first_name: o.customer.first_name, last_name: o.customer.last_name,
          email: o.customer.email ?? null, phone: o.customer.phone ?? null,
        }
      : null,
    fulfillments: (o.fulfillments || []).map((f: any) => ({
      id: f.id, status: f.status, shipment_status: f.shipment_status ?? null,
      tracking_company: f.tracking_company ?? null, tracking_number: f.tracking_number ?? null,
      tracking_url: f.tracking_url ?? (f.tracking_urls || [])[0] ?? null,
      created_at: f.created_at ?? null,
    })),
    // Money that already went back, summarised. The full refund objects carry
    // adjustment and duty sets nobody reads.
    refunds: (o.refunds || []).map((r: any) => ({
      id: r.id, created_at: r.created_at, note: r.note ?? null,
      amount: (r.transactions || []).reduce((s: number, t: any) => s + Number(t.amount || 0), 0).toFixed(2),
    })),
    discount_codes: (o.discount_codes || []).map((d: any) => ({ code: d.code, amount: d.amount, type: d.type })),
  };
}

/**
 * Ordered vs shipped vs pending vs refunded, per line.
 *
 * Two reads: the order (which already carries `fulfillments` and `refunds`)
 * and the fulfillment orders (the only place a not-yet-dispatched second
 * shipment exists). The arithmetic itself is pure and lives in
 * `shopify-item-reconciliation.ts` so it can be tested against real payload
 * shapes without a network.
 */
/**
 * The customer's own profile, changed and then independently verified.
 *
 * `args` arrives already scoped: customer-access-guard.ts stripped whatever
 * selector the model supplied and substituted the authenticated one, so
 * `resolveCustomer` here is looking up a record the system chose.
 *
 * The read-back is a separate GET on purpose. Shopify's PUT echoes the object
 * it believes it saved, which is the same call reporting on itself - it cannot
 * distinguish "saved" from "accepted, then normalised to something else", and
 * an update that silently did not take is exactly the case a customer must not
 * be told succeeded.
 */
async function updateOwnProfile(ctx: Ctx, args: Record<string, any>): Promise<Record<string, unknown>> {
  // The selector arrives under its own reserved key. Merging it into the
  // arguments made it indistinguishable from a requested change: an injected
  // `{ phone: … }` reads as "set my phone to this", and an injected
  // `{ customer_id: … }` was rejected by the field validator, which then
  // reported `nothing_to_update` for a change the customer had just confirmed.
  const { [SELF_SCOPE_KEY]: selector, address, ...flat } = args as Record<string, any>;
  const c = await resolveCustomer(ctx, (selector as Record<string, any>) ?? {});
  if (!c) throw new Error("customer_not_found");

  const patch = validateProfilePatch({ ...flat, ...(address ? { address } : {}) });
  if (patch.errors.length) {
    return {
      customer_id: String(c.id),
      updated: false,
      errors: patch.errors,
      rejected_fields: patch.rejected,
      model_instruction:
        "The update was NOT made. Tell the customer plainly which value was not accepted and ask for a corrected one." +
        " Do not say anything was changed.",
    };
  }

  // Uniqueness, before Shopify turns it into an opaque 422. A customer whose
  // new email already sits on another account needs to hear that, not "the
  // update failed".
  if (patch.customer.email || patch.customer.phone) {
    const field = patch.customer.email ? "email" : "phone";
    const value = patch.customer.email ?? patch.customer.phone ?? "";
    let candidates: any[] = [];
    try {
      // Escaped, unlike the REST call this replaces: an apostrophe in what the
      // customer typed used to end the term and have the rest read as syntax.
      candidates = await searchCustomers(ctx, `${field}:${escapeSearchValue(value)}`, 5);
    } catch {
      // A search failure must not block a legitimate change; Shopify still
      // enforces uniqueness on the write itself.
    }
    const dup = detectDuplicate(patch, String(c.id), candidates);
    if (dup.conflict) {
      return {
        customer_id: String(c.id),
        updated: false,
        conflict: dup.field,
        model_instruction:
          `That ${dup.field} is already registered to a different account, so it cannot be moved onto this one.` +
          " Say exactly that, and offer to hand over to a person who can merge the accounts. Do not say anything was changed.",
      };
    }
  }

  if (Object.keys(patch.customer).length) {
    await updateCustomer(ctx, String(c.id), patch.customer);
  }

  if (Object.keys(patch.address).length) {
    const existing = c.default_address ?? (c.addresses ?? [])[0] ?? null;
    // An address is addressed by its gid, which the mapper keeps beside the
    // numeric id. Creating one sets it as the default in the SAME call, so the
    // first-address case can no longer half-land as an address that exists and
    // is not the customer's.
    await writeCustomerAddress(ctx, String(c.id), patch.address, existing?.admin_graphql_api_id ?? null);
  }

  const after = await getCustomerById(ctx, String(c.id));
  const verdict = verifyReadBack(patch, after);
  const changed = [
    ...Object.keys(patch.customer),
    ...Object.keys(patch.address).map((k) => `address.${k}`),
  ];

  return {
    customer_id: String(c.id),
    updated: verdict.verified,
    verified: verdict.verified,
    changed_fields: verdict.verified ? changed : [],
    mismatches: verdict.mismatches,
    normalized_fields: verdict.normalized,
    rejected_fields: patch.rejected,
    sensitive_change: patch.sensitive,
    // Only on a verified write. The ledger treats an id as proof the action is
    // claimable, so handing it one for a change the read-back did not confirm
    // would be worse than the missing-id problem it solves.
    ...(verdict.verified ? { externalRef: { type: "shopify_customer", id: String(c.id) } } : {}),
    model_instruction: verdict.verified
      ? `The change is confirmed by an independent read of the record. Tell the customer exactly which fields changed (${changed.join(", ")}) and nothing more.`
      : "The read-back does NOT match what was requested, so the change did not take effect as asked." +
        " Tell the customer it did not go through and offer a person. Do NOT say it was updated.",
  };
}

// ─── Returns (RMA) ──────────────────────────────────────────
//
// `returnCreate` works against FULFILLMENT line items, not order line items.
// That is not a quirk to route around: an item that never shipped has nothing
// to return, and the API saying so is more correct than a tool that would
// happily open an RMA for a parcel still in the warehouse.

// Read the FULFILLMENTS and their line items, not `returnableFulfillments`.
//
// Live (2026-08-02): `Field 'returnableFulfillments' doesn't exist on type
// 'Order'` on the current API version - after a human had approved the return.
// GraphQL fails the WHOLE query on one unknown field, so a convenience field
// that comes and goes across versions is the worst possible thing to build a
// money-adjacent action on. `fulfillments { fulfillmentLineItems }` is the
// stable shape and carries exactly what returnCreate needs.
const RETURNABLE_FULFILLMENTS_QUERY = `
  query ReturnableFulfillments($id: ID!) {
    order(id: $id) {
      id
      name
      fulfillments(first: 20) {
        id
        status
        fulfillmentLineItems(first: 50) {
          nodes {
            id
            quantity
            lineItem { id title sku }
          }
        }
      }
    }
  }`;

/**
 * The supported way to (re)send an order confirmation.
 *
 * REST `POST /orders/{id}/send_invoice.json` answers 406 on the current API,
 * and answered it to a live customer in Part 4 as `shopify_406`. This works.
 */
const ORDER_INVOICE_SEND = `
  mutation OrderInvoiceSend($id: ID!) {
    orderInvoiceSend(id: $id) {
      order { id name }
      userErrors { field message }
    }
  }`;

const RETURN_CREATE_MUTATION = `
  mutation ReturnCreate($input: ReturnInput!) {
    returnCreate(returnInput: $input) {
      return { id name status totalQuantity }
      userErrors { field message }
    }
  }`;

/** Shopify's ReturnReason enum. Anything unrecognised becomes UNKNOWN. */
const RETURN_REASONS = new Set([
  "COLOR", "DEFECTIVE", "NOT_AS_DESCRIBED", "OTHER", "SIZE_TOO_LARGE", "SIZE_TOO_SMALL",
  "STYLE", "UNKNOWN", "UNWANTED", "WRONG_ITEM",
]);

function normalizeReturnReason(v: unknown): string {
  const s = String(v ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  return RETURN_REASONS.has(s) ? s : "UNKNOWN";
}

/**
 * Open a real Shopify return and report its real id.
 *
 * The rule this exists to keep: a return is only claimed once the provider has
 * handed back an id. Everything before that - a note, a tag, a customer record,
 * an intention - reaches nobody, and scenario 21 is what "we've passed it on"
 * looks like when nothing was passed anywhere.
 */
async function createShopifyReturn(
  ctx: Ctx,
  order: any,
  args: Record<string, any>,
): Promise<Record<string, unknown>> {
  // Nothing may be returned twice. Checked here as well as in the directive,
  // because a re-dispatched approval would otherwise open a second RMA for the
  // same complaint.
  const existing = await shopifyGraphQL(ctx, RETURNS_QUERY, { id: orderGid(order.id) });
  const openReturns = (existing?.order?.returns?.nodes ?? []).filter(
    (r: any) => !["CLOSED", "CANCELED", "CANCELLED", "DECLINED"].includes(String(r?.status ?? "").toUpperCase()),
  );
  if (openReturns.length) {
    return {
      order_id: String(order.id),
      name: order.name,
      return_created: false,
      already_open: true,
      return_id: String(openReturns[0].id),
      return_status: openReturns[0].status ?? null,
      model_instruction:
        `A return is ALREADY open on this order (${openReturns[0].name ?? openReturns[0].id}, status ${openReturns[0].status}). ` +
        `Tell the customer it is already open and give them its status. Do NOT open another one.`,
    };
  }

  const returnable = await shopifyGraphQL(ctx, RETURNABLE_FULFILLMENTS_QUERY, { id: orderGid(order.id) });
  const fulfilled: any[] = returnable?.order?.fulfillments ?? [];
  const available = fulfilled
    // A cancelled fulfillment shipped nothing, so nothing on it can come back.
    .filter((f: any) => String(f?.status ?? "").toUpperCase() !== "CANCELLED")
    .flatMap((f: any) =>
      (f?.fulfillmentLineItems?.nodes ?? []).map((li: any) => ({
        fulfillmentLineItemId: li?.id,
        orderLineItemId: String(li?.lineItem?.id ?? "").split("/").pop(),
        title: li?.lineItem?.title ?? "",
        maxQuantity: Number(li?.quantity ?? 0),
      })),
    )
    .filter((x: any) => x.fulfillmentLineItemId && x.maxQuantity > 0);

  if (!available.length) {
    return {
      order_id: String(order.id),
      name: order.name,
      return_created: false,
      returnable_items: 0,
      model_instruction:
        "Nothing on this order can be returned - Shopify has no returnable fulfilled items for it, which normally means it " +
        "has not been delivered yet or everything has already been returned. Say exactly that. Do NOT say a return was opened.",
    };
  }

  const requested: any[] = Array.isArray(args.line_items) ? args.line_items : [];
  const selected = requested.length
    ? requested
        .map((r: any) => {
          const match = available.find((a: any) => String(a.orderLineItemId) === String(r.line_item_id));
          if (!match) return null;
          const qty = r.quantity != null ? Math.floor(Number(r.quantity)) : match.maxQuantity;
          if (!Number.isFinite(qty) || qty < 1) return null;
          return {
            fulfillmentLineItemId: match.fulfillmentLineItemId,
            quantity: Math.min(qty, match.maxQuantity),
            returnReason: normalizeReturnReason(r.reason),
            returnReasonNote: args.note ? String(args.note).slice(0, 500) : undefined,
            title: match.title,
          };
        })
        .filter(Boolean)
    : available.map((a: any) => ({
        fulfillmentLineItemId: a.fulfillmentLineItemId,
        quantity: a.maxQuantity,
        returnReason: normalizeReturnReason(args.reason),
        returnReasonNote: args.note ? String(args.note).slice(0, 500) : undefined,
        title: a.title,
      }));

  if (!selected.length) {
    return {
      order_id: String(order.id),
      name: order.name,
      return_created: false,
      returnable_items: available.length,
      model_instruction:
        "The items asked for are not among the ones this order can return. Name what IS returnable and ask which they mean. " +
        "Do NOT say a return was opened.",
    };
  }

  const created = await shopifyGraphQL(ctx, RETURN_CREATE_MUTATION, {
    input: {
      orderId: orderGid(order.id),
      returnLineItems: selected.map((s: any) => ({
        fulfillmentLineItemId: s.fulfillmentLineItemId,
        quantity: s.quantity,
        returnReason: s.returnReason,
        ...(s.returnReasonNote ? { returnReasonNote: s.returnReasonNote } : {}),
      })),
    },
  });
  const err = firstUserError(created?.returnCreate);
  if (err) throw new Error(`shopify_return_create: ${err}`);

  const rid = created?.returnCreate?.return?.id;
  if (!rid) throw new Error("shopify_return_create: no return id returned");

  // Independent read-back. A return id from the mutation is the mutation's own
  // word for it; this is the order confirming the return exists on it.
  const after = await shopifyGraphQL(ctx, RETURNS_QUERY, { id: orderGid(order.id) });
  const found = (after?.order?.returns?.nodes ?? []).find((r: any) => String(r?.id) === String(rid));

  return {
    order_id: String(order.id),
    name: order.name,
    return_created: !!found,
    verified: !!found,
    return_provider: "shopify",
    return_id: String(rid),
    return_name: found?.name ?? created?.returnCreate?.return?.name ?? null,
    return_status: found?.status ?? created?.returnCreate?.return?.status ?? null,
    items: selected.map((s: any) => ({ title: s.title, quantity: s.quantity, reason: s.returnReason })),
    ...(found ? { externalRef: { type: "shopify_return", id: String(rid) } } : {}),
    model_instruction: found
      ? `The return is open and confirmed on the order. Tell the customer it is open, give them the return reference (${found.name ?? rid}) and say what happens next only if you actually know it.`
      : `The return could not be confirmed on a read-back of the order, so do NOT tell the customer it is open. Say it did not complete and hand over to a person.`,
  };
}

// ─── Order edit (exchange) ──────────────────────────────────
//
// The REST Admin API cannot edit a placed order at all; `orderEdit` is
// GraphQL-only. It is a three-step session - begin, mutate the calculated
// order, commit - and nothing is real until the commit, which is what makes a
// pre-flight refusal safe: an exchange we decline never existed.

// The calculated order's LINE ITEMS come back from this mutation, because there
// is no top-level `calculatedOrder` query to fetch them with afterwards. The
// first version issued one - `Field 'calculatedOrder' doesn't exist on type
// 'QueryRoot'` - which failed after a human had approved the exchange. Same
// lesson as `returnableFulfillments`: GraphQL fails the whole document on one
// unknown field, so a money-adjacent action must not be built on a field nobody
// has watched execute.
const ORDER_EDIT_BEGIN = `
  mutation OrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalOutstandingSet { shopMoney { amount } }
        lineItems(first: 100) {
          nodes { id quantity variant { id } }
        }
      }
      userErrors { field message }
    }
  }
`;

// `restock` is not optional in practice, and leaving it out is what turned a
// same-price swap into a 50% larger bill.
//
// Reducing a PAID line without it does not credit the line: Shopify keeps the
// charge and the added variant is billed on top. Live (2026-08-02) order #1012
// went from 2 boards at 1399.90 to a subtotal of 2099.85 and
// `financial_status: partially_paid` - a customer owing money for a swap that
// was supposed to cost nothing. With `restock: true` the same edit nets to
// exactly the original subtotal.
//
// Both mutations return the running totals so the caller can check the money
// BEFORE committing, using Shopify's arithmetic rather than its own.
const ORDER_EDIT_SET_QUANTITY = `
  mutation OrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!, $restock: Boolean) {
    orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: $restock) {
      calculatedOrder {
        id
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalOutstandingSet { shopMoney { amount } }
      }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_ADD_VARIANT = `
  mutation OrderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
    orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
      calculatedOrder {
        id
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalOutstandingSet { shopMoney { amount } }
      }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_COMMIT = `
  mutation OrderEditCommit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      order { id name }
      userErrors { field message }
    }
  }
`;

/** A Shopify MoneyBag's amount, or NaN-free zero when it is absent. */
function money(set: any): number {
  const n = Number(set?.shopMoney?.amount);
  return Number.isFinite(n) ? n : 0;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function firstUserError(payload: any): string | null {
  const errs = payload?.userErrors;
  if (Array.isArray(errs) && errs.length) {
    return errs.map((e: any) => e?.message).filter(Boolean).join("; ") || "order_edit_rejected";
  }
  return null;
}

/**
 * Swap one line item for a different variant on an order that has not shipped.
 *
 * The order of operations is deliberate and every step before the commit is a
 * refusal point: eligibility, then the quote, then the edit. Nothing is written
 * until all three pass, so a refused exchange leaves no half-applied state
 * behind - which matters because an aborted order edit is worse than none.
 */
async function exchangeOrderItem(
  ctx: Ctx,
  order: any,
  args: Record<string, any>,
): Promise<Record<string, unknown>> {
  // 1. Has it left yet? Same authority as the address change, re-read here
  //    because an approval may have been sitting for an hour.
  const fos = await fetchFulfillmentOrders(ctx, order.id);
  const m = assessMutability(order, fos);
  if (m.verdict !== "editable") {
    return {
      order_id: String(order.id),
      name: order.name,
      exchange_completed: false,
      eligible: false,
      reason: m.reason,
      fulfillment_states: m.fulfillment_states,
      model_instruction:
        `${m.customer_explanation} An exchange is no longer an order edit at this point - it has to be a RETURN plus a ` +
        `replacement. Explain that, and take the return route if one is configured. Do NOT say the item was exchanged, ` +
        `and do NOT say a warehouse or courier was contacted.`,
    };
  }

  // 2. Which line, and which replacement?
  const lines: any[] = order.line_items ?? [];
  const lineItem =
    (args.line_item_id && lines.find((l) => String(l.id) === String(args.line_item_id))) ||
    (args.current_variant_id && lines.find((l) => String(l.variant_id) === String(args.current_variant_id))) ||
    (lines.length === 1 ? lines[0] : null);

  let variant: any = null;
  let productTitle = "";
  if (args.new_variant_id) {
    try {
      variant = await getVariantById(ctx, String(args.new_variant_id));
      if (variant?.product_id) {
        const pr = await getProductById(ctx, variant.product_id);
        productTitle = pr?.title ?? "";
      }
    } catch {
      variant = null;
    }
  }
  // No id, but a name the customer used. Resolve it against the SAME product
  // the line item is on - a colour or size only means anything within one
  // product, and searching the catalogue for "Dawn" would find whatever else
  // happens to be called that.
  if (!variant && args.new_variant_name && lineItem?.product_id) {
    try {
      // With inventory: the quote refuses an exchange for a variant that is out
      // of stock, and `inventory_management` is how it tells tracked from not.
      const product = await getProductById(ctx, String(lineItem.product_id), true);
      productTitle = product?.title ?? "";
      const want = String(args.new_variant_name).trim().toLowerCase();
      variant =
        (product?.variants ?? []).find((v: any) => String(v.title ?? "").trim().toLowerCase() === want) ??
        (product?.variants ?? []).find((v: any) =>
          [v.option1, v.option2, v.option3].some((o: any) => String(o ?? "").trim().toLowerCase() === want),
        ) ??
        null;
    } catch {
      variant = null;
    }
  }

  const quoted = quoteExchange({
    orderName: String(order.name ?? ""),
    currency: String(order.currency ?? ""),
    lineItem: lineItem ?? null,
    variant,
    productTitle,
    quantity: args.quantity != null ? Number(args.quantity) : Number(lineItem?.quantity ?? 1),
  });

  if (!quoted.ok) {
    return {
      order_id: String(order.id),
      name: order.name,
      exchange_completed: false,
      eligible: false,
      reason: quoted.reason,
      quote: quoted.quote ?? null,
      model_instruction: exchangeRefusalInstruction(quoted.reason, quoted.detail),
    };
  }
  const quote = quoted.quote;

  // 3. The edit itself.
  const begun = await shopifyGraphQL(ctx, ORDER_EDIT_BEGIN, { id: orderGid(order.id) });
  const beginErr = firstUserError(begun?.orderEditBegin);
  if (beginErr) throw new Error(`shopify_order_edit_begin: ${beginErr}`);
  const calcId = begun?.orderEditBegin?.calculatedOrder?.id;
  if (!calcId) throw new Error("shopify_order_edit_begin: no calculated order returned");

  // The CALCULATED order's line ids are not the order's line ids.
  // `orderEditSetQuantity` wants a `CalculatedLineItem` gid, and passing the
  // order's own `LineItem` gid fails with a message about an invalid id that
  // reads like a permissions problem. The mapping comes back from the begin
  // mutation itself.
  const calcLine = (begun?.orderEditBegin?.calculatedOrder?.lineItems?.nodes ?? []).find(
    (n: any) => String(n?.variant?.id ?? "").endsWith(`/${quote.current_variant_id}`),
  );
  if (!calcLine?.id) throw new Error("shopify_order_edit: could not locate the line to replace");

  const outstandingBefore = money(begun?.orderEditBegin?.calculatedOrder?.totalOutstandingSet);

  const remaining = Math.max(0, quote.original_quantity - quote.quantity);
  const setQty = await shopifyGraphQL(ctx, ORDER_EDIT_SET_QUANTITY, {
    id: calcId,
    lineItemId: calcLine.id,
    quantity: remaining,
    // Credits the reduced line. Without it Shopify keeps the charge and bills
    // the replacement on top - a same-price swap that costs the customer money.
    restock: true,
  });
  const setErr = firstUserError(setQty?.orderEditSetQuantity);
  if (setErr) throw new Error(`shopify_order_edit_set_quantity: ${setErr}`);

  const added = await shopifyGraphQL(ctx, ORDER_EDIT_ADD_VARIANT, {
    id: calcId,
    variantId: `gid://shopify/ProductVariant/${quote.requested_variant_id}`,
    quantity: quote.quantity,
  });
  const addErr = firstUserError(added?.orderEditAddVariant);
  if (addErr) throw new Error(`shopify_order_edit_add_variant: ${addErr}`);

  // THE settlement guard, and the last point at which nothing has happened yet.
  //
  // The quote's arithmetic says the prices match. This asks SHOPIFY whether the
  // edit it has actually staged leaves the customer owing anything different
  // from what they owed before - which is the only question that matters, and
  // the one my own arithmetic got wrong once already. An uncommitted calculated
  // order simply expires, so refusing here leaves the order untouched.
  const outstandingAfter = money(added?.orderEditAddVariant?.calculatedOrder?.totalOutstandingSet);
  const delta = round2(outstandingAfter - outstandingBefore);
  if (Math.abs(delta) >= 0.005) {
    return {
      order_id: String(order.id),
      name: order.name,
      exchange_completed: false,
      eligible: false,
      reason: "settlement_delta_not_zero",
      settlement_delta: delta.toFixed(2),
      quote,
      model_instruction:
        `This exchange would leave the order ${delta > 0 ? "owing" : "owed"} ${Math.abs(delta).toFixed(2)} ${quote.currency}, ` +
        `so it was NOT applied and the order is unchanged. Tell the customer the swap cannot be completed as an even exchange ` +
        `and offer a real handover to a person who can settle the difference. Do NOT say the item was exchanged, and do NOT ` +
        `offer a discount, coupon or store credit to close the gap.`,
    };
  }

  const committed = await shopifyGraphQL(ctx, ORDER_EDIT_COMMIT, {
    id: calcId,
    notifyCustomer: false,
    staffNote: `Exchange requested in chat: ${quote.current_variant ?? quote.current_title} → ${quote.requested_variant ?? quote.requested_title}`,
  });
  const commitErr = firstUserError(committed?.orderEditCommit);
  if (commitErr) throw new Error(`shopify_order_edit_commit: ${commitErr}`);

  // 4. Read the order back independently and check BOTH sides of the swap.
  const after: any = await getOrderById(ctx, String(order.id));
  const verdict = verifyExchange(quote, after ?? null);

  return {
    order_id: String(order.id),
    name: order.name,
    exchange_completed: verdict.verified,
    verified: verdict.verified,
    problems: verdict.problems,
    quote,
    order_total: after?.total_price ?? null,
    ...(verdict.verified ? { externalRef: { type: "shopify_order", id: String(order.id) } } : {}),
    model_instruction: verdict.verified
      ? `The exchange is confirmed by an independent read of the order: ${quote.current_variant ?? quote.current_title} was replaced with ${quote.requested_variant ?? quote.requested_title}. Tell the customer exactly that. There is nothing further to pay.`
      : `The order does NOT read back as expected after the edit (${verdict.problems.join(", ")}). Tell the customer the exchange did not complete and hand over to a person. Do NOT say the item was exchanged.`,
  };
}

/**
 * The real options for what is actually on this order.
 *
 * Reads the line items' own products, so a colour question is answered from
 * the order rather than from a search for whatever the customer called the
 * thing. Degrades to a plain sentence rather than throwing: this runs inside a
 * refusal, and a refusal that fails is worse than one that is vague.
 */
async function exchangeOptionsForOrder(
  call: (tool: string, args: Record<string, any>) => Promise<any>,
  order: any,
): Promise<string> {
  try {
    const lines: any[] = order?.line_items ?? [];
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const li of lines) {
      if (!li?.product_id || seen.has(String(li.product_id))) continue;
      seen.add(String(li.product_id));
      const info = await call("variant_information", { product_id: String(li.product_id) });
      const variants: any[] = info?.variants ?? [];
      if (!info?.has_variant_options || variants.length < 2) {
        parts.push(`"${li.title}" is sold in one version only - there is nothing to exchange it for.`);
        continue;
      }
      const available = variants
        .map((v) => `${v.title}${v.in_stock === false ? " (out of stock)" : ""}`)
        .join(", ");
      parts.push(`"${li.title}" comes in: ${available}.`);
    }
    return parts.length ? parts.join(" ") : "The order's options could not be read.";
  } catch {
    return "The order's available options could not be read right now.";
  }
}

/** What the model may say about each way an exchange can be refused. */
function exchangeRefusalInstruction(reason: string, detail: string): string {
  const base = `${detail} Do NOT say the item was exchanged.`;
  switch (reason) {
    case "price_difference_requires_payment":
      return (
        `${base} Say plainly that the difference has to be paid and that you cannot take payment here, then offer a real ` +
        `handover to a person who can. Do NOT offer a discount, a coupon or a free upgrade to close the gap - none of those exist.`
      );
    case "price_difference_requires_refund":
      return (
        `${base} Say plainly that the replacement is cheaper and the difference has to be settled separately, then offer a real ` +
        `handover to a person. Do NOT promise a refund yourself and do NOT invent store credit.`
      );
    case "out_of_stock":
      return `${base} Offer the options that ARE available, from a real variant lookup - do not guess at alternatives.`;
    default:
      return `${base} Ask for what you actually need, or offer a person if the request cannot be met.`;
  }
}

/**
 * Redirect an order that has not left yet.
 *
 * The eligibility check runs again here even though `precheckEligibility`
 * already ran it. That is not redundancy: the precheck happens before a human
 * approves, and an approval can sit for minutes or hours. The warehouse does
 * not wait for it. Between the question and the answer the order may have been
 * picked, and applying the approved address then would be Shopify accepting a
 * write against a parcel that is already labelled.
 */
async function updateOrderShippingAddress(
  ctx: Ctx,
  order: any,
  address: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fos = await fetchFulfillmentOrders(ctx, order.id);
  const m = assessMutability(order, fos);
  if (m.verdict !== "editable") {
    return {
      order_id: String(order.id),
      name: order.name,
      address_updated: false,
      eligible: false,
      reason: m.reason,
      fulfillment_states: m.fulfillment_states,
      model_instruction:
        `${m.customer_explanation} Say exactly that. Do NOT say the address was changed. ` +
        `Do NOT say the carrier, courier or warehouse has been contacted - nothing in this tool reaches them. ` +
        `If a tracking link exists you may offer it, and if they need a person, create a real handover.`,
    };
  }

  const patch = validateShippingAddress(address);
  if (patch.missing.length || patch.errors.length) {
    return {
      order_id: String(order.id),
      name: order.name,
      address_updated: false,
      eligible: true,
      missing_fields: patch.missing,
      errors: patch.errors,
      model_instruction:
        "The address was NOT changed because it is incomplete or invalid. Ask the customer for the missing or corrected " +
        "part, then try again. Do not say anything was changed.",
    };
  }

  const before = order.shipping_address ?? {};
  await writeOrderShippingAddress(ctx, String(order.id), { ...before, ...patch.fields });

  // A SEPARATE read, not the mutation's echo: "Shopify accepted it" and "the
  // parcel is going there" are different claims.
  const after: any = await getOrderById(ctx, String(order.id));
  const verdict = verifyShippingAddress(patch, after ?? null);

  return {
    order_id: String(order.id),
    name: order.name,
    address_updated: verdict.verified,
    verified: verdict.verified,
    changed_fields: verdict.verified ? Object.keys(patch.fields) : [],
    mismatches: verdict.mismatches,
    normalized_fields: verdict.normalized,
    // City and country only. An approval card and a chat transcript are both
    // read by people who do not need the customer's street address to
    // understand what is being decided.
    from: { city: before.city ?? null, country: before.country ?? null },
    to: { city: patch.fields.city ?? before.city ?? null, country: patch.fields.country ?? before.country ?? null },
    ...(verdict.verified ? { externalRef: { type: "shopify_order", id: String(order.id) } } : {}),
    model_instruction: verdict.verified
      ? `The order's delivery address is confirmed changed by an independent read of the order. Tell the customer the new city and country, and nothing about carriers.` +
        (verdict.normalized.length
          ? ` The shop stored ${verdict.normalized.map((n) => `${n.field} as "${n.actual}"`).join(", ")} - use that wording, it is what is on the label.`
          : "")
      : `The read-back does NOT match the requested address, so the change did not take effect. Tell the customer it did not go through and offer a person. Do NOT say the address was changed.`,
  };
}

async function reconcileOrderItems(ctx: Ctx, order: any): Promise<Record<string, unknown>> {
  const fos = await fetchFulfillmentOrders(ctx, order.id);
  return reconcile(order, fos) as unknown as Record<string, unknown>;
}

function hasOutstandingFulfillments(fulfillmentOrders: any[]): boolean {
  return fulfillmentOrders.some((f: any) => {
    const status = String(f?.status ?? "").toLowerCase();
    const request = String(f?.request_status ?? "").toLowerCase();
    if (["in_progress", "incomplete"].includes(status)) return true;
    return ["submitted", "accepted"].includes(request);
  });
}

/**
 * The supported way to cancel an order on a current API version.
 *
 * Asynchronous by design: it returns a Job, so a caller that reports success
 * on the mutation alone is guessing. `orderCancelUserErrors` carries the real
 * refusals (already cancelled, cannot refund, and so on) as structured codes
 * rather than the misleading blanket 422 the REST endpoint returns.
 */
const ORDER_CANCEL_MUTATION = `
  mutation OrderCancel(
    $orderId: ID!
    $reason: OrderCancelReason!
    $refund: Boolean!
    $restock: Boolean!
    $notifyCustomer: Boolean
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      refund: $refund
      restock: $restock
      notifyCustomer: $notifyCustomer
    ) {
      job { id done }
      orderCancelUserErrors { field message code }
    }
  }
`;

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

// Product search. Field set is deliberately conservative - every field
// here exists in 2024-04, because GraphQL fails the WHOLE query on one
// unknown field and the fallback would then be the only path that ever runs.

/* ───── Product narrowing ───── */

/**
 * How much cheaper than the anchor a product must be before we are willing to
 * call it an accessory rather than an alternative.
 *
 * 0.6 is a judgement, not a measurement: it admits a 350 binding for a 600
 * board and refuses a 585 board, which is the distinction that matters. It only
 * governs the last-resort store-wide scan - a merchant's own curated list and
 * the shared-collection rule are both better evidence and are tried first.
 */
const ACCESSORY_PRICE_RATIO = 0.6;

export interface ComplementAnchor {
  /** legacyResourceId of the product being complemented. */
  id: string;
  /** Its product type, lowercased. "" when the store leaves it blank. */
  type: string;
  /** Its lowest buyable price, or null when unpriced. */
  price: number | null;
}

/**
 * Pick the products that go WITH the anchor, out of a candidate list.
 *
 * Three rules, all of them exclusions:
 *  - never the anchor itself, and never something nobody can buy;
 *  - never the same product type. Another item from the category the customer
 *    just chose from is a competitor, not a complement - offering a second
 *    snowboard as an "add-on" to the first reads as not having listened;
 *  - never above `maxRatio` of the anchor's price. An accessory is materially
 *    cheaper than what it accompanies; without this the rule degrades into
 *    "any other product in the store".
 *
 * `seen` is carried in so a caller can run this over several sources - the
 * merchant's collections first, the whole store second - without repeating a
 * product between them.
 */
export function selectComplements(
  candidates: any[],
  anchor: ComplementAnchor,
  opts: { want: number; maxRatio?: number; seen?: Set<string> },
): any[] {
  const seen = opts.seen ?? new Set<string>();
  const ratio = opts.maxRatio;
  const out: any[] = [];
  for (const p of narrowProducts(candidates, null, true)) {
    if (out.length >= opts.want) break;
    const key = String(p?.id ?? "");
    if (!key || key === String(anchor.id) || seen.has(key)) continue;
    if (anchor.type && String(p?.product_type || "").toLowerCase() === anchor.type) continue;
    const price = lowestPrice(p, true);
    if (ratio !== undefined) {
      // A product we cannot price cannot be shown to be accessory-shaped.
      if (price === null) continue;
      if (anchor.price !== null && price > anchor.price * ratio) continue;
    } else if (anchor.price !== null && price !== null && price > anchor.price) {
      continue;
    }
    seen.add(key);
    out.push(p);
  }
  return out;
}

export interface PriceBounds { min?: number; max?: number }

/** Case-insensitive equality against a store string. An absent filter matches. */
export function matchesTerm(value: unknown, wanted: unknown): boolean {
  const w = String(wanted ?? "").trim();
  if (!w) return true;
  return String(value ?? "").trim().toLowerCase() === w.toLowerCase();
}

/**
 * One `field:"value"` clause for Shopify's search grammar.
 *
 * Quoted, because the values are the store's own strings and they contain
 * spaces: `vendor:Snowboard Vendor` parses as vendor "Snowboard" plus a
 * free-text term "Vendor", which matches a different set of products entirely.
 */
export function termClause(field: string, value: unknown): string {
  const v = String(value ?? "").trim();
  if (!v) return "";
  return `${field}:"${v.replace(/"/g, '\\"')}"`;
}

export interface OptionFilter { name: string; value: string }

/** Read a variant-option filter off tool args. Both halves or nothing - a name
 *  with no value cannot narrow, and a value with no name is ambiguous. */
export function optionFilter(args: Record<string, any>): OptionFilter | null {
  const name = String(args?.option_name ?? "").trim();
  const value = String(args?.option_value ?? "").trim();
  if (!name || !value) return null;
  return { name, value };
}

/**
 * Keep products that have a variant carrying this option value.
 *
 * Shopify's Admin search has no predicate for a variant option, so "a snowboard
 * in Powder" can only be answered after reading the variants. Matching is on
 * the SELECTED OPTION of a real variant rather than the product's declared
 * option list, because a product can advertise a Color axis and stock none of
 * the colours the shopper asked for.
 */
export function filterByOption(products: any[], filter: OptionFilter | null): any[] {
  if (!filter) return Array.isArray(products) ? products : [];
  return (Array.isArray(products) ? products : []).filter((p: any) => {
    const idx = (Array.isArray(p?.options) ? p.options : []).findIndex((o: any) =>
      matchesTerm(o?.name, filter.name),
    );
    if (idx < 0) return false;
    const key = (["option1", "option2", "option3"] as const)[idx];
    if (!key) return false;
    return (Array.isArray(p?.variants) ? p.variants : []).some((v: any) => matchesTerm(v?.[key], filter.value));
  });
}

/** Read the price window off tool args. Returns null when neither bound is usable. */
export function priceBounds(args: Record<string, any>): PriceBounds | null {
  const num = (v: unknown): number | undefined => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const min = num(args?.price_min);
  const max = num(args?.price_max);
  if (min === undefined && max === undefined) return null;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

/**
 * The lowest buyable price on a product, which is the number a shopper judges
 * a budget against.
 *
 * Lowest and not first: the first variant is an arbitrary one, and on a product
 * whose 159cm costs more than its 152cm, judging a 600 budget by whichever
 * variant Shopify happened to list first excludes a board the shopper could
 * actually have bought. When `inStockOnly`, unbuyable variants do not get a
 * vote either - an in-budget price you cannot purchase is not a price.
 */
export function lowestPrice(product: any, inStockOnly: boolean): number | null {
  const variants: any[] = Array.isArray(product?.variants) ? product.variants : [];
  const prices = variants
    .filter((v) => (inStockOnly ? v?.available !== false : true))
    // Guard the empties BEFORE Number(): Number(null) and Number("") are both
    // 0, so a variant with no price would read as free and match every budget
    // ever named, including "under 20".
    .map((v) => (v?.price === null || v?.price === undefined || v?.price === "" ? NaN : Number(v.price)))
    .filter((n) => Number.isFinite(n));
  if (prices.length === 0) return null;
  return Math.min(...prices);
}

/** Does the product have any variant a shopper can actually buy right now? */
export function hasBuyableVariant(product: any): boolean {
  const variants: any[] = Array.isArray(product?.variants) ? product.variants : [];
  // No variant carries an availability verdict -> we do not know, and "unknown"
  // must not be read as "gone". Only an explicit false on EVERY variant is a
  // product nobody can buy.
  if (!variants.some((v) => typeof v?.available === "boolean")) return true;
  return variants.some((v) => v?.available === true);
}

/**
 * Apply stock and price to a candidate list.
 *
 * Returns them narrowed, in the order they arrived - relevance is Shopify's
 * job, and re-sorting by price here would quietly turn "the best match under
 * 600" into "the cheapest thing in the store".
 */
export function narrowProducts(
  products: any[],
  bounds: PriceBounds | null,
  inStockOnly: boolean,
): any[] {
  let out = Array.isArray(products) ? products : [];
  if (inStockOnly) out = out.filter(hasBuyableVariant);
  if (bounds) {
    out = out.filter((p) => {
      const price = lowestPrice(p, inStockOnly);
      // An unpriced product cannot be shown to breach a bound, so a bound does
      // not exclude it. Same rule the budget path downstream already uses.
      if (price === null) return true;
      if (bounds.min !== undefined && price < bounds.min) return false;
      if (bounds.max !== undefined && price > bounds.max) return false;
      return true;
    });
  }
  return out;
}

/**
 * Order a narrowed candidate list.
 *
 * Relevance is the default and stays Shopify's job: re-sorting by price inside
 * a budget would turn "the best match under 600" into "the cheapest thing in
 * the store", which is why `narrowProducts` deliberately preserves arrival
 * order.
 *
 * `price_asc` exists for the one case where that reasoning inverts. When
 * nothing fits the budget, or too little does, the shopper is shown products
 * ABOVE what they asked to spend - and there, relevance ranking is close to
 * meaningless while distance from the budget is exactly what they are judging.
 * Live on Urban Supply a shopper asked for boards around 600 and was offered
 * 949 and 885 while a 629 sat twelfth in the relevance list, unseen. Ordering
 * is opt-in rather than automatic so the default path keeps the behaviour the
 * comment above protects.
 */
export function sortProducts(products: any[], sort: unknown, inStockOnly: boolean): any[] {
  if (sort !== "price_asc") return products;
  return [...products].sort((a, b) => {
    const pa = lowestPrice(a, inStockOnly);
    const pb = lowestPrice(b, inStockOnly);
    // An unpriced product cannot be ranked against a number, and dropping it
    // here would hide a product the filters deliberately kept. It sorts last.
    if (pa === null && pb === null) return 0;
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb;
  });
}

/** One product selection, shared by every query that returns products, so a
 *  field added for search is present in recommendations too. */
const PRODUCT_NODE_FIELDS = `
  legacyResourceId
  title
  handle
  status
  vendor
  productType
  tags
  featuredImage { url }
  images(first: 5) { nodes { url } }
  options { name }
  variants(first: 50) {
    nodes {
      legacyResourceId
      title
      sku
      price
      compareAtPrice
      availableForSale
      inventoryQuantity
      inventoryPolicy
      selectedOptions { name value }
    }
  }`;

const PRODUCT_SEARCH_QUERY = `
  query ProductSearch($q: String!, $n: Int!, $sort: ProductSortKeys) {
    products(first: $n, query: $q, sortKey: $sort) {
      nodes { ${PRODUCT_NODE_FIELDS} }
    }
  }`;

/**
 * The anchor product, plus the two things that can name its complements: the
 * merchant's own curated list, and the collections it belongs to.
 *
 * The metafield is Shopify's Search & Discovery app writing where a merchant
 * clicked "complementary products" in the admin. It is the authoritative
 * answer when it exists, because it is a human saying "these go together"
 * rather than us inferring it from a price and a product type.
 */
const PRODUCT_COMPLEMENTS_QUERY = `
  query ProductComplements($id: ID!) {
    product(id: $id) {
      legacyResourceId
      title
      productType
      metafield(namespace: "shopify--discovery--product_recommendation", key: "complementary_products") { value }
      variants(first: 50) { nodes { price availableForSale } }
      collections(first: 5) { nodes { id } }
    }
  }`;

const PRODUCTS_BY_ID_QUERY = `
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { ${PRODUCT_NODE_FIELDS} }
    }
  }`;

const COLLECTION_PRODUCTS_QUERY = `
  query CollectionProducts($id: ID!, $n: Int!) {
    collection(id: $id) {
      products(first: $n) {
        nodes { ${PRODUCT_NODE_FIELDS} }
      }
    }
  }`;

/**
 * Map a GraphQL product onto the REST-ish shape the rest of the tool
 * surface already speaks, so callers (and the LLM) see one contract
 * regardless of which transport answered.
 *
 * `available` is carried through explicitly: `availableForSale` is
 * Shopify's own verdict and strictly better than re-deriving stock from
 * the inventory triplet.
 */
function mapGraphQLProduct(p: any): any {
  const variants = (p?.variants?.nodes || []).map((v: any) => {
    const opts: string[] = (v?.selectedOptions || []).map((o: any) => o?.value).filter(Boolean);
    return {
      id: v?.legacyResourceId ?? null,
      title: v?.title ?? null,
      sku: v?.sku ?? null,
      price: v?.price ?? null,
      compare_at_price: v?.compareAtPrice ?? null,
      available: v?.availableForSale === true,
      inventory_quantity: v?.inventoryQuantity ?? null,
      inventory_policy: String(v?.inventoryPolicy ?? "").toLowerCase() || null,
      option1: opts[0] ?? null,
      option2: opts[1] ?? null,
      option3: opts[2] ?? null,
    };
  });
  const images = (p?.images?.nodes || []).map((i: any) => ({ src: i?.url })).filter((i: any) => i.src);
  return {
    id: p?.legacyResourceId ?? null,
    title: p?.title ?? null,
    handle: p?.handle ?? null,
    status: String(p?.status ?? "ACTIVE").toLowerCase(),
    vendor: p?.vendor ?? null,
    product_type: p?.productType ?? null,
    // The REST path has always carried tags; GraphQL was not asked for them,
    // so every product read through the (primary) GraphQL path looked untagged.
    // The catalogue facets are built from these reads, which meant the model
    // was offered a `tag` filter argument and never told which tags exist -
    // leaving it to guess a value that narrows to nothing.
    tags: Array.isArray(p?.tags) ? p.tags : [],
    image: p?.featuredImage?.url ? { src: p.featuredImage.url } : images[0] ?? null,
    images,
    options: (p?.options || []).map((o: any) => ({ name: o?.name })).filter((o: any) => o.name),
    variants,
  };
}

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
  // GraphQL is version-pinned by the same URL segment as REST, so it drifts
  // identically and needs the same check. GraphQL is the stricter of the two -
  // an unknown field fails the WHOLE query - so drift shows up here first.
  reportVersionDrift(res, `${ctx.base}/graphql.json`, "GraphQL");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`shopify_${res.status}: ${shopifyErrorSummary(text)}`);
  }
  const j: any = await res.json();
  if (Array.isArray(j.errors) && j.errors.length) {
    const msg = j.errors.map((e: any) => e?.message).filter(Boolean).join("; ");
    if (/access denied|read_returns|not approved|requires merchant approval/i.test(msg)) {
      // Name the scope Shopify actually asked for. This said "re-connect to
      // grant the read_returns scope" for EVERY GraphQL denial, because it was
      // written when returns were the only GraphQL surface - so an orderEdit
      // refused for `write_order_edits` told an operator to grant an unrelated
      // scope they already had. Shopify puts the real one in the message; use
      // it, and fall back to the generic advice rather than to a guess.
      const named = /`?([a-z_]*(?:read|write)_[a-z_]+)`?\s*(?:access\s*)?scope/i.exec(msg)?.[1];
      throw new Error(
        `shopify_graphql_access_denied: ${msg.slice(0, 160)} - re-connect Shopify to grant ` +
          (named ? `the ${named} scope.` : `the scope it names.`),
      );
    }
    throw new Error(`shopify_graphql_error: ${msg.slice(0, 200)}`);
  }
  return j.data;
}

/**
 * Shopify never rejects an unsupported API version - it falls forward and
 * serves the oldest accessible one, so the only evidence is this header.
 * Never throws: a header disagreement must not fail a live customer request.
 */
function reportVersionDrift(res: Response, url: string, surface: "REST" | "GraphQL"): void {
  try {
    checkShopifyResponseVersion({
      requested: apiVersion(),
      headerValue: res.headers.get("X-Shopify-API-Version"),
      surface,
      // Host only - the path can carry customer ids.
      shop: (() => { try { return new URL(url).host; } catch { return undefined; } })(),
    });
  } catch {
    /* telemetry must never break a request */
  }
}

registerAdapter(ShopifyAdapter);
export default ShopifyAdapter;
