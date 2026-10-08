/**
 * ★ Home chat stage 2, the store queries (docs/api/assistant-threads-v1.md §9.1):
 *   - orders are read LIVE from the connected store for the workspace's days
 *     (the store is asked for exactly that window), counted per workspace day
 *   - sales carry the store's currency; by product the figure is units
 *   - refunds name their line items: units refunded per product, and the
 *     refunded orders listed
 *   - a refusal (Shopify's protected customer data) or no store produces NO
 *     card and a plain reason; WooCommerce refunds are said to be unsupported
 *   - a capped read is labelled partial; WooCommerce is paged
 *   - stock per variant, Shopify's "Default Title" variant not shown
 *   - the list behind a source replays page by page
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ store: "shopify" as string | null, calls: [] as any[], reply: null as any }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readDurableSetting: async () => JSON.stringify({ timezone: "Asia/Jerusalem", schedule: {} }),
    prisma: {
      tenantIntegration: { findMany: async () => (H.store ? [{ integration: { slug: H.store } }] : []) },
    },
  };
});

vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: async (a: any) => {
    H.calls.push(a);
    return H.reply(a);
  },
}));

import { queryOrders, queryProductStock, normalizeOrderQuery, listOrdersForSource } from "../services/assistant-commerce-query.service";
import { buildSystemAgentTools, dispatchSystemToolCall } from "../services/system-tools.service";

let n = 0;
const ctx = (o: any = {}) => ({ tenantId: "T", locale: "en" as const, nextId: (k: "b" | "s") => `${k}${++n}`, ...o });
const Q = (o: any = {}) => normalizeOrderQuery({ from: "2026-10-01", to: "2026-10-03", ...o }) as any;

const order = (id: string, created_at: string, total: number, lines: any[], refunds: any[] = []) => ({
  id, name: `#${id}`, created_at, currency: "ILS", total_price: String(total),
  line_items: lines.map(([lid, pid, title, quantity]) => ({ id: lid, product_id: pid, title, quantity, price: "10.00" })),
  refunds,
});
const ORDERS = [
  order("1003", "2026-10-03T08:00:00Z", 300, [["L5", 11, "Duvet", 1]], [
    { id: "R1", created_at: "2026-10-03T09:00:00Z", total: "100.00", refund_line_items: [{ line_item_id: "L5", quantity: 1 }] },
  ]),
  order("1002", "2026-10-01T22:30:00Z", 50, [["L3", 22, "Pillow", 2]]), // 01:30 on 2 October in Jerusalem
  order("1001", "2026-10-01T09:00:00Z", 150, [["L1", 11, "Duvet", 1], ["L2", 22, "Pillow", 3]]),
];

beforeEach(() => {
  n = 0; H.calls = []; H.store = "shopify";
  H.reply = () => ({ ok: true, result: ORDERS });
});

describe("★ orders by workspace day", () => {
  it("asks the store for exactly the workspace's days and counts per day", async () => {
    const r = await queryOrders(ctx(), Q());
    expect(H.calls[0]).toMatchObject({
      toolFunctionName: "shopify.search_orders", accessScope: "internal",
      args: { status: "any", limit: 250, created_from: "2026-09-30T21:00:00.000Z", created_to: "2026-10-03T21:00:00.000Z" },
    });
    const chart: any = r.blocks[0];
    expect(chart).toMatchObject({ type: "chart", sourceId: "s1", unit: "count", currency: null, partial: null });
    expect(chart.x.values).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(chart.series[0].values).toEqual([1, 1, 1]);
    expect(r.summary).toMatchObject({ ok: true, cite: "s1", store: "shopify", total: 3 });
    expect(r.source).toMatchObject({ id: "s1", kind: "orders", count: 3, query: { tool: "orders", params: { from: "2026-10-01", to: "2026-10-03", measure: "orders", groupBy: "day" } } });
  });

  it("sales are money in the store's currency, the best day highlighted", async () => {
    const r = await queryOrders(ctx(), Q({ measure: "revenue" }));
    const chart: any = r.blocks[0];
    expect(chart).toMatchObject({ unit: "currency", currency: "ILS", highlight: ["2026-10-03"] });
    expect(chart.series[0].values).toEqual([150, 50, 300]);
    expect(r.summary).toMatchObject({ total: 500, cards: ["Sales by day: a bar chart over 3 days"] });
    // ★ Money is TEXT the model repeats, symbol first, in both languages; never
    // a number plus a code for the model to format ("10,539.69 ILS" surfaced live).
    expect(r.summary).toMatchObject({ totalText: "₪500.00" });
    expect((await queryOrders(ctx({ locale: "he" }), Q({ measure: "revenue" }))).summary).toMatchObject({ totalText: "₪500.00" });
    expect(r.summary).not.toHaveProperty("currency");
    expect(r.source!.count).toBe(3); // the orders behind the sum
  });

  it("by product the figure is units sold", async () => {
    const b: any = (await queryOrders(ctx(), Q({ groupBy: "product" }))).blocks[0];
    expect(b.title).toBe("Units sold by product");
    expect(b.items.map((i: any) => [i.key, i.label, i.value])).toEqual([["22", "Pillow", 5], ["11", "Duvet", 2]]);
    expect(b.total).toBe(7);
  });
});

describe("★ refunds", () => {
  it("units refunded per product, through the refund's line items; the refunded orders listed", async () => {
    const r = await queryOrders(ctx(), Q({ measure: "refunds", groupBy: "product" }));
    const b: any = r.blocks[0];
    expect(b.items).toEqual([{ key: "11", label: "Duvet", value: 1, share: 1 }]);
    const list: any = r.blocks.find((x) => x.type === "record_list");
    expect(list).toMatchObject({ kind: "order", total: 1, hasMore: false, sourceId: "s1" });
    expect(list.items[0]).toMatchObject({ id: "1003", title: "#1003" });
    expect(list.items[0].subtitle).toBe("₪300.00 · refunded ₪100.00");
    // No invisible RTL marks (he-IL's own format hides them around the symbol).
    const he: any = (await queryOrders(ctx({ locale: "he" }), Q({ measure: "refunds", groupBy: "product" }))).blocks.find((x) => x.type === "record_list");
    expect(he.items[0].subtitle).toBe("₪300.00 · הוחזרו ₪100.00");
    expect(r.summary).toMatchObject({ total: 1, note2: "refunds on orders placed in the period" });
    expect(r.source).toMatchObject({ kind: "refunds", count: 1 });
  });

  it("by day a refund counts on the day it was made", async () => {
    const chart: any = (await queryOrders(ctx(), Q({ measure: "refunds" }))).blocks[0];
    expect(chart.series[0].values).toEqual([0, 0, 1]);
  });

  it("★ WooCommerce: refunds counted and listed; split by reason with its coverage", async () => {
    H.store = "woocommerce";
    const woo = (id: number, refunds: any[]) => ({ id, number: String(id), date_created_gmt: "2026-10-02T08:00:00", total: "100.00", currency: "ILS", line_items: [{ product_id: 7, name: "Scarf", quantity: 1 }], refunds });
    H.reply = () => ({ ok: true, result: [
      woo(1, [{ id: 91, reason: "Too small", total: "-40.00" }]),
      woo(2, [{ id: 92, reason: "Too small", total: "-60.00" }, { id: 93, reason: "", total: "-5.00" }]),
      woo(3, []),
    ] });
    const r = await queryOrders(ctx(), Q({ measure: "refunds", groupBy: "reason" }));
    const b: any = r.blocks[0];
    expect(b).toMatchObject({ type: "breakdown", title: "Refunds by reason", total: 2, coverage: { covered: 2, of: 3 } });
    expect(b.items).toEqual([{ key: "Too small", label: "Too small", value: 2, share: 1 }]);
    expect(r.summary).toMatchObject({ total: 3, refundedText: "₪105.00", reasonGivenFor: "2 of 3" });
    const list: any = r.blocks.find((x) => x.type === "record_list");
    expect(list.items.map((i: any) => i.id)).toEqual(["1", "2"]);
  });

  it("★ a split the store cannot give is no card (never an empty chart that reads as none), and said", async () => {
    H.store = "woocommerce";
    H.reply = () => ({ ok: true, result: [{ id: 1, number: "1", date_created_gmt: "2026-10-02T08:00:00", total: "10.00", currency: "ILS", line_items: [], refunds: [{ id: 9, reason: "", total: "-10.00" }] }] });
    for (const groupBy of ["day", "product"]) {
      const r = await queryOrders(ctx(), Q({ measure: "refunds", groupBy }));
      expect(r.blocks.map((x) => x.type)).toEqual(["record_list"]);
      expect((r.summary as any).unavailableSplit).toMatch(groupBy === "day" ? /when each refund was made/ : /which products were refunded/);
      expect(r.summary).toMatchObject({ total: 1 });
    }
  });

  it("★ a Hebrew turn: every word the model may repeat is Hebrew (2026-10-08: \"right now\" leaked into a Hebrew answer)", async () => {
    H.store = "woocommerce";
    H.reply = () => ({ ok: true, result: [{ id: 1, number: "1", date_created_gmt: "2026-10-02T08:00:00", total: "10.00", currency: "ILS", line_items: [], refunds: [{ id: 9, reason: "", total: "-10.00" }] }] });
    const hebrewOnly = (summary: any) => {
      const { shownAs: _a, money: _b, store: _c, cite: _d, ...words } = summary;
      const texts: string[] = [];
      const collect = (v: unknown): void => { if (typeof v === "string") texts.push(v); else if (v && typeof v === "object") Object.values(v).forEach(collect); };
      collect(words);
      return texts.join(" | ");
    };
    for (const groupBy of ["day", "product", "reason"]) {
      const r = await queryOrders(ctx({ locale: "he" }), Q({ measure: "refunds", groupBy }));
      const said = hebrewOnly(r.summary);
      expect(said).not.toMatch(/[A-Za-z]{3,}/);
      expect(said).toMatch(/[א-ת]/);
    }
    expect((await queryOrders(ctx({ locale: "he" }), Q({ measure: "refunds", groupBy: "day" }))).summary).toMatchObject({ unavailableSplit: "החנות לא מציינת מתי בוצע כל החזר", note2: "החזרים על הזמנות שבוצעו בתקופה" });
    expect((await queryOrders(ctx({ locale: "he" }), Q({ measure: "refunds", groupBy: "reason" }))).summary).toMatchObject({ reasonGivenFor: "0 מתוך 1" });
  });

  it("reason is a refund split only", () => {
    expect(normalizeOrderQuery({ from: "2026-10-01", to: "2026-10-03", measure: "orders", groupBy: "reason" })).toMatchObject({ groupBy: "day" });
    expect(normalizeOrderQuery({ from: "2026-10-01", to: "2026-10-03", measure: "refunds", groupBy: "reason" })).toMatchObject({ groupBy: "reason" });
  });
});

describe("★ no store, a refusing store", () => {
  it("no store: no card, a reason", async () => {
    H.store = null;
    const r = await queryOrders(ctx({ locale: "he" }), Q());
    expect(r).toMatchObject({ blocks: [], source: null, summary: { ok: false, unavailable: "no_store" } });
    expect((r.summary as any).message).toContain("אין חנות מחוברת");
  });

  it("Shopify's protected customer data refusal: no card, never the store's raw text", async () => {
    H.reply = () => ({ ok: false, failure: "errored", reason: "Shopify 403: This app is not approved to access the Order object" });
    const r = await queryOrders(ctx(), Q());
    expect(r).toMatchObject({ blocks: [], source: null, summary: { ok: false, unavailable: "store_permission" } });
    expect(JSON.stringify(r.summary)).not.toContain("403");
  });

  it("a bare HTTP 403 from the store is a permission refusal, not an outage", async () => {
    H.reply = () => ({ ok: false, failure: "errored", reason: "shopify_http_403" });
    expect((await queryOrders(ctx(), Q())).summary).toMatchObject({ ok: false, unavailable: "store_permission" });
  });

  it("a store that fails is a store error", async () => {
    H.reply = () => ({ ok: false, failure: "errored", reason: "ECONNRESET" });
    expect((await queryOrders(ctx(), Q())).summary).toMatchObject({ ok: false, unavailable: "store_error" });
  });
});

describe("limits", () => {
  it("a full read is labelled partial", async () => {
    H.reply = () => ({ ok: true, result: Array.from({ length: 250 }, (_, i) => order(String(i), "2026-10-02T08:00:00Z", 1, [])) });
    const r = await queryOrders(ctx(), Q());
    expect((r.blocks[0] as any).partial).toEqual({ reason: "capped", cap: 250 });
    expect(r.summary).toHaveProperty("note");
  });

  it("WooCommerce is paged with its own date filter until a short page", async () => {
    H.store = "woocommerce";
    const woo = (id: number) => ({ id, number: String(id), date_created_gmt: "2026-10-02T08:00:00", total: "10.00", currency: "ILS", line_items: [] });
    H.reply = (a: any) => ({ ok: true, result: a.args.page === 1 ? Array.from({ length: 100 }, (_, i) => woo(i)) : [woo(500)] });
    const r = await queryOrders(ctx(), Q());
    expect(H.calls.map((c) => [c.toolFunctionName, c.args.page])).toEqual([["woocommerce.list_orders", 1], ["woocommerce.list_orders", 2]]);
    expect(H.calls[0].args).toMatchObject({ after: "2026-09-30T21:00:00.000Z", before: "2026-10-03T21:00:00.000Z", per_page: 100 });
    expect(r.summary).toMatchObject({ total: 101 });
    expect((r.blocks[0] as any).partial).toBeNull();
  });

  it("a bad period is refused, not guessed", () => {
    expect(normalizeOrderQuery({ from: "2026-10-03", to: "2026-10-01" })).toHaveProperty("error");
    expect(normalizeOrderQuery({ from: "2026-01-01", to: "2026-10-01" })).toHaveProperty("error");
    expect(normalizeOrderQuery({ from: "2026-10-01", to: "2026-10-03", measure: "profit", groupBy: "hour" })).toMatchObject({ measure: "orders", groupBy: "day" });
  });
});

describe("★ stock", () => {
  it("per variant from the store; a single 'Default Title' variant is just the total", async () => {
    H.reply = (a: any) => {
      if (a.toolFunctionName === "shopify.search_products") return { ok: true, result: [{ id: 11, title: "Duvet" }, { id: 33, title: "Mug" }] };
      if (a.args.product_id === "11") return { ok: true, result: [{ title: "King", inventory_quantity: 4 }, { title: "Queen", inventory_quantity: 10 }] };
      return { ok: true, result: [{ title: "Default Title", inventory_quantity: 7 }] };
    };
    const r = await queryProductStock(ctx(), "duvet");
    expect(H.calls[0].args).toMatchObject({ query: "duvet", in_stock_only: false });
    const [duvet, mug]: any[] = r.blocks;
    expect(duvet).toMatchObject({ type: "record", kind: "product", title: "Duvet", sourceId: "s1" });
    expect(duvet.fields).toEqual([
      { key: "stock", label: "In stock", value: "14" },
      { key: "variant:King", label: "King", value: "4" },
      { key: "variant:Queen", label: "Queen", value: "10" },
    ]);
    expect(mug.fields).toEqual([{ key: "stock", label: "In stock", value: "7" }]);
    expect(r.source).toMatchObject({ kind: "product", query: { tool: "product_stock", params: { query: "duvet" } } });
  });

  it("no such product: no card", async () => {
    H.reply = () => ({ ok: true, result: [] });
    const r = await queryProductStock(ctx(), "zzz");
    expect(r).toMatchObject({ blocks: [], source: null, summary: { ok: true, found: 0 } });
  });
});

describe("the list behind a source", () => {
  it("replays the store read page by page; refunds list only refunded orders", async () => {
    const all = await listOrdersForSource("T", "en", Q(), null);
    expect(all!.data.map((r) => r.id)).toEqual(["1003", "1002", "1001"]);
    expect(all!.nextCursor).toBeNull();
    const refunds = await listOrdersForSource("T", "en", Q({ measure: "refunds" }), null);
    expect(refunds!.data.map((r) => r.id)).toEqual(["1003"]);
  });

  it("pages by 25", async () => {
    H.reply = () => ({ ok: true, result: Array.from({ length: 30 }, (_, i) => order(String(i), "2026-10-02T08:00:00Z", 1, [])) });
    const p1 = await listOrdersForSource("T", "en", Q(), null);
    expect(p1!.data).toHaveLength(25);
    const p2 = await listOrdersForSource("T", "en", Q(), p1!.nextCursor);
    expect(p2!.data.map((r) => r.id)).toEqual(["25", "26", "27", "28", "29"]);
    expect(p2!.nextCursor).toBeNull();
  });

  it("a store that no longer answers: null (the route says SOURCE_UNAVAILABLE)", async () => {
    H.reply = () => ({ ok: false, failure: "refused", reason: "403" });
    expect(await listOrdersForSource("T", "en", Q(), null)).toBeNull();
  });
});

describe("★ who may ask: customer:commerce:read", () => {
  const names = (tools: any[]) => tools.map((t) => t.function.name);
  const call = (name: string, args: any) => ({ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }) as any;

  it("the store tools are offered only when allowed (with a store)", async () => {
    expect(names(await buildSystemAgentTools({ tenantId: "T", commerce: true }))).toEqual(expect.arrayContaining(["system_query_orders", "system_product_stock"]));
    expect(names(await buildSystemAgentTools({ tenantId: "T" }))).not.toContain("system_query_orders");
    expect(names(await buildSystemAgentTools({ tenantId: "T" }))).not.toContain("system_product_stock");
  });

  it("a caller without it is refused even if the model names the tool; the store is never read", async () => {
    for (const [name, args] of [["system_query_orders", {}], ["system_product_stock", { query: "duvet" }]] as const) {
      const r = await dispatchSystemToolCall(call(name, args), { tenantId: "T", userId: "u1" });
      expect(JSON.parse(r.content)).toEqual({ ok: false, error: "not_permitted" });
      expect(r.artifacts).toBeUndefined();
    }
    expect(H.calls).toHaveLength(0);
  });

  it("with it: the thread's period is the default, the cards come back as artifacts", async () => {
    const r = await dispatchSystemToolCall(call("system_query_orders", { measure: "revenue" }), {
      tenantId: "T", userId: "u1", canReadCommerce: true, defaultPeriod: { from: "2026-10-01", to: "2026-10-03" },
    });
    expect(JSON.parse(r.content)).toMatchObject({ ok: true, total: 500 });
    expect(r.artifacts!.source).toMatchObject({ kind: "orders", query: { params: { from: "2026-10-01", to: "2026-10-03" } } });
  });

  it("a refusing store: a reason, no artifacts", async () => {
    H.reply = () => ({ ok: false, failure: "refused", reason: "403" });
    const r = await dispatchSystemToolCall(call("system_query_orders", {}), { tenantId: "T", userId: "u1", canReadCommerce: true });
    expect(JSON.parse(r.content)).toMatchObject({ ok: false, unavailable: "store_permission" });
    expect(r.artifacts).toBeUndefined();
  });
});
