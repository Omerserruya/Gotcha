/**
 * What a customer has bought, for the Customers list - in bulk.
 *
 * The list shows "₪2,140 · 6 orders" per row and "who your customers are"
 * (bought once / came back / wholesale / never bought). There is no local order
 * table to read, and one connector call per row is fifty calls per page. So the
 * store's orders are read ONCE per tenant (paged, capped), reduced to the few
 * fields the list needs, cached briefly in Redis, and matched to contacts by
 * email and by phone. Every row and every count comes from that one read.
 *
 * Provider: WooCommerce today (read with the connection's own keys). A store
 * that is not connected - or a provider not wired here yet - answers
 * `source: null` with a reason, never zeros: "no orders" and "we could not
 * look" are different facts, and only the first one is true of a customer.
 */
import { prisma, getRedis, assertPublicUrl } from "@chatcenter/shared";
import { loadConnection } from "./connectors/integration-framework";

export interface SlimOrder {
  number: string;
  status: string;
  total: number;
  currency: string;
  createdAt: string;
  email: string | null;
  phone: string | null;
}

export interface CommerceSummary {
  lifetimeValue: number;
  currency: string | null;
  orderCount: number;
  lastOrderAt: string | null;
}

export type OrdersSource =
  | { source: "woocommerce"; orders: SlimOrder[]; truncated: boolean }
  | { source: null; reason: "no_store_connected" | "store_unreachable" | "provider_not_supported" };

/** Orders that represent a purchase. Cancelled, refunded, failed and unpaid ones do not. */
const PURCHASE_STATUSES = new Set(["completed", "processing", "on-hold"]);
const CACHE_TTL_SECONDS = 600;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export function emailKey(email: unknown): string | null {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  return e.includes("@") ? e : null;
}

/** The last 9 digits - enough to match +972-50-…, 050-…, 50… as one number. */
export function phoneKey(phone: unknown): string | null {
  const d = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
  return d.length >= 7 ? d.slice(-9) : null;
}

async function fetchWooOrders(storeUrl: string, consumerKey: string, consumerSecret: string): Promise<{ orders: SlimOrder[]; truncated: boolean }> {
  const auth = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;
  const out: SlimOrder[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${storeUrl}/wp-json/wc/v3/orders?per_page=${PAGE_SIZE}&page=${page}&orderby=date&order=desc`;
    await assertPublicUrl(url);
    const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
    if (!res.ok) throw new Error(`woocommerce_${res.status}`);
    const rows = (await res.json()) as any[];
    for (const o of rows) {
      out.push({
        number: String(o.number ?? o.id),
        status: String(o.status ?? ""),
        total: Number(o.total ?? 0) || 0,
        currency: String(o.currency ?? ""),
        createdAt: String(o.date_created_gmt ? `${o.date_created_gmt}Z` : o.date_created ?? ""),
        email: emailKey(o.billing?.email),
        phone: phoneKey(o.billing?.phone),
      });
    }
    const totalPages = Number(res.headers.get("x-wp-totalpages") || 1);
    if (rows.length < PAGE_SIZE || page >= totalPages) return { orders: out, truncated: false };
  }
  return { orders: out, truncated: true };
}

/** The tenant's orders, from the cache or one paged read of the store. */
export async function loadTenantOrders(tenantId: string): Promise<OrdersSource> {
  const woo = await loadConnection({ tenantId, slug: "woocommerce" }).catch(() => null);
  if (!woo || woo.status !== "CONNECTED") {
    const shop = await loadConnection({ tenantId, slug: "shopify" }).catch(() => null);
    return { source: null, reason: shop && shop.status === "CONNECTED" ? "provider_not_supported" : "no_store_connected" };
  }

  const cacheKey = `customers:orders:${tenantId}:woocommerce`;
  try {
    const cached = await getRedis().get(cacheKey);
    if (cached) return { source: "woocommerce", ...(JSON.parse(cached) as { orders: SlimOrder[]; truncated: boolean }) };
  } catch { /* a cold cache is only slower */ }

  const storeUrl = String(woo.config?.storeUrl || "").replace(/\/+$/, "");
  const ck = woo.credentials.consumerKey || woo.credentials.consumer_key;
  const cs = woo.credentials.consumerSecret || woo.credentials.consumer_secret;
  if (!storeUrl || !ck || !cs) return { source: null, reason: "store_unreachable" };
  try {
    const result = await fetchWooOrders(storeUrl, String(ck), String(cs));
    await getRedis().set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL_SECONDS).catch(() => undefined);
    return { source: "woocommerce", ...result };
  } catch (err: any) {
    console.warn(`[customer-commerce] store read failed tenant=${tenantId}: ${err?.message}`);
    return { source: null, reason: "store_unreachable" };
  }
}

/** Index purchases by email and by phone key. */
export function indexOrders(orders: SlimOrder[]): { byEmail: Map<string, SlimOrder[]>; byPhone: Map<string, SlimOrder[]> } {
  const byEmail = new Map<string, SlimOrder[]>();
  const byPhone = new Map<string, SlimOrder[]>();
  for (const o of orders) {
    if (!PURCHASE_STATUSES.has(o.status)) continue;
    if (o.email) byEmail.set(o.email, [...(byEmail.get(o.email) ?? []), o]);
    if (o.phone) byPhone.set(o.phone, [...(byPhone.get(o.phone) ?? []), o]);
  }
  return { byEmail, byPhone };
}

/** One customer's purchases: union of email and phone matches, each order once. */
export function summarizeContact(
  contact: { email?: string | null; phone?: string | null; externalId?: string | null },
  index: ReturnType<typeof indexOrders>,
): CommerceSummary {
  const seen = new Map<string, SlimOrder>();
  const e = emailKey(contact.email);
  const p = phoneKey(contact.phone) ?? phoneKey(contact.externalId);
  for (const o of e ? index.byEmail.get(e) ?? [] : []) seen.set(o.number, o);
  for (const o of p ? index.byPhone.get(p) ?? [] : []) seen.set(o.number, o);
  const orders = [...seen.values()];
  if (orders.length === 0) return { lifetimeValue: 0, currency: null, orderCount: 0, lastOrderAt: null };
  const currencies = new Set(orders.map((o) => o.currency));
  return {
    // A sum across currencies is not an amount of money; say nothing instead.
    lifetimeValue: currencies.size === 1 ? Math.round(orders.reduce((s, o) => s + o.total, 0) * 100) / 100 : 0,
    currency: currencies.size === 1 ? [...currencies][0] : null,
    orderCount: orders.length,
    lastOrderAt: orders.map((o) => o.createdAt).sort().at(-1) ?? null,
  };
}

export type CustomerSegment = "wholesale" | "came_back" | "bought_once" | "never_bought";

export function segmentOf(summary: CommerceSummary, tags: unknown): CustomerSegment {
  const t = Array.isArray(tags) ? tags.map((x) => String(x).toLowerCase()) : [];
  if (t.includes("wholesale")) return "wholesale";
  if (summary.orderCount > 1) return "came_back";
  if (summary.orderCount === 1) return "bought_once";
  return "never_bought";
}

/** Summaries for the given contacts of this tenant. Unknown ids are simply absent. */
export async function commerceSummaries(tenantId: string, contactIds: string[]) {
  const src = await loadTenantOrders(tenantId);
  if (src.source === null) return { source: null, reason: src.reason, data: {} as Record<string, CommerceSummary> };
  const contacts = await prisma.contact.findMany({
    where: { tenantId, id: { in: contactIds } },
    select: { id: true, email: true, phone: true, externalId: true },
  });
  const index = indexOrders(src.orders);
  const data: Record<string, CommerceSummary> = {};
  for (const c of contacts) data[c.id] = summarizeContact(c, index);
  return { source: src.source, truncated: src.truncated, data };
}

/** Counts per segment over the tenant's contacts (merged-away contacts excluded). */
export async function segmentCounts(tenantId: string) {
  const src = await loadTenantOrders(tenantId);
  if (src.source === null) return { source: null, reason: src.reason, counts: null };
  const contacts = await prisma.contact.findMany({
    where: { tenantId, mergedIntoId: null },
    select: { email: true, phone: true, externalId: true, tags: true },
    take: 10_000,
  });
  const index = indexOrders(src.orders);
  const counts: Record<CustomerSegment, number> = { bought_once: 0, came_back: 0, wholesale: 0, never_bought: 0 };
  for (const c of contacts) counts[segmentOf(summarizeContact(c, index), c.tags)]++;
  return { source: src.source, truncated: src.truncated, total: contacts.length, counts };
}

/** The contact behind an order number, matched by the order's email or phone. */
export async function contactByOrderNumber(tenantId: string, orderNumber: string) {
  const wanted = orderNumber.trim().replace(/^#/, "");
  if (!wanted) return { source: null, reason: "empty", contactId: null };
  const src = await loadTenantOrders(tenantId);
  if (src.source === null) return { source: null, reason: src.reason, contactId: null };
  const order = src.orders.find((o) => o.number === wanted);
  if (!order) return { source: src.source, contactId: null, orderNumber: wanted };
  const or: any[] = [];
  if (order.email) or.push({ email: { equals: order.email, mode: "insensitive" } });
  if (order.phone) or.push({ phone: { endsWith: order.phone } }, { externalId: { endsWith: order.phone } });
  const contact = or.length
    ? await prisma.contact.findFirst({ where: { tenantId, mergedIntoId: null, OR: or }, select: { id: true } })
    : null;
  return { source: src.source, contactId: contact?.id ?? null, orderNumber: wanted };
}
