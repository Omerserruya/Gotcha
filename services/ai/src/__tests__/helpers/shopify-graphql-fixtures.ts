/**
 * Shopify fixtures, in GraphQL's shape.
 *
 * The REST→GraphQL migration moved the transport, not the contract: what the
 * adapter hands its callers is still the REST-shaped order. So the test
 * fixtures across this suite go on describing orders the REST way, and this
 * translates one into the response Shopify would now send. Keeping it in one
 * place means a field added to the order query is added to every fixture at
 * once, instead of three files drifting apart.
 */
/**
 * An order read, now that reads are Admin GraphQL.
 *
 * The fixtures below still describe orders the way REST returned them, and that
 * is the point: what this migration must preserve is the shape the adapter
 * hands to everything downstream, so the tests keep asserting against it and
 * this helper does the transport translation. Only the fields these tests
 * actually set are translated.
 */
export function orderNode(o: any) {
  const set = (v: any) => (v == null ? null : { shopMoney: { amount: String(v) } });
  const FULFILLMENT: Record<string, string> = { fulfilled: "FULFILLED", partial: "PARTIALLY_FULFILLED", restocked: "RESTOCKED" };
  return {
    legacyResourceId: o.id == null ? null : String(o.id),
    name: o.name ?? null,
    createdAt: o.created_at ?? null,
    currencyCode: o.currency ?? null,
    displayFinancialStatus: o.financial_status ? String(o.financial_status).toUpperCase() : null,
    displayFulfillmentStatus: FULFILLMENT[String(o.fulfillment_status ?? "")] ?? "UNFULFILLED",
    cancelledAt: o.cancelled_at ?? null,
    cancelReason: o.cancel_reason ?? null,
    note: o.note ?? null,
    tags: o.tags == null ? [] : String(o.tags).split(",").map((t: string) => t.trim()).filter(Boolean),
    email: o.email ?? null,
    phone: o.phone ?? null,
    totalPriceSet: set(o.total_price),
    subtotalPriceSet: set(o.subtotal_price),
    totalTaxSet: set(o.total_tax),
    totalDiscountsSet: set(o.total_discounts),
    totalOutstandingSet: set(o.total_outstanding),
    customer: o.customer
      ? {
          legacyResourceId: String(o.customer.id),
          firstName: o.customer.first_name ?? null,
          lastName: o.customer.last_name ?? null,
          defaultEmailAddress: { emailAddress: o.customer.email ?? null },
          defaultPhoneNumber: { phoneNumber: o.customer.phone ?? null },
        }
      : null,
    shippingAddress: o.shipping_address ?? null,
    billingAddress: o.billing_address ?? null,
    lineItems: {
      nodes: (o.line_items || []).map((li: any) => ({
        id: `gid://shopify/LineItem/${li.id}`,
        title: li.title ?? null,
        variantTitle: li.variant_title ?? null,
        sku: li.sku ?? null,
        quantity: li.quantity ?? null,
        unfulfilledQuantity: li.fulfillable_quantity ?? li.quantity ?? null,
        originalUnitPriceSet: set(li.price),
        totalDiscountSet: set(li.total_discount),
        product: li.product_id ? { legacyResourceId: String(li.product_id) } : null,
        variant: li.variant_id ? { legacyResourceId: String(li.variant_id) } : null,
      })),
    },
    fulfillments: (o.fulfillments || []).map((f: any) => ({
      legacyResourceId: String(f.id),
      status: f.status ?? null,
      displayStatus: f.shipment_status ?? null,
      createdAt: f.created_at ?? null,
      trackingInfo: f.tracking_number ? [{ company: f.tracking_company ?? null, number: f.tracking_number, url: f.tracking_url ?? null }] : [],
    })),
    refunds: (o.refunds || []).map((r: any) => ({
      legacyResourceId: String(r.id),
      createdAt: r.created_at ?? null,
      note: r.note ?? null,
      totalRefundedSet: set(r.amount),
    })),
    discountApplications: { nodes: [] },
  };
}

/** A REST-shaped customer as Admin GraphQL returns it. */
export function customerNode(c: any) {
  return {
    legacyResourceId: c.id == null ? null : String(c.id),
    firstName: c.first_name ?? null,
    lastName: c.last_name ?? null,
    defaultEmailAddress: { emailAddress: c.email ?? null, marketingState: c.marketing_state ?? null },
    defaultPhoneNumber: { phoneNumber: c.phone ?? null },
    note: c.note ?? null,
    tags: c.tags ? String(c.tags).split(",").map((t: string) => t.trim()).filter(Boolean) : [],
    createdAt: c.created_at ?? null,
    numberOfOrders: String(c.orders_count ?? 0),
    amountSpent: { amount: String(c.total_spent ?? "0"), currencyCode: c.currency ?? "ILS" },
    defaultAddress: c.default_address ?? null,
    addressesV2: { nodes: c.addresses ?? [] },
  };
}

/** A REST-shaped product as Admin GraphQL returns it. */
export function productNode(p: any) {
  return {
    legacyResourceId: p.id == null ? null : String(p.id),
    title: p.title ?? null,
    handle: p.handle ?? null,
    status: String(p.status ?? "active").toUpperCase(),
    vendor: p.vendor ?? null,
    productType: p.product_type ?? null,
    tags: p.tags ? String(p.tags).split(",").map((t: string) => t.trim()).filter(Boolean) : [],
    featuredImage: p.image?.src ? { url: p.image.src } : null,
    images: { nodes: (p.images ?? []).map((i: any) => ({ url: i.src })) },
    options: (p.options ?? []).map((o: any) => ({ name: o.name })),
    variants: { nodes: (p.variants ?? []).map(variantNode) },
  };
}

/** A REST-shaped variant as Admin GraphQL returns it. */
export function variantNode(v: any) {
  return {
    legacyResourceId: v.id == null ? null : String(v.id),
    title: v.title ?? null,
    sku: v.sku ?? null,
    price: v.price ?? null,
    compareAtPrice: v.compare_at_price ?? null,
    availableForSale: v.available !== false,
    inventoryQuantity: v.inventory_quantity ?? null,
    inventoryPolicy: String(v.inventory_policy ?? "deny").toUpperCase(),
    selectedOptions: [v.option1, v.option2, v.option3].filter(Boolean).map((value: any) => ({ name: "Option", value })),
    inventoryItem: { tracked: v.inventory_management != null },
    product: v.product_id ? { legacyResourceId: String(v.product_id), title: v.product_title ?? null } : null,
  };
}

/** The money helper the refund fixtures use. */
const moneySet = (v: unknown) => (v == null ? null : { shopMoney: { amount: String(v), currencyCode: "ILS" } });

/**
 * A priced refund, as `Order.suggestedRefund` returns it.
 *
 * `parentTransaction.id` is a gid here where REST sent a numeric `parent_id`;
 * the adapter passes it straight back to `refundCreate` and never reads it as a
 * number, which is exactly what these fixtures pin.
 */
export function suggestedRefundNode(o: {
  transactions?: Array<{ parent_id: number | string; amount: string; gateway?: string }>;
  shipping?: { amount: string };
  maximum_refundable?: string;
  currency?: string;
}) {
  const txs = o.transactions ?? [];
  return {
    amountSet: moneySet(txs.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2)),
    maximumRefundableSet: moneySet(o.maximum_refundable ?? txs.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2)),
    shipping: { amountSet: moneySet(o.shipping?.amount ?? "0.00") },
    suggestedTransactions: txs.map((t) => ({
      amountSet: moneySet(t.amount),
      gateway: t.gateway ?? "manual",
      kind: "SUGGESTED_REFUND",
      parentTransaction: { id: `gid://shopify/OrderTransaction/${t.parent_id}` },
    })),
  };
}

/** A created refund, as `refundCreate` returns it. */
export function refundNode(r: {
  id: number;
  created_at?: string | null;
  transactions?: Array<{ id: number; amount: string; status: string; gateway?: string }>;
}) {
  const txs = r.transactions ?? [];
  return {
    legacyResourceId: String(r.id),
    createdAt: r.created_at ?? null,
    totalRefundedSet: moneySet(txs.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2)),
    transactions: {
      nodes: txs.map((t) => ({
        id: `gid://shopify/OrderTransaction/${t.id}`,
        status: String(t.status).toUpperCase(),
        kind: "REFUND",
        amountSet: moneySet(t.amount),
        gateway: t.gateway ?? "manual",
      })),
    },
  };
}

/** Refunds already on an order, as the order refunds query returns them. */
export function orderRefundsNode(
  refunds: Array<{
    id?: number;
    created_at?: string | null;
    note?: string | null;
    refund_line_items?: Array<{ line_item_id: number; quantity: number; restock_type?: string }>;
    transactions?: Array<{ kind?: string; status?: string; amount: string }>;
  }>,
) {
  return refunds.map((r, i) => ({
    legacyResourceId: String(r.id ?? i + 1),
    createdAt: r.created_at ?? null,
    note: r.note ?? null,
    totalRefundedSet: moneySet((r.transactions ?? []).reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2)),
    refundLineItems: {
      nodes: (r.refund_line_items ?? []).map((li) => ({
        lineItem: { id: `gid://shopify/LineItem/${li.line_item_id}` },
        quantity: li.quantity,
        restockType: String(li.restock_type ?? "no_restock").toUpperCase(),
      })),
    },
    transactions: {
      nodes: (r.transactions ?? []).map((t, j) => ({
        id: `gid://shopify/OrderTransaction/${j + 1}`,
        status: String(t.status ?? "success").toUpperCase(),
        kind: String(t.kind ?? "refund").toUpperCase(),
        amountSet: moneySet(t.amount),
        gateway: "manual",
      })),
    },
  }));
}
