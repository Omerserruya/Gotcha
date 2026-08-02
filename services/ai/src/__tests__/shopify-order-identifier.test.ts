import { describe, it, expect } from "vitest";
import {
  classifyOrderIdentifier,
  orderIdentifierFromArgs,
  orderIdentifierKey,
} from "../services/connectors/shopify-order-identifier";

/**
 * The defect that broke Matan Amran's conversation.
 *
 * He gave "#1006" - an order NAME. `update_order_fulfillment` was the only
 * Shopify order tool that hand-rolled its parameters, exposing `order_id` and
 * requiring it, with no `order_name`. The model had nowhere else to put the
 * value, so it sent "#1006" as an id and the adapter issued
 * `GET /orders/%231006.json` → `400 id: expected String to be a id`. Stripping
 * the "#" gave `GET /orders/1006.json` → `404`, because the internal id for
 * that order is a 13-digit number.
 *
 * Four failed writes, twenty minutes of stalling, an escalation, and a customer
 * asking to cancel the order - from a value in the wrong namespace.
 */

describe("identifying what the customer actually gave us", () => {
  it("treats a hash-prefixed value as an order name", () => {
    // The literal input from the real conversation.
    expect(classifyOrderIdentifier("#1006")).toMatchObject({ kind: "order_name", name: "1006" });
  });

  it("treats a long numeric as a Shopify internal id", () => {
    expect(classifyOrderIdentifier("5678901234567")).toMatchObject({
      kind: "internal_id",
      id: "5678901234567",
    });
  });

  it("unwraps a Shopify GID", () => {
    expect(classifyOrderIdentifier("gid://shopify/Order/5678901234567")).toMatchObject({
      kind: "internal_id",
      id: "5678901234567",
    });
    // Case-insensitive, because GIDs get copied around by hand.
    expect(classifyOrderIdentifier("GID://Shopify/Order/42424242424")).toMatchObject({
      kind: "internal_id",
      id: "42424242424",
    });
  });

  it("does NOT assume a short numeric is an internal id", () => {
    // The explicit requirement. "1006" is far more likely to be the number a
    // customer read off their confirmation email than a Shopify id, but old
    // stores can have short ids, so both remain reachable.
    const r = classifyOrderIdentifier("1006");
    expect(r.kind).toBe("ambiguous");
    expect(r.name).toBe("1006");
    expect(r.id).toBe("1006");
  });

  it("tolerates whitespace around the value", () => {
    expect(classifyOrderIdentifier("  #1006  ")).toMatchObject({ kind: "order_name", name: "1006" });
    expect(classifyOrderIdentifier("\t1006\n")).toMatchObject({ kind: "ambiguous", name: "1006" });
  });

  it("accepts a store-prefixed order name", () => {
    expect(classifyOrderIdentifier("URB-1006")).toMatchObject({ kind: "order_name", name: "URB-1006" });
    expect(classifyOrderIdentifier("EN1006")).toMatchObject({ kind: "order_name", name: "EN1006" });
  });

  it("reports a missing identifier as missing, not malformed", () => {
    // These are different failures: one means "you forgot an argument", the
    // other means "that argument cannot be an order". They get different
    // errors so a caller can tell them apart.
    for (const v of [undefined, null, "", "   "]) {
      expect(classifyOrderIdentifier(v).kind, `for ${JSON.stringify(v)}`).toBe("missing");
    }
  });

  it("reports a malformed identifier as malformed", () => {
    for (const v of ["#", "???", "order name", "!!", "-"]) {
      expect(classifyOrderIdentifier(v).kind, `for ${JSON.stringify(v)}`).toBe("malformed");
    }
  });
});

describe("choosing between the two arguments", () => {
  it("uses order_name when only it is present", () => {
    expect(orderIdentifierFromArgs({ order_name: "#1006" })).toMatchObject({
      kind: "order_name", name: "1006",
    });
  });

  it("uses order_id when only it is present", () => {
    expect(orderIdentifierFromArgs({ order_id: "5678901234567" })).toMatchObject({
      kind: "internal_id", id: "5678901234567",
    });
  });

  it("RESCUES an order name that arrived in the order_id field", () => {
    // Exactly what the model did four times. The value is now understood for
    // what it is rather than being forced down the id path.
    expect(orderIdentifierFromArgs({ order_id: "#1006" })).toMatchObject({
      kind: "order_name", name: "1006",
    });
  });

  it("trusts order_name over order_id when the two disagree", () => {
    // The name is what the customer said out loud. If the model also guessed
    // an id and the two point at different orders, acting on the customer's
    // own reference is the safer of the two.
    expect(orderIdentifierFromArgs({ order_name: "#1006", order_id: "9999999999999" }))
      .toMatchObject({ kind: "order_name", name: "1006" });
  });

  it("treats bare digits in order_name as a name, not an ambiguity", () => {
    // The field itself is the signal here: the caller said "this is a name".
    expect(orderIdentifierFromArgs({ order_name: "1006" })).toMatchObject({
      kind: "order_name", name: "1006",
    });
  });

  it("reports missing when neither argument is supplied", () => {
    expect(orderIdentifierFromArgs({}).kind).toBe("missing");
    expect(orderIdentifierFromArgs({ note: "hello" } as any).kind).toBe("missing");
  });
});

describe("the repeat-call key", () => {
  it("collapses cosmetic variations of the same order to one key", () => {
    // The loop guard depends on this: the model retried with "#1006" and then
    // "1006", which must count as the same order rather than a new attempt.
    const a = orderIdentifierKey(orderIdentifierFromArgs({ order_id: "#1006" }));
    const b = orderIdentifierKey(orderIdentifierFromArgs({ order_name: "1006" }));
    const c = orderIdentifierKey(orderIdentifierFromArgs({ order_name: " #1006 " }));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("keeps genuinely different orders apart", () => {
    const a = orderIdentifierKey(orderIdentifierFromArgs({ order_name: "#1006" }));
    const b = orderIdentifierKey(orderIdentifierFromArgs({ order_name: "#1007" }));
    expect(a).not.toBe(b);
  });
});
