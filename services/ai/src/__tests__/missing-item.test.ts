/**
 * A missing-item complaint is arithmetic, and the bot was answering it with an
 * interrogation.
 *
 * Scenario 25 (2026-08-01): Matan reported a missing item on his own order,
 * from the WhatsApp number stored on that order, and the reply asked him to
 * verify his identity. The turn never read a quantity.
 *
 * These tests cover the two halves of the repair: the comparison itself
 * (ordered vs shipped vs pending vs refunded, against real Shopify payload
 * shapes) and the directive that stops the model asking a question it can
 * answer.
 */
import { describe, it, expect } from "vitest";
import { reconcile } from "../services/connectors/shopify-item-reconciliation";
import {
  detectMissingItemIntent,
  buildMissingItemDirective,
  buildEstablishedIdentityBlock,
  identityIsEstablished,
} from "../services/customer-request-intents.service";

const readable = (orders: any[]) => ({ orders, readable: true });
const unreadable = { orders: [], readable: false, error: "shopify_403: access denied" };

function line(id: number, title: string, quantity: number, extra: Record<string, unknown> = {}) {
  return { id, title, quantity, variant_title: null, sku: null, ...extra };
}

describe("reconciling what was ordered against what arrived", () => {
  it("a single-item order that shipped in full leaves nothing short", () => {
    const order = {
      id: 1, name: "#1011",
      line_items: [line(101, "The Compare at Price Snowboard", 1)],
      fulfillments: [{ id: 9, status: "success", line_items: [{ line_item_id: 101, quantity: 1 }] }],
    };
    const r = reconcile(order, readable([]));
    expect(r.lines[0].shipped).toBe(1);
    expect(r.lines[0].unaccounted).toBe(0);
    expect(r.lines[0].short).toBe(false);
  });

  it("a one-item order is NEVER ambiguous - there is nothing to ask", () => {
    const order = {
      id: 1, name: "#1011",
      line_items: [line(101, "The Minimal Snowboard", 1)],
      fulfillments: [],
    };
    const r = reconcile(order, readable([]));
    expect(r.ambiguous).toBe(false);
    expect(r.unambiguous_item?.title).toBe("The Minimal Snowboard");
    expect(r.model_instruction).toContain("Do NOT ask the customer which item they mean");
  });

  it("two items with only one unfulfilled names that one and does not ask", () => {
    const order = {
      id: 1, name: "#1012",
      line_items: [line(101, "Snowboard", 1), line(102, "Gift Card", 1)],
      fulfillments: [{ id: 9, status: "success", line_items: [{ line_item_id: 102, quantity: 1 }] }],
    };
    const r = reconcile(order, readable([]));
    expect(r.ambiguous).toBe(false);
    expect(r.unambiguous_item?.title).toBe("Snowboard");
  });

  it("quantity 2 with one received is a shortage of exactly one", () => {
    const order = {
      id: 1, name: "#1013",
      line_items: [line(101, "Snowboard", 2)],
      fulfillments: [{ id: 9, status: "success", line_items: [{ line_item_id: 101, quantity: 1 }] }],
    };
    const r = reconcile(order, readable([]));
    expect(r.lines[0].ordered).toBe(2);
    expect(r.lines[0].shipped).toBe(1);
    expect(r.lines[0].unaccounted).toBe(1);
    expect(r.lines[0].short).toBe(true);
  });

  it("a still-pending second shipment explains the shortfall instead of losing it", () => {
    const order = {
      id: 1, name: "#1014",
      line_items: [line(101, "Snowboard", 2)],
      fulfillments: [{ id: 9, status: "success", line_items: [{ line_item_id: 101, quantity: 1 }] }],
    };
    const fo = [{ id: 55, status: "open", line_items: [{ line_item_id: 101, fulfillable_quantity: 1, quantity: 1 }] }];
    const r = reconcile(order, readable(fo));
    expect(r.another_shipment_pending).toBe(true);
    expect(r.lines[0].pending).toBe(1);
    expect(r.lines[0].unaccounted).toBe(0);
    expect(r.model_instruction).toContain("still pending");
  });

  it("counts multiple shipments as a partial delivery, not a loss", () => {
    const order = {
      id: 1, name: "#1015",
      line_items: [line(101, "Snowboard", 1), line(102, "Boots", 1)],
      fulfillments: [
        { id: 9, status: "success", line_items: [{ line_item_id: 101, quantity: 1 }] },
        { id: 10, status: "success", line_items: [{ line_item_id: 102, quantity: 1 }] },
      ],
    };
    const r = reconcile(order, readable([]));
    expect(r.multiple_shipments).toBe(true);
    expect(r.shipments).toHaveLength(2);
  });

  it("a cancelled fulfillment does not count as shipped", () => {
    const order = {
      id: 1, name: "#1016",
      line_items: [line(101, "Snowboard", 1)],
      fulfillments: [{ id: 9, status: "cancelled", line_items: [{ line_item_id: 101, quantity: 1 }] }],
    };
    const r = reconcile(order, readable([]));
    expect(r.lines[0].shipped).toBe(0);
    expect(r.lines[0].cancelled).toBe(1);
    expect(r.lines[0].short).toBe(true);
  });

  it("a refunded unit is money returned, so it is not missing", () => {
    const order = {
      id: 1, name: "#1017",
      line_items: [line(101, "Snowboard", 1)],
      fulfillments: [],
      refunds: [{ id: 7, refund_line_items: [{ line_item_id: 101, quantity: 1 }] }],
    };
    const r = reconcile(order, readable([]));
    expect(r.lines[0].refunded).toBe(1);
    expect(r.lines[0].unaccounted).toBe(0);
  });

  it("two short lines IS ambiguous - that is the only case worth asking about", () => {
    const order = {
      id: 1, name: "#1018",
      line_items: [line(101, "Snowboard", 1), line(102, "Boots", 1)],
      fulfillments: [],
    };
    const r = reconcile(order, readable([]));
    expect(r.ambiguous).toBe(true);
    expect(r.unambiguous_item).toBeNull();
    expect(r.model_instruction).toContain("Ask which item is missing");
  });

  it("an unreadable fulfillment scope is never rendered as 'nothing shipped'", () => {
    const order = { id: 1, name: "#1019", line_items: [line(101, "Snowboard", 1)], fulfillments: [] };
    const r = reconcile(order, unreadable);
    expect(r.fulfillment_visibility).toBe("unreadable");
    expect(r.model_instruction).toContain("cannot confirm");
    expect(r.model_instruction).toContain("Do NOT say nothing shipped");
  });

  it("accepts the older fulfillment payload shape that carries only `id`", () => {
    const order = {
      id: 1, name: "#1020",
      line_items: [line(101, "Snowboard", 1)],
      fulfillments: [{ id: 9, status: "success", line_items: [{ id: 101, quantity: 1 }] }],
    };
    expect(reconcile(order, readable([])).lines[0].shipped).toBe(1);
  });

  it("never reports more shipped than was ordered, whatever the payload says", () => {
    const order = {
      id: 1, name: "#1021",
      line_items: [line(101, "Snowboard", 1)],
      fulfillments: [{ id: 9, status: "success", line_items: [{ line_item_id: 101, quantity: 4 }] }],
    };
    expect(reconcile(order, readable([])).lines[0].shipped).toBe(1);
  });

  it("every ordered unit accounted for still leaves the complaint standing", () => {
    const order = {
      id: 1, name: "#1022",
      line_items: [line(101, "Snowboard", 1)],
      fulfillments: [{ id: 9, status: "success", line_items: [{ line_item_id: 101, quantity: 1 }] }],
    };
    const r = reconcile(order, readable([]));
    expect(r.model_instruction).toContain("take the complaint seriously");
    expect(r.model_instruction).toContain("proceed to the return/support step");
  });
});

describe("detecting a missing-item complaint", () => {
  it("fires on the ways customers actually report a shortfall", () => {
    for (const s of [
      "חסר לי פריט בהזמנה",
      "קיבלתי רק אחד מהשניים",
      "לא הגיע הכל",
      "הגיע רק חלק מההזמנה",
      "an item is missing from my order",
      "I only received one of them",
    ]) {
      expect(detectMissingItemIntent(s), s).toBe(true);
    }
  });

  it("does not fire on an ordinary order-status question", () => {
    expect(detectMissingItemIntent("איפה ההזמנה שלי?")).toBe(false);
    expect(detectMissingItemIntent("where is my package?")).toBe(false);
  });
});

describe("the established-identity block", () => {
  it("treats an authenticated WhatsApp sender as settled", () => {
    expect(identityIsEstablished({ channel: "WHATSAPP", customerExternalId: "972545680665" })).toBe(true);
  });

  it("says nothing at all when the channel proves nothing", () => {
    expect(identityIsEstablished({ channel: "WEBCHAT", customerExternalId: null })).toBe(false);
    expect(buildEstablishedIdentityBlock({ channel: "WEBCHAT", customerExternalId: null })).toBeNull();
  });

  it("keeps verification for the one case it is for - someone else's records", () => {
    const b = buildEstablishedIdentityBlock({ channel: "WHATSAPP", customerExternalId: "972545680665" })!;
    expect(b).toContain("ONLY when the request is about SOMEONE ELSE");
    expect(b).toContain("request_identity_verification");
  });

  it("names the complaint shapes that were wrongly triggering a re-check", () => {
    const b = buildEstablishedIdentityBlock({ channel: "WHATSAPP", customerExternalId: "972545680665" })!;
    expect(b).toContain("A complaint, a missing item, a refund request or an address change is NOT a reason to re-verify");
  });
});

describe("the missing-item directive", () => {
  it("forbids re-verifying an identity the channel already proved", () => {
    const d = buildMissingItemDirective({ hasReconcileTool: true });
    expect(d).toContain("Identity is ALREADY established");
    expect(d).toContain("Do NOT ask them to verify their identity");
  });

  it("names the comparison tool and the branch for each of its answers", () => {
    const d = buildMissingItemDirective({ hasReconcileTool: true });
    expect(d).toContain("reconcile_order_items");
    expect(d).toContain("unambiguous_item");
    expect(d).toContain("ambiguous");
    expect(d).toContain("another_shipment_pending");
    expect(d).toContain("unreadable");
  });

  it("without the tool it must admit it cannot check rather than guess", () => {
    const d = buildMissingItemDirective({ hasReconcileTool: false });
    expect(d).toContain("cannot confirm what is missing");
    expect(d).toContain("Do not guess and do not claim to have checked");
    expect(d).not.toContain("Call reconcile_order_items");
  });

  it("refuses the false team-notification claim in both languages of it", () => {
    const d = buildMissingItemDirective({ hasReconcileTool: true });
    expect(d).toContain("NOT a team notification");
    expect(d).toContain("פתחתי קריאה");
    expect(d).toContain("העברתי לצוות");
  });
});
