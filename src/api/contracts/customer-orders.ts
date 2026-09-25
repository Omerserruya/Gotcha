import { z } from 'zod';

/**
 * Screen 04d — one customer's orders.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE PLATFORM HANDS US EIGHT STATES AND ASKS US NOT TO COLLAPSE THEM
 * ════════════════════════════════════════════════════════════════════════════
 * `CommerceContextResponse` is a discriminated union, and its own comment
 * says the frontend *"renders an explicit UI for each state — it never
 * guesses from a bare error"*.
 *
 * Two of them are the distinction this project has made on three screens
 * already, made here by Backend before we arrived:
 *
 *   not_connected         nothing was ever connected
 *   connection_unhealthy  connected, and broken — "connect one" is the wrong
 *                         instruction for somebody who already did the work
 *
 * And three more that a single "couldn't load orders" would destroy:
 * `customer_not_linked` (the shop has no record of this person),
 * `verification_required` (we will not show one customer's orders to
 * another), and `missing_scopes` (the connection is fine and the app was
 * never granted permission to read orders — a repair in the provider, not
 * here).
 *
 * ── THE CHIPS ARE THEIRS, NOT OURS ──
 * `financial`, `fulfillment`, `refund` and `shipping` arrive as
 * `{ key, label, tone }` with the label ALREADY localised. Rendered verbatim,
 * the same rule as 14c's banner error and the catalogue notes: a paraphrase
 * would be a second, vaguer copy of a sentence they already wrote.
 *
 * `refundChip` is derived from refunded-versus-total rather than from a raw
 * enum — their comment says so — which is the same refusal we have been
 * applying all week, arriving from the other direction.
 */

/* ── Money and chips ─────────────────────────────────────────────────────── */

export const moneySchema = z.object({
  amount: z.number().nullable().default(null),
  currency: z.string().nullable().default(null),
});
export type Money = z.infer<typeof moneySchema>;

/**
 * A status as the platform phrased it.
 *
 * `tone` is theirs too. We map it to our own intent tokens rather than
 * inventing a judgement: "partially refunded" is `warning` because they
 * decided it is, and a screen that re-decided would disagree with the Inbox
 * about the same order.
 */
export const statusChipSchema = z.object({
  key: z.string(),
  label: z.string(),
  tone: z.enum(['neutral', 'positive', 'warning', 'danger']).default('neutral'),
});
export type StatusChip = z.infer<typeof statusChipSchema>;

/* ── One order ───────────────────────────────────────────────────────────── */

export const orderItemSchema = z.object({
  title: z.string().default(''),
  quantity: z.number().default(0),
});

export const orderCardSchema = z.object({
  orderId: z.string(),
  orderNumber: z.string().default(''),
  createdAt: z.string().nullable().default(null),
  total: moneySchema.default({ amount: null, currency: null }),
  financial: statusChipSchema.nullish().default(null),
  fulfillment: statusChipSchema.nullish().default(null),
  cancelled: z.boolean().default(false),
  refund: statusChipSchema.nullish().default(null),
  shipping: statusChipSchema.nullish().default(null),
  items: z.array(orderItemSchema).default([]),
  /** "+N items" beyond those listed. Rendered, so a card never looks complete when it is not. */
  extraItemCount: z.number().default(0),
  refundedAmount: moneySchema.default({ amount: null, currency: null }),
  /**
   * ★ THE AUTHORITATIVE CEILING FOR A REFUND, and the reason it is read even
   * though this screen offers no refund control: it is the difference between
   * "this order is refundable" and "this order is refundable FOR HOW MUCH",
   * and a merchant deciding whether to open the Inbox needs the second.
   */
  refundableMaximum: moneySchema.default({ amount: null, currency: null }),
  /**
   * ★★ COMPUTED FROM THE VIEWER'S OWN PERMISSIONS.
   *
   * The service's cache key includes a permission signature, because
   * capabilities and per-order eligibility are derived from who is looking —
   * *"otherwise two agents with different commerce grants viewing the same
   * conversation would share one entry and see the wrong capabilities."*
   *
   * So this is 04d's *"actions follow the same permissions as the AI"*,
   * already computed server-side. `reasonIfNot` is why, in their words.
   */
  eligibility: z
    .object({
      cancellable: z.boolean().default(false),
      refundable: z.boolean().default(false),
      returnable: z.boolean().default(false),
      exchangeable: z.boolean().default(false),
      reasonIfNot: z.string().nullish().default(null),
    })
    .default({
      cancellable: false,
      refundable: false,
      returnable: false,
      exchangeable: false,
      reasonIfNot: null,
    }),
});
export type OrderCard = z.infer<typeof orderCardSchema>;

/* ── The eight states ────────────────────────────────────────────────────── */

export const COMMERCE_STATES = [
  'not_connected',
  'connection_unhealthy',
  'customer_not_linked',
  'verification_required',
  'missing_scopes',
  'no_orders',
  'unavailable',
  'ok',
] as const;
export type CommerceState = (typeof COMMERCE_STATES)[number];

export const commerceSummarySchema = z.object({
  orderCount: z.number().default(0),
  /**
   * Every field optional ON PURPOSE, in their words: *"an absent email must
   * render as 'not available', never as an empty string that looks like a
   * real answer, and a customer with no spend history must not show a
   * confident 0."*
   */
  name: z.string().nullish().default(null),
  email: z.string().nullish().default(null),
  phone: z.string().nullish().default(null),
  currency: z.string().nullish().default(null),
});
export type CommerceSummary = z.infer<typeof commerceSummarySchema>;

export const commerceContextSchema = z.object({
  state: z.enum(COMMERCE_STATES),
  /** `missing_scopes` only. Named, because the repair is granting these. */
  missing: z.array(z.string()).default([]),
  summary: commerceSummarySchema.nullish().default(null),
  data: z
    .object({
      summary: commerceSummarySchema.nullish().default(null),
      recentOrders: z.array(orderCardSchema).default([]),
      fetchedAt: z.string().nullable().default(null),
      /**
       * ★★ NAMED BECAUSE 04e NEEDS IT, AND IT WAS ON THE WIRE ALL ALONG.
       *
       * `z.object` strips what the schema does not name, so this arrived on
       * every `ok` response and was discarded before anything could use it —
       * the third time today a field we needed was already being sent.
       *
       * It is the **provider's** customer id, resolved server-side from the
       * trusted conversation linkage: *"SECURITY: the customer id is
       * resolved ONLY from the trusted linkage."* We never derive it and
       * never accept one from a client.
       *
       * 04e's audit log cannot attribute customer-keyed rows without it —
       * `targetId` there is a Shopify id and the endpoint says it cannot
       * derive one from a contact. So this is what turns a declared gap into
       * rows on screen. See `shopifyCustomerIdIn`.
       */
      customer: z
        .object({
          verified: z.boolean().default(false),
          customerId: z.string().nullish().default(null),
        })
        .nullish()
        .default(null),
    })
    .nullish()
    .default(null),
});
export type CommerceContextResponse = z.infer<typeof commerceContextSchema>;

/**
 * The provider's customer id, when there is a verified one.
 *
 * ★ `verified` IS REQUIRED, NOT DECORATION. The service sets it only on the
 * path that resolved the id from the trusted linkage; anything else renders
 * `customer_not_linked` and loads no protected data. Passing an unverified
 * id to the audit log would be asking for one person's rows using another
 * person's identifier.
 */
export function shopifyCustomerIdIn(context: CommerceContextResponse | null): string | null {
  if (context?.state !== 'ok') return null;
  const customer = context.data?.customer;
  if (!customer?.verified) return null;
  return customer.customerId?.trim() || null;
}

/** The orders to render, or an empty list for every non-`ok` state. */
export function ordersIn(context: CommerceContextResponse | null): readonly OrderCard[] {
  return context?.state === 'ok' ? (context.data?.recentOrders ?? []) : [];
}

/**
 * Is this order the one worth opening?
 *
 * The design expands *"the open or troubled order"*. Troubled is the useful
 * half: an order that is cancelled, refunded in part, or carries a shipping
 * chip the platform toned `warning` or `danger` is the one somebody came to
 * this screen about.
 *
 * Derived from the platform's own tones rather than from our reading of a
 * status string — so if they decide a state is alarming, this screen agrees
 * with the Inbox instead of disagreeing with it.
 */
export function isTroubled(order: OrderCard): boolean {
  if (order.cancelled) return true;
  const tones = [
    order.financial?.tone,
    order.fulfillment?.tone,
    order.shipping?.tone,
    order.refund?.tone,
  ];
  return tones.some((t) => t === 'warning' || t === 'danger');
}

/**
 * The one order to expand, or null.
 *
 * Troubled first, then the most recent. Never more than one: a screen that
 * expands three has expanded none of them.
 */
export function orderToExpand(orders: readonly OrderCard[]): OrderCard | null {
  return orders.find(isTroubled) ?? orders[0] ?? null;
}

/**
 * Could anything be done to this order, by the person looking at it?
 *
 * Used to decide whether to say what is possible — NOT to draw a control.
 * See the note in `CustomerOrders.tsx` about why this screen performs no
 * order actions.
 */
export function anythingPossible(order: OrderCard): boolean {
  const e = order.eligibility;
  return e.cancellable || e.refundable || e.returnable || e.exchangeable;
}

/* ── Acting on an order ──────────────────────────────────────────────────── */

/**
 * The four order actions, and the tools they are.
 *
 * `TOOL_FOR` in `commerce-actions.service.ts`. There is no address change —
 * cancel, refund, return and exchange is the whole set, so 04d's *"change
 * address"* has nothing behind it and is not drawn.
 */
export const ORDER_ACTIONS = ['cancel', 'refund', 'create_return', 'exchange_item'] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];

/**
 * ★★ FIVE OUTCOMES, AND ONLY ONE OF THEM MEANS IT HAPPENED.
 *
 * `pending_approval` is not a failure and not a success: the action is in the
 * queue screen 03 renders, holding until a person decides. Rendered as
 * either of the others it would be a lie in a different direction each time.
 *
 * `executed` carries the VERIFIED order card — the service runs a
 * post-action verify and returns what the provider actually reports, and its
 * header says *"a button click never mutates order state in the UI; the
 * caller updates only from the verified result returned here."* So the new
 * state is read from this, never predicted from the action that was taken.
 */
export const orderActionResultSchema = z.object({
  state: z.enum(['pending_approval', 'denied', 'unavailable', 'executed', 'executed_customer']),
  approvalRequestId: z.string().nullish().default(null),
  reason: z.string().nullish().default(null),
  /** Present on `executed`. The provider's verified state, not our guess. */
  order: orderCardSchema.nullish().default(null),
  note: z.string().nullish().default(null),
});
export type OrderActionResult = z.infer<typeof orderActionResultSchema>;

/** Did anything actually change at the provider? */
export function didExecute(result: OrderActionResult | null): boolean {
  return result?.state === 'executed';
}

/**
 * Is this outcome still in flight?
 *
 * An approval-gated action has neither happened nor failed, and a screen that
 * resolves it either way is wrong about somebody's money.
 */
export function isWaitingOnAPerson(result: OrderActionResult | null): boolean {
  return result?.state === 'pending_approval';
}
