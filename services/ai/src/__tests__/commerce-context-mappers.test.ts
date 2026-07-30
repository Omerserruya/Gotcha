/**
 * Pure projection mappers for the Shopify commerce panel. Exact order/product
 * data comes ONLY from the verified Shopify fields; status is a localized
 * business label (never a raw enum); money is never summed across currencies;
 * a refund can never exceed the refundable maximum.
 *
 * Covers spec §12 tests: 7 (multi-currency), 9 (status mapping), 10 (exact
 * data), 11/12 (capability/scope gating), 14 (refundable maximum).
 */
import { describe, it, expect } from "vitest";
import { __testables } from "../services/commerce-context.service";

const {
  financialChip, fulfillmentChip, refundChip, shippingChip,
  refundedAmount, mapOrderCard, buildCapabilities, money,
} = __testables;

const ORDER = {
  id: 5001,
  name: "#1246",
  created_at: "2026-07-18T10:00:00Z",
  currency: "USD",
  total_price: "120.00",
  financial_status: "paid",
  fulfillment_status: null,
  cancelled_at: null,
  line_items: [
    { id: 1, title: "Nike Cryptokicks", quantity: 1, price: "120.00" },
  ],
  refunds: [],
  customer: { id: 999 },
};

describe("status mapping → localized labels, never raw enums (test 9)", () => {
  it("paid → positive Paid / שולם", () => {
    expect(financialChip("paid", "en")).toEqual({ key: "paid", label: "Paid", tone: "positive" });
    expect(financialChip("paid", "he").label).toBe("שולם");
  });
  it("unknown/null fulfillment → Unfulfilled (not a raw enum)", () => {
    expect(fulfillmentChip(null, "en")).toEqual({ key: "unfulfilled", label: "Unfulfilled", tone: "neutral" });
    expect(fulfillmentChip("fulfilled", "en").label).toBe("Fulfilled");
    expect(fulfillmentChip("partial", "en").key).toBe("partial");
  });
  it("refund chip derives from amounts, not an enum", () => {
    expect(refundChip(0, 100, "en")).toBeNull();
    expect(refundChip(40, 100, "en")).toMatchObject({ key: "partially_refunded", tone: "warning" });
    expect(refundChip(100, 100, "en")).toMatchObject({ key: "refunded", tone: "danger" });
  });
});

describe("money is never cross-currency (test 7)", () => {
  it("money() keeps the amount in its own currency as a fixed string", () => {
    expect(money("120", "USD")).toEqual({ amount: "120.00", currency: "USD" });
    expect(money("50.5", "EUR")).toEqual({ amount: "50.50", currency: "EUR" });
  });
  it("two orders in different currencies keep distinct currencies (no summation)", () => {
    const usd = mapOrderCard({ ...ORDER, currency: "USD", total_price: "120.00" }, "s.myshopify.com", true, "en");
    const eur = mapOrderCard({ ...ORDER, id: 5002, currency: "EUR", total_price: "90.00" }, "s.myshopify.com", true, "en");
    expect(usd.total).toEqual({ amount: "120.00", currency: "USD" });
    expect(eur.total).toEqual({ amount: "90.00", currency: "EUR" });
  });
});

describe("refunded amount + refundable maximum (test 14)", () => {
  it("sums refund transactions", () => {
    const o = { ...ORDER, refunds: [{ transactions: [{ kind: "refund", status: "success", amount: "30.00" }] }] };
    expect(refundedAmount(o)).toBeCloseTo(30);
  });
  it("refundableMaximum = total − refunded, never negative", () => {
    const o = { ...ORDER, total_price: "120.00", refunds: [{ transactions: [{ kind: "refund", status: "success", amount: "50.00" }] }] };
    const card = mapOrderCard(o, "s.myshopify.com", true, "en");
    expect(card.refundedAmount).toEqual({ amount: "50.00", currency: "USD" });
    expect(card.refundableMaximum).toEqual({ amount: "70.00", currency: "USD" });
  });
  it("a fully refunded order is not refundable", () => {
    const o = { ...ORDER, total_price: "120.00", refunds: [{ transactions: [{ kind: "refund", status: "success", amount: "120.00" }] }] };
    const card = mapOrderCard(o, "s.myshopify.com", true, "en");
    expect(card.refundableMaximum.amount).toBe("0.00");
    expect(card.eligibility.refundable).toBe(false);
    expect(card.eligibility.reasonIfNot).toBe("already_refunded");
  });
});

describe("exact order data + admin URL (test 10)", () => {
  const card = mapOrderCard(ORDER, "urban-supply.myshopify.com", true, "en");
  it("order number + total are exact", () => {
    expect(card.orderNumber).toBe("#1246");
    expect(card.total).toEqual({ amount: "120.00", currency: "USD" });
  });
  it("admin URL is tenant/provider-derived, not reconstructed by a model", () => {
    expect(card.adminUrl).toBe("https://urban-supply.myshopify.com/admin/orders/5001");
  });
  it("item title is verbatim; image is null (Shopify line items omit it)", () => {
    expect(card.items[0]).toEqual({ title: "Nike Cryptokicks", quantity: 1, imageUrl: null });
  });
});

describe("cancelled order eligibility", () => {
  it("a cancelled order is not cancellable and is flagged", () => {
    const card = mapOrderCard({ ...ORDER, cancelled_at: "2026-07-19T00:00:00Z" }, "s.myshopify.com", true, "en");
    expect(card.cancelled).toBe(true);
    expect(card.eligibility.cancellable).toBe(false);
    expect(card.eligibility.reasonIfNot).toBe("already_cancelled");
  });
});

describe("capabilities gate on granted scopes + agent permission (tests 11, 12)", () => {
  it("no write_orders scope disables cancel/refund even for a permitted agent", () => {
    const caps = buildCapabilities(
      { grantedScopes: ["read_orders"] },
      { canOpen: true, canCancel: true, canRefund: true, canTag: true, canNote: true, canNotify: true },
    );
    expect(caps.canOpen).toBe(true);
    expect(caps.canCancel).toBe(false);
    expect(caps.canRefund).toBe(false);
    expect(caps.missingScopes).toContain("write_orders");
  });
  it("agent without the permission cannot cancel/refund even with the scope", () => {
    const caps = buildCapabilities(
      { grantedScopes: ["read_orders", "write_orders"] },
      { canOpen: false, canCancel: false, canRefund: false, canTag: false, canNote: false, canNotify: false },
    );
    expect(caps.canCancel).toBe(false);
    expect(caps.canRefund).toBe(false);
    expect(caps.canOpen).toBe(false);
  });
  it("permitted agent + order write scope enables the ORDER actions", () => {
    const caps = buildCapabilities(
      { grantedScopes: ["read_orders", "write_orders"] },
      { canOpen: true, canCancel: true, canRefund: true, canTag: true, canNote: true, canNotify: true },
    );
    expect(caps.canCancel).toBe(true);
    expect(caps.canRefund).toBe(true);
    // write_orders does not buy customer-record writes. A store can grant one
    // and not the other, and offering a tag button that always fails would be
    // worse than not offering it.
    expect(caps.canTag).toBe(false);
    expect(caps.canNote).toBe(false);
    expect(caps.missingScopes).toEqual(["write_customers"]);
  });

  it("both scopes granted → nothing missing", () => {
    const caps = buildCapabilities(
      { grantedScopes: ["read_orders", "write_orders", "write_customers"] },
      { canOpen: true, canCancel: true, canRefund: true, canTag: true, canNote: true, canNotify: true },
    );
    expect(caps.canTag).toBe(true);
    expect(caps.canNote).toBe(true);
    expect(caps.missingScopes).toHaveLength(0);
  });

  it("a scope is only reported missing when the agent could otherwise use it", () => {
    // Listing write_customers for an agent who may not tag anyone would send
    // an admin to re-authorize the store for no reason.
    const caps = buildCapabilities(
      { grantedScopes: ["read_orders", "write_orders"] },
      { canOpen: true, canCancel: true, canRefund: true, canTag: false, canNote: false, canNotify: false },
    );
    expect(caps.missingScopes).toHaveLength(0);
  });
});

describe("shipping chip only appears with real fulfillment/tracking", () => {
  it("no fulfillments → null", () => {
    expect(shippingChip(ORDER, "en")).toBeNull();
  });
  it("tracking present → Shipped; delivered status → Delivered", () => {
    expect(shippingChip({ ...ORDER, fulfillments: [{ tracking_number: "TN1" }] }, "en")).toMatchObject({ key: "shipped" });
    expect(shippingChip({ ...ORDER, fulfillments: [{ shipment_status: "delivered" }] }, "en")).toMatchObject({ key: "delivered", tone: "positive" });
  });
});

describe("order detail money is reported, never derived (§16)", () => {
  const { mapOrderDetail } = (__testables as any);
  const base = { currency: "USD", total_price: "600.00", line_items: [] };

  it("a refunded order does not claim the customer still owes the total", () => {
    // Derived as total - current_total_price, a fully refunded order reads as
    // "outstanding 600.00" - the exact opposite of what happened, and a number
    // an agent would act on.
    const d = mapOrderDetail(
      { ...base, current_total_price: "0.00", financial_status: "refunded" },
      "USD", {},
    );
    expect(d.outstanding).toBeUndefined();
  });

  it("reports the provider's own outstanding balance when there is one", () => {
    const d = mapOrderDetail({ ...base, total_outstanding: "40.00" }, "USD", {});
    expect(d.outstanding?.amount).toBe("40.00");
  });

  it("omits money lines the provider did not send, rather than sending 0.00", () => {
    const d = mapOrderDetail(base, "USD", {});
    expect(d.subtotal).toBeUndefined();
    expect(d.tax).toBeUndefined();
    expect(d.shipping).toBeUndefined();
  });

  it("keeps a real zero, which is a value the provider actually reported", () => {
    const d = mapOrderDetail({ ...base, total_tax: "0.00" }, "USD", {});
    expect(d.tax?.amount).toBe("0.00");
  });

  it("computes each line total from unit price and quantity", () => {
    const d = mapOrderDetail(
      { ...base, line_items: [{ title: "Board", quantity: 3, price: "50.00", variant_title: "L" }] },
      "USD", {},
    );
    expect(d.itemCount).toBe(3);
    expect(d.lineItems[0].lineTotal.amount).toBe("150.00");
    expect(d.lineItems[0].variantTitle).toBe("L");
  });
});
