import { describe, it, expect } from "vitest";
import { mapDiscount } from "../services/connectors/shopify-gql-discounts";

/**
 * Discounts, where REST and GraphQL genuinely describe different objects.
 *
 * REST had a price rule with a code attached; GraphQL has one discount node.
 * The translation that can actually mislead a customer is the VALUE: GraphQL
 * says `percentage: 0.1` for a 10% coupon, REST said `"-10.0"`, and passing the
 * fraction through would tell someone their coupon is worth a tenth of a
 * percent.
 */

const basic = {
  title: "Bot GOTCHA-1",
  status: "ACTIVE",
  startsAt: "2026-08-01T00:00:00Z",
  endsAt: "2026-09-01T00:00:00Z",
  usageLimit: 1,
  asyncUsageCount: 0,
  codes: { nodes: [{ code: "GOTCHA-1" }] },
  context: { __typename: "DiscountCustomerAll" },
  customerGets: { value: { percentage: 0.1 } },
};

const NODE_ID = "gid://shopify/DiscountCodeNode/51";

describe("discount mapping", () => {
  it("carries the code, the dates and the usage the tools report", () => {
    const d = mapDiscount(NODE_ID, basic)!;
    expect(d.code).toBe("GOTCHA-1");
    expect(d.title).toBe("Bot GOTCHA-1");
    expect(d.starts_at).toBe("2026-08-01T00:00:00Z");
    expect(d.ends_at).toBe("2026-09-01T00:00:00Z");
    expect(d.usage_limit).toBe(1);
    expect(d.usage_count).toBe(0);
    expect(d.status).toBe("active");
  });

  // The one that would misprice a coupon in a customer's face.
  it("turns GraphQL's fraction back into REST's signed percentage", () => {
    expect(mapDiscount(NODE_ID, basic)).toMatchObject({ value: "-10", value_type: "percentage" });
    expect(mapDiscount(NODE_ID, { ...basic, customerGets: { value: { percentage: 0.5 } } }))
      .toMatchObject({ value: "-50", value_type: "percentage" });
  });

  it("reports a fixed-amount discount as REST's fixed_amount", () => {
    expect(mapDiscount(NODE_ID, { ...basic, customerGets: { value: { amount: { amount: "25.00" } } } }))
      .toMatchObject({ value: "-25", value_type: "fixed_amount" });
  });

  it("keeps the numeric id under the name the tools pass back", () => {
    const d = mapDiscount(NODE_ID, basic)!;
    expect(d.price_rule_id).toBe(51);
    expect(d.id).toBe(51);
  });

  it("reads an open discount as customer_selection: all", () => {
    const d = mapDiscount(NODE_ID, basic)!;
    expect(d.customer_selection).toBe("all");
    expect(d.prerequisite_customer_ids).toEqual([]);
  });

  // `get_customer_discounts` filters on exactly these two fields.
  it("reads a customer-restricted discount as prerequisite, with numeric ids", () => {
    const d = mapDiscount(NODE_ID, {
      ...basic,
      context: { __typename: "DiscountCustomers", customers: [{ legacyResourceId: "31" }, { legacyResourceId: "42" }] },
    })!;
    expect(d.customer_selection).toBe("prerequisite");
    expect(d.prerequisite_customer_ids).toEqual([31, 42]);
  });

  it("returns null for a discount that is not there", () => {
    expect(mapDiscount(NODE_ID, null)).toBeNull();
  });

  // An automatic discount has no code; the tools here are all about codes.
  it("reports no code for a discount that has none, so it can be filtered out", () => {
    expect(mapDiscount(NODE_ID, { ...basic, codes: { nodes: [] } })!.code).toBeNull();
  });

  it("survives a discount with no value, dates or usage recorded", () => {
    const d = mapDiscount(NODE_ID, { title: "Bare" })!;
    expect(d.value).toBeNull();
    expect(d.value_type).toBeNull();
    expect(d.ends_at).toBeNull();
    expect(d.usage_count).toBe(0);
  });

  // The status Shopify itself reports, which REST's date arithmetic could not
  // see: a deactivated code is not active however its dates read.
  it("surfaces a deactivated code as expired", () => {
    expect(mapDiscount(NODE_ID, { ...basic, status: "EXPIRED" })!.status).toBe("expired");
  });
});
