/**
 * The order's real currency on a refund approval - or nothing.
 *
 * "refund 179" said nothing about 179 of what. The currency now comes from the
 * ORDER at approval creation. The rules pinned here are the ones a careless
 * version breaks: no order -> no field, unreadable -> no field, a model-supplied
 * currency is never overwritten (that would turn 200 USD into 200 ILS), a
 * non-ISO answer is not trusted, a failing lookup never costs the approval,
 * and tools that take no currency get nothing added to what they dispatch.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../services/connectors/integration-framework", () => ({ executeAdapterTool: vi.fn() }));

import { withOrderCurrency, withKnownOrderCurrency, normalizeCurrency } from "../services/approval-currency";

const T = "tenant-A";
const REFUND = { order_name: "#1842", amount: 179, reason: "damaged" };

describe("withOrderCurrency (the bot's HITL path - looks the order up)", () => {
  it("★ adds the order's currency to a refund", async () => {
    const lookup = vi.fn(async () => "ils");
    const out = await withOrderCurrency(T, "shopify.process_refund", REFUND, { lookup });
    expect(out).toEqual({ ...REFUND, currency: "ILS" });
    expect(lookup).toHaveBeenCalledWith(T, { order_name: "#1842" }, undefined);
  });

  it("prefers order_id over order_name as the lookup target", async () => {
    const lookup = vi.fn(async () => "USD");
    await withOrderCurrency(T, "shopify.process_refund", { order_id: 5501, order_name: "#1842", amount: 1 }, { lookup });
    expect(lookup).toHaveBeenCalledWith(T, { order_id: "5501" }, undefined);
  });

  it("★ no order in the params → no field, and no lookup", async () => {
    const lookup = vi.fn(async () => "ILS");
    const out = await withOrderCurrency(T, "shopify.process_refund", { amount: 50 }, { lookup });
    expect(out).toEqual({ amount: 50 });
    expect(out).not.toHaveProperty("currency");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("★ the order cannot be read → no field, never a default", async () => {
    for (const answer of [null, undefined, "", "shekel", "US", 42]) {
      const out = await withOrderCurrency(T, "shopify.process_refund", REFUND, { lookup: async () => answer });
      expect(out).not.toHaveProperty("currency");
    }
  });

  it("★ a lookup that throws costs nothing - the params come back unchanged", async () => {
    const out = await withOrderCurrency(T, "shopify.process_refund", REFUND, {
      lookup: async () => { throw new Error("shopify 503"); },
    });
    expect(out).toEqual(REFUND);
  });

  it("★ a currency already in the params is never overwritten", async () => {
    const lookup = vi.fn(async () => "ILS");
    const out = await withOrderCurrency(T, "shopify.process_refund", { ...REFUND, currency: "USD" }, { lookup });
    expect(out.currency).toBe("USD");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("tools that take no currency get nothing added to what they dispatch", async () => {
    const lookup = vi.fn(async () => "ILS");
    for (const tool of ["shopify.cancel_order", "shopify.create_discount_code", "stripe.refund_payment"]) {
      expect(await withOrderCurrency(T, tool, REFUND, { lookup })).toEqual(REFUND);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not mutate the params it was given", async () => {
    const original = { ...REFUND };
    await withOrderCurrency(T, "shopify.process_refund", original, { lookup: async () => "ILS" });
    expect(original).toEqual(REFUND);
  });
});

describe("withKnownOrderCurrency (the commerce panel - order already resolved)", () => {
  it("uses the resolved order's currency", () => {
    expect(withKnownOrderCurrency("shopify.process_refund", REFUND, "EUR")).toEqual({ ...REFUND, currency: "EUR" });
  });

  it("★ an order without a currency gets NO field - not the policy engine's USD default", () => {
    expect(withKnownOrderCurrency("shopify.process_refund", REFUND, undefined)).not.toHaveProperty("currency");
    expect(withKnownOrderCurrency("shopify.process_refund", REFUND, null)).not.toHaveProperty("currency");
  });

  it("never overwrites, and leaves other tools alone", () => {
    expect(withKnownOrderCurrency("shopify.process_refund", { ...REFUND, currency: "USD" }, "ILS").currency).toBe("USD");
    expect(withKnownOrderCurrency("shopify.cancel_order", REFUND, "ILS")).toEqual(REFUND);
  });
});

describe("normalizeCurrency", () => {
  it("accepts ISO 4217 codes only", () => {
    expect(normalizeCurrency(" ils ")).toBe("ILS");
    expect(normalizeCurrency("USDT")).toBeNull();
    expect(normalizeCurrency("₪")).toBeNull();
    expect(normalizeCurrency(undefined)).toBeNull();
  });
});
