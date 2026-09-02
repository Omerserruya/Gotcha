import { describe, it, expect } from "vitest";
import {
  mapOrder,
  mapFinancialStatus,
  mapFulfillmentStatus,
  buildOrderQuery,
} from "../services/connectors/shopify-gql-orders";

/**
 * The order contract.
 *
 * Everything a customer conversation does with an order - answering "where is
 * it", refusing a cancel on a shipped order, calculating a refund, deciding
 * whether an exchange is still possible - reads the REST-shaped fields below.
 * The status vocabulary and the money fields are where a GraphQL order can look
 * right and answer wrong, so that is where these concentrate.
 */

const node = {
  legacyResourceId: "5001",
  name: "#1006",
  createdAt: "2026-08-01T08:00:00Z",
  currencyCode: "ILS",
  displayFinancialStatus: "PARTIALLY_REFUNDED",
  displayFulfillmentStatus: "PARTIALLY_FULFILLED",
  cancelledAt: null,
  cancelReason: null,
  note: "Leave with neighbour",
  tags: ["vip", "beta"],
  email: "dana@example.com",
  phone: "+972545680665",
  totalPriceSet: { shopMoney: { amount: "749.95" } },
  subtotalPriceSet: { shopMoney: { amount: "700.00" } },
  totalTaxSet: { shopMoney: { amount: "49.95" } },
  totalDiscountsSet: { shopMoney: { amount: "0.00" } },
  totalOutstandingSet: { shopMoney: { amount: "0.00" } },
  customer: {
    legacyResourceId: "8123",
    firstName: "Dana",
    lastName: "Levi",
    defaultEmailAddress: { emailAddress: "dana@example.com" },
    defaultPhoneNumber: { phoneNumber: "+972545680665" },
  },
  shippingAddress: { name: "Dana Levi", address1: "Herzl 1", city: "Tel Aviv", country: "Israel", zip: "6120101" },
  billingAddress: null,
  lineItems: {
    nodes: [
      {
        id: "gid://shopify/LineItem/31",
        title: "The Collection Snowboard",
        variantTitle: "159cm",
        sku: "SNOW-159",
        quantity: 2,
        unfulfilledQuantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: "349.97" } },
        totalDiscountSet: { shopMoney: { amount: "0.00" } },
        product: { legacyResourceId: "111" },
        variant: { legacyResourceId: "44444" },
      },
    ],
  },
  fulfillments: [
    {
      legacyResourceId: "77",
      status: "SUCCESS",
      displayStatus: "IN_TRANSIT",
      createdAt: "2026-08-02T08:00:00Z",
      trackingInfo: [{ company: "Israel Post", number: "RR123", url: "https://track.example.com/RR123" }],
    },
  ],
  refunds: [
    { legacyResourceId: "901", createdAt: "2026-08-03T08:00:00Z", note: null, totalRefundedSet: { shopMoney: { amount: "349.97" } } },
  ],
  discountApplications: {
    nodes: [{ code: "WELCOME10", value: { percentage: 10 } }],
  },
};

describe("order mapping", () => {
  it("produces the REST field names the whole support surface reads", () => {
    const o = mapOrder(node);
    expect(o.id).toBe(5001);
    expect(o.name).toBe("#1006");
    expect(o.order_number).toBe(1006);
    expect(o.currency).toBe("ILS");
    expect(o.total_price).toBe("749.95");
    expect(o.total_outstanding).toBe("0.00");
    expect(o.note).toBe("Leave with neighbour");
    expect(o.email).toBe("dana@example.com");
  });

  it("keeps money as decimal strings from the SHOP money, not presentment", () => {
    const o = mapOrder(node);
    expect(o.total_price).toBe("749.95");
    expect(o.subtotal_price).toBe("700.00");
    expect(typeof o.total_tax).toBe("string");
  });

  it("flattens tags back to the comma string callers split", () => {
    expect(mapOrder(node).tags).toBe("vip, beta");
  });

  it("returns numeric ids everywhere an id is used to act", () => {
    const o = mapOrder(node);
    expect(o.id).toBe(5001);
    expect(o.customer.id).toBe(8123);
    // No legacyResourceId exists on LineItem, and the REST refund path needs a
    // number - so this comes from the gid tail.
    expect(o.line_items[0].id).toBe(31);
    expect(o.line_items[0].product_id).toBe(111);
    expect(o.line_items[0].variant_id).toBe(44444);
  });

  it("reports line prices PER UNIT, as REST did", () => {
    // 2 x 349.97 = 699.94. A line total here would double every refund.
    expect(mapOrder(node).line_items[0].price).toBe("349.97");
    expect(mapOrder(node).line_items[0].quantity).toBe(2);
  });

  it("carries what is still unshipped as fulfillable_quantity", () => {
    expect(mapOrder(node).line_items[0].fulfillable_quantity).toBe(1);
  });

  it("flattens tracking off the first tracking entry", () => {
    const f = mapOrder(node).fulfillments[0];
    expect(f).toMatchObject({ id: 77, tracking_number: "RR123", tracking_company: "Israel Post" });
  });

  it("summarises refunds by total instead of re-summing transactions", () => {
    expect(mapOrder(node).refunds[0]).toMatchObject({ id: 901, total: "349.97" });
  });

  it("keeps only discount applications that have a code", () => {
    expect(mapOrder(node).discount_codes).toEqual([{ code: "WELCOME10", amount: null, type: "percentage" }]);
  });

  it("returns null for a missing order rather than an empty shell", () => {
    expect(mapOrder(null)).toBeNull();
  });

  it("survives an order with no customer, address, lines or fulfillments", () => {
    const o = mapOrder({ legacyResourceId: "9", name: "#9" });
    expect(o.customer).toBeNull();
    expect(o.shipping_address).toBeNull();
    expect(o.line_items).toEqual([]);
    expect(o.fulfillments).toEqual([]);
    expect(o.refunds).toEqual([]);
  });
});

describe("status vocabulary", () => {
  it("keeps REST's financial words", () => {
    expect(mapFinancialStatus("PARTIALLY_REFUNDED")).toBe("partially_refunded");
    expect(mapFinancialStatus("REFUNDED")).toBe("refunded");
    expect(mapFinancialStatus("PAID")).toBe("paid");
    expect(mapFinancialStatus(null)).toBeNull();
  });

  it("keeps REST's three fulfillment words", () => {
    expect(mapFulfillmentStatus("FULFILLED")).toBe("fulfilled");
    expect(mapFulfillmentStatus("PARTIALLY_FULFILLED")).toBe("partial");
    expect(mapFulfillmentStatus("RESTOCKED")).toBe("restocked");
  });

  // The states REST never had. Reporting anything but null here would either
  // hide a delayed order from find_delayed_order (which looks for null) or
  // refuse a cancellation that is still possible.
  it("reports every not-yet-shipped state as null, the way REST did", () => {
    for (const state of ["UNFULFILLED", "IN_PROGRESS", "ON_HOLD", "SCHEDULED", "PENDING_FULFILLMENT", "OPEN", "REQUEST_DECLINED", null, undefined]) {
      expect(mapFulfillmentStatus(state)).toBeNull();
    }
  });

  it("an unshipped order still reads as delayed-eligible", () => {
    const o = mapOrder({ ...node, displayFulfillmentStatus: "ON_HOLD", cancelledAt: null });
    expect(o.fulfillment_status == null || o.fulfillment_status === "partial").toBe(true);
  });

  it("a shipped order still blocks a cancel", () => {
    const o = mapOrder({ ...node, displayFulfillmentStatus: "FULFILLED" });
    expect(["fulfilled", "partial"].includes(String(o.fulfillment_status))).toBe(true);
  });
});

describe("search query building", () => {
  it("translates REST's open/closed status into a predicate", () => {
    expect(buildOrderQuery({ limit: 10, status: "open" })).toBe("status:open");
    expect(buildOrderQuery({ limit: 10, status: "closed" })).toBe("status:closed");
  });

  // REST's `any` meant "do not filter"; sending `status:any` would match nothing.
  it("drops the predicate entirely for status=any", () => {
    expect(buildOrderQuery({ limit: 10, status: "any" })).toBe("");
    expect(buildOrderQuery({ limit: 10 })).toBe("");
  });

  it("escapes values that came from a customer", () => {
    expect(buildOrderQuery({ limit: 1, email: 'a"b@example.com' })).toBe('email:"a\\"b@example.com"');
  });

  it("strips the # a customer types in front of an order name", () => {
    expect(buildOrderQuery({ limit: 2, name: "#1006" })).toBe('name:"1006"');
  });

  it("combines every filter REST took as a separate parameter", () => {
    expect(buildOrderQuery({ limit: 5, status: "open", email: "a@b.com", financialStatus: "paid", fulfillmentStatus: "unshipped" }))
      .toBe('status:open AND email:"a@b.com" AND financial_status:"paid" AND fulfillment_status:"unshipped"');
  });
});
