/**
 * Orders, on Admin GraphQL.
 *
 * Family 4, and the one the whole support surface reads: every order lookup,
 * every "where is my parcel", every refund and exchange starts here. So this
 * module's job is to make the GraphQL order INDISTINGUISHABLE from the REST one
 * to everything downstream - `projectOrderForAgent`, the commerce context
 * panel, the cross-customer access guard, the item reconciler - none of which
 * are touched by this migration.
 *
 * ── The three translations that could silently change an answer ──
 *
 * 1. STATUS VOCABULARY. REST said `financial_status: "partially_refunded"` and
 *    `fulfillment_status: null | "partial" | "fulfilled" | "restocked"`.
 *    GraphQL says `PARTIALLY_REFUNDED` and `UNFULFILLED | PARTIALLY_FULFILLED |
 *    IN_PROGRESS | ON_HOLD | ...`. Callers compare against the REST words
 *    (`["fulfilled","partial"].includes(...)`, `=== "refunded"`), so the enum
 *    is translated back rather than lowercased and hoped for: an unrecognised
 *    fulfillment state becomes null, which is exactly what REST reported for an
 *    order that had not shipped.
 *
 * 2. MONEY. REST returned a decimal string per total. GraphQL returns a
 *    MoneyBag, and the SHOP money is the one REST reported - reading
 *    `presentmentMoney` instead would quietly switch currency on any store
 *    selling in more than one.
 *
 * 3. LINE ITEM IDS. `LineItem` has no `legacyResourceId` in 2026-07 (verified
 *    against the schema), so the numeric id comes from the gid tail. It has to
 *    be numeric: the refund path still calls REST, and REST refunds are built
 *    from numeric line item ids.
 */
import { shopifyGraphQLRequest, paginate, toGid, numericId, escapeSearchValue, type ShopifyCtx } from "./shopify-graphql";

const ADDRESS = `name address1 address2 city province zip country phone`;

const ORDER_FIELDS = `
  legacyResourceId
  name
  createdAt
  currencyCode
  displayFinancialStatus
  displayFulfillmentStatus
  cancelledAt
  cancelReason
  note
  tags
  email
  phone
  totalPriceSet { shopMoney { amount } }
  subtotalPriceSet { shopMoney { amount } }
  totalTaxSet { shopMoney { amount } }
  totalDiscountsSet { shopMoney { amount } }
  totalOutstandingSet { shopMoney { amount } }
  customer {
    legacyResourceId
    firstName
    lastName
    defaultEmailAddress { emailAddress }
    defaultPhoneNumber { phoneNumber }
  }
  shippingAddress { ${ADDRESS} }
  billingAddress { ${ADDRESS} }
  lineItems(first: 100) {
    nodes {
      id
      title
      variantTitle
      sku
      quantity
      unfulfilledQuantity
      originalUnitPriceSet { shopMoney { amount } }
      totalDiscountSet { shopMoney { amount } }
      product { legacyResourceId }
      variant { legacyResourceId }
    }
  }
  fulfillments(first: 20) {
    legacyResourceId
    status
    displayStatus
    createdAt
    trackingInfo { company number url }
    fulfillmentLineItems(first: 50) { nodes { lineItem { id } quantity } }
  }
  refunds(first: 20) {
    legacyResourceId
    createdAt
    note
    totalRefundedSet { shopMoney { amount } }
    refundLineItems(first: 50) { nodes { lineItem { id } quantity } }
  }
  discountApplications(first: 10) {
    nodes {
      allocationMethod
      value {
        ... on MoneyV2 { amount }
        ... on PricingPercentageValue { percentage }
      }
      ... on DiscountCodeApplication { code }
    }
  }`;

/** The row shape for list reads - no line items, no address book. */
const ORDER_ROW_FIELDS = `
  legacyResourceId
  name
  createdAt
  currencyCode
  displayFinancialStatus
  displayFulfillmentStatus
  cancelledAt
  cancelReason
  note
  tags
  email
  phone
  totalPriceSet { shopMoney { amount } }
  customer {
    legacyResourceId
    firstName
    lastName
    defaultEmailAddress { emailAddress }
  }`;

const ORDER_BY_ID = `
  query GotchaOrderById($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} }
  }`;

const ORDER_SEARCH_FULL = `
  query GotchaOrderSearchFull($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
    orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      nodes { ${ORDER_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const ORDER_SEARCH_ROWS = `
  query GotchaOrderSearchRows($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
    orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      nodes { ${ORDER_ROW_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const ORDER_UPDATE = `
  mutation GotchaOrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { legacyResourceId name note tags }
      userErrors { field message }
    }
  }`;

const ORDER_SHIPPING_ADDRESS_UPDATE = `
  mutation GotchaOrderShippingAddressUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { legacyResourceId shippingAddress { ${ADDRESS} } }
      userErrors { field message }
    }
  }`;

function money(set: any): string | null {
  const amount = set?.shopMoney?.amount;
  return amount == null ? null : String(amount);
}

/**
 * REST's `financial_status`, from the display enum.
 *
 * The two vocabularies agree word for word once the enum is lowercased, so this
 * is a straight translation rather than a lookup - but it is a FUNCTION so the
 * one value REST never had (`EXPIRED`) is visible rather than assumed.
 */
export function mapFinancialStatus(v: unknown): string | null {
  if (!v) return null;
  return String(v).toLowerCase();
}

/**
 * REST's `fulfillment_status`, from the display enum.
 *
 * REST had four values and GraphQL has ten. Anything that is not shipped,
 * part-shipped or restocked reported as `null` on REST - "nothing has gone out
 * yet" - and callers rely on that null: `find_delayed_order` looks for
 * `fulfillment_status == null || === "partial"`, and the cancel-eligibility
 * check treats "fulfilled" as a refusal. Mapping IN_PROGRESS or ON_HOLD to
 * anything else would either hide a delayed order or refuse a cancellable one.
 */
export function mapFulfillmentStatus(v: unknown): string | null {
  switch (String(v ?? "").toUpperCase()) {
    case "FULFILLED":
      return "fulfilled";
    case "PARTIALLY_FULFILLED":
      return "partial";
    case "RESTOCKED":
      return "restocked";
    default:
      return null;
  }
}

function mapAddress(a: any): any {
  if (!a) return null;
  return {
    name: a.name ?? null,
    address1: a.address1 ?? null,
    address2: a.address2 ?? null,
    city: a.city ?? null,
    province: a.province ?? null,
    zip: a.zip ?? null,
    country: a.country ?? null,
    phone: a.phone ?? null,
  };
}

/**
 * A GraphQL order node in the REST order's shape.
 *
 * Deliberately NOT pruned here: `projectOrderForAgent` is what decides which
 * fields reach a prompt, and it still runs downstream. Two normalisers with
 * different ideas about what an order is would be how a field quietly stops
 * reaching the model.
 */
export function mapOrder(o: any): any | null {
  if (!o) return null;
  const id = o.legacyResourceId == null ? null : Number(o.legacyResourceId);
  const name = o.name ?? null;
  return {
    id,
    name,
    // REST carried the bare number alongside the display name ("#1006" / 1006).
    order_number: name ? Number(String(name).replace(/^#/, "")) || null : null,
    created_at: o.createdAt ?? null,
    currency: o.currencyCode ?? null,
    financial_status: mapFinancialStatus(o.displayFinancialStatus),
    fulfillment_status: mapFulfillmentStatus(o.displayFulfillmentStatus),
    cancelled_at: o.cancelledAt ?? null,
    cancel_reason: o.cancelReason ? String(o.cancelReason).toLowerCase() : null,
    note: o.note ?? null,
    // REST's order tags were a comma string and callers still split them that
    // way; an array survives `splitTags` unchanged, so it is left as Shopify
    // sends it.
    tags: Array.isArray(o.tags) ? o.tags.join(", ") : o.tags ?? null,
    email: o.email ?? o.customer?.defaultEmailAddress?.emailAddress ?? null,
    phone: o.phone ?? o.customer?.defaultPhoneNumber?.phoneNumber ?? null,
    total_price: money(o.totalPriceSet),
    subtotal_price: money(o.subtotalPriceSet),
    total_tax: money(o.totalTaxSet),
    total_discounts: money(o.totalDiscountsSet),
    total_outstanding: money(o.totalOutstandingSet),
    customer: o.customer
      ? {
          id: o.customer.legacyResourceId == null ? null : Number(o.customer.legacyResourceId),
          first_name: o.customer.firstName ?? null,
          last_name: o.customer.lastName ?? null,
          email: o.customer.defaultEmailAddress?.emailAddress ?? null,
          phone: o.customer.defaultPhoneNumber?.phoneNumber ?? null,
        }
      : null,
    shipping_address: mapAddress(o.shippingAddress),
    billing_address: mapAddress(o.billingAddress),
    line_items: (o.lineItems?.nodes || []).map((li: any) => ({
      // No legacyResourceId on LineItem - the gid tail is the numeric id, and
      // it has to be numeric because the refund path still speaks REST.
      id: numericId(li),
      product_id: li.product?.legacyResourceId == null ? null : Number(li.product.legacyResourceId),
      variant_id: li.variant?.legacyResourceId == null ? null : Number(li.variant.legacyResourceId),
      title: li.title ?? null,
      variant_title: li.variantTitle ?? null,
      sku: li.sku ?? null,
      quantity: li.quantity ?? null,
      // REST's `fulfillable_quantity` - what is still waiting to go out.
      fulfillable_quantity: li.unfulfilledQuantity ?? null,
      // Per UNIT, as REST reported it. `originalUnitPriceSet` is the same
      // number; a line total here would inflate every refund calculation.
      price: money(li.originalUnitPriceSet),
      total_discount: money(li.totalDiscountSet),
    })),
    fulfillments: (o.fulfillments || []).map((f: any) => ({
      id: f.legacyResourceId == null ? null : Number(f.legacyResourceId),
      status: f.status ? String(f.status).toLowerCase() : null,
      shipment_status: f.displayStatus ? String(f.displayStatus).toLowerCase() : null,
      tracking_company: f.trackingInfo?.[0]?.company ?? null,
      tracking_number: f.trackingInfo?.[0]?.number ?? null,
      tracking_url: f.trackingInfo?.[0]?.url ?? null,
      created_at: f.createdAt ?? null,
      // What this shipment contained. The item reconciler counts ordered vs
      // shipped vs refunded per line, and without these every fulfilled item
      // would read as still pending.
      line_items: (f.fulfillmentLineItems?.nodes || []).map((fli: any) => ({
        line_item_id: numericId(fli?.lineItem),
        quantity: fli?.quantity ?? null,
      })),
    })),
    refunds: (o.refunds || []).map((r: any) => ({
      id: r.legacyResourceId == null ? null : Number(r.legacyResourceId),
      created_at: r.createdAt ?? null,
      note: r.note ?? null,
      // REST callers summed `transactions[].amount`; the total is the same
      // number without asking for the transaction list.
      total: money(r.totalRefundedSet),
      // Per-line quantities, for the same reconciliation arithmetic.
      refund_line_items: (r.refundLineItems?.nodes || []).map((rli: any) => ({
        line_item_id: numericId(rli?.lineItem),
        quantity: rli?.quantity ?? null,
      })),
    })),
    discount_codes: (o.discountApplications?.nodes || [])
      .filter((d: any) => d?.code)
      .map((d: any) => ({
        code: d.code,
        amount: d.value?.amount ?? null,
        type: d.value?.percentage != null ? "percentage" : "fixed_amount",
      })),
  };
}

/**
 * One order by numeric or global id; null when it does not exist.
 *
 * The guard is not defensive tidiness. The model reaches for an order by
 * whatever the customer typed, and "#1006" is an order NAME - REST answered
 * that with a 400 that `orderById` caught and turned into a fall-through to the
 * name lookup. GraphQL would instead reject the malformed gid as a top-level
 * error, which is not a "miss" and would surface as a failed lookup for an
 * order that exists. So a value that cannot be an id is a miss HERE, before a
 * request is spent on it.
 */
export async function getOrderById(ctx: ShopifyCtx, id: string | number): Promise<any | null> {
  const raw = String(id ?? "").trim();
  if (!/^\d+$/.test(raw) && !raw.startsWith("gid://")) return null;
  const data = await shopifyGraphQLRequest(ctx, ORDER_BY_ID, { id: toGid("Order", raw) }, { retryable: true });
  return mapOrder(data?.order);
}

export interface OrderSearchOptions {
  limit: number;
  /** REST's `status` parameter: open | closed | any. */
  status?: string;
  email?: string;
  name?: string;
  financialStatus?: string;
  fulfillmentStatus?: string;
  /** Full order bodies (line items, addresses) rather than summary rows. */
  full?: boolean;
}

/**
 * Build the search query string from what REST took as parameters.
 *
 * Every value is escaped: these come from customer input (an email, an order
 * name the customer typed) and go into a query LANGUAGE, where an unescaped
 * quote ends the term and the remainder is parsed as syntax.
 */
export function buildOrderQuery(opts: OrderSearchOptions): string {
  const clauses: string[] = [];
  const status = String(opts.status ?? "any").toLowerCase();
  // REST's `any` meant "do not filter"; open and closed are real predicates.
  if (status === "open" || status === "closed") clauses.push(`status:${status}`);
  if (opts.email) clauses.push(`email:${escapeSearchValue(opts.email)}`);
  if (opts.name) clauses.push(`name:${escapeSearchValue(String(opts.name).replace(/^#/, ""))}`);
  if (opts.financialStatus) clauses.push(`financial_status:${escapeSearchValue(opts.financialStatus)}`);
  if (opts.fulfillmentStatus) clauses.push(`fulfillment_status:${escapeSearchValue(opts.fulfillmentStatus)}`);
  return clauses.join(" AND ");
}

/**
 * Search orders, newest first.
 *
 * REST's `/orders.json` answered in `processed_at DESC` order, which is what
 * `find_latest_order` depends on - it asks for ONE order and takes it. GraphQL
 * has no default worth relying on, so the sort is stated explicitly.
 */
export async function searchOrders(ctx: ShopifyCtx, opts: OrderSearchOptions): Promise<any[]> {
  const rows = await paginate<any>(
    ctx,
    opts.full ? ORDER_SEARCH_FULL : ORDER_SEARCH_ROWS,
    { query: buildOrderQuery(opts), sortKey: "PROCESSED_AT", reverse: true },
    "orders",
    opts.limit,
  );
  return rows.map(mapOrder).filter(Boolean);
}

/**
 * An order by its human-facing name, with duplicates DETECTED.
 *
 * Two are asked for so a store that reuses a name is refused rather than
 * silently acted on - the same reason the REST call passed `limit=2`.
 */
export async function getOrderByName(
  ctx: ShopifyCtx,
  name: string,
): Promise<{ order: any | null; ambiguous: boolean }> {
  const rows = await searchOrders(ctx, { limit: 2, status: "any", name, full: true });
  if (rows.length > 1) return { order: null, ambiguous: true };
  return { order: rows[0] ?? null, ambiguous: false };
}

/** Set an order's note and/or tags. Never retried: it overwrites what is there. */
export async function updateOrder(
  ctx: ShopifyCtx,
  id: string | number,
  fields: { note?: string; tags?: string[] },
): Promise<any | null> {
  const input: Record<string, unknown> = { id: toGid("Order", id) };
  if (fields.note != null) input.note = fields.note;
  if (fields.tags != null) input.tags = fields.tags;
  const data = await shopifyGraphQLRequest(ctx, ORDER_UPDATE, { input }, { userErrorsAt: "orderUpdate" });
  const o = data?.orderUpdate?.order;
  return o
    ? {
        id: o.legacyResourceId == null ? null : Number(o.legacyResourceId),
        name: o.name ?? null,
        note: o.note ?? null,
        tags: Array.isArray(o.tags) ? o.tags.join(", ") : o.tags ?? null,
      }
    : null;
}

/**
 * Replace an order's shipping address.
 *
 * `MailingAddressInput` has no `name` field - it takes firstName / lastName -
 * so the caller's merged address is filtered to the fields the input accepts
 * rather than passed through. Sending an unknown key fails the whole mutation.
 */
export async function updateOrderShippingAddress(
  ctx: ShopifyCtx,
  id: string | number,
  address: Record<string, any>,
): Promise<any | null> {
  const allowed = ["address1", "address2", "city", "province", "provinceCode", "zip", "country", "countryCode", "phone", "company", "firstName", "lastName"];
  const shippingAddress: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(address ?? {})) {
    if (v == null) continue;
    const key = k === "province_code" ? "provinceCode" : k === "country_code" ? "countryCode" : k === "first_name" ? "firstName" : k === "last_name" ? "lastName" : k;
    if (allowed.includes(key)) shippingAddress[key] = v;
  }
  const data = await shopifyGraphQLRequest(
    ctx,
    ORDER_SHIPPING_ADDRESS_UPDATE,
    { input: { id: toGid("Order", id), shippingAddress } },
    { userErrorsAt: "orderUpdate" },
  );
  return mapAddressPublic(data?.orderUpdate?.order?.shippingAddress);
}

/** The mapped shipping address, for a caller that wants to confirm the write. */
export function mapAddressPublic(a: any): any {
  return mapAddress(a);
}
