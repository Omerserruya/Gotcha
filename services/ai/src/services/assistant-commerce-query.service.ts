/**
 * Home chat stage 2 (docs/api/assistant-threads-v1.md §9.1): orders, refunds
 * and stock from the connected store. There is no local order table: every
 * number is a LIVE read through the store's own adapter, capped, and labelled
 * `partial` when the cap was reached. A store that refuses (Shopify's
 * protected customer data, a missing scope) or cannot answer produces no card;
 * the assistant is told why in words it can repeat.
 */
import { prisma, nextWorkspaceDay } from "@chatcenter/shared";
import { executeAdapterTool } from "./connectors/integration-framework";
import { whenText } from "./system-tools.service";
import { dayStart, dayOf, tenantTimeZone, type QueryCtx, type ChartBlock, type BreakdownBlock, type RecordListBlock } from "./assistant-query.service";

type Locale = "he" | "en";
export type Store = "shopify" | "woocommerce";

export interface OrderQuery {
  from: string;
  to: string;
  measure: "orders" | "revenue" | "refunds";
  groupBy: "day" | "product";
}

export interface RecordBlock { type: "record"; id: string; title: string; sourceId: string; kind: "product"; fields: Array<{ key: string; label: string; value: string }>; deepLink: null; partial: null }
export interface CommerceSource { id: string; label: string; kind: "orders" | "refunds" | "product"; count: number | null; deepLink: null; query: { tool: "orders" | "product_stock"; params: unknown } }

export type Unavailable = { unavailable: "no_store" | "store_permission" | "store_error" | "not_supported"; message: string };

interface Line { productId: string | null; title: string; quantity: number }
interface NormOrder { id: string; name: string; createdAt: Date; total: number; currency: string | null; lines: Line[]; refunds: Array<{ createdAt: Date | null; amount: number; lines: Line[] }> }

const CAP = 250;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The workspace's connected store, if any. */
export async function connectedStore(tenantId: string): Promise<Store | null> {
  const rows = await prisma.tenantIntegration.findMany({
    where: { tenantId, status: "CONNECTED" as any, integration: { slug: { in: ["shopify", "woocommerce"] } } },
    select: { integration: { select: { slug: true } } },
  });
  const slugs = rows.map((r: any) => r.integration?.slug);
  return slugs.includes("shopify") ? "shopify" : slugs.includes("woocommerce") ? "woocommerce" : null;
}

const WORDS: Record<Unavailable["unavailable"], Record<Locale, string>> = {
  no_store: { he: "אין חנות מחוברת, אז אין נתוני הזמנות.", en: "No store is connected, so there are no order figures." },
  store_permission: { he: "החנות עדיין לא מאשרת גישה להזמנות (נדרש אישור מ-Shopify לנתוני לקוחות).", en: "The store does not allow reading orders yet (Shopify must approve access to customer data)." },
  store_error: { he: "החנות לא ענתה כרגע.", en: "The store did not answer just now." },
  not_supported: { he: "החנות הזו לא מספקת את הנתון הזה.", en: "This store does not provide that figure." },
};

function unavailable(kind: Unavailable["unavailable"], locale: Locale): Unavailable {
  return { unavailable: kind, message: WORDS[kind][locale] };
}

/** A refusal or failure from the adapter, in our words (never the store's raw text). */
function classify(reason: string, failure: "refused" | "errored"): Unavailable["unavailable"] {
  if (/403|protected customer data|not approved|access denied|scope/i.test(reason)) return "store_permission";
  if (/unknown_tool|not_supported|unsupported/i.test(reason)) return "not_supported";
  return failure === "errored" ? "store_error" : "store_permission";
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function fromShopify(o: any): NormOrder {
  const byLine = new Map<string, any>((o.line_items ?? []).map((li: any) => [String(li.id), li]));
  return {
    id: String(o.id), name: String(o.name ?? o.id), createdAt: new Date(o.created_at), total: num(o.total_price), currency: o.currency ?? null,
    lines: (o.line_items ?? []).map((li: any) => ({ productId: li.product_id == null ? null : String(li.product_id), title: String(li.title ?? ""), quantity: num(li.quantity) })),
    refunds: (o.refunds ?? []).map((r: any) => ({
      createdAt: r.created_at ? new Date(r.created_at) : null,
      amount: num(r.total),
      lines: (r.refund_line_items ?? []).map((rli: any) => {
        const li = byLine.get(String(rli.line_item_id));
        return { productId: li?.product_id == null ? null : String(li.product_id), title: String(li?.title ?? ""), quantity: num(rli.quantity) };
      }),
    })),
  };
}

function fromWoo(o: any): NormOrder {
  return {
    id: String(o.id), name: `#${o.number ?? o.id}`, createdAt: new Date(o.date_created_gmt ? `${o.date_created_gmt}Z` : o.date_created), total: num(o.total), currency: o.currency ?? null,
    lines: (o.line_items ?? []).map((li: any) => ({ productId: li.product_id == null ? null : String(li.product_id), title: String(li.name ?? ""), quantity: num(li.quantity) })),
    // The order list gives refunds without a date or lines: refunds are not
    // countable from it (the assistant says so).
    refunds: [],
  };
}

/** The store's orders created in [start, end), newest first, up to CAP. */
async function ordersInPeriod(tenantId: string, store: Store, start: Date, end: Date): Promise<{ orders: NormOrder[]; capped: boolean } | { fail: Unavailable["unavailable"] }> {
  if (store === "shopify") {
    const r = await executeAdapterTool({
      tenantId, toolFunctionName: "shopify.search_orders", accessScope: "internal",
      args: { status: "any", created_from: start.toISOString(), created_to: end.toISOString(), limit: CAP },
    });
    if (!r.ok) return { fail: classify(r.reason, r.failure) };
    const rows = Array.isArray(r.result) ? r.result : [];
    return { orders: rows.map(fromShopify), capped: rows.length >= CAP };
  }
  const orders: NormOrder[] = [];
  for (let page = 1; page <= 3 && orders.length < CAP; page++) {
    const r = await executeAdapterTool({
      tenantId, toolFunctionName: "woocommerce.list_orders", accessScope: "internal",
      args: { status: "any", after: start.toISOString(), before: end.toISOString(), per_page: 100, page },
    });
    if (!r.ok) return { fail: classify(r.reason, r.failure) };
    const rows = Array.isArray(r.result) ? r.result : [];
    orders.push(...rows.map(fromWoo));
    if (rows.length < 100) return { orders, capped: false };
  }
  return { orders: orders.slice(0, CAP), capped: true };
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (d <= end && out.length <= 92) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

export function normalizeOrderQuery(raw: any): OrderQuery | { error: string } {
  const from = String(raw?.from ?? ""), to = String(raw?.to ?? "");
  if (!DAY.test(from) || !DAY.test(to) || from > to) return { error: "from and to must be YYYY-MM-DD days, from <= to" };
  if (daysBetween(from, to).length > 92) return { error: "at most 92 days" };
  const measure = ["orders", "revenue", "refunds"].includes(raw?.measure) ? raw.measure : "orders";
  const groupBy = raw?.groupBy === "product" ? "product" : "day";
  return { from, to, measure, groupBy };
}

const T = {
  orders: { he: "הזמנות", en: "orders" },
  revenue: { he: "מכירות", en: "sales" },
  refunds: { he: "החזרים", en: "refunds" },
};

export interface CommerceResult { summary: Record<string, unknown>; blocks: Array<ChartBlock | BreakdownBlock | RecordListBlock | RecordBlock>; source: CommerceSource | null }

/** Orders, sales or refunds over a period, by day or by product. */
export async function queryOrders(ctx: QueryCtx, q: OrderQuery): Promise<CommerceResult> {
  const store = await connectedStore(ctx.tenantId);
  if (!store) return noCards(unavailable("no_store", ctx.locale));
  if (q.measure === "refunds" && store === "woocommerce") return noCards(unavailable("not_supported", ctx.locale));
  const tz = await tenantTimeZone(ctx.tenantId);
  const start = dayStart(q.from, tz), end = dayStart(nextWorkspaceDay(q.to), tz);
  const got = await ordersInPeriod(ctx.tenantId, store, start, end);
  if ("fail" in got) return noCards(unavailable(got.fail, ctx.locale));
  const { orders, capped } = got;
  const he = ctx.locale === "he";
  const currency = orders.find((o) => o.currency)?.currency ?? null;
  // Refunds are those on orders placed in the period (the only ones a period read returns).
  const refunds = orders.flatMap((o) => o.refunds);

  const sId = ctx.nextId("s");
  const total = q.measure === "orders" ? orders.length : q.measure === "revenue" ? round(sum(orders.map((o) => o.total))) : refunds.length;
  const period = `${whenText(new Date(`${q.from}T12:00:00Z`), ctx.locale, "UTC", false)} - ${whenText(new Date(`${q.to}T12:00:00Z`), ctx.locale, "UTC", false)}`;
  const source: CommerceSource = {
    id: sId, kind: q.measure === "refunds" ? "refunds" : "orders", count: q.measure === "revenue" ? orders.length : total, deepLink: null,
    label: q.measure === "revenue" ? `${orders.length} ${T.orders[ctx.locale]} · ${period}` : `${total} ${T[q.measure][ctx.locale]} · ${period}`,
    query: { tool: "orders", params: q },
  };
  const partial = capped ? { reason: "capped", cap: CAP } : null;
  const unit = q.measure === "revenue" ? ("currency" as const) : ("count" as const);
  const blocks: Array<ChartBlock | BreakdownBlock | RecordListBlock> = [];

  if (q.groupBy === "day") {
    const days = daysBetween(q.from, q.to);
    const by = new Map(days.map((d) => [d, 0]));
    const add = (when: Date | null, v: number) => { if (!when) return; const d = dayOf(when, tz); if (by.has(d)) by.set(d, by.get(d)! + v); };
    if (q.measure === "refunds") refunds.forEach((r) => add(r.createdAt, 1));
    else orders.forEach((o) => add(o.createdAt, q.measure === "revenue" ? o.total : 1));
    const values = days.map((d) => round(by.get(d)!));
    const max = Math.max(0, ...values);
    blocks.push({
      type: "chart", id: ctx.nextId("b"), title: he ? `${T[q.measure].he} לפי יום` : `${cap1(T[q.measure].en)} by day`, sourceId: sId, kind: "bar",
      x: { kind: "day", values: days }, series: [{ key: q.measure, label: cap1(T[q.measure][ctx.locale]), values }],
      unit, currency: unit === "currency" ? currency : null, highlight: max > 0 ? days.filter((_, i) => values[i] === max) : [], deepLink: null, partial,
    });
  } else {
    const by = new Map<string, { label: string; value: number }>();
    const add = (l: Line, v: number) => { const k = l.productId ?? l.title; const e = by.get(k) ?? { label: l.title || k, value: 0 }; e.value += v; by.set(k, e); };
    // By product the measure is UNITS (sold or refunded): an order's total is
    // not split across its lines, so "sales by product" is units, and the
    // card's title says so.
    if (q.measure === "refunds") refunds.forEach((r) => r.lines.forEach((l) => add(l, l.quantity)));
    else orders.forEach((o) => o.lines.forEach((l) => add(l, l.quantity)));
    const all = [...by.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    const sumAll = sum(all.map((i) => i.value));
    const top = all.slice(0, 8);
    const rest = sum(all.slice(8).map((i) => i.value));
    blocks.push({
      type: "breakdown", id: ctx.nextId("b"), sourceId: sId,
      title: q.measure === "refunds" ? (he ? "יחידות שהוחזרו לפי מוצר" : "Units refunded by product") : (he ? "יחידות שנמכרו לפי מוצר" : "Units sold by product"),
      items: top.map((i) => ({ key: i.key, label: i.label, value: i.value, share: sumAll ? i.value / sumAll : 0 })),
      total: sumAll, unit: "count", currency: null, other: rest ? { label: he ? "אחר" : "Other", value: rest } : null, coverage: null, deepLink: null, partial: null,
    });
  }

  if (q.measure === "refunds" && refunds.length) {
    // The rows behind a refund count: which orders were refunded.
    const rows = orderRows(orders.filter((o) => o.refunds.length), ctx.locale, tz);
    blocks.push({
      type: "record_list", id: ctx.nextId("b"), sourceId: sId, kind: "order",
      title: he ? "הזמנות עם החזר" : "Refunded orders",
      items: rows.slice(0, 5), total: rows.length, hasMore: rows.length > 5, deepLink: null, partial: null,
    });
  }

  return {
    summary: {
      ok: true, cite: sId, store, total, ...(unit === "currency" ? { currency } : {}), period,
      ...(capped ? { note: `counted the latest ${CAP} orders of the period` } : {}),
      ...(q.measure === "refunds" ? { note2: "refunds on orders placed in the period" } : {}),
      shownAs: "cards the user already sees; summarise, do not repeat every number, cite the source",
    },
    blocks,
    source,
  };
}

/** A product's stock, per variant, from the store. */
export async function queryProductStock(ctx: QueryCtx, query: string): Promise<CommerceResult> {
  const store = await connectedStore(ctx.tenantId);
  if (!store) return noCards(unavailable("no_store", ctx.locale));
  const he = ctx.locale === "he";
  const found = await executeAdapterTool({
    tenantId: ctx.tenantId, accessScope: "internal",
    toolFunctionName: store === "shopify" ? "shopify.search_products" : "woocommerce.list_products",
    args: store === "shopify" ? { query, limit: 3, status: "any", in_stock_only: false } : { query, per_page: 3 },
  });
  if (!found.ok) return noCards(unavailable(classify(found.reason, found.failure), ctx.locale));
  const products: any[] = Array.isArray(found.result) ? found.result : Array.isArray((found.result as any)?.products) ? (found.result as any).products : [];
  if (!products.length) return { summary: { ok: true, found: 0, note: he ? "לא נמצא מוצר כזה" : "no such product" }, blocks: [], source: null };

  const sId = ctx.nextId("s");
  const blocks: RecordBlock[] = [];
  for (const p of products.slice(0, 3)) {
    let variants: Array<{ title: string; qty: number | null }> = [];
    if (store === "shopify") {
      const inv = await executeAdapterTool({ tenantId: ctx.tenantId, accessScope: "internal", toolFunctionName: "shopify.inventory_status", args: { product_id: String(p.id ?? p.product_id) } });
      if (inv.ok && Array.isArray(inv.result)) variants = (inv.result as any[]).map((v) => ({ title: String(v.title ?? ""), qty: v.inventory_quantity == null ? null : num(v.inventory_quantity) }));
    } else {
      variants = [{ title: "", qty: p.stock_quantity == null ? null : num(p.stock_quantity) }];
    }
    const known = variants.filter((v) => v.qty != null);
    const totalQty = sum(known.map((v) => v.qty!));
    blocks.push({
      type: "record", id: ctx.nextId("b"), title: String(p.title ?? p.name ?? ""), sourceId: sId, kind: "product", deepLink: null, partial: null,
      fields: [
        { key: "stock", label: he ? "במלאי" : "In stock", value: known.length ? String(totalQty) : (he ? "לא מנוהל" : "Not tracked") },
        ...variants.filter((v) => v.title && v.title !== "Default Title" && v.qty != null).slice(0, 8)
          .map((v) => ({ key: `variant:${v.title}`, label: v.title, value: String(v.qty) })),
      ],
    });
  }
  return {
    summary: { ok: true, cite: sId, found: blocks.length, products: blocks.map((b) => ({ title: b.title, inStock: b.fields[0]!.value })), shownAs: "cards the user already sees; cite the source" },
    blocks,
    source: { id: sId, kind: "product", count: blocks.length, deepLink: null, label: blocks.map((b) => b.title).join(", "), query: { tool: "product_stock", params: { query } } },
  };
}

export interface OrderRow { id: string; title: string; subtitle: string; meta: string; deepLink: null }

function money(n: number, currency: string | null, locale: Locale): string {
  if (!currency) return String(round(n));
  try { return new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", { style: "currency", currency }).format(n); } catch { return `${round(n)} ${currency}`; }
}

function orderRows(orders: NormOrder[], locale: Locale, tz: string): OrderRow[] {
  return orders.map((o) => {
    const refunded = sum(o.refunds.map((r) => r.amount));
    const units = sum(o.lines.map((l) => l.quantity));
    const items = locale === "he" ? `${units} פריטים` : `${units} item${units === 1 ? "" : "s"}`;
    return {
      id: o.id, title: o.name,
      subtitle: refunded > 0 ? `${money(o.total, o.currency, locale)} · ${locale === "he" ? "הוחזרו" : "refunded"} ${money(refunded, o.currency, locale)}` : `${money(o.total, o.currency, locale)} · ${items}`,
      meta: whenText(o.createdAt, locale, tz, false), deepLink: null,
    };
  });
}

/**
 * The full list behind an orders/refunds source (§9.4): the saved query
 * re-read from the store, 25 a page. The cursor is the row offset.
 * Null when the store can no longer be read.
 */
export async function listOrdersForSource(tenantId: string, locale: Locale, q: OrderQuery, cursor: string | null): Promise<{ data: OrderRow[]; nextCursor: string | null } | null> {
  const store = await connectedStore(tenantId);
  if (!store) return null;
  const tz = await tenantTimeZone(tenantId);
  const got = await ordersInPeriod(tenantId, store, dayStart(q.from, tz), dayStart(nextWorkspaceDay(q.to), tz));
  if ("fail" in got) return null;
  const rows = orderRows(q.measure === "refunds" ? got.orders.filter((o) => o.refunds.length) : got.orders, locale, tz);
  const at = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
  const page = rows.slice(at, at + 25);
  return { data: page, nextCursor: at + 25 < rows.length ? String(at + 25) : null };
}

function noCards(u: Unavailable): CommerceResult {
  return { summary: { ok: false, ...u }, blocks: [], source: null };
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round = (n: number) => Math.round(n * 100) / 100;
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
