/**
 * An approval is a person's attention. Don't spend it on a no-op.
 *
 * Live failure: Matan asked "תבטלו לי בבקשה את הזמנה 1007" for an order that
 * had been cancelled minutes earlier. The bot answered "רגע אחד, מטפלת עכשיו
 * בביטול ההזמנה 1007" - one moment, I'm handling the cancellation now - and
 * raised a PENDING approval. Nothing about that was true: there was no
 * cancellation to handle, and a human was about to be asked to authorise a
 * change that could not occur.
 *
 * The adapter already reconciled state at EXECUTION time, which is after the
 * approval has been granted. These lock the check at PROPOSE time, and lock
 * the distinction the customer actually cares about: "this already happened"
 * is not the same answer as "this cannot happen".
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (l?: string) => l || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  assertPublicUrl: vi.fn(async () => {}),
  prisma: {},
  encryptCredentials: (v: unknown) => v,
  decryptCredentials: (v: unknown) => v,
}));

import ShopifyAdapter from "../services/connectors/shopify.adapter";

/**
 * Run the precheck against a stubbed `get_order` + `get_fulfillment_status`.
 *
 * `fulfillment` defaults to a readable, empty fulfillment state - i.e. nothing
 * is being fulfilled - which is the only case where cancelling is allowed.
 */
function precheck(
  toolName: string,
  args: Record<string, unknown>,
  order: any,
  fulfillment: any = { fulfillment_orders_readable: true, has_outstanding_fulfillments: false },
) {
  return (ShopifyAdapter as any).precheckEligibility({
    toolName,
    args,
    call: async (t: string) => {
      if (t === "get_order") return order;
      if (t === "get_fulfillment_status") return fulfillment;
      throw new Error(`unexpected precheck read: ${t}`);
    },
  });
}

const OPEN_ORDER = {
  id: 11, name: "#1009", cancelled_at: null,
  financial_status: "paid", fulfillment_status: null, fulfillments: [],
};

describe("cancel_order eligibility", () => {
  it("refuses an already-cancelled order and says it ALREADY happened", async () => {
    const r = await precheck("cancel_order", { order_name: "#1007" }, { ...OPEN_ORDER, name: "#1007", cancelled_at: "2026-07-31T12:02:00Z" });
    expect(r.eligible).toBe(false);
    expect(r.alreadySatisfied).toBe(true);
    expect(r.reason).toMatch(/already cancelled/i);
  });

  it("refuses a fulfilled order and names the action that works", async () => {
    const r = await precheck("cancel_order", { order_name: "#1006" }, { ...OPEN_ORDER, fulfillment_status: "fulfilled", fulfillments: [{ id: 1 }] });
    expect(r.eligible).toBe(false);
    // NOT alreadySatisfied - this never happened and never will.
    expect(r.alreadySatisfied).toBeUndefined();
    expect(r.reason).toMatch(/return|refund/i);
  });

  it("detects fulfillment from the fulfillments array alone", async () => {
    const r = await precheck("cancel_order", { order_name: "#1006" }, { ...OPEN_ORDER, fulfillment_status: null, fulfillments: [{ id: 1 }] });
    expect(r.eligible).toBe(false);
  });

  // The live #1006 shape: the ORDER looks completely unfulfilled and only the
  // fulfillment ORDER reveals that Shopify will refuse the cancellation.
  it("refuses when only the fulfillment ORDER shows work in progress", async () => {
    const r = await precheck(
      "cancel_order",
      { order_name: "#1006" },
      { ...OPEN_ORDER, fulfillment_status: null, fulfillments: [] },
      { fulfillment_orders_readable: true, has_outstanding_fulfillments: true },
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/return|refund/i);
  });

  it("refuses - and says it cannot SEE - when fulfillment state is unreadable", async () => {
    // A missing scope must never be read as "nothing is being fulfilled".
    // Inferring cancellable from silence spends a human's approval on an
    // action Shopify will refuse.
    const r = await precheck(
      "cancel_order",
      { order_name: "#1006" },
      { ...OPEN_ORDER, fulfillment_status: null, fulfillments: [] },
      { fulfillment_orders_readable: false, has_outstanding_fulfillments: null },
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/cannot read|unknown|do not currently have access/i);
    // Not "already done" - nothing happened.
    expect(r.alreadySatisfied).toBeUndefined();
  });

  it("allows an ordinary open order - the guard must not make cancelling unreachable", async () => {
    expect((await precheck("cancel_order", { order_name: "#1009" }, OPEN_ORDER)).eligible).toBe(true);
  });
});

describe("process_refund eligibility", () => {
  it("refuses a fully refunded order as ALREADY done", async () => {
    const r = await precheck("process_refund", { order_name: "#1009" }, { ...OPEN_ORDER, financial_status: "refunded" });
    expect(r.eligible).toBe(false);
    expect(r.alreadySatisfied).toBe(true);
  });

  it("allows a partially refunded order - money may still be owed", async () => {
    const r = await precheck("process_refund", { order_name: "#1009" }, { ...OPEN_ORDER, financial_status: "partially_refunded" });
    expect(r.eligible).toBe(true);
  });
});

describe("scope of the check", () => {
  it("ignores tools it knows nothing about", async () => {
    const r = await (ShopifyAdapter as any).precheckEligibility({
      toolName: "add_tag",
      args: { tag: "vip" },
      call: async () => { throw new Error("must not read for an unrelated tool"); },
    });
    expect(r.eligible).toBe(true);
  });

  it("does not read when no order was named - resolution is the executor's job", async () => {
    const r = await (ShopifyAdapter as any).precheckEligibility({
      toolName: "cancel_order",
      args: {},
      call: async () => { throw new Error("must not read without a target"); },
    });
    expect(r.eligible).toBe(true);
  });
});
