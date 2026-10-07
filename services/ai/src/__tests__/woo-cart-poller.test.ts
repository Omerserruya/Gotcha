/**
 * The WooCommerce cart poller: waiting orders become carts to watch, paid
 * ones mark the checkout bought - and the customer's store is treated gently.
 *   - ★ first poll reads nothing and starts the cursor now
 *   - ★ only orders modified since the cursor, 20 a page, at most 3 pages
 *   - ★ a 429 / error backs that store off, doubling; the next tick skips it
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ redis: new Map<string, string>(), queued: [] as any[] }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getRedis: () => ({
      get: async (k: string) => H.redis.get(k) ?? null,
      set: async (k: string, v: string) => { H.redis.set(k, v); return "OK"; },
    }),
    incomingMessageQueue: { add: async (name: string, data: any) => { H.queued.push({ name, data }); } },
    decryptCredentials: (x: any) => x,
    assertPublicUrl: async () => undefined,
  };
});

import { cartEventFromWooOrder, orderEventFromWooOrder, pollWooConnection } from "../services/woo-cart-poller.service";

const conn = { id: "ti1", tenantId: "T", credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: "https://shop.example.com" } };
const order = (id: number, status: string, modified: string) => ({
  id, status, date_modified_gmt: modified, currency: "ILS", total: "590.00", payment_url: `https://shop.example.com/pay/${id}`,
  billing: { first_name: "Dana", email: "dana@example.com", phone: "0501234567" },
  line_items: [{ name: "Coat", quantity: 1, price: 590 }],
});

beforeEach(() => { H.redis = new Map(); H.queued = []; });

describe("★ WooCommerce cart poller", () => {
  it("waiting orders are carts, paid ones complete them, others say nothing; no consent from the store", () => {
    expect(cartEventFromWooOrder("T", order(7, "checkout-draft", "2026-10-07T10:00:00"))).toMatchObject({
      checkoutId: "woo:7", completed: false, cartUrl: "https://shop.example.com/pay/7", customer: { firstName: "Dana", phone: "0501234567" }, marketingConsent: null,
    });
    expect(cartEventFromWooOrder("T", order(7, "processing", "x"))!.completed).toBe(true);
    expect(cartEventFromWooOrder("T", order(7, "refunded", "x"))).toBeNull();
  });

  it("★ the first poll reads nothing and starts from now", async () => {
    const fetchImpl = vi.fn();
    expect(await pollWooConnection(conn, new Date("2026-10-07T10:00:00Z"), fetchImpl as any)).toEqual({ queued: 0, status: "first_poll" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(H.redis.get("woo:cart-cursor:ti1")).toBe("2026-10-07T10:00:00");
  });

  it("★ only orders changed since the cursor, 20 a page, at most 3 pages; the cursor moves to the newest", async () => {
    H.redis.set("woo:cart-cursor:ti1", "2026-10-07T09:00:00");
    const urls: string[] = [];
    const full = Array.from({ length: 20 }, (_, i) => order(100 + i, "pending", `2026-10-07T09:${String(10 + i).padStart(2, "0")}:00`));
    const fetchImpl = vi.fn(async (url: string) => { urls.push(url); return { ok: true, status: 200, json: async () => full }; });
    const r = await pollWooConnection(conn, new Date(), fetchImpl as any);
    expect(r).toEqual({ queued: 60, status: "ok" });
    expect(urls).toHaveLength(3);
    const q = new URL(urls[0]!).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ modified_after: "2026-10-07T09:00:00", per_page: "20", page: "1", status: "any", orderby: "modified", order: "asc" });
    expect(H.redis.get("woo:cart-cursor:ti1")).toBe("2026-10-07T09:29:00");
    expect(H.queued[0]).toMatchObject({ name: "cart-event", data: { tenantId: "T", source: "woocommerce", checkoutId: "woo:100" } });
  });

  it("★ a 429 backs the store off and the next tick skips it; the backoff doubles", async () => {
    H.redis.set("woo:cart-cursor:ti1", "2026-10-07T09:00:00");
    const tooMany = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    expect((await pollWooConnection(conn, new Date(), tooMany as any)).status).toBe("backoff");
    expect(H.redis.get("woo:cart-backoff:ti1:last")).toBe(String(15 * 60));
    expect((await pollWooConnection(conn, new Date(), tooMany as any)).status).toBe("skipped");
    expect(tooMany).toHaveBeenCalledTimes(1);
    H.redis.delete("woo:cart-backoff:ti1"); // the TTL ran out
    await pollWooConnection(conn, new Date(), tooMany as any);
    expect(H.redis.get("woo:cart-backoff:ti1:last")).toBe(String(30 * 60));
    expect(H.redis.get("woo:cart-cursor:ti1")).toBe("2026-10-07T09:00:00"); // never moved on failure
  });
});

describe("★ WooCommerce orders → order events (same gentle read)", () => {
  it("on-hold → created, processing → paid, completed → fulfilled, cancelled / refunded → cancelled; pending is a cart, not an order event", () => {
    const st = (s: string) => orderEventFromWooOrder("T", { ...order(9, s, "x"), number: "1042" })?.status ?? null;
    expect(["on-hold", "processing", "completed", "cancelled", "refunded", "pending", "checkout-draft", "failed"].map(st))
      .toEqual(["created", "paid", "fulfilled", "cancelled", "cancelled", null, null, null]);
    expect(orderEventFromWooOrder("T", { ...order(9, "completed", "x"), number: "1042" })).toMatchObject({
      source: "woocommerce", orderId: "9", orderNumber: "#1042", total: 590, customer: { firstName: "Dana", phone: "0501234567" }, items: [{ title: "Coat", quantity: 1 }],
    });
  });

  it("a poll queues the order event beside the cart event", async () => {
    H.redis.set("woo:cart-cursor:ti1", "2026-10-07T09:00:00");
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => [order(9, "processing", "2026-10-07T09:30:00"), order(10, "completed", "2026-10-07T09:31:00")] }));
    await pollWooConnection(conn, new Date(), fetchImpl as any);
    expect(H.queued.map((q) => [q.name, q.data.status ?? (q.data.completed ? "bought" : "cart")])).toEqual([
      ["cart-event", "bought"], ["order-event", "paid"], ["cart-event", "bought"], ["order-event", "fulfilled"],
    ]);
  });
});

