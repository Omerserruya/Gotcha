/**
 * The refund payload Shopify actually accepts.
 *
 * restock_type is an ENUM (no_restock / cancel / return / legacy_restock). We
 * were sending the literal "restock", which Shopify rejects with
 * `refund_line_items: ["invalid restock type"]` - so every refund that asked to
 * restock failed in front of an agent, with a raw 422 as the explanation.
 */
import { describe, it, expect } from "vitest";

/** Mirrors the adapter's per-line-item rule. */
function restockTypeFor(order: any, restock: boolean, lineItemId: unknown): string {
  if (!restock) return "no_restock";
  const li = (order.line_items || []).find((x: any) => String(x.id) === String(lineItemId));
  const fulfillable = Number(li?.fulfillable_quantity ?? 0);
  return fulfillable > 0 ? "cancel" : "return";
}

const VALID = new Set(["no_restock", "cancel", "return", "legacy_restock"]);

const order = {
  line_items: [
    { id: 1, fulfillable_quantity: 0 },  // shipped
    { id: 2, fulfillable_quantity: 3 },  // not yet shipped
  ],
};

describe("restock_type", () => {
  it("never emits the invalid value that broke live refunds", () => {
    for (const id of [1, 2]) {
      for (const restock of [true, false]) {
        const v = restockTypeFor(order, restock, id);
        expect(v).not.toBe("restock");
        expect(VALID.has(v)).toBe(true);
      }
    }
  });

  it("returns a FULFILLED item and cancels an unfulfilled one", () => {
    // Not cosmetic: it decides whether Shopify counts the unit as
    // never-shipped or as physically returned.
    expect(restockTypeFor(order, true, 1)).toBe("return");
    expect(restockTypeFor(order, true, 2)).toBe("cancel");
  });

  it("does not restock when the agent did not ask to", () => {
    expect(restockTypeFor(order, false, 1)).toBe("no_restock");
    expect(restockTypeFor(order, false, 2)).toBe("no_restock");
  });

  it("falls back to a valid value for an unknown line item", () => {
    expect(VALID.has(restockTypeFor(order, true, 999))).toBe(true);
  });
});

describe("the adapter source no longer contains the invalid literal", () => {
  it('never assigns restock_type = "restock"', async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../services/connectors/shopify.adapter.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/restock\s*\?\s*"restock"/);
    expect(src).toContain("restockTypeFor");
  });
});
