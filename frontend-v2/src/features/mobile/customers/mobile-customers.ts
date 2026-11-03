/**
 * What the phone's customer profile works out from the desktop's reads: the
 * number a call can be placed to, and the figures the store reported.
 */

/** The channels keyed by a phone number - the ones a call can be placed to. */
const PHONE_CHANNELS = new Set(['WHATSAPP', 'VOICE', 'SMS']);

/**
 * The person's phone, to show and to dial: the first phone-keyed handle that
 * is a whole international number. `null` with none - never a guess at a
 * local number's country.
 */
export function phoneOf(
  handles: readonly { readonly channel: string; readonly externalId: string }[],
): { readonly channel: string; readonly externalId: string; readonly dial: string } | null {
  for (const handle of handles) {
    if (!PHONE_CHANNELS.has(handle.channel.toUpperCase())) continue;
    const digits = handle.externalId.replace(/^\+/, '');
    if (/^\d{8,15}$/.test(digits)) return { ...handle, dial: `+${digits}` };
  }
  return null;
}

/** One amount in one currency, as the store reports it. */
export interface Spend {
  readonly amount: number;
  readonly currency: string;
}

/**
 * The profile's figures, from the store's summary: what they spent, how many
 * orders, how many refunded or cancelled. Each is `null` when the store gave
 * no value - drawn as absent, never as a confident zero.
 *
 * ★ Spend is the store's own total in its currency when it has one, else the
 *   per-currency totals, never summed across currencies (`OrdersTab`'s rule).
 */
export function worthOf(
  summary: {
    readonly orderCount: number;
    readonly shopCurrencyTotal?: {
      readonly amount: number | null;
      readonly currency: string | null;
    } | null;
    readonly totalSpentByCurrency?: readonly {
      readonly amount: number | null;
      readonly currency: string | null;
    }[];
    readonly refundedOrCancelledCount?: number | null;
  } | null,
): {
  readonly spent: readonly Spend[] | null;
  readonly orders: number;
  readonly refunds: number | null;
} | null {
  if (!summary) return null;
  const whole = (m: { amount: number | null; currency: string | null }): m is Spend =>
    m.amount !== null && !!m.currency;
  const total = summary.shopCurrencyTotal;
  const spent =
    total && whole(total) ? [total] : (summary.totalSpentByCurrency ?? []).filter(whole);
  return {
    spent: spent.length > 0 ? spent : null,
    orders: summary.orderCount,
    refunds: summary.refundedOrCancelledCount ?? null,
  };
}

/* ── Orders on the profile (2026-11-03) ───────────────────────────────────── */

/** The fields of an order the phone's list reads (`OrderCard` from the contract). */
interface OrderLike {
  readonly orderNumber: string;
  readonly createdAt: string | null;
  readonly total: { readonly amount: number | null; readonly currency: string | null };
  readonly cancelled: boolean;
  readonly financial?: { readonly label: string } | null;
  readonly fulfillment?: { readonly label: string } | null;
  readonly shipping?: { readonly label: string } | null;
}

/**
 * An order's status in one line: cancelled is said as that; otherwise the
 * furthest the store reports - shipping, then fulfilment, then payment - in
 * the store's own localised words. `null` when the store gave none.
 */
export function orderStatus(
  order: OrderLike,
): { readonly kind: 'cancelled' } | { readonly kind: 'label'; readonly label: string } | null {
  if (order.cancelled) return { kind: 'cancelled' };
  const chip = order.shipping ?? order.fulfillment ?? order.financial ?? null;
  return chip?.label ? { kind: 'label', label: chip.label } : null;
}

/**
 * Why the profile shows no order, as the inbox's wall says it (`OrdersCarousel`),
 * from `GET …/customers/:contactId/orders` - or `null` when there are orders.
 *
 *   unread         the read failed, or an answer we have no words for
 *   storeNotChosen two stores, none chosen as the business's
 *   notConnected   no store at all
 *   storeUnreachable / noIdentifiers   the platform's own reasons
 *   noWooOrders    WooCommerce answered, with nothing
 *   state          Shopify's state for this customer, in the customers catalogue
 *
 * ★ A failed read is never "no orders": unknown is not empty.
 */
export type OrdersNote =
  | { readonly kind: 'unread' }
  | { readonly kind: 'storeNotChosen' }
  | { readonly kind: 'notConnected' }
  | { readonly kind: 'storeUnreachable' }
  | { readonly kind: 'noIdentifiers' }
  | { readonly kind: 'noWooOrders' }
  | { readonly kind: 'missingScopes' }
  | { readonly kind: 'state'; readonly state: string };

export function ordersNote(
  read: {
    readonly source: string | null;
    readonly state: string | null;
    readonly reason: string | null;
    readonly orders: readonly unknown[];
  } | null,
): OrdersNote | null {
  if (read === null) return { kind: 'unread' };
  if (read.orders.length > 0) return null;
  if (read.source === null) {
    switch (read.reason) {
      case 'store_not_chosen':
        return { kind: 'storeNotChosen' };
      case 'no_store_connected':
        return { kind: 'notConnected' };
      case 'store_unreachable':
        return { kind: 'storeUnreachable' };
      case 'no_identifiers':
        return { kind: 'noIdentifiers' };
      default:
        return { kind: 'unread' };
    }
  }
  if (read.source === 'woocommerce') return { kind: 'noWooOrders' };
  if (read.state === null) return { kind: 'unread' };
  if (read.state === 'missing_scopes') return { kind: 'missingScopes' };
  return { kind: 'state', state: read.state === 'ok' ? 'no_orders' : read.state };
}
