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
import {
  orderNode,
  suggestedRefundNode,
  refundNode,
  orderRefundsNode,
} from "./helpers/shopify-graphql-fixtures";

const CTX = { tenantId: "t1", tenantIntegrationId: "ti1" } as any;
const CREDS = { accessToken: "shpat_test" };
const CONFIG = { shopDomain: "test-shop.myshopify.com" };

type Route = { match: (method: string, url: string, body?: any) => boolean; reply: (method: string, url: string, body: any) => any };

/** Install a fetch stub built from ordered route matchers. Records calls. */
function stubShopify(routes: Route[]) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), body });
    for (const r of routes) {
      if (r.match(method, String(url), body)) {
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



/** Did this call write anything? A GraphQL read and a GraphQL write are both POSTs. */
function isMutation(c: { method: string; url: string; body: any }): boolean {
  if (c.method !== "POST") return false;
  if (!/\/graphql\.json$/.test(c.url)) return true;
  return /^\s*mutation\b/m.test(String(c.body?.query ?? ""));
}

/** Route one named GraphQL operation to a reply. */
function gqlRoute(operation: string, reply: () => any): Route {
  return {
    match: (m, u, body) => m === "POST" && /\/graphql\.json$/.test(u) && String(body?.query).includes(operation),
    reply,
  };
}

/** Route the `GotchaOrderById` read to a REST-shaped fixture. */
function orderRoute(order: () => any): Route {
  return {
    match: (m, u, body) => m === "POST" && /\/graphql\.json$/.test(u) && String(body?.query).includes("GotchaOrderById"),
    reply: () => ({ data: { order: orderNode(order()) } }),
  };
}

function run(toolName: string, args: Record<string, unknown>) {
  return ShopifyAdapter.execute({ ctx: CTX, toolName, args, credentials: CREDS, config: CONFIG } as any);
}

beforeEach(() => vi.restoreAllMocks());

describe("shopify.cancel_order", () => {
  // The cancel is a GraphQL mutation. REST `/orders/{id}/cancel.json` answers
  // 422 "Cannot cancel a paid and fulfilled order" for orders that are
  // neither - live-verified - so it cannot be the path a customer depends on.
  it("cancels via GraphQL, then VERIFIES cancelled_at before reporting success", async () => {
    let cancelled = false;
    const calls = stubShopify([
      orderRoute(() => ({ id: 1001, name: "#1004", cancelled_at: cancelled ? "2026-07-20T10:00:00Z" : null, financial_status: "paid" })),
      {
        match: (m, u) => m === "POST" && /\/graphql\.json$/.test(u),
        reply: () => { cancelled = true; return { data: { orderCancel: { job: { id: "gid://shopify/Job/1", done: true }, orderCancelUserErrors: [] } } }; },
      },
    ]);
    const out: any = await run("cancel_order", { order_id: "1001", reason: "customer" });
    expect(out.cancelled_at).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/graphql.json"))).toBe(true);
    // REST cancel must not be used at all.
    expect(calls.some((c) => c.url.includes("/cancel.json"))).toBe(false);
  });

  it("reports Shopify's structured refusal instead of a blanket status code", async () => {
    // orderCancelUserErrors is the whole reason to be on GraphQL: it names the
    // real obstacle ("outstanding fulfillments") where REST claimed the order
    // was "paid and fulfilled" - a state it was demonstrably not in.
    stubShopify([
      orderRoute(() => ({ id: 1001, cancelled_at: null, financial_status: "paid" })),
      {
        match: (m, u) => m === "POST" && /\/graphql\.json$/.test(u),
        reply: () => ({ data: { orderCancel: { job: null, orderCancelUserErrors: [{ field: null, message: "Cannot cancel an order that has outstanding fulfillments", code: "INVALID" }] } } }),
      },
    ]);
    await expect(run("cancel_order", { order_id: "1001" })).rejects.toThrow(/outstanding fulfillments/);
  });

  it("is idempotent: an already-cancelled order returns already_cancelled and never re-POSTs", async () => {
    const calls = stubShopify([
      orderRoute(() => ({ id: 1001, name: "#1004", cancelled_at: "2026-07-19T13:00:00Z", financial_status: "refunded" })),
    ]);
    const out: any = await run("cancel_order", { order_id: "1001" });
    expect(out.already_cancelled).toBe(true);
    // Reads are POSTs to graphql.json now, so "nothing was written" is asserted
    // against the MUTATIONS rather than against the HTTP verb.
    expect(calls.filter((c) => isMutation(c)).length).toBe(0);
  });

  it("FAILS when the mutation is accepted but the order stays uncancelled", async () => {
    // The mutation returns a JOB, so acceptance is not completion. If the
    // order never actually flips, this must be a failure - "Shopify took the
    // request" is not a claim a customer can be told.
    let getCount = 0;
    stubShopify([
      orderRoute(() => { getCount++; return { id: 1001, cancelled_at: null, financial_status: "paid" }; }),
      { match: (m, u) => m === "POST" && /\/graphql\.json$/.test(u), reply: () => ({ data: { orderCancel: { job: { id: "gid://shopify/Job/1", done: false }, orderCancelUserErrors: [] } } }) },
    ]);
    await expect(run("cancel_order", { order_id: "1001" })).rejects.toThrow(/cancel_not_applied/);
    expect(getCount).toBeGreaterThanOrEqual(2); // resolve + verification re-reads
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
      gqlRoute("GotchaOrderRefunds", () => ({ data: { order: { refunds: orderRefundsNode([]) } } })),
      gqlRoute("GotchaSuggestedRefund", () => ({
        data: { order: { suggestedRefund: suggestedRefundNode({ transactions: [{ parent_id: 7, amount: "150.00", gateway: "manual" }], shipping: { amount: "0.00" } }) } },
      })),
      gqlRoute("GotchaRefundCreate", () => {
        refundCreated = true;
        return {
          data: {
            refundCreate: {
              refund: refundNode({ id: 555, created_at: "2026-07-20T10:00:00Z", transactions: [{ id: 9, status: "success", amount: "150.00", gateway: "manual" }] }),
              userErrors: [],
            },
          },
        };
      }),
      orderRoute(() => ({ ...ORDER, financial_status: refundCreated ? "refunded" : "paid" })),
    ]);
    const out: any = await run("process_refund", { order_id: "2001" });
    expect(out.refund_id).toBe(555);
    expect(out.refund_status).toBe("processed");
    expect(out.financial_status).toBe("refunded");
    // calculate ran before create
    const idxCalc = calls.findIndex((c) => String(c.body?.query ?? "").includes("GotchaSuggestedRefund"));
    const idxCreate = calls.findIndex((c) => String(c.body?.query ?? "").includes("GotchaRefundCreate"));
    expect(idxCalc).toBeGreaterThanOrEqual(0);
    expect(idxCreate).toBeGreaterThan(idxCalc);
  });

  it("reports pending (NOT processed) when the gateway transaction is still pending", async () => {
    stubShopify([
      gqlRoute("GotchaOrderRefunds", () => ({ data: { order: { refunds: orderRefundsNode([]) } } })),
      gqlRoute("GotchaSuggestedRefund", () => ({
        data: { order: { suggestedRefund: suggestedRefundNode({ transactions: [{ parent_id: 7, amount: "150.00" }] }) } },
      })),
      gqlRoute("GotchaRefundCreate", () => ({
        data: {
          refundCreate: {
            refund: refundNode({ id: 556, transactions: [{ id: 9, status: "pending", amount: "150.00" }] }),
            userErrors: [],
          },
        },
      })),
      orderRoute(() => ORDER),
    ]);
    const out: any = await run("process_refund", { order_id: "2001" });
    expect(out.refund_status).toBe("pending");
  });

  it("partial refund beyond the refundable maximum is rejected BEFORE any money moves", async () => {
    const calls = stubShopify([
      gqlRoute("GotchaOrderRefunds", () => ({ data: { order: { refunds: orderRefundsNode([]) } } })),
      gqlRoute("GotchaSuggestedRefund", () => ({
        data: { order: { suggestedRefund: suggestedRefundNode({ transactions: [{ parent_id: 7, amount: "100.00" }] }) } },
      })),
      orderRoute(() => ORDER),
    ]);
    await expect(run("process_refund", { order_id: "2001", amount: 500 })).rejects.toThrow(/refund_exceeds_refundable/);
    // No money moved: the refusal happened before the mutation.
    expect(calls.some((c) => String(c.body?.query ?? "").includes("GotchaRefundCreate"))).toBe(false);
  });

  it("is idempotent: an already fully-refunded order short-circuits without creating another refund", async () => {
    const calls = stubShopify([
      orderRoute(() => ({ ...ORDER, financial_status: "refunded" })),
    ]);
    const out: any = await run("process_refund", { order_id: "2001" });
    expect(out.already_refunded).toBe(true);
    // Reads are POSTs to graphql.json now, so "nothing was written" is asserted
    // against the MUTATIONS rather than against the HTTP verb.
    expect(calls.filter((c) => isMutation(c)).length).toBe(0);
  });

  it("re-run after a lost result: prior refunds consume remaining quantities → already_refunded, no double refund", async () => {
    const calls = stubShopify([
      orderRoute(() => ({ ...ORDER, financial_status: "partially_refunded" })),
      gqlRoute("GotchaOrderRefunds", () => ({
        data: {
          order: {
            refunds: orderRefundsNode([
              { refund_line_items: [{ line_item_id: 31, quantity: 2 }], transactions: [{ kind: "refund", status: "success", amount: "150.00" }] },
            ]),
          },
        },
      })),
    ]);
    const out: any = await run("process_refund", { order_id: "2001" });
    expect(out.already_refunded).toBe(true);
    // Reads are POSTs to graphql.json now, so "nothing was written" is asserted
    // against the MUTATIONS rather than against the HTTP verb.
    expect(calls.filter((c) => isMutation(c)).length).toBe(0);
  });
});

describe("shopify.issue_compensation_coupon", () => {
  it("returns the existing code instead of double-creating on retry", async () => {
    const calls = stubShopify([
      {
        // The customer lookup and the coupon lookup are both GraphQL now, so
        // one reply carries both - each operation reads its own field.
        match: (m, u) => m === "POST" && /\/graphql\.json$/.test(u),
        reply: () => ({
          data: {
            customers: { nodes: [{ legacyResourceId: "42", tags: [] }], pageInfo: { hasNextPage: false, endCursor: null } },
            codeDiscountNodeByCode: {
              id: "gid://shopify/DiscountCodeNode/77",
              codeDiscount: { title: "GOTCHA-MATAN-1004", status: "ACTIVE", codes: { nodes: [{ code: "GOTCHA-MATAN-1004" }] }, customerGets: { value: { percentage: 1 } } },
            },
          },
        }),
      },
    ]);
    const out: any = await run("issue_compensation_coupon", { email: "matanam0012@gmail.com", code: "GOTCHA-MATAN-1004", percentage: 100 });
    expect(out.already_existed).toBe(true);
    expect(out.price_rule_id).toBe(77);
    // Nothing was created: the coupon already existed.
    expect(calls.some((c) => String(c.body?.query ?? "").includes("GotchaDiscountCreate"))).toBe(false);
  });
});

describe("failure honesty", () => {
  it("unknown tool name fails loudly, never a silent no-op", async () => {
    stubShopify([]);
    await expect(run("refund_order", { order_id: "1" })).rejects.toThrow(/unknown_shopify_tool/);
  });

  it("GraphQL top-level errors fail the call (get_returns)", async () => {
    stubShopify([
      orderRoute(() => ({ id: 3001, name: "#3001" })),
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
    // Now raised by the GraphQL transport, since that is where the cancel goes.
    stubShopify([
      { match: (m, u) => m === "GET" && /\/orders\/1001\.json$/.test(u), reply: () => ({ order: { id: 1001, cancelled_at: null } }) },
      { match: (m, u) => m === "POST" && /\/graphql\.json$/.test(u), reply: () => ({ __status: 403, body: { errors: "write_orders scope required" } }) },
    ]);
    await expect(run("cancel_order", { order_id: "1001" })).rejects.toThrow(/shopify_403/);
  });
});

describe("shopify.create_note", () => {
  /**
   * A customer whose `note` field starts at `note` and records every write.
   *
   * Read and write are the same POST to graphql.json now, so the routes
   * discriminate on the operation in the body rather than on the URL.
   */
  function customerWithNote(note: string) {
    let current = note;
    const puts: string[] = [];
    const calls = stubShopify([
      {
        match: (m, u) => m === "POST" && /\/graphql\.json$/.test(u),
        reply: (_m, _u, body) => {
          if (String(body?.query).includes("GotchaCustomerUpdate")) {
            current = body?.variables?.input?.note ?? current;
            puts.push(current);
            return { data: { customerUpdate: { customer: { legacyResourceId: "77", note: current }, userErrors: [] } } };
          }
          return { data: { customer: { legacyResourceId: "77", note: current } } };
        },
      },
    ]);
    return { calls, puts, read: () => current };
  }

  const MARKER = "[gotcha_source_interaction_id=conv-1:summary]";

  it("appends to the customer's existing note rather than replacing it", async () => {
    const c = customerWithNote("Prefers pickup.");

    await run("create_note", { customer_id: "77", note: `New summary.\n\n${MARKER}` });

    expect(c.read()).toContain("Prefers pickup.");
    expect(c.read()).toContain("New summary.");
  });

  it("does not append twice when the same marked note is retried", async () => {
    // `customer.note` is one free-text field that every note appends to, and
    // this handler is reached by retried background work. Without the marker
    // check a redelivered post-chat run duplicates the summary permanently.
    const c = customerWithNote("");

    await run("create_note", { customer_id: "77", note: `Summary v1.\n\n${MARKER}` });
    await run("create_note", { customer_id: "77", note: `Summary v1 reworded by the LLM.\n\n${MARKER}` });

    expect(c.puts).toHaveLength(1);
    expect(c.read()).toContain("Summary v1.");
    // The retry must not have written the reworded body either.
    expect(c.read()).not.toContain("reworded");
  });

  it("still writes a DIFFERENT conversation's note to the same customer", async () => {
    const c = customerWithNote("");

    await run("create_note", { customer_id: "77", note: `First.\n\n${MARKER}` });
    await run("create_note", { customer_id: "77", note: "Second.\n\n[gotcha_source_interaction_id=conv-2:summary]" });

    expect(c.puts).toHaveLength(2);
    expect(c.read()).toContain("First.");
    expect(c.read()).toContain("Second.");
  });

  it("appends an unmarked note every time - dedup is opt-in via the marker", async () => {
    // A human or the model writing a free-text note has no idempotency key,
    // and silently swallowing the second one would lose a real note.
    const c = customerWithNote("");

    await run("create_note", { customer_id: "77", note: "Called about sizing." });
    await run("create_note", { customer_id: "77", note: "Called about sizing." });

    expect(c.puts).toHaveLength(2);
  });
});
