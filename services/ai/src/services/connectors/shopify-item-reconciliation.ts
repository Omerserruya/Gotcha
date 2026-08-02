/**
 * "חסר לי פריט" - what a missing-item complaint actually is.
 *
 * It is arithmetic, not an investigation: ordered minus shipped minus
 * cancelled minus refunded, per line. Live (scenario 25, 2026-08-01) the bot
 * answered it by demanding identity verification from a customer whose
 * WhatsApp number was already the one on the Shopify order, and the turn never
 * got as far as looking at a quantity.
 *
 * Two facts make the difference between a useful answer and an interrogation:
 *
 *   - `pending` per line. An order can be short because a second shipment has
 *     not gone out yet, which is not a missing item at all and is the single
 *     most common cause. Saying "it is missing" there is a false alarm; saying
 *     "another shipment is still coming" is the true answer.
 *   - `ambiguous`. On a one-line order there is nothing to ask. On a two-line
 *     order where only one line is short, there is still nothing to ask. Only
 *     when more than one line could plausibly be the complaint does the
 *     customer need a question, and only then.
 *
 * Everything here is pure so it can be tested against real Shopify payload
 * shapes without the network. The adapter does the two reads and hands them in.
 */

export interface ReconciledLine {
  line_item_id: string;
  title: string;
  variant_title: string | null;
  sku: string | null;
  /** Units the customer paid for. */
  ordered: number;
  /** Units in a fulfillment that was actually created and not cancelled. */
  shipped: number;
  /** Units still sitting in an open/in-progress fulfillment order. */
  pending: number;
  /** Units removed by a cancelled fulfillment - back to unfulfilled, not gone. */
  cancelled: number;
  /** Units already refunded (money returned, so not "missing"). */
  refunded: number;
  /**
   * ordered - shipped - pending - refunded. Positive means units the customer
   * paid for that are neither with them, on their way, nor refunded.
   */
  unaccounted: number;
  /** Shipped short of ordered, with nothing pending to explain it. */
  short: boolean;
}

export type FulfillmentVisibility = "readable" | "unreadable";

export interface ItemReconciliation {
  order_id: string;
  name: string;
  fulfillment_visibility: FulfillmentVisibility;
  fulfillment_orders_error?: string;
  /** More than one fulfillment exists - a "partial delivery" is expected. */
  multiple_shipments: boolean;
  shipments: Array<{ id: string; status: string | null; tracking_number: string | null; item_count: number }>;
  /** True when at least one fulfillment order still has work outstanding. */
  another_shipment_pending: boolean;
  lines: ReconciledLine[];
  /** Lines that could be the item the customer means. */
  candidates: ReconciledLine[];
  /** The single line the complaint can only be about, or null. */
  unambiguous_item: ReconciledLine | null;
  /** More than one line could reasonably be meant - ask which. */
  ambiguous: boolean;
  model_instruction: string;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function id(v: unknown): string {
  return String(v ?? "");
}

/**
 * A fulfillment order still owes the customer something.
 *
 * `open` and `scheduled` are work that has not left yet; `in_progress` is work
 * handed to a service. `closed` and `cancelled` owe nothing. This is a
 * DIFFERENT question from `hasOutstandingFulfillments` in the adapter, which
 * asks what blocks a cancellation - an `open` fulfillment order does not block
 * a cancel but absolutely does explain a short delivery.
 */
function isPendingFulfillmentOrder(fo: any): boolean {
  const status = String(fo?.status ?? "").toLowerCase();
  return ["open", "scheduled", "in_progress", "incomplete"].includes(status);
}

export function reconcile(
  order: any,
  fulfillmentOrders: { orders: any[]; readable: boolean; error?: string },
): ItemReconciliation {
  const lineItems: any[] = Array.isArray(order?.line_items) ? order.line_items : [];
  const fulfillments: any[] = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  const refunds: any[] = Array.isArray(order?.refunds) ? order.refunds : [];

  const shipped = new Map<string, number>();
  const cancelled = new Map<string, number>();
  for (const f of fulfillments) {
    const isCancelled = String(f?.status ?? "").toLowerCase() === "cancelled";
    const target = isCancelled ? cancelled : shipped;
    for (const li of f?.line_items ?? []) {
      // A fulfillment's line item carries its OWN id plus the order line's id.
      // Shopify populates both; older payloads only carry `id`, which is the
      // order line id in that shape.
      const key = id(li?.line_item_id ?? li?.id);
      target.set(key, (target.get(key) ?? 0) + num(li?.quantity));
    }
  }

  const refunded = new Map<string, number>();
  for (const r of refunds) {
    for (const rli of r?.refund_line_items ?? []) {
      const key = id(rli?.line_item_id ?? rli?.line_item?.id);
      refunded.set(key, (refunded.get(key) ?? 0) + num(rli?.quantity));
    }
  }

  const pending = new Map<string, number>();
  let anotherShipmentPending = false;
  if (fulfillmentOrders.readable) {
    for (const fo of fulfillmentOrders.orders ?? []) {
      if (!isPendingFulfillmentOrder(fo)) continue;
      anotherShipmentPending = true;
      for (const li of fo?.line_items ?? []) {
        const key = id(li?.line_item_id);
        // `fulfillable_quantity` is what is still owed on this fulfillment
        // order; `quantity` is what it was opened with. Prefer the former and
        // fall back only when Shopify omits it.
        const qty = li?.fulfillable_quantity != null ? num(li.fulfillable_quantity) : num(li?.quantity);
        pending.set(key, (pending.get(key) ?? 0) + qty);
      }
    }
  }

  const lines: ReconciledLine[] = lineItems.map((li) => {
    const key = id(li?.id);
    const ordered = num(li?.quantity);
    const ship = Math.min(shipped.get(key) ?? 0, ordered);
    const pend = Math.min(pending.get(key) ?? 0, Math.max(0, ordered - ship));
    const ref = Math.min(refunded.get(key) ?? 0, ordered);
    const unaccounted = Math.max(0, ordered - ship - pend - ref);
    return {
      line_item_id: key,
      title: String(li?.title ?? ""),
      variant_title: li?.variant_title ?? null,
      sku: li?.sku ?? null,
      ordered,
      shipped: ship,
      pending: pend,
      cancelled: cancelled.get(key) ?? 0,
      refunded: ref,
      unaccounted,
      short: unaccounted > 0,
    };
  });

  // Who could the customer mean? A line that shipped in full and was not
  // refunded is accounted for and cannot be the one - UNLESS nothing at all is
  // short, in which case every delivered line is a candidate, because the
  // complaint is then about something Shopify believes was sent.
  const shortLines = lines.filter((l) => l.short);
  const candidates = shortLines.length ? shortLines : lines.filter((l) => l.shipped > 0);
  const ambiguous = candidates.length > 1;

  const instruction = buildInstruction({
    visibility: fulfillmentOrders.readable ? "readable" : "unreadable",
    lines,
    shortLines,
    candidates,
    anotherShipmentPending,
  });

  return {
    order_id: id(order?.id),
    name: String(order?.name ?? ""),
    fulfillment_visibility: fulfillmentOrders.readable ? "readable" : "unreadable",
    ...(fulfillmentOrders.readable ? {} : { fulfillment_orders_error: fulfillmentOrders.error }),
    multiple_shipments: fulfillments.filter((f) => String(f?.status ?? "").toLowerCase() !== "cancelled").length > 1,
    shipments: fulfillments.map((f) => ({
      id: id(f?.id),
      status: f?.status ?? null,
      tracking_number: f?.tracking_number ?? null,
      item_count: (f?.line_items ?? []).length,
    })),
    another_shipment_pending: anotherShipmentPending,
    lines,
    candidates,
    unambiguous_item: candidates.length === 1 ? candidates[0] : null,
    ambiguous,
    model_instruction: instruction,
  };
}

/**
 * What the model is allowed to conclude from these numbers.
 *
 * Written as instruction rather than left to inference because each branch has
 * a specific wrong answer the model reaches for on its own: it calls a pending
 * second shipment a lost item, it calls an unreadable fulfillment scope "nothing
 * shipped", and on a one-line order it still asks which item is missing.
 */
function buildInstruction(ctx: {
  visibility: FulfillmentVisibility;
  lines: ReconciledLine[];
  shortLines: ReconciledLine[];
  candidates: ReconciledLine[];
  anotherShipmentPending: boolean;
}): string {
  const never =
    " Do NOT ask the customer to verify their identity - it is already established, and a complaint is not a reason to re-verify." +
    " Do NOT say a team, warehouse or courier has been told anything unless a handoff, task or return was actually created this turn.";

  if (ctx.visibility === "unreadable") {
    return (
      "You CANNOT see this order's fulfillment information, so you cannot confirm what shipped." +
      " Say exactly that - that you are unable to confirm the shipment breakdown right now - and offer a human agent." +
      " Do NOT say nothing shipped, and do NOT say the item is missing." +
      never
    );
  }
  // The pending branch comes FIRST, and it must. A second shipment that has
  // not gone out yet drives `unaccounted` to zero, which reads exactly like
  // "everything is accounted for" - so ordering this after the all-accounted
  // branch told a customer whose parcel was still in the warehouse that
  // Shopify shows nothing outstanding. True of the numbers, wrong as an answer.
  const stillComing = ctx.anotherShipmentPending && ctx.lines.some((l) => l.pending > 0);
  if (stillComing && !ctx.shortLines.length) {
    return (
      "Part of this order has not been dispatched yet - a further shipment is still pending." +
      " Explain that the remaining items are still coming rather than treating them as lost." +
      never
    );
  }
  if (!ctx.shortLines.length && ctx.candidates.length) {
    return (
      "Shopify records every ordered unit as shipped or refunded, so nothing is outstanding on this order." +
      " Tell the customer what the records show, take the complaint seriously anyway, and proceed to the return/support step" +
      " rather than arguing with them." +
      (ctx.candidates.length > 1 ? " More than one item was delivered - ask which one is missing." : "") +
      never
    );
  }
  const pendingNote = stillComing
    ? " Note that a further shipment is still pending on this order, so some of what they are waiting for is on its way."
    : "";
  if (ctx.candidates.length === 1) {
    const c = ctx.candidates[0];
    return (
      `One item is short: "${c.title}"${c.variant_title ? ` (${c.variant_title})` : ""} - ordered ${c.ordered}, ` +
      `shipped ${c.shipped}, ${c.unaccounted} unaccounted for. Do NOT ask the customer which item they mean; you know.` +
      " State the shortfall, then take the configured next step (return/RMA or a real handoff)." +
      pendingNote +
      never
    );
  }
  if (ctx.candidates.length > 1) {
    return (
      "More than one item on this order is short, so you genuinely do not know which the customer means." +
      " Ask which item is missing, naming the candidates." +
      pendingNote +
      never
    );
  }
  return (
    "This order has no line items to compare. Say you cannot see anything outstanding and offer a human agent." + never
  );
}
