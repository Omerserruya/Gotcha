/**
 * Shopify adapter: declared-tool ↔ handler parity + write-tool honesty.
 *
 * Background: `update_order_fulfillment` was declared in tools() for months
 * with NO switch case - the model could call it, policy could gate it, a
 * manager could approve it, and it would die on `unknown_shopify_tool`.
 * The parity test makes that class of bug impossible to reintroduce: every
 * name the adapter advertises must reach a real handler (graceful
 * `unsupported_rest` degrades are handlers too - they explain themselves).
 *
 * Also locks the new idempotency/verification semantics of cancel_order,
 * issue_compensation_coupon and process_refund.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@chatcenter/shared", () => ({
  // Durable tenant settings (business hours, auto-greeting, SLA). Exhaustive
  // mocks of this barrel must supply them or the read path throws instead of
  // returning "not configured". Default: nothing configured.
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  assertPublicUrl: vi.fn().mockResolvedValue(undefined),
}));

import ShopifyAdapter from "../services/connectors/shopify.adapter";

const CREDS = { accessToken: "tok" };
const CONFIG = { shopDomain: "test-shop.myshopify.com" };
const CTX = { tenantId: "t1", tenantIntegrationId: "ti1" } as any;

/** A permissive Shopify REST/GraphQL stub: every endpoint returns a
 * plausibly-shaped object so handlers run to completion (or fail on their
 * own validation - never on routing). */
function stubShopify(overrides: Record<string, (url: string, init: any) => any> = {}) {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const order = {
    id: 11, name: "#1001", cancelled_at: null, financial_status: "paid",
    fulfillment_status: null, currency: "ILS", total_price: "100.00",
    line_items: [{ id: 21, quantity: 2, title: "Widget" }],
    fulfillments: [], note: "", tags: "", email: "c@x.com",
  };
  const fn = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: u, method, body });
    for (const [match, handler] of Object.entries(overrides)) {
      if (u.includes(match)) {
        const out = handler(u, init);
        return { ok: out?.__status ? out.__status < 400 : true, status: out?.__status ?? 200, json: async () => out, text: async () => JSON.stringify(out) } as any;
      }
    }
    const payload: any = {
      customer: { id: 31, first_name: "M", last_name: "A", email: "c@x.com", tags: "", note: "", orders_count: 1, total_spent: "10" },
      customers: [{ id: 31, first_name: "M", email: "c@x.com", tags: "" }],
      orders: [order], order,
      refunds: [],
      refund: {
        id: 91, processed_at: "2026-07-20T00:00:00Z", currency: "ILS",
        transactions: [{ id: 71, parent_id: 61, amount: "100.00", kind: "suggested_refund", gateway: "manual", status: "success" }],
        shipping: { amount: "0.00" },
      },
      price_rule: { id: 51, value: "-10.0", value_type: "percentage" },
      price_rules: [],
      discount_code: { code: "C1", price_rule_id: 51, usage_count: 0 },
      metafields: [], addresses: [],
      products: [{ id: 41, title: "Widget", variants: [] }],
      product: { id: 41, title: "Widget", variants: [] },
      variants: [], variant: { id: 55, price: "10", inventory_quantity: 3 },
      fulfillments: [], events: [],
      order_invoice: { to: "c@x.com" },
      data: { order: { id: "gid://shopify/Order/11", name: "#1001", returns: { nodes: [] } } },
    };
    return { ok: true, status: 200, json: async () => payload, text: async () => "{}" } as any;
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

function run(toolName: string, args: Record<string, unknown>) {
  return ShopifyAdapter.execute({ ctx: CTX, toolName, args, credentials: CREDS, config: CONFIG } as any);
}

afterEach(() => vi.unstubAllGlobals());

describe("declared-tool ↔ handler parity", () => {
  const GENERIC_ARGS: Record<string, unknown> = {
    customer_id: "31", order_id: "11", order_name: "#1001", code: "C1", percentage: 10,
    query: "x", email: "c@x.com", phone: "+972500000000", note: "n", tag: "t",
    variant_id: "55", product_id: "41", name: "#1001", key: "k", value: "v",
    segment: "vip", title: "Widget", handle: "widget", first_name: "M",
  };

  it.each(ShopifyAdapter.tools().map((t) => t.name))(
    "%s has a real handler (never unknown_shopify_tool)",
    async (fullName) => {
      stubShopify();
      const toolName = fullName.slice("shopify.".length);
      try {
        await run(toolName, GENERIC_ARGS);
      } catch (err: any) {
        expect(err?.message ?? "").not.toContain("unknown_shopify_tool");
      }
    },
  );
});

describe("cancel_order", () => {
  it("short-circuits idempotently when the order is already cancelled - no cancel POST", async () => {
    const { calls } = stubShopify({
      "/orders/11.json": () => ({ order: { id: 11, name: "#1001", cancelled_at: "2026-07-19T00:00:00Z", financial_status: "refunded" } }),
    });
    const out: any = await run("cancel_order", { order_id: "11" });
    expect(out.already_cancelled).toBe(true);
    expect(calls.some((c) => c.url.includes("/cancel.json"))).toBe(false);
  });

  it("fails when the mutation is accepted but the order stays uncancelled", async () => {
    stubShopify({
      "/graphql.json": () => ({ data: { orderCancel: { job: { id: "j1", done: false }, orderCancelUserErrors: [] } } }),
      "/orders/11.json": () => ({ order: { id: 11, cancelled_at: null } }),
    });
    await expect(run("cancel_order", { order_id: "11" })).rejects.toThrow(/cancel_not_applied/);
  });

  it("refund:true is carried BY the mutation - never a second refund call", async () => {
    // The REST cancel silently ignored the boolean, so the adapter used to fire
    // an explicit refund afterwards. `orderCancel` honours it, and leaving that
    // second call in place would refund an order Shopify had already refunded.
    let cancelled = false;
    const { calls } = stubShopify({
      "/graphql.json": (_u, init) => {
        if (String(init?.body ?? "").includes("orderCancel")) cancelled = true;
        return { data: { orderCancel: { job: { id: "j1", done: true }, orderCancelUserErrors: [] } } };
      },
      "/orders/11.json": () => ({
        order: {
          id: 11, name: "#1001",
          cancelled_at: cancelled ? "2026-07-20T00:00:00Z" : null,
          financial_status: cancelled ? "refunded" : "paid",
        },
      }),
    });
    const out: any = await run("cancel_order", { order_id: "11", refund: true, reason: "customer" });
    expect(out.cancelled_at).toBeTruthy();
    expect(out.refund_status).toBe("refunded");
    expect(out.refund_verified).toBe(true);
    // No second money movement.
    expect(calls.some((c) => c.url.includes("/refunds.json") && c.method === "POST")).toBe(false);
    expect(calls.some((c) => c.url.includes("/refunds/calculate.json"))).toBe(false);
  });

  it("a cancel whose refund did not land is reported as not_refunded, never as refunded", async () => {
    let cancelled = false;
    stubShopify({
      "/graphql.json": (_u, init) => {
        if (String(init?.body ?? "").includes("orderCancel")) cancelled = true;
        return { data: { orderCancel: { job: { id: "j1", done: true }, orderCancelUserErrors: [] } } };
      },
      // Cancelled, but the money never moved.
      "/orders/11.json": () => ({
        order: { id: 11, name: "#1001", cancelled_at: cancelled ? "2026-07-20T00:00:00Z" : null, financial_status: "paid" },
      }),
    });
    const out: any = await run("cancel_order", { order_id: "11", refund: true });
    expect(out.cancelled_at).toBeTruthy();
    expect(out.refund_status).toBe("not_refunded");
    expect(out.refund_verified).toBe(false);
  });

  it("surfaces Shopify's structured refusal, not a bare status code", async () => {
    stubShopify({
      "/graphql.json": () => ({ data: { orderCancel: { job: null, orderCancelUserErrors: [{ message: "Cannot cancel an order that has outstanding fulfillments", code: "INVALID" }] } } }),
    });
    await expect(run("cancel_order", { order_id: "11" })).rejects.toThrow(/outstanding fulfillments/);
  });
});

describe("amount-only partial refund", () => {
  /**
   * Live failure: every partial refund on a fully paid, unrefunded order died
   * with "requested 200 USD but only 0.00 USD is refundable".
   *
   * An amount-only refund names no line items, so the calculate call was sent
   * `{currency}` and nothing else - asking Shopify to price a refund of
   * NOTHING. It answered 0.00, and 0.00 became the ceiling.
   */
  it("prices the ceiling against what the ORDER can still bear", async () => {
    const { calls } = stubShopify();
    const out: any = await run("process_refund", { order_id: "11", amount: 50 });
    expect(out.refund_id).toBe(91);
    const calc = calls.find((c) => c.url.includes("/refunds/calculate.json"))!;
    // The ceiling call must describe something refundable, not an empty refund.
    expect(calc.body.refund.refund_line_items?.length).toBeGreaterThan(0);
    expect(calc.body.refund.shipping).toBeTruthy();
    // Nothing is physically coming back on an arbitrary amount refund.
    expect(calc.body.refund.refund_line_items[0].restock_type).toBe("no_restock");
  });

  it("creates the refund as amount-only, not tied to line items", async () => {
    const { calls } = stubShopify();
    await run("process_refund", { order_id: "11", amount: 50 });
    const create = calls.find((c) => c.url.includes("/refunds.json") && c.method === "POST" && !c.url.includes("calculate"))!;
    expect(create.body.refund.transactions[0].amount).toBe("50.00");
    expect(create.body.refund.refund_line_items).toBeUndefined();
  });

  it("still refuses an amount above the real ceiling", async () => {
    stubShopify();
    await expect(run("process_refund", { order_id: "11", amount: 99999 })).rejects.toThrow(/refund_exceeds_refundable/);
  });

  it("rejects zero, negative and non-numeric amounts", async () => {
    stubShopify();
    for (const amount of [0, -5, "abc"]) {
      await expect(run("process_refund", { order_id: "11", amount })).rejects.toThrow(/refund_amount_invalid/);
    }
  });

  it("accepts a decimal amount exactly", async () => {
    const { calls } = stubShopify();
    await run("process_refund", { order_id: "11", amount: 12.34 });
    const create = calls.find((c) => c.url.includes("/refunds.json") && c.method === "POST" && !c.url.includes("calculate"))!;
    expect(create.body.refund.transactions[0].amount).toBe("12.34");
  });

  it("refuses a currency that is not the order's", async () => {
    stubShopify();
    // Not a unit conversion - a different amount of money.
    await expect(run("process_refund", { order_id: "11", amount: 50, currency: "USD" }))
      .rejects.toThrow(/refund_currency_mismatch/);
  });
});

describe("process_refund", () => {
  it("full refund: calculates, creates, verifies, and reports gateway status", async () => {
    const { calls } = stubShopify();
    const out: any = await run("process_refund", { order_id: "11" });
    expect(out.refund_id).toBe(91);
    expect(out.refund_status).toBe("processed");
    expect(calls.some((c) => c.url.includes("/refunds/calculate.json"))).toBe(true);
    const create = calls.find((c) => c.url.includes("/refunds.json") && c.method === "POST" && !c.url.includes("calculate"))!;
    expect(create.body.refund.transactions[0]).toMatchObject({ kind: "refund", parent_id: 61 });
    // full refund includes the remaining line items
    expect(create.body.refund.refund_line_items[0]).toMatchObject({ line_item_id: 21, quantity: 2 });
  });

  it("rejects a partial amount above the refundable maximum", async () => {
    stubShopify();
    await expect(run("process_refund", { order_id: "11", amount: 250 })).rejects.toThrow(/refund_exceeds_refundable/);
  });

  it("partial amount rides on the calculated parent transaction", async () => {
    const { calls } = stubShopify();
    const out: any = await run("process_refund", { order_id: "11", amount: 40 });
    expect(out.amount).toBe(100); // reported from the stub's created refund
    const create = calls.find((c) => c.url.includes("/refunds.json") && c.method === "POST" && !c.url.includes("calculate"))!;
    expect(create.body.refund.transactions).toHaveLength(1);
    expect(create.body.refund.transactions[0].amount).toBe("40.00");
  });

  it("is idempotent for an already fully-refunded order", async () => {
    stubShopify({
      "/orders/11.json": () => ({ order: { id: 11, name: "#1001", cancelled_at: null, financial_status: "refunded" } }),
    });
    const out: any = await run("process_refund", { order_id: "11" });
    expect(out.already_refunded).toBe(true);
  });

  it("reports pending (not processed) when the gateway hasn't settled", async () => {
    stubShopify({
      "/refunds.json": (u: string) => u.includes("calculate")
        ? { refund: { transactions: [{ parent_id: 61, amount: "100.00", kind: "suggested_refund", gateway: "manual" }], currency: "ILS", shipping: { amount: "0.00" } } }
        : { refund: { id: 92, processed_at: null, transactions: [{ id: 72, parent_id: 61, amount: "100.00", status: "pending", gateway: "manual" }] } },
    });
    const out: any = await run("process_refund", { order_id: "11" });
    expect(out.refund_status).toBe("pending");
  });
});

describe("issue_compensation_coupon", () => {
  it("returns the existing code instead of failing on a duplicate", async () => {
    const { calls } = stubShopify({
      "/discount_codes/lookup.json": () => ({ discount_code: { code: "GOTCHA-1", price_rule_id: 51 } }),
    });
    const out: any = await run("issue_compensation_coupon", { code: "GOTCHA-1", percentage: 100, phone: "+972500000000" });
    expect(out.already_existed).toBe(true);
    expect(calls.some((c) => c.url.includes("/price_rules.json") && c.method === "POST")).toBe(false);
  });
});

describe("update_order_fulfillment (previously a dead tool)", () => {
  it("appends the note and tag on the order", async () => {
    const { calls } = stubShopify();
    const out: any = await run("update_order_fulfillment", { order_id: "11", note: "call customer", tag: "ops" });
    expect(out.order_id).toBe(11);
    const put = calls.find((c) => c.method === "PUT" && c.url.includes("/orders/11.json"))!;
    expect(put.body.order.note).toContain("call customer");
    expect(put.body.order.tags).toContain("ops");
  });
});
