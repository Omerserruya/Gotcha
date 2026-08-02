/**
 * Can this order still be changed?
 *
 * Both remaining customer-facing order mutations - editing the shipping
 * address and swapping a line item for a different variant - turn on the same
 * question, and the wrong way to answer it is `order.fulfillment_status`.
 *
 * That field reported `null` for order #1006 while Shopify refused to cancel
 * it with "Cannot cancel an order that has outstanding fulfillments" (Part 2).
 * It is a summary of the legacy `fulfillments` array, and an order being packed
 * has no fulfillment yet - the work lives in a FULFILLMENT ORDER, which is a
 * different object with a different permission. Anything that decides "has
 * this left yet" from the legacy field is confidently wrong on exactly the
 * orders where being wrong costs a parcel going to the old address.
 *
 * The three-valued result matters as much as the rule. "We cannot see" is not
 * "it is fine to edit": without the fulfillment scope the honest answer is that
 * eligibility is unknown, and an unknown must never be spent on a mutation.
 */

export type MutabilityVerdict = "editable" | "blocked" | "unknown";

export interface Mutability {
  verdict: MutabilityVerdict;
  /** Machine-readable cause, for the outcome contract and the audit. */
  reason:
    | "editable"
    | "order_cancelled"
    | "fulfillment_in_progress"
    | "fulfillment_requested"
    | "assigned_to_fulfillment_service"
    | "already_fulfilled"
    | "fulfillment_unreadable";
  /** What the customer may be told, without naming Shopify internals. */
  customer_explanation: string;
  /** Fulfillment-order statuses seen, for the approval card and the log. */
  fulfillment_states: string[];
}

/**
 * Fulfillment-order statuses that mean the warehouse already owns this order.
 *
 * `open` and `scheduled` are NOT here. An open fulfillment order is work that
 * has not started - every unfulfilled order has one - and treating it as
 * blocking would refuse every legitimate address change there is. `scheduled`
 * is deliberately blocking: it is a dispatch already booked, which is the case
 * the product decision calls "scheduled for dispatch".
 */
const BLOCKING_STATUSES = new Set(["in_progress", "incomplete", "closed"]);
const BLOCKING_REQUEST_STATUSES = new Set(["submitted", "accepted"]);

export function assessMutability(
  order: any,
  fulfillmentOrders: { orders: any[]; readable: boolean },
): Mutability {
  const states: string[] = (fulfillmentOrders.orders ?? []).map((f: any) =>
    String(f?.status ?? "unknown").toLowerCase(),
  );

  if (order?.cancelled_at) {
    return {
      verdict: "blocked",
      reason: "order_cancelled",
      customer_explanation: "This order has been cancelled, so there is nothing left to change on it.",
      fulfillment_states: states,
    };
  }

  // Checked BEFORE the scope question. An order with a real fulfillment on it
  // has demonstrably shipped, and that is knowable without the fulfillment
  // scope - refusing it as "unknown" would be needlessly unhelpful.
  const shipped = (order?.fulfillments ?? []).some(
    (f: any) => String(f?.status ?? "").toLowerCase() !== "cancelled",
  );
  if (shipped) {
    return {
      verdict: "blocked",
      reason: "already_fulfilled",
      customer_explanation: "This order has already been dispatched, so it cannot be changed here any more.",
      fulfillment_states: states,
    };
  }

  if (!fulfillmentOrders.readable) {
    return {
      verdict: "unknown",
      reason: "fulfillment_unreadable",
      customer_explanation:
        "I cannot currently confirm whether this order has already gone out, so I am not able to change it from here.",
      fulfillment_states: [],
    };
  }

  for (const fo of fulfillmentOrders.orders ?? []) {
    const status = String(fo?.status ?? "").toLowerCase();
    const request = String(fo?.request_status ?? "").toLowerCase();
    if (BLOCKING_STATUSES.has(status)) {
      return {
        verdict: "blocked",
        reason: "fulfillment_in_progress",
        customer_explanation: "This order is already being prepared for dispatch, so it can no longer be changed here.",
        fulfillment_states: states,
      };
    }
    if (BLOCKING_REQUEST_STATUSES.has(request)) {
      return {
        verdict: "blocked",
        reason: "fulfillment_requested",
        customer_explanation: "This order has already been handed to the warehouse, so it can no longer be changed here.",
        fulfillment_states: states,
      };
    }
    if (status === "scheduled") {
      return {
        verdict: "blocked",
        reason: "fulfillment_in_progress",
        customer_explanation: "This order is already scheduled for dispatch, so it can no longer be changed here.",
        fulfillment_states: states,
      };
    }
    // A fulfillment SERVICE holds the stock: the shop cannot edit what it does
    // not control, and Shopify accepts the write while the third party ships
    // against what it already has.
    if (fo?.assigned_location?.location_id == null && fo?.assigned_location_id == null && fo?.fulfillment_service_handle) {
      return {
        verdict: "blocked",
        reason: "assigned_to_fulfillment_service",
        customer_explanation: "This order is with an external fulfillment partner, so it can no longer be changed here.",
        fulfillment_states: states,
      };
    }
  }

  return {
    verdict: "editable",
    reason: "editable",
    customer_explanation: "This order has not been dispatched yet.",
    fulfillment_states: states,
  };
}

// ── Shipping address validation ───────────────────────────────

export interface AddressPatch {
  fields: Record<string, string>;
  missing: string[];
  errors: string[];
}

/**
 * The fields a parcel actually needs.
 *
 * `address2` and `company` are genuinely optional; `province` is required only
 * where the country has them, which is not something we can decide from here -
 * so Shopify is left to refuse that one, and only the universally-required
 * fields are demanded up front. Demanding a province for Israel would block a
 * valid change on a rule that does not apply.
 */
const REQUIRED = ["address1", "city", "country"] as const;
const ALLOWED = ["first_name", "last_name", "address1", "address2", "city", "province", "zip", "country", "phone", "company"] as const;

const ZIP_RE = /^[A-Za-z0-9][A-Za-z0-9\s-]{2,11}$/;

export function validateShippingAddress(input: Record<string, unknown>): AddressPatch {
  const out: AddressPatch = { fields: {}, missing: [], errors: [] };
  const src = input && typeof input === "object" ? input : {};
  for (const [k, v] of Object.entries(src)) {
    if (v == null || v === "") continue;
    if (!(ALLOWED as readonly string[]).includes(k)) {
      out.errors.push(`unsupported_address_field:${k}`);
      continue;
    }
    out.fields[k] = String(v).trim();
  }
  for (const r of REQUIRED) {
    if (!out.fields[r]) out.missing.push(r);
  }
  if (out.fields.zip && !ZIP_RE.test(out.fields.zip)) {
    out.errors.push(`invalid_postal_code:${out.fields.zip}`);
  }
  return out;
}

/**
 * Did the address actually change to what was asked for?
 *
 * Compared field by field against an independent read, for the same reason the
 * profile update is: Shopify's own response to the write is not evidence that
 * the write took.
 */
export function verifyShippingAddress(
  patch: AddressPatch,
  order: any,
): { verified: boolean; mismatches: Array<{ field: string; requested: string; actual: string | null }> } {
  const addr = order?.shipping_address ?? null;
  const mismatches: Array<{ field: string; requested: string; actual: string | null }> = [];
  if (!addr) return { verified: false, mismatches: [{ field: "shipping_address", requested: "read back", actual: null }] };
  for (const [field, requested] of Object.entries(patch.fields)) {
    const actual = addr[field] == null ? null : String(addr[field]);
    if (actual == null || actual.trim().toLowerCase() !== requested.trim().toLowerCase()) {
      mismatches.push({ field, requested, actual });
    }
  }
  return { verified: mismatches.length === 0, mismatches };
}
