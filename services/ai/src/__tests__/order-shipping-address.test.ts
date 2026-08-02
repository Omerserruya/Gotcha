/**
 * Changing where an order is going.
 *
 * Scenarios 10 and 11 were both UNSUPPORTED for opposite reasons: before
 * dispatch the bot handed the conversation to a person for something it could
 * have done, and after dispatch the risk is the other way - claiming the
 * address was changed, or that a courier was contacted, neither of which any
 * tool here can make true.
 *
 * The eligibility rule is the whole test surface. `fulfillment_status` reported
 * `null` for order #1006 while Shopify refused to cancel it for having
 * outstanding fulfillments, so anything deciding "has this left yet" from the
 * legacy field is wrong on exactly the orders where being wrong matters.
 */
import { describe, it, expect } from "vitest";
import {
  assessMutability,
  validateShippingAddress,
  verifyShippingAddress,
} from "../services/connectors/shopify-order-mutability";
import {
  detectOrderAddressIntent,
  buildOrderAddressDirective,
} from "../services/customer-request-intents.service";

const open = { orders: [{ id: 1, status: "open" }], readable: true };
const unreadable = { orders: [], readable: false };

describe("is this order still editable", () => {
  it("an unfulfilled order with an open fulfillment order is editable", () => {
    const m = assessMutability({ id: 1, name: "#1011", fulfillment_status: null, fulfillments: [] }, open);
    expect(m.verdict).toBe("editable");
  });

  it("in_progress blocks, even though fulfillment_status still says null", () => {
    const m = assessMutability(
      { id: 1, name: "#1006", fulfillment_status: null, fulfillments: [] },
      { orders: [{ id: 1, status: "in_progress" }], readable: true },
    );
    expect(m.verdict).toBe("blocked");
    expect(m.reason).toBe("fulfillment_in_progress");
  });

  it("a scheduled dispatch blocks - the booking has been made", () => {
    const m = assessMutability({ id: 1 }, { orders: [{ id: 1, status: "scheduled" }], readable: true });
    expect(m.verdict).toBe("blocked");
  });

  it("a submitted or accepted request blocks - the warehouse has it", () => {
    for (const request_status of ["submitted", "accepted"]) {
      const m = assessMutability({ id: 1 }, { orders: [{ id: 1, status: "open", request_status }], readable: true });
      expect(m.reason, request_status).toBe("fulfillment_requested");
    }
  });

  it("an external fulfillment service blocks - the shop does not hold the stock", () => {
    const m = assessMutability(
      { id: 1 },
      { orders: [{ id: 1, status: "open", fulfillment_service_handle: "shipwire" }], readable: true },
    );
    expect(m.reason).toBe("assigned_to_fulfillment_service");
  });

  it("a real fulfillment blocks regardless of the fulfillment orders", () => {
    const m = assessMutability({ id: 1, fulfillments: [{ id: 9, status: "success" }] }, open);
    expect(m.reason).toBe("already_fulfilled");
  });

  it("a CANCELLED fulfillment does not block - nothing left with that one", () => {
    const m = assessMutability({ id: 1, fulfillments: [{ id: 9, status: "cancelled" }] }, open);
    expect(m.verdict).toBe("editable");
  });

  it("a cancelled order is blocked with its own reason", () => {
    const m = assessMutability({ id: 1, cancelled_at: "2026-08-01T00:00:00Z" }, open);
    expect(m.reason).toBe("order_cancelled");
  });

  it("an unreadable fulfillment scope is UNKNOWN, never editable", () => {
    const m = assessMutability({ id: 1, fulfillments: [] }, unreadable);
    expect(m.verdict).toBe("unknown");
    expect(m.reason).toBe("fulfillment_unreadable");
  });

  it("never explains itself in Shopify vocabulary", () => {
    const m = assessMutability({ id: 1 }, { orders: [{ id: 1, status: "in_progress" }], readable: true });
    expect(m.customer_explanation).not.toMatch(/fulfillment_order|in_progress|shopify/i);
  });
});

describe("validating the new address", () => {
  it("requires street, city and country", () => {
    const a = validateShippingAddress({ city: "Haifa" });
    expect(a.missing.sort()).toEqual(["address1", "country"]);
  });

  it("does not demand a province - not every country has one", () => {
    const a = validateShippingAddress({ address1: "Herzl 1", city: "Haifa", country: "Israel" });
    expect(a.missing).toEqual([]);
    expect(a.errors).toEqual([]);
  });

  it("rejects a postal code that cannot be one", () => {
    const a = validateShippingAddress({ address1: "Herzl 1", city: "Haifa", country: "Israel", zip: "!!" });
    expect(a.errors[0]).toMatch(/^invalid_postal_code/);
  });

  it("refuses fields that are not part of an address", () => {
    const a = validateShippingAddress({ address1: "Herzl 1", city: "Haifa", country: "Israel", note: "hi" });
    expect(a.errors).toContain("unsupported_address_field:note");
  });
});

describe("verifying the address actually changed", () => {
  const patch = validateShippingAddress({ address1: "Herzl 1", city: "Haifa", country: "Israel" });

  it("confirms against an independent read of the order", () => {
    const v = verifyShippingAddress(patch, { shipping_address: { address1: "Herzl 1", city: "Haifa", country: "Israel" } });
    expect(v.verified).toBe(true);
  });

  it("catches a write that Shopify accepted but did not apply", () => {
    const v = verifyShippingAddress(patch, { shipping_address: { address1: "Herzl 1", city: "Tel Aviv", country: "Israel" } });
    expect(v.verified).toBe(false);
    expect(v.mismatches[0].field).toBe("city");
  });

  it("an order with no shipping address at all is not a success", () => {
    expect(verifyShippingAddress(patch, { shipping_address: null }).verified).toBe(false);
  });

  // Live (2026-08-02): the customer wrote "ישראל", Shopify stored "Israel",
  // and a change whose street, city and postal code were all exactly right
  // reported as a failed write. The customer would have been told their
  // address had not changed while the parcel was already routed to the new one.
  it("accepts Shopify's rewrite of a country name it had to normalise", () => {
    const p = validateShippingAddress({ address1: "הרצל 1", city: "חיפה", country: "ישראל", zip: "3100000" });
    const v = verifyShippingAddress(p, {
      shipping_address: { address1: "הרצל 1", city: "חיפה", country: "Israel", country_code: "IL", zip: "3100000" },
    });
    expect(v.verified).toBe(true);
    expect(v.normalized).toEqual([{ field: "country", requested: "ישראל", actual: "Israel" }]);
  });

  it("matches on the country CODE when that is what was asked for", () => {
    const p = validateShippingAddress({ address1: "Herzl 1", city: "Haifa", country: "IL" });
    expect(verifyShippingAddress(p, {
      shipping_address: { address1: "Herzl 1", city: "Haifa", country: "Israel", country_code: "IL" },
    }).verified).toBe(true);
  });

  // The normalisation allowance must not swallow a real country error, so it
  // only applies where WE sent something Shopify had to rewrite.
  it("still fails when an ASCII country comes back as a different country", () => {
    const p = validateShippingAddress({ address1: "Herzl 1", city: "Haifa", country: "Israel" });
    const v = verifyShippingAddress(p, {
      shipping_address: { address1: "Herzl 1", city: "Haifa", country: "United States", country_code: "US" },
    });
    expect(v.verified).toBe(false);
    expect(v.mismatches[0].field).toBe("country");
  });

  it("a wrong city is still a mismatch even alongside a normalised country", () => {
    const p = validateShippingAddress({ address1: "הרצל 1", city: "חיפה", country: "ישראל" });
    const v = verifyShippingAddress(p, {
      shipping_address: { address1: "הרצל 1", city: "Tel Aviv", country: "Israel", country_code: "IL" },
    });
    expect(v.verified).toBe(false);
    expect(v.mismatches.map((m) => m.field)).toEqual(["city"]);
  });
});

describe("detecting an order-address request", () => {
  it("fires when the order is in scope", () => {
    for (const s of [
      "תשנו לי את הכתובת בהזמנה",
      "אפשר לעדכן את כתובת המשלוח של ההזמנה?",
      "change the shipping address for order 1011",
    ]) {
      expect(detectOrderAddressIntent(s), s).toBe(true);
    }
  });

  it("does not claim a bare profile-address change", () => {
    expect(detectOrderAddressIntent("הכתובת שלי השתנתה")).toBe(false);
  });
});

describe("the order-address directive", () => {
  it("forbids the two claims that cannot be true after dispatch", () => {
    const d = buildOrderAddressDirective({ hasAddressTool: true });
    expect(d).toContain("do NOT say the address was changed");
    expect(d).toContain("do NOT say the carrier, courier or warehouse has been contacted");
  });

  it("requires the full address before calling, not after", () => {
    const d = buildOrderAddressDirective({ hasAddressTool: true });
    expect(d).toContain("Collect the FULL new address first");
    expect(d).toContain("Read it back to them before calling");
  });

  it("without the tool it still may not claim a courier was contacted", () => {
    const d = buildOrderAddressDirective({ hasAddressTool: false });
    expect(d).toContain("Do NOT say the courier, carrier or warehouse was contacted");
    expect(d).toContain("cannot change it from this chat");
  });
});
