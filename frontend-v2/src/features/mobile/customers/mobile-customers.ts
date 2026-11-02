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
