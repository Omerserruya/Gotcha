/**
 * The refund payload Shopify actually accepts.
 *
 * restock_type is an ENUM (no_restock / cancel / return / legacy_restock). We
 * were sending the literal "restock", which Shopify rejects with
 * `refund_line_items: ["invalid restock type"]` - so every refund that asked to
 * restock failed in front of an agent, with a raw 422 as the explanation.
 */
import { describe, it, expect } from "vitest";

/** Mirrors the adapter's per-line-item rule, including the location it needs. */
function restockFor(order: any, restock: boolean, lineItemId: unknown, skipped: string[] = []) {
  if (!restock) return { restock_type: "no_restock" as const };
  const li = (order.line_items || []).find((x: any) => String(x.id) === String(lineItemId));
  const fulfillable = Number(li?.fulfillable_quantity ?? 0);
  const byItem = new Map<string, number>();
  let fallback: number | undefined;
  for (const f of order.fulfillments || []) {
    if (!Number.isFinite(Number(f.location_id))) continue;
    if (fallback === undefined) fallback = Number(f.location_id);
    for (const x of f.line_items || []) byItem.set(String(x.id), Number(f.location_id));
  }
  const locationId = byItem.get(String(lineItemId)) ?? fallback;
  if (locationId === undefined) { skipped.push(String(lineItemId)); return { restock_type: "no_restock" as const }; }
  return { restock_type: fulfillable > 0 ? "cancel" : "return", location_id: locationId };
}
const restockTypeFor = (o: any, r: boolean, id: unknown) => restockFor(o, r, id).restock_type;

const VALID = new Set(["no_restock", "cancel", "return", "legacy_restock"]);

const order = {
  line_items: [
    { id: 1, fulfillable_quantity: 0 },  // shipped
    { id: 2, fulfillable_quantity: 3 },  // not yet shipped
  ],
  fulfillments: [{ location_id: 119299375473, line_items: [{ id: 1 }] }],
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
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/services/connectors/shopify.adapter.ts"), "utf8");
    expect(src).not.toMatch(/restock\s*\?\s*"restock"/);
    expect(src).toContain("restockFor");
  });
});

describe("restocking needs somewhere to put the goods", () => {
  it("attaches the location the item shipped from", () => {
    // Without it Shopify refuses: refund_line_items.base "You need to set a
    // location to restock items". refunds/calculate does NOT enforce this,
    // only the create call does - a dry run alone will not catch it.
    expect(restockFor(order, true, 1).location_id).toBe(119299375473);
  });

  it("falls back to another fulfillment's location for an unshipped line", () => {
    expect(restockFor(order, true, 2).location_id).toBe(119299375473);
  });

  it("skips the restock rather than failing the whole refund when no location exists", () => {
    // The money going back is the primary intent. Failing the refund because
    // inventory cannot be placed would be the wrong trade.
    const noLoc = { line_items: [{ id: 1, fulfillable_quantity: 0 }], fulfillments: [] };
    const skipped: string[] = [];
    const r = restockFor(noLoc, true, 1, skipped);
    expect(r.restock_type).toBe("no_restock");
    expect(r.location_id).toBeUndefined();
    // And it is REPORTED, not silent.
    expect(skipped).toEqual(["1"]);
  });

  it("sends no location when restocking was not requested", () => {
    expect(restockFor(order, false, 1).location_id).toBeUndefined();
  });
});
