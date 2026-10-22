/**
 * WooCommerce has no cart webhook. What a store DOES create is an order that
 * waits for payment: `pending` (classic checkout, payment not completed) and
 * `checkout-draft` (the block checkout's draft). This poller reads orders the
 * store CHANGED since the last poll and turns them into the shared cart event:
 * waiting → a checkout to watch; paid (processing / completed / on-hold) →
 * that checkout is bought.
 *
 * Gentle on the customer's store, by design:
 *   - only orders modified since this connection's last poll (`modified_after`)
 *   - 20 per page, at most 3 pages a tick, every 15 minutes
 *   - a 429 or an error backs that store off (15 min, doubling, max 6 h)
 *   - the first poll starts NOW: history is never replayed
 * Consent: WooCommerce stores none, so these carts reach only customers with a
 * granted ConsentRecord (the cart service decides; the trigger says so).
 *
 * The same read feeds "Order event" automations: a changed order with a
 * status that means something becomes an order event (once per order per
 * status, deduped by the incoming worker). Polling, not a Woo webhook: it
 * needs nothing written to the customer's store.
 */
import { prisma, getRedis, incomingMessageQueue, decryptCredentials, assertPublicUrl, withCrossTenantAccess, type CartEventJob, type OrderEventJob, type OrderStatus } from "@chatcenter/shared";
import { normalizeStoreUrl } from "./connectors/woocommerce.adapter";

const PER_PAGE = 20;
const MAX_PAGES = 3;
const TICK_MS = 15 * 60_000;
const BACKOFF_BASE_S = 15 * 60;
const BACKOFF_MAX_S = 6 * 3600;
const WAITING = new Set(["pending", "checkout-draft"]);
const PAID = new Set(["processing", "completed", "on-hold"]);

/** Woo status → order event. `pending` is a checkout waiting for payment (carts), not an order event. */
const ORDER_STATUS: Record<string, OrderStatus> = {
  "on-hold": "created", processing: "paid", completed: "fulfilled", cancelled: "cancelled", refunded: "cancelled",
};

const cursorKey = (id: string) => `woo:cart-cursor:${id}`;
const backoffKey = (id: string) => `woo:cart-backoff:${id}`;

/** One Woo order as a cart event, or null for a status that says nothing about a cart. */
export function cartEventFromWooOrder(tenantId: string, order: any): CartEventJob | null {
  const status = String(order?.status ?? "");
  if (!order?.id || (!WAITING.has(status) && !PAID.has(status))) return null;
  const billing = order.billing ?? {};
  return {
    tenantId,
    source: "woocommerce",
    checkoutId: `woo:${order.id}`,
    completed: PAID.has(status),
    updatedAt: String(order.date_modified_gmt ?? order.date_modified ?? new Date().toISOString()),
    customer: { email: billing.email || null, phone: billing.phone || null, firstName: billing.first_name || null },
    items: (Array.isArray(order.line_items) ? order.line_items : []).map((l: any) => ({
      title: String(l?.name ?? ""), quantity: Number(l?.quantity ?? 1) || 1, price: Number.isFinite(Number(l?.price)) ? Number(l.price) : null,
    })).filter((i: any) => i.title),
    total: Number.isFinite(Number(order.total)) ? Number(order.total) : null,
    currency: order.currency ?? null,
    // The store's own "pay for this order" link.
    cartUrl: order.payment_url ?? null,
    marketingConsent: null,
  };
}

/** One Woo order as an order event, or null for a status that is not one. */
export function orderEventFromWooOrder(tenantId: string, order: any): OrderEventJob | null {
  const status = ORDER_STATUS[String(order?.status ?? "")];
  if (!order?.id || !status) return null;
  const billing = order.billing ?? {};
  return {
    tenantId,
    source: "woocommerce",
    orderId: String(order.id),
    status,
    orderNumber: `#${order.number ?? order.id}`,
    total: Number.isFinite(Number(order.total)) ? Number(order.total) : null,
    currency: order.currency ?? null,
    customer: { email: billing.email || null, phone: billing.phone || null, firstName: billing.first_name || null },
    items: (Array.isArray(order.line_items) ? order.line_items : []).map((l: any) => ({ title: String(l?.name ?? ""), quantity: Number(l?.quantity ?? 1) || 1 })).filter((i: any) => i.title),
    orderUrl: null,
  };
}

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; headers?: any }>;

/** One connection, one tick. Returns how many cart events it queued. */
export async function pollWooConnection(
  conn: { id: string; tenantId: string; credentials: any; config: any },
  now: Date,
  fetchImpl: FetchLike = fetch as any,
): Promise<{ queued: number; status: "ok" | "skipped" | "backoff" | "first_poll" }> {
  const redis = getRedis();
  if (await redis.get(backoffKey(conn.id))) return { queued: 0, status: "skipped" };
  const cursor = await redis.get(cursorKey(conn.id));
  if (!cursor) {
    // First poll: remember now, read nothing older.
    await redis.set(cursorKey(conn.id), now.toISOString().slice(0, 19)); // Woo's GMT form
    return { queued: 0, status: "first_poll" };
  }
  let creds: any = {};
  try { creds = typeof conn.credentials === "string" ? decryptCredentials(conn.credentials) : conn.credentials ?? {}; } catch { creds = {}; }
  const key = creds.consumerKey || creds.consumer_key;
  const secret = creds.consumerSecret || creds.consumer_secret;
  const store = normalizeStoreUrl(conn.config?.storeUrl || creds.storeUrl || creds.store_url);
  if (!key || !secret || !store) return { queued: 0, status: "skipped" };
  const auth = `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;

  let queued = 0;
  let newest = cursor;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      modified_after: cursor, per_page: String(PER_PAGE), page: String(page), orderby: "modified", order: "asc", status: "any",
      // Dates in GMT on both sides.
      dates_are_gmt: "true",
    });
    const url = `${store}/wp-json/wc/v3/orders?${qs.toString()}`;
    let res;
    try {
      await assertPublicUrl(url);
      res = await fetchImpl(url, { headers: { Authorization: auth, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    } catch {
      res = null;
    }
    if (!res || !res.ok) {
      const prev = Number(await redis.get(`${backoffKey(conn.id)}:last`)) || 0;
      const next = Math.min(prev ? prev * 2 : BACKOFF_BASE_S, BACKOFF_MAX_S);
      await redis.set(backoffKey(conn.id), "1", "EX", next);
      await redis.set(`${backoffKey(conn.id)}:last`, String(next), "EX", BACKOFF_MAX_S * 2);
      return { queued, status: "backoff" };
    }
    const orders: any[] = await res.json().catch(() => []);
    for (const o of Array.isArray(orders) ? orders : []) {
      const ev = cartEventFromWooOrder(conn.tenantId, o);
      if (ev) {
        await incomingMessageQueue.add("cart-event", ev, { attempts: 3, removeOnComplete: true, removeOnFail: 100 });
        queued++;
      }
      const oe = orderEventFromWooOrder(conn.tenantId, o);
      if (oe) {
        await incomingMessageQueue.add("order-event", oe, { attempts: 3, removeOnComplete: true, removeOnFail: 100 });
        queued++;
      }
      const m = String(o?.date_modified_gmt ?? "");
      if (m && m > newest) newest = m;
    }
    if (!Array.isArray(orders) || orders.length < PER_PAGE) break;
  }
  await redis.set(cursorKey(conn.id), newest);
  await redis.set(`${backoffKey(conn.id)}:last`, "0");
  return { queued, status: "ok" };
}

/**
 * One tick over every CONNECTED WooCommerce store that has a live cart or
 * order automation. A workspace without one is never polled.
 */
export async function pollWooCarts(now = new Date()): Promise<number> {
  // Deliberately cross-tenant: which workspaces have a live cart / order
  // automation, then their stores. Without the wrapper the TenantGuard blocked
  // the first query and every tick failed before polling anything (2026-10-14:
  // no Woo cart or order automation had ever fired). Everything after this is
  // per store: pollWooConnection only talks to that store, Redis and the queue,
  // and each job carries its connection's own tenantId.
  const conns = await withCrossTenantAccess(async () => {
    const tenants = await prisma.chatbotFlow.findMany({
      where: { isActive: true, triggerType: { in: ["cart_abandoned", "order_event"] } },
      select: { tenantId: true },
      distinct: ["tenantId"],
    } as any);
    const ids = [...new Set((tenants as any[]).map((t) => t.tenantId))];
    if (!ids.length) return [];
    return prisma.tenantIntegration.findMany({
      where: { tenantId: { in: ids }, status: "CONNECTED", integration: { slug: "woocommerce" } },
      select: { id: true, tenantId: true, credentials: true, config: true },
    });
  });
  let total = 0;
  for (const c of conns as any[]) {
    const r = await pollWooConnection(c, now).catch((err) => { console.warn(`[woo-carts] ${c.id}:`, err?.message); return { queued: 0 }; });
    total += r.queued;
  }
  return total;
}

/**
 * One poll per tick across every replica (2026-10-09 review: each replica ran
 * its own setInterval, so every one of them polled every store). The first
 * replica to take the tick's Redis lock polls; the others skip it. The lock is
 * NOT released after the poll: releasing early would let a replica whose timer
 * fires a minute later poll the same window again. It expires a minute before
 * the next tick, so a replica that died holding it costs one tick at most.
 */
export const WOO_TICK_LOCK_KEY = "woo-carts:tick-lock";
const TICK_LOCK_MS = TICK_MS - 60_000;

export async function pollWooCartsIfLeader(now = new Date(), owner = `${process.pid}:${Math.random().toString(36).slice(2)}`): Promise<number | null> {
  const won = await getRedis().set(WOO_TICK_LOCK_KEY, owner, "PX", TICK_LOCK_MS, "NX");
  if (won !== "OK") return null;
  return pollWooCarts(now);
}

let timer: NodeJS.Timeout | null = null;
export function startWooCartPoller(): void {
  if (timer) return;
  timer = setInterval(() => { pollWooCartsIfLeader().catch((err) => console.warn("[woo-carts] tick failed:", err?.message)); }, TICK_MS);
  timer.unref?.();
}
