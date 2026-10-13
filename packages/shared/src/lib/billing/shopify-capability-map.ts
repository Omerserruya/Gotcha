/**
 * Which Shopify-funded entitlement each Shopify operation requires.
 *
 * WHY A MATRIX AND NOT A SINGLE "IS SHOPIFY PAID" FLAG
 * ----------------------------------------------------
 * The Connector grants a SET of entitlements, and a plan may grant a subset.
 * Treating "has any Shopify-funded row" as authorization would mean a merchant
 * funded only for catalog sync could read every customer's order history and
 * issue refunds. The entitlement boundary is per capability or it is not a
 * boundary at all.
 *
 * THE FOUR GROUPS
 *   shopify_catalog_sync       catalogue, product, inventory - reads and sync
 *   shopify_order_read         customer and order CONTEXT, and order reads
 *   shopify_order_actions      every mutation: writes, refunds, cancellations,
 *                              returns, discounts, tags, segments, writebacks
 *   shopify_storefront_widget  storefront chat, app embed, theme extension
 *
 * READS ARE SPLIT BY SUBJECT, NOT BY VERB. `get_product` is catalogue data and
 * `get_order` is order data, so they sit in different groups even though both
 * are reads. A merchant who bought catalogue sync did not buy order history.
 *
 * EVERY WRITE IS AN ORDER ACTION, including writes whose subject is a customer
 * or a discount. They mutate the merchant's Shopify store, which is the thing
 * `shopify_order_actions` is sold to permit, and grouping them by subject
 * instead would let a catalogue-only merchant tag customers and mint coupons.
 *
 * UNKNOWN TOOLS ARE DENIED. A tool added later with no entry here returns null
 * and the caller refuses. That is deliberately inconvenient: the inconvenience
 * is a build-time reminder to make a commercial decision, and the alternative
 * is a new Shopify capability quietly riding on someone else's entitlement.
 */
import type { ShopifyCapability } from "./shopify-authorization";

/** Catalogue, product and inventory reads. */
const CATALOG_TOOLS = new Set([
  "get_product",
  "search_products",
  "inventory_status",
  "variant_information",
  "complementary_products",
  "get_product_images",
  "get_shop",
]);

/** Customer and order context, and every order-shaped read. */
const ORDER_READ_TOOLS = new Set([
  "get_customer",
  "search_customers",
  "get_customer_by_email",
  "get_customer_by_phone",
  "get_customer_orders",
  "get_customer_addresses",
  "get_customer_tags",
  "get_customer_metafields",
  "get_orders",
  "get_order",
  "search_orders",
  "get_order_items",
  "get_financial_status",
  "get_fulfillment_status",
  "reconcile_order_items",
  "get_shipment_status",
  "get_tracking_number",
  "get_tracking_url",
  "get_fulfillment_events",
  "list_discounts",
  "validate_discount",
  "get_customer_discounts",
  "list_segments",
  "check_segment_membership",
  "get_refund_status",
  "get_returns",
  "get_return_reason",
  "summarize_customer",
  "get_customer_health",
  "find_latest_order",
  "find_delayed_order",
  "check_payment_status",
  "track_shipment",
  "check_delivery_eta",
  "check_pickup_point",
  "check_refund",
  "check_return_status",
  "order_lookup",
]);

/** Every mutation against the merchant's Shopify store. */
const ORDER_ACTION_TOOLS = new Set([
  "create_customer",
  "update_customer",
  "update_my_profile",
  "add_tag",
  "remove_tag",
  "update_metafield",
  "create_note",
  "add_order_note",
  "create_discount_code",
  "create_one_time_coupon",
  "create_vip_coupon",
  "disable_coupon",
  "add_customer_to_segment",
  "remove_customer_from_segment",
  "issue_compensation_coupon",
  "add_vip_tag",
  "add_retention_segment",
  "update_order_fulfillment",
]);

/**
 * The entitlement a Shopify tool requires, or null when the tool is unknown.
 *
 * Accepts either the dotted form the dispatcher uses (`shopify.get_order`) or
 * the bare slug.
 */
export function shopifyCapabilityForTool(toolName: string): ShopifyCapability | null {
  const slug = toolName.includes(".") ? toolName.slice(toolName.lastIndexOf(".") + 1) : toolName;
  if (CATALOG_TOOLS.has(slug)) return "shopify_catalog_sync";
  if (ORDER_READ_TOOLS.has(slug)) return "shopify_order_read";
  if (ORDER_ACTION_TOOLS.has(slug)) return "shopify_order_actions";
  return null;
}

/** Every Shopify tool slug this matrix classifies. Used by the drift test. */
export const MAPPED_SHOPIFY_TOOLS: readonly string[] = [
  ...CATALOG_TOOLS,
  ...ORDER_READ_TOOLS,
  ...ORDER_ACTION_TOOLS,
];

/**
 * Non-tool Shopify operations, named so call sites read as policy rather than
 * as a string literal chosen on the spot.
 */
export const SHOPIFY_OPERATION = {
  /** Catalogue import, product/inventory sync, product search for an agent. */
  CATALOG: "shopify_catalog_sync",
  /** Inbox commerce context, customer 360, order lookup panels. */
  ORDER_CONTEXT: "shopify_order_read",
  /** Refunds, cancellations, returns, writebacks. */
  ORDER_ACTION: "shopify_order_actions",
  /** Storefront chat channel, theme app extension, app embed. */
  STOREFRONT: "shopify_storefront_widget",
} as const satisfies Record<string, ShopifyCapability>;
