import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * One order, five tools, one answer.
 *
 * `update_order_fulfillment` was the only Shopify order tool that hand-rolled
 * its parameters - `order_id` required, no `order_name` - while every sibling
 * used the shared `P.orderSel`. A customer saying "#1006" could therefore be
 * looked up by four tools and not by the fifth, which is exactly what happened
 * to Matan Amran: four failed writes and an escalation.
 *
 * These tests drive the real adapter against a stubbed Shopify that behaves
 * like the real one: `/orders/{id}.json` only answers to the INTERNAL id, and
 * `?name=` only answers to the name.
 */

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  assertPublicUrl: vi.fn(async () => {}),
  prisma: {},
  encryptCredentials: (v: unknown) => v,
  decryptCredentials: (v: unknown) => v,
}));

import ShopifyAdapter from "../services/connectors/shopify.adapter";

const CTX = { tenantId: "t1", tenantIntegrationId: "ti1" } as any;
const CREDS = { accessToken: "shpat_test" };
const CONFIG = { shopDomain: "test-shop.myshopify.com" };

/** The real order: a 13-digit internal id, displayed to humans as "#1006". */
const INTERNAL_ID = 5678901234567;
const ORDER_NAME = "#1006";

const ORDER = {
  id: INTERNAL_ID,
  name: ORDER_NAME,
  note: null,
  tags: "",
  cancelled_at: null,
  financial_status: "paid",
  fulfillment_status: null,
  fulfillments: [],
  line_items: [],
};

interface Call { method: string; url: string; body: any }

/**
 * A Shopify that keeps its two namespaces separate, like the real one.
 *
 * `/orders/{x}.json` answers ONLY for the internal id - anything else gets the
 * 400 that "#1006" produced in production. `?name=` answers only for the name.
 */
function stubShopify(opts: { duplicateName?: boolean; missing?: boolean } = {}): Call[] {
  const calls: Call[] = [];
  (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: u, body });

    const ok = (data: any) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }) as any;
    const err = (status: number, payload: any) =>
      ({ ok: false, status, json: async () => payload, text: async () => JSON.stringify(payload) }) as any;

    // Name lookup.
    const nameQ = u.match(/\/orders\.json\?name=([^&]+)/);
    if (method === "GET" && nameQ) {
      const asked = decodeURIComponent(nameQ[1]);
      if (opts.missing) return ok({ orders: [] });
      if (asked !== "1006") return ok({ orders: [] });
      if (opts.duplicateName) return ok({ orders: [ORDER, { ...ORDER, id: 9999999999999 }] });
      return ok({ orders: [ORDER] });
    }

    // Direct id lookup - ONLY the internal id resolves.
    const idQ = u.match(/\/orders\/([^/.]+)\.json$/);
    if (method === "GET" && idQ) {
      const asked = decodeURIComponent(idQ[1]);
      if (asked === String(INTERNAL_ID) && !opts.missing) return ok({ order: ORDER });
      // What production actually returned for "%231006".
      if (!/^\d+$/.test(asked)) return err(400, { errors: { id: "expected String to be a id" } });
      return err(404, { errors: "Not Found" });
    }

    // The write.
    if (method === "PUT" && idQ) {
      const asked = decodeURIComponent(idQ[1]);
      if (asked !== String(INTERNAL_ID)) return err(400, { errors: { id: "expected String to be a id" } });
      const upd = body?.order ?? {};
      return ok({ order: { ...ORDER, note: upd.note ?? null, tags: upd.tags ?? "" } });
    }

    return err(404, {});
  });
  return calls;
}

const run = (toolName: string, args: Record<string, unknown>) =>
  ShopifyAdapter.execute({ ctx: CTX, toolName, args, credentials: CREDS, config: CONFIG } as any);

beforeEach(() => vi.restoreAllMocks());

describe("the exact call that failed in production", () => {
  it("update_order_fulfillment now succeeds with an order NAME in order_id", async () => {
    // Byte-for-byte the arguments the model sent at 12:39, which returned
    // `shopify_400: id: expected String to be a id` four times.
    stubShopify();
    const out: any = await run("update_order_fulfillment", {
      order_id: "#1006",
      note: "Customer requested shipping ETA and tracking.",
      tag: "investigate_shipment",
    });
    expect(out.orderResolved).toBe(true);
    expect(out.order_id).toBe(INTERNAL_ID);
    expect(out.name).toBe(ORDER_NAME);
  });

  it("also succeeds with the bare number the model tried next", async () => {
    stubShopify();
    const out: any = await run("update_order_fulfillment", { order_id: "1006", tag: "x" });
    expect(out.order_id).toBe(INTERNAL_ID);
  });

  it("accepts the canonical order_name argument it never used to expose", async () => {
    stubShopify();
    const out: any = await run("update_order_fulfillment", { order_name: "#1006", note: "n" });
    expect(out.order_id).toBe(INTERNAL_ID);
  });

  it("still accepts a real internal id and a GID", async () => {
    stubShopify();
    const byId: any = await run("update_order_fulfillment", { order_id: String(INTERNAL_ID), tag: "t" });
    expect(byId.order_id).toBe(INTERNAL_ID);

    stubShopify();
    const byGid: any = await run("update_order_fulfillment", {
      order_id: `gid://shopify/Order/${INTERNAL_ID}`, tag: "t",
    });
    expect(byGid.order_id).toBe(INTERNAL_ID);
  });

  it("never issues the malformed request that caused the 400", async () => {
    const calls = stubShopify();
    await run("update_order_fulfillment", { order_id: "#1006", tag: "t" });
    // The literal URL from production: /orders/%231006.json
    expect(calls.some((c) => /%231006/.test(c.url)), "must not send '#' as an id").toBe(false);
  });
});

describe("every order tool resolves the same order from the same input", () => {
  const SIBLINGS = ["get_order", "get_fulfillment_status", "check_delivery_eta", "order_lookup"];
  const ALL = [...SIBLINGS, "update_order_fulfillment"];

  /**
   * Did the adapter actually FIND the order?
   *
   * Asserted on the requests rather than the return value, because these tools
   * shape their responses differently and some throw a legitimate domain error
   * AFTER resolving - `check_delivery_eta` raises `no_eta` for an order with no
   * fulfillment, which is the same thing it did in the real conversation. That
   * throw is proof of resolution, not a failure to resolve.
   */
  async function resolutionRequests(tool: string, args: Record<string, unknown>) {
    const calls = stubShopify();
    try {
      await run(tool, { ...args, note: "n", tag: "t" });
    } catch (err: any) {
      // Only post-resolution domain errors are acceptable here.
      if (!/no_eta|no_tracking|not_fulfilled|no_pickup/.test(String(err?.message))) throw err;
    }
    return {
      foundByName: calls.some((c) => /\/orders\.json\?name=1006/.test(c.url)),
      foundById: calls.some((c) => new RegExp(`/orders/${INTERNAL_ID}\\.json`).test(c.url)),
      malformed: calls.some((c) => /%231006/.test(c.url)),
    };
  }

  it.each(ALL)("%s resolves #1006 from order_name", async (tool) => {
    const r = await resolutionRequests(tool, { order_name: "#1006" });
    expect(r.foundByName || r.foundById, `${tool} never looked the order up`).toBe(true);
    expect(r.malformed, `${tool} sent '#' as an id`).toBe(false);
  });

  it.each(ALL)("%s resolves #1006 even when it arrives in order_id", async (tool) => {
    // The production shape: the model had nowhere else to put it.
    const r = await resolutionRequests(tool, { order_id: "#1006" });
    expect(r.foundByName || r.foundById, `${tool} never looked the order up`).toBe(true);
    expect(r.malformed, `${tool} sent '#' as an id`).toBe(false);
  });

  it("the write path lands on the same internal id the read paths return", async () => {
    stubShopify();
    const write: any = await run("update_order_fulfillment", { order_name: "#1006", tag: "t" });
    stubShopify();
    const read: any = await run("get_order", { order_name: "#1006" });
    expect(String(write.order_id)).toBe(String(INTERNAL_ID));
    expect(JSON.stringify(read)).toContain(String(write.order_id));
  });
});

describe("refusing rather than guessing", () => {
  it("refuses a duplicate order name instead of taking the first match", async () => {
    // Acting on the wrong order is worse than refusing to act.
    stubShopify({ duplicateName: true });
    await expect(run("update_order_fulfillment", { order_name: "#1006", tag: "t" }))
      .rejects.toThrow(/order_ambiguous/);
  });

  it("reports a nonexistent order as not found", async () => {
    stubShopify({ missing: true });
    await expect(run("update_order_fulfillment", { order_name: "#9999", tag: "t" }))
      .rejects.toThrow(/order_not_found/);
  });

  it("distinguishes a MISSING identifier from a MALFORMED one", async () => {
    stubShopify();
    await expect(run("update_order_fulfillment", { tag: "t" }))
      .rejects.toThrow(/order_id_or_name_required/);
    await expect(run("update_order_fulfillment", { order_id: "???", tag: "t" }))
      .rejects.toThrow(/order_identifier_invalid/);
  });

  it("requires a note or a tag - an empty write is a no-op, not a success", async () => {
    stubShopify();
    await expect(run("update_order_fulfillment", { order_name: "#1006" }))
      .rejects.toThrow(/note_or_tag_required/);
  });
});

describe("the result says what did NOT happen", () => {
  it("reports the write as recorded-on-order-only", async () => {
    // The model previously saw a bare success shape and told the customer a
    // team had been contacted. These flags make the absence explicit.
    stubShopify();
    const out: any = await run("update_order_fulfillment", {
      order_name: "#1006", note: "n", tag: "t",
    });
    expect(out.noteAdded).toBe(true);
    expect(out.tagAdded).toBe(true);
    expect(out.notificationSent).toBe(false);
    expect(out.assignmentCreated).toBe(false);
    expect(out.followUpScheduled).toBe(false);
    expect(out.recordedOnOrderOnly).toBe(true);
  });

  it("distinguishes a note-only write from a tag-only write", async () => {
    stubShopify();
    const noteOnly: any = await run("update_order_fulfillment", { order_name: "#1006", note: "n" });
    expect(noteOnly.noteAdded).toBe(true);
    expect(noteOnly.tagAdded).toBe(false);

    stubShopify();
    const tagOnly: any = await run("update_order_fulfillment", { order_name: "#1006", tag: "t" });
    expect(tagOnly.noteAdded).toBe(false);
    expect(tagOnly.tagAdded).toBe(true);
  });
});
