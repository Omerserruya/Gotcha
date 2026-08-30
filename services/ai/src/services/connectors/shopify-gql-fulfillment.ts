/**
 * Fulfillment orders, fulfillment events and locations, on Admin GraphQL.
 *
 * Family 5. Small in call count and large in consequence: this is what decides
 * whether an order can still be cancelled, whether its address can still be
 * changed, and whether "it has not shipped yet" is a true statement.
 *
 * ── Degrading is a FEATURE here, and GraphQL changes how it happens ──
 *
 * Every read in this module is best-effort by design. A shop that granted no
 * fulfillment scope must get "I cannot see this" rather than "there is
 * nothing", because the second one is a confident false negative about whether
 * a parcel is on its way. On REST a missing scope came back as a 403 or an
 * empty list; on GraphQL a missing scope fails the WHOLE document. Either way
 * the caller gets `readable: false` and the existing degradation path runs.
 *
 * The one place that changes behaviour rather than preserving it is
 * `listLocations`: REST answered a shop without `read_locations` with an EMPTY
 * LIST, and the refund path reads that as "cannot restock". GraphQL answers it
 * with an access-denied error instead, so that error is caught and turned back
 * into an empty list - otherwise a refund that asked to restock would fail
 * outright on a shop where it used to simply not restock.
 */
import { shopifyGraphQLRequest, paginate, toGid, numericId, type ShopifyCtx } from "./shopify-graphql";

const FULFILLMENT_ORDERS = `
  query GotchaFulfillmentOrders($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      fulfillmentOrders(first: $first, after: $after) {
        nodes {
          id
          status
          requestStatus
          lineItems(first: 50) {
            nodes {
              id
              totalQuantity
              remainingQuantity
              lineItem { id }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const FULFILLMENT_EVENTS = `
  query GotchaFulfillmentEvents($id: ID!) {
    order(id: $id) {
      fulfillments(first: 20) {
        legacyResourceId
        events(first: 50) {
          nodes { status happenedAt message }
        }
      }
    }
  }`;

/**
 * Where each shipped line left from, for the refund restock target.
 *
 * Separate from the order query on purpose. `Fulfillment.location` requires
 * `read_locations`, and GraphQL enforces scopes over the WHOLE document - so
 * putting it in the main order fragment would make every order read fail on a
 * shop that has not granted it. Here it is a best-effort extra read that
 * degrades to "no location" exactly as the locations list does.
 *
 * NOTE: REST returned `fulfillment.location_id` on the order payload without
 * needing `read_locations` at all. On GraphQL there is no such field, so a shop
 * without that scope can no longer learn a restock location from the
 * fulfillment - the refund still happens, and the restock is skipped and
 * reported as skipped, which is the same degradation an unfulfilled order
 * already had.
 */
const FULFILLMENT_LOCATIONS = `
  query GotchaFulfillmentLocations($id: ID!) {
    order(id: $id) {
      fulfillments(first: 20) {
        legacyResourceId
        location { legacyResourceId }
        fulfillmentLineItems(first: 50) { nodes { lineItem { id } } }
      }
    }
  }`;

/**
 * Locations, for the refund restock target.
 *
 * `isActive` replaces REST's `active`, and the first active location is the
 * fallback the refund path picks when an unfulfilled order has no fulfillment
 * to learn a location from.
 */
const LOCATIONS = `
  query GotchaLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after) {
      nodes { legacyResourceId name isActive }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/**
 * Fulfillment orders in the REST shape the mutability and reconciliation
 * modules already read: lowercase `status` / `request_status`, and line items
 * keyed by the ORDER line id.
 */
export function mapFulfillmentOrder(fo: any): any {
  return {
    id: numericId(fo),
    status: fo?.status ? String(fo.status).toLowerCase() : null,
    request_status: fo?.requestStatus ? String(fo.requestStatus).toLowerCase() : null,
    line_items: (fo?.lineItems?.nodes || []).map((li: any) => ({
      id: numericId(li),
      line_item_id: numericId(li?.lineItem),
      quantity: li?.totalQuantity ?? null,
      // REST called this `fulfillable_quantity`: what this fulfillment order
      // still owes. The reconciler prefers it over the opening quantity.
      fulfillable_quantity: li?.remainingQuantity ?? null,
    })),
  };
}

/**
 * The order's fulfillment orders, or an explicit "could not read".
 *
 * `readable: false` is NOT the same as "there are none", and collapsing the two
 * would report `has_outstanding_fulfillments: false` for an order Shopify
 * refuses to cancel for exactly that reason.
 */
export async function getFulfillmentOrders(
  ctx: ShopifyCtx,
  orderId: string | number,
): Promise<{ orders: any[]; readable: boolean; error?: string }> {
  try {
    const rows = await paginate<any>(
      ctx,
      FULFILLMENT_ORDERS,
      { id: toGid("Order", orderId) },
      "order.fulfillmentOrders",
      50,
    );
    return { orders: rows.map(mapFulfillmentOrder), readable: true };
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown");
    console.warn(`[shopify] fulfillment_orders unreadable for order ${orderId}: ${msg}`);
    return { orders: [], readable: false, error: msg.slice(0, 200) };
  }
}

/**
 * Fulfillment events per fulfillment.
 *
 * REST needed one call per fulfillment; this is one call for the order. Events
 * that cannot be read are simply absent, as they were when the per-fulfillment
 * REST call was caught and skipped.
 */
export async function getFulfillmentEvents(
  ctx: ShopifyCtx,
  orderId: string | number,
): Promise<Array<{ fulfillment_id: number | null; events: any[] }>> {
  const data = await shopifyGraphQLRequest(
    ctx,
    FULFILLMENT_EVENTS,
    { id: toGid("Order", orderId) },
    { retryable: true },
  );
  return (data?.order?.fulfillments || []).map((f: any) => ({
    fulfillment_id: f?.legacyResourceId == null ? null : Number(f.legacyResourceId),
    events: (f?.events?.nodes || []).map((e: any) => ({
      status: e?.status ? String(e.status).toLowerCase() : null,
      happened_at: e?.happenedAt ?? null,
      message: e?.message ?? null,
    })),
  }));
}

/**
 * Active locations, or an empty list when the shop did not grant
 * `read_locations`.
 *
 * The empty list is deliberate and matches what REST returned in that case: the
 * refund path reads "no locations" as "cannot restock" and says so, which is a
 * far better outcome than failing the refund itself.
 */
export async function listLocations(ctx: ShopifyCtx, limit = 50): Promise<Array<{ id: number | null; name: string | null; active: boolean }>> {
  try {
    const rows = await paginate<any>(ctx, LOCATIONS, {}, "locations", limit);
    return rows.map((l: any) => ({
      id: l?.legacyResourceId == null ? null : Number(l.legacyResourceId),
      name: l?.name ?? null,
      active: l?.isActive === true,
    }));
  } catch (err: any) {
    console.warn(`[shopify] locations unreadable: ${String(err?.message ?? "unknown").slice(0, 160)}`);
    return [];
  }
}

/**
 * Restock locations per order line, plus a fallback.
 *
 * Best-effort: a shop without `read_locations` gets an empty map and the refund
 * path degrades to `no_restock` for those lines, which it reports rather than
 * silently dropping.
 */
export async function getFulfillmentLocations(
  ctx: ShopifyCtx,
  orderId: string | number,
): Promise<{ byLineItem: Map<string, number>; fallback?: number }> {
  const byLineItem = new Map<string, number>();
  let fallback: number | undefined;
  try {
    const data = await shopifyGraphQLRequest(
      ctx,
      FULFILLMENT_LOCATIONS,
      { id: toGid("Order", orderId) },
      { retryable: true },
    );
    for (const f of data?.order?.fulfillments || []) {
      const loc = f?.location?.legacyResourceId == null ? NaN : Number(f.location.legacyResourceId);
      if (!Number.isFinite(loc)) continue;
      if (fallback === undefined) fallback = loc;
      for (const fli of f?.fulfillmentLineItems?.nodes || []) {
        const id = numericId(fli?.lineItem);
        if (id != null) byLineItem.set(String(id), loc);
      }
    }
  } catch (err: any) {
    // No read_locations, most likely. The caller degrades to no_restock.
    console.warn(`[shopify] fulfillment locations unreadable for order ${orderId}: ${String(err?.message ?? "unknown").slice(0, 160)}`);
  }
  return { byLineItem, fallback };
}
