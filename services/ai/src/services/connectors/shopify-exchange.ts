/**
 * Swapping a line item for a different variant of the same order.
 *
 * "156 → 159" is what a customer means by an exchange when nothing has
 * shipped, and it is an order edit, not a return. Once the parcel is moving it
 * stops being an order edit and becomes a return plus a replacement, which is
 * Phase 6's problem.
 *
 * ── Why money stops this short ───────────────────────────────────────────
 *
 * A Shopify order edit does not settle itself. Adding a more expensive variant
 * leaves the order with an outstanding balance the merchant has to collect;
 * removing value leaves a refund owed. Committing either without settling it
 * produces an order that is internally inconsistent - paid amount and order
 * total disagree - and no customer-facing payment flow exists here to fix it.
 *
 * So the price difference decides who does the work:
 *
 *   equal      the edit is complete on its own. Commit it.
 *   higher     refuse BEFORE editing, state the exact difference, hand to a
 *              person who can take payment.
 *   lower      refuse BEFORE editing, state the exact difference, hand to a
 *              person who can settle it.
 *
 * Refusing before editing rather than after is the important part: an aborted
 * edit still exists as a calculated order, and a half-applied exchange is worse
 * than none. The alternative - commit and then chain a refund - would invent a
 * compensation mechanism out of two separate approvals, which is exactly what
 * the product decision forbids.
 */

export type PriceRelation = "equal" | "higher" | "lower";

export interface ExchangeQuote {
  order_name: string;
  current_title: string;
  current_variant: string | null;
  current_variant_id: string;
  current_unit_price: string;
  /** How many of the original variant the order holds, before the swap. */
  original_quantity: number;
  /** The order line being edited - needed to set its quantity down. */
  line_item_id: string;
  requested_title: string;
  requested_variant: string | null;
  requested_variant_id: string;
  requested_unit_price: string;
  quantity: number;
  currency: string;
  price_difference: string;
  relation: PriceRelation;
  inventory_available: number | null;
  in_stock: boolean;
}

export type ExchangeEligibility =
  | { ok: true; quote: ExchangeQuote }
  | { ok: false; reason: ExchangeRefusal; detail: string; quote?: ExchangeQuote };

export type ExchangeRefusal =
  | "line_item_not_found"
  | "variant_not_found"
  | "same_variant"
  | "out_of_stock"
  | "insufficient_quantity"
  | "quantity_invalid"
  | "price_difference_requires_payment"
  | "price_difference_requires_refund";

function money(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Two decimal places, as an order total is. */
function fixed(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export interface ExchangeInputs {
  orderName: string;
  currency: string;
  /** The order line the customer wants replaced. */
  lineItem: any | null;
  /** The variant they want instead, with its inventory. */
  variant: any | null;
  /** Product title of the replacement, for the approval card. */
  productTitle: string;
  /** How many units to swap. */
  quantity: number;
}

/**
 * Everything the approval card needs, and the decision about whether an
 * approval should exist at all.
 *
 * No HITL is raised for an exchange that is technically impossible - an
 * out-of-stock variant, a quantity the order does not have, a price gap nobody
 * here can settle. Putting those in front of a person spends a real decision on
 * something the answer cannot change, which is the failure the cancellation
 * precheck was built to stop.
 */
export function quoteExchange(input: ExchangeInputs): ExchangeEligibility {
  const { lineItem, variant, orderName, currency, quantity } = input;

  if (!lineItem) {
    return { ok: false, reason: "line_item_not_found", detail: "That item is not on this order." };
  }
  if (!variant) {
    return { ok: false, reason: "variant_not_found", detail: "That option does not exist for this product." };
  }
  if (String(variant.id) === String(lineItem.variant_id)) {
    return { ok: false, reason: "same_variant", detail: "That is the option already on the order." };
  }

  const qty = Math.floor(Number(quantity));
  if (!Number.isFinite(qty) || qty < 1) {
    return { ok: false, reason: "quantity_invalid", detail: "The quantity to exchange must be at least 1." };
  }
  const ordered = Number(lineItem.quantity ?? 0);
  if (qty > ordered) {
    return {
      ok: false,
      reason: "insufficient_quantity",
      detail: `The order has ${ordered} of that item, so ${qty} cannot be exchanged.`,
    };
  }

  // `inventory_quantity` is an aggregate and is meaningless when Shopify is not
  // tracking the variant at all - the same trap that once reported an entire
  // catalogue in stock. Untracked reads as available; tracked-and-zero does not.
  const tracked = variant.inventory_management != null && String(variant.inventory_management) !== "";
  const available = tracked ? Number(variant.inventory_quantity ?? 0) : null;
  const inStock = !tracked || (available ?? 0) >= qty;

  const currentUnit = money(lineItem.price);
  const requestedUnit = money(variant.price);
  const diff = (requestedUnit - currentUnit) * qty;

  const quote: ExchangeQuote = {
    order_name: orderName,
    current_title: String(lineItem.title ?? ""),
    current_variant: lineItem.variant_title ?? null,
    current_variant_id: String(lineItem.variant_id ?? ""),
    current_unit_price: fixed(currentUnit),
    original_quantity: ordered,
    line_item_id: String(lineItem.id ?? ""),
    requested_title: input.productTitle,
    requested_variant: variant.title ?? null,
    requested_variant_id: String(variant.id),
    requested_unit_price: fixed(requestedUnit),
    quantity: qty,
    currency,
    price_difference: fixed(diff),
    relation: relationOf(diff),
    inventory_available: available,
    in_stock: inStock,
  };

  if (!inStock) {
    return {
      ok: false,
      reason: "out_of_stock",
      detail: `That option is not in stock${available != null ? ` (${available} available)` : ""}.`,
      quote,
    };
  }

  if (quote.relation === "higher") {
    return {
      ok: false,
      reason: "price_difference_requires_payment",
      detail: `The replacement costs ${quote.price_difference} ${currency} more, and there is no way to take that payment from this conversation.`,
      quote,
    };
  }
  if (quote.relation === "lower") {
    return {
      ok: false,
      reason: "price_difference_requires_refund",
      detail: `The replacement costs ${fixed(Math.abs(diff))} ${currency} less, which has to be settled separately from the exchange.`,
      quote,
    };
  }

  return { ok: true, quote };
}

/**
 * A cent of tolerance, because order-line prices are decimal strings and
 * `159.00 - 159.00` is not reliably `0` once it has been through a float.
 */
function relationOf(diff: number): PriceRelation {
  if (!Number.isFinite(diff)) return "higher"; // unknowable price: never auto-commit
  if (Math.abs(diff) < 0.005) return "equal";
  return diff > 0 ? "higher" : "lower";
}

/**
 * Did the committed edit produce the order we asked for?
 *
 * Both halves are checked. An edit that added the new variant but failed to
 * remove the old leaves the customer holding two snowboards and a bill, and
 * "the new line exists" alone would report that as success.
 */
export function verifyExchange(
  quote: ExchangeQuote,
  order: any,
): { verified: boolean; problems: string[] } {
  const problems: string[] = [];
  const lines: any[] = Array.isArray(order?.line_items) ? order.line_items : [];

  const qtyOf = (variantId: string) =>
    lines.filter((l) => String(l.variant_id) === variantId).reduce((s, l) => s + Number(l.quantity ?? 0), 0);

  const newQty = qtyOf(quote.requested_variant_id);
  if (newQty < quote.quantity) {
    problems.push(`replacement_quantity_${newQty}_expected_${quote.quantity}`);
  }

  // Exchanging 1 of 2 must leave 1 behind; exchanging 2 of 2 must leave none.
  // Checking only "the new line exists" would report a swap that added the new
  // variant and failed to remove the old as a success - a customer holding two
  // snowboards and a bill.
  const expectedOld = Math.max(0, quote.original_quantity - quote.quantity);
  const actualOld = qtyOf(quote.current_variant_id);
  if (actualOld !== expectedOld) {
    problems.push(`original_quantity_${actualOld}_expected_${expectedOld}`);
  }

  return { verified: problems.length === 0, problems };
}
