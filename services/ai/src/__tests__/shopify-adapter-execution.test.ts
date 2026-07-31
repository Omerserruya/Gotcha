/**
 * Shopify adapter execution tests - the write paths that move real money or
 * mutate orders. These lock the honesty contract that the Matan Amran audit
 * demanded:
 *
 *   - success is verified against re-fetched Shopify state, never inferred
 *     from a transport 200;
 *   - retries are idempotent (already-cancelled / already-refunded / existing
 *     coupon code short-circuit instead of double-executing);
 *   - partial refunds respect the gateway's refundable maximum;
 *   - GraphQL errors and unknown tools fail loudly, not silently.
 *
 * All Shopify HTTP is stubbed via global fetch - no network, no DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  // The adapter only calls assertPublicUrl (SSRF guard). integration-framework
  // (pulled in via registerAdapter) references prisma/encryption at call time
  // only, so inert stubs are enough for module load.
  assertPublicUrl: vi.fn(async () => {}),
  prisma: {},
  encryptCredentials: (v: unknown) => v,
  decryptCredentials: (v: unknown) => v,
}));

import ShopifyAdapter from "../services/connectors/shopify.adapter";

const CTX = { tenantId: "t1", tenantIntegrationId: "ti1" } as any;
const CREDS = { accessToken: "shpat_test" };
const CONFIG = { shopDomain: "test-shop.myshopify.com" };

type Route = { match: (method: string, url: string) => boolean; reply: (method: string, url: string, body: any) => any };

/** Install a fetch stub built from ordered route matchers. Records calls. */
function stubShopify(routes: Route[]) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), body });
    for (const r of routes) {
      if (r.match(method, String(url))) {
        const data = r.reply(method, String(url), body);
        if (data && data.__status && data.__status >= 400) {
          return { ok: false, status: data.__status, text: async () => JSON.stringify(data.body ?? {}), json: async () => data.body ?? {} } as any;
        }
        return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as any;
      }
    }
    return { ok: false, status: 404, text: async () => "{}", json: async () => ({}) } as any;
  });
  return calls;
}

function run(toolName: string, args: Record<string, unknown>) {
  return ShopifyAdapter.execute({ ctx: CTX, toolName, args, credentials: CREDS, config: CONFIG } as any);
}

beforeEach(() => vi.restoreAllMocks());

describe("shopify.cancel_order", () => {
  it("cancels, then VERIFIES cancelled_at before reporting success", async () => {
    const calls = stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/1001\.json$/.test(u), reply: () => ({ order: { id: 1001, name: "#1004", cancelled_at: null, financial_status: "paid" } }) },
      { match: (m, u) => m === "POST" && /\/orders\/1001\/cancel\.json$/.test(u), reply: () => ({ order: { id: 1001, name: "#1004", cancelled_at: "2026-07-20T10:00:00Z", financial_status: "paid" } }) },
    ]);
    const out: any = await run("cancel_order", { order_id: "1001", reason: "customer" });
    expect(out.cancelled_at).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/cancel.json"))).toBe(true);
  });

  it("is idempotent: an already-cancelled order returns already_cancelled and never re-POSTs", async () => {
    const calls = stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/1001\.json$/.test(u), reply: () => ({ order: { id: 1001, name: "#1004", cancelled_at: "2026-07-19T13:00:00Z", financial_status: "refunded" } }) },
    ]);
    const out: any = await run("cancel_order", { order_id: "1001" });
    expect(out.already_cancelled).toBe(true);
    expect(calls.filter((c) => c.method === "POST").length).toBe(0);
  });

  it("FAILS when Shopify 200s the cancel but the order stays uncancelled", async () => {
    let getCount = 0;
    stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/1001\.json$/.test(u), reply: () => { getCount++; return { order: { id: 1001, cancelled_at: null, financial_status: "paid" } }; } },
      { match: (m, u) => m === "POST" && /\/cancel\.json$/.test(u), reply: () => ({ order: { id: 1001, cancelled_at: null } }) },
    ]);
    await expect(run("cancel_order", { order_id: "1001" })).rejects.toThrow(/cancel_not_applied/);
    expect(getCount).toBeGreaterThanOrEqual(2); // resolve + verification re-fetch
  });

  it("fails visibly when the order does not exist", async () => {
    stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\.json/.test(u), reply: () => ({ orders: [] }) },
    ]);
    await expect(run("cancel_order", { order_name: "#9999" })).rejects.toThrow(/order_not_found/);
  });
});

describe("shopify.process_refund", () => {
  const ORDER = {
    id: 2001, name: "#2001", currency: "ILS", cancelled_at: null, financial_status: "paid",
    line_items: [{ id: 31, quantity: 2 }],
  };

  it("full refund: calculate → create → verify, reports processed on gateway success", async () => {
    // Stateful: the order reads "paid" until the refund is created, then the
    // verification re-fetch sees "refunded" - mirrors real Shopify.
    let refundCreated = false;
    const calls = stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/2001\/refunds\.json$/.test(u), reply: () => ({ refunds: [] }) },
      { match: (m, u) => m === "POST" && /\/refunds\/calculate\.json$/.test(u), reply: () => ({ refund: { currency: "ILS", transactions: [{ parent_id: 7, amount: "150.00", gateway: "manual" }], shipping: { amount: "0.00" } } }) },
      { match: (m, u) => m === "POST" && /\/orders\/2001\/refunds\.json$/.test(u), reply: () => { refundCreated = true; return { refund: { id: 555, processed_at: "2026-07-20T10:00:00Z", transactions: [{ id: 9, status: "success", amount: "150.00", gateway: "manual" }] } }; } },
      { match: (m, u) => m === "GET" && /\/orders\/2001\.json$/.test(u), reply: () => ({ order: { ...ORDER, financial_status: refundCreated ? "refunded" : "paid" } }) },
    ]);
    const out: any = await run("process_refund", { order_id: "2001" });
    expect(out.refund_id).toBe(555);
    expect(out.refund_status).toBe("processed");
    expect(out.financial_status).toBe("refunded");
    // calculate ran before create
    const idxCalc = calls.findIndex((c) => c.url.includes("/refunds/calculate.json"));
    const idxCreate = calls.findIndex((c) => c.method === "POST" && /\/orders\/2001\/refunds\.json$/.test(c.url));
    expect(idxCalc).toBeGreaterThanOrEqual(0);
    expect(idxCreate).toBeGreaterThan(idxCalc);
  });

  it("reports pending (NOT processed) when the gateway transaction is still pending", async () => {
    stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/2001\/refunds\.json$/.test(u), reply: () => ({ refunds: [] }) },
      { match: (m, u) => m === "POST" && /\/refunds\/calculate\.json$/.test(u), reply: () => ({ refund: { currency: "ILS", transactions: [{ parent_id: 7, amount: "150.00" }] } }) },
      { match: (m, u) => m === "POST" && /\/orders\/2001\/refunds\.json$/.test(u), reply: () => ({ refund: { id: 556, transactions: [{ id: 9, status: "pending", amount: "150.00" }] } }) },
      { match: (m, u) => m === "GET" && /\/orders\/2001\.json$/.test(u), reply: () => ({ order: ORDER }) },
    ]);
    const out: any = await run("process_refund", { order_id: "2001" });
    expect(out.refund_status).toBe("pending");
  });

  it("partial refund beyond the refundable maximum is rejected BEFORE any money moves", async () => {
    const calls = stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/2001\/refunds\.json$/.test(u), reply: () => ({ refunds: [] }) },
      { match: (m, u) => m === "POST" && /\/refunds\/calculate\.json$/.test(u), reply: () => ({ refund: { currency: "ILS", transactions: [{ parent_id: 7, amount: "100.00" }] } }) },
      { match: (m, u) => m === "GET" && /\/orders\/2001\.json$/.test(u), reply: () => ({ order: ORDER }) },
    ]);
    await expect(run("process_refund", { order_id: "2001", amount: 500 })).rejects.toThrow(/refund_exceeds_refundable/);
    expect(calls.some((c) => c.method === "POST" && /\/orders\/2001\/refunds\.json$/.test(c.url))).toBe(false);
  });

  it("is idempotent: an already fully-refunded order short-circuits without creating another refund", async () => {
    const calls = stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/2001\.json$/.test(u), reply: () => ({ order: { ...ORDER, financial_status: "refunded" } }) },
    ]);
    const out: any = await run("process_refund", { order_id: "2001" });
    expect(out.already_refunded).toBe(true);
    expect(calls.filter((c) => c.method === "POST").length).toBe(0);
  });

  it("re-run after a lost result: prior refunds consume remaining quantities → already_refunded, no double refund", async () => {
    const calls = stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/2001\.json$/.test(u), reply: () => ({ order: { ...ORDER, financial_status: "partially_refunded" } }) },
      { match: (m, u) => m === "GET" && /\/orders\/2001\/refunds\.json$/.test(u), reply: () => ({ refunds: [{ refund_line_items: [{ line_item_id: 31, quantity: 2 }], transactions: [{ kind: "refund", status: "success", amount: "150.00" }] }] }) },
    ]);
    const out: any = await run("process_refund", { order_id: "2001" });
    expect(out.already_refunded).toBe(true);
    expect(calls.filter((c) => c.method === "POST").length).toBe(0);
  });
});

describe("shopify.issue_compensation_coupon", () => {
  it("returns the existing code instead of double-creating on retry", async () => {
    const calls = stubShopify([
      { match: (m, u) => m === "GET" && /\/customers\/search\.json/.test(u), reply: () => ({ customers: [{ id: 42, tags: "" }] }) },
      { match: (m, u) => m === "GET" && /\/discount_codes\/lookup\.json/.test(u), reply: () => ({ discount_code: { code: "GOTCHA-MATAN-1004", price_rule_id: 77 } }) },
    ]);
    const out: any = await run("issue_compensation_coupon", { email: "matanam0012@gmail.com", code: "GOTCHA-MATAN-1004", percentage: 100 });
    expect(out.already_existed).toBe(true);
    expect(out.price_rule_id).toBe(77);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/price_rules"))).toBe(false);
  });
});

describe("failure honesty", () => {
  it("unknown tool name fails loudly, never a silent no-op", async () => {
    stubShopify([]);
    await expect(run("refund_order", { order_id: "1" })).rejects.toThrow(/unknown_shopify_tool/);
  });

  it("GraphQL top-level errors fail the call (get_returns)", async () => {
    stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/3001\.json$/.test(u), reply: () => ({ order: { id: 3001, name: "#3001" } }) },
      { match: (m, u) => m === "POST" && /\/graphql\.json$/.test(u), reply: () => ({ errors: [{ message: "something exploded" }] }) },
    ]);
    await expect(run("get_returns", { order_id: "3001" })).rejects.toThrow(/shopify_graphql_error/);
  });

  it("GraphQL access-denied maps to a re-connect instruction (missing scope surfaces, not silently degrades)", async () => {
    stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/3001\.json$/.test(u), reply: () => ({ order: { id: 3001 } }) },
      { match: (m, u) => m === "POST" && /\/graphql\.json$/.test(u), reply: () => ({ errors: [{ message: "Access denied for returns field. Required access: read_returns" }] }) },
    ]);
    await expect(run("get_returns", { order_id: "3001" })).rejects.toThrow(/access_denied.*read_returns|re-connect/i);
  });

  it("HTTP-level Shopify errors carry the status + body (missing write scope → 403 surfaces)", async () => {
    stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/1001\.json$/.test(u), reply: () => ({ order: { id: 1001, cancelled_at: null } }) },
      { match: (m, u) => m === "POST" && /\/cancel\.json$/.test(u), reply: () => ({ __status: 403, body: { errors: "write_orders scope required" } }) },
    ]);
    await expect(run("cancel_order", { order_id: "1001" })).rejects.toThrow(/shopify_403/);
  });
});
