/**
 * Customers list commerce data: one store read, matched to contacts.
 *
 * Pinned: purchases only (cancelled/refunded/failed do not count), a match by
 * email OR phone counts each order once, a mixed-currency total is withheld
 * rather than added up, "no store" is `source: null` with a reason and never
 * zeros, the store is read once per tenant and cached, and the order-number
 * lookup finds the contact behind the order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const S = vi.hoisted(() => ({
  conn: null as any,
  shop: null as any,
  contacts: [] as any[],
  redis: new Map<string, string>(),
  fetches: 0,
  pages: [] as any[][],
}));

vi.mock("@chatcenter/shared", () => ({
  assertPublicUrl: async (u: string) => new URL(u),
  getRedis: () => ({
    get: async (k: string) => S.redis.get(k) ?? null,
    set: async (k: string, v: string) => { S.redis.set(k, v); return "OK"; },
  }),
  prisma: {
    contact: {
      findMany: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("tenant guard");
        return S.contacts.filter((c) => c.tenantId === a.where.tenantId && (!a.where.id || a.where.id.in.includes(c.id)) && (a.where.mergedIntoId === undefined || c.mergedIntoId == null));
      },
      findFirst: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("tenant guard");
        return S.contacts.find((c) => c.tenantId === a.where.tenantId && a.where.OR.some((cl: any) =>
          (cl.email && (c.email ?? "").toLowerCase() === cl.email.equals.toLowerCase()) ||
          (cl.phone && (c.phone ?? "").endsWith(cl.phone.endsWith)) ||
          (cl.externalId && (c.externalId ?? "").endsWith(cl.externalId.endsWith)))) ?? null;
      },
    },
  },
}));
vi.mock("../services/connectors/integration-framework", () => ({
  loadConnection: async (o: any) => (o.slug === "woocommerce" ? S.conn : S.shop),
}));

import {
  commerceSummaries, segmentCounts, contactByOrderNumber, phoneKey, summarizeContact, indexOrders,
} from "../services/customer-commerce.service";

const order = (number: string, email: string | null, phone: string | null, total: string, status = "completed", currency = "ILS") =>
  ({ id: Number(number), number, status, total, currency, date_created_gmt: `2026-09-${number.padStart(2, "0").slice(-2)}T10:00:00`, billing: { email, phone } });

beforeEach(() => {
  S.conn = { status: "CONNECTED", config: { storeUrl: "https://shop.example.test" }, credentials: { consumerKey: "ck", consumerSecret: "cs" } };
  S.shop = null;
  S.redis.clear();
  S.fetches = 0;
  S.pages = [[
    order("11", "noa@example.com", "050-111-2222", "100.00"),
    order("12", "noa@example.com", null, "250.50"),
    order("13", null, "+972501112222", "40.00"),
    order("14", "noa@example.com", null, "999.00", "cancelled"),
    order("15", "dan@example.com", null, "80.00"),
  ]];
  S.contacts = [
    { id: "c_noa", tenantId: "T", email: "Noa@Example.com", phone: "0501112222", externalId: "972501112222", tags: [] },
    { id: "c_dan", tenantId: "T", email: "dan@example.com", phone: null, externalId: null, tags: [] },
    { id: "c_new", tenantId: "T", email: "new@example.com", phone: null, externalId: null, tags: [] },
    { id: "c_whs", tenantId: "T", email: null, phone: null, externalId: null, tags: ["Wholesale"] },
    { id: "c_other", tenantId: "OTHER", email: "noa@example.com", phone: null, externalId: null, tags: [] },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    S.fetches++;
    const page = Number(new URL(url).searchParams.get("page"));
    const rows = S.pages[page - 1] ?? [];
    return { ok: true, status: 200, json: async () => rows, headers: { get: () => String(S.pages.length) } } as any;
  }));
});

describe("summaries", () => {
  it("★ email + phone matches count each purchase once; a cancelled order does not count", async () => {
    const r: any = await commerceSummaries("T", ["c_noa", "c_dan", "c_new"]);
    expect(r.source).toBe("woocommerce");
    expect(r.data.c_noa).toEqual({ lifetimeValue: 390.5, currency: "ILS", orderCount: 3, lastOrderAt: "2026-09-13T10:00:00Z" });
    expect(r.data.c_dan).toMatchObject({ lifetimeValue: 80, orderCount: 1 });
    expect(r.data.c_new).toEqual({ lifetimeValue: 0, currency: null, orderCount: 0, lastOrderAt: null });
  });

  it("★ another tenant's contact is not returned", async () => {
    const r: any = await commerceSummaries("T", ["c_other"]);
    expect(r.data).toEqual({});
  });

  it("★ the store is read once and then served from the cache", async () => {
    await commerceSummaries("T", ["c_noa"]);
    await commerceSummaries("T", ["c_dan"]);
    await segmentCounts("T");
    expect(S.fetches).toBe(1);
  });

  it("★ no store connected → source null with a reason, never zeros", async () => {
    S.conn = null;
    expect(await commerceSummaries("T", ["c_noa"])).toEqual({ source: null, reason: "no_store_connected", data: {} });
    S.conn = { ...S.conn, status: "ERROR" };
    S.shop = { status: "CONNECTED" };
    expect((await commerceSummaries("T", ["c_noa"])).reason).toBe("provider_not_supported");
  });

  it("an unreachable store is store_unreachable, not an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), headers: { get: () => "1" } })));
    expect((await commerceSummaries("T", ["c_noa"])).reason).toBe("store_unreachable");
  });

  it("a mixed-currency total is withheld, not added up", () => {
    const idx = indexOrders([
      { number: "1", status: "completed", total: 10, currency: "ILS", createdAt: "a", email: "x@y.z", phone: null },
      { number: "2", status: "completed", total: 10, currency: "USD", createdAt: "b", email: "x@y.z", phone: null },
    ]);
    expect(summarizeContact({ email: "x@y.z" }, idx)).toMatchObject({ lifetimeValue: 0, currency: null, orderCount: 2 });
  });
});

describe("segments", () => {
  it("★ came back / bought once / wholesale / never bought, over this tenant's contacts", async () => {
    const r: any = await segmentCounts("T");
    expect(r.counts).toEqual({ came_back: 1, bought_once: 1, wholesale: 1, never_bought: 1 });
    expect(r.total).toBe(4);
  });
});

describe("by order number", () => {
  it("★ finds the contact behind an order, '#' allowed", async () => {
    expect((await contactByOrderNumber("T", "#13")).contactId).toBe("c_noa");
    expect((await contactByOrderNumber("T", "15")).contactId).toBe("c_dan");
  });
  it("an unknown order is a null contact, not an error", async () => {
    expect((await contactByOrderNumber("T", "999")).contactId).toBeNull();
  });
});

describe("phoneKey", () => {
  it("matches local and international forms of one number", () => {
    expect(phoneKey("050-111-2222")).toBe(phoneKey("+972 50 111 2222"));
    expect(phoneKey("12")).toBeNull();
  });
});
