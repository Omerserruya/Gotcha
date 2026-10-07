/**
 * Shopify webhooks - one app, one secret, two consequences.
 *
 * The isolation these tests used to assert was between two Shopify apps.
 * There is now ONE app, so the secret is shared and the property under test
 * changes: every route verifies against the CORE secret, the retired Chat
 * secret is refused everywhere, and the two route families still produce
 * DIFFERENT consequences even though they no longer have different keys.
 *
 * The consequences are the part that still matters. A core uninstall now
 * disables chat too (the Theme App Extension left with the app), while a
 * chat-route delivery must still never disconnect commerce.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.SHOPIFY_CHAT_APP_CLIENT_ID = "chat-client-id";
  process.env.SHOPIFY_CHAT_APP_SECRET = "chat-app-secret";
  process.env.SHOPIFY_API_KEY = "core-client-id";
  process.env.SHOPIFY_API_SECRET = "core-app-secret";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    seen: new Set<string>(),
    connections: { current: [] as any[] },
    installation: { current: null as any },
    markUninstalled: v.fn(),
    disableChatOnUninstall: v.fn(async () => ({ disabled: true })),
    updateConnection: v.fn(async () => ({})),
    updateInstallations: v.fn(async () => ({ count: 1 })),
    createAudit: v.fn(async () => ({})),
    enqueue: v.fn(async () => ({})),
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withCrossTenantAccess: async (fn: any) => fn(),
    incomingMessageQueue: { add: H.enqueue },
    getRedis: () => ({
      // Mirrors SET NX: first claim wins, later ones are replays.
      set: vi.fn(async (key: string, _v: string, _ex: string, _ttl: number, mode: string) => {
        if (mode === "NX" && H.seen.has(key)) return null;
        H.seen.add(key);
        return "OK";
      }),
    }),
    prisma: {
      auditLog: { create: H.createAudit },
      tenantIntegration: {
        findMany: vi.fn(async () => H.connections.current),
        update: H.updateConnection,
      },
      shopifyChatInstallation: { updateMany: H.updateInstallations },
    },
  };
});

vi.mock("../services/shopify-chat-install.service", () => ({
  markUninstalledByShop: H.markUninstalled,
  findLatestInstallation: vi.fn(async () => H.installation.current),
  disableChatForUninstalledShop: H.disableChatOnUninstall,
}));

// app/uninstalled tells billing over HTTP. Left real, that fetch resolved
// after its test had finished and failed the NEXT one; it is not what these
// tests are about, and a test must not reach the network.
vi.mock("../services/shopify-billing-bridge.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, notifyShopifyUninstalled: vi.fn(async () => {}) };
});

import router from "../routes/shopify-webhooks";

function app() {
  const a = express();
  // Mirrors createServiceApp: the raw body must survive JSON parsing or no
  // signature can ever be verified.
  a.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  a.use("/api", router);
  return a;
}

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("base64");
}

const SHOP = "my-store.myshopify.com";

beforeEach(() => {
  vi.clearAllMocks();
  H.seen.clear();
  H.installation.current = { id: "i1", shopDomain: SHOP, tenantId: "t1", status: "ACTIVE" };
  H.markUninstalled.mockResolvedValue({ id: "i1", shopDomain: SHOP, tenantId: "t1", status: "UNINSTALLED" });
  H.disableChatOnUninstall.mockResolvedValue({ disabled: true });
  H.connections.current = [{ id: "ti1", tenantId: "t1", config: { shopDomain: SHOP } }];
});

async function post(path: string, secret: string, body: any = { shop_domain: SHOP }, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  return request(app())
    .post(path)
    .set("Content-Type", "application/json")
    .set("X-Shopify-Hmac-Sha256", sign(raw, secret))
    .set("X-Shopify-Shop-Domain", SHOP)
    .set("X-Shopify-Topic", "app/uninstalled")
    .set("X-Shopify-Webhook-Id", headers["X-Shopify-Webhook-Id"] ?? "delivery-1")
    .send(raw);
}

describe("chat app/uninstalled", () => {
  it("retires the chat installation", async () => {
    const res = await post("/api/shopify-chat/webhooks/app-uninstalled", "core-app-secret");
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(H.markUninstalled).toHaveBeenCalledWith(SHOP);
  });

  it("does NOT touch the Core integration's connection", async () => {
    await post("/api/shopify-chat/webhooks/app-uninstalled", "core-app-secret");
    await new Promise((r) => setImmediate(r));
    expect(H.updateConnection).not.toHaveBeenCalled();
  });

  it("refuses a body signed with the RETIRED chat secret", async () => {
    // Inverted deliberately at unification. The chat app no longer exists,
    // so a delivery it could have signed must not be honoured - otherwise a
    // leaked old secret would still be able to disable a merchant's chat.
    const res = await post("/api/shopify-chat/webhooks/app-uninstalled", "chat-app-secret");
    expect(res.status).toBe(401);
    expect(H.markUninstalled).not.toHaveBeenCalled();
  });

  it("refuses an unsigned body", async () => {
    const res = await request(app())
      .post("/api/shopify-chat/webhooks/app-uninstalled")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ shop_domain: SHOP }));
    expect(res.status).toBe(401);
    expect(H.markUninstalled).not.toHaveBeenCalled();
  });

  it("processes a redelivered webhook only once", async () => {
    await post("/api/shopify-chat/webhooks/app-uninstalled", "core-app-secret");
    await new Promise((r) => setImmediate(r));
    await post("/api/shopify-chat/webhooks/app-uninstalled", "core-app-secret");
    await new Promise((r) => setImmediate(r));
    expect(H.markUninstalled).toHaveBeenCalledTimes(1);
  });
});

describe("core app/uninstalled", () => {
  it("disconnects the commerce connection and drops its credentials", async () => {
    const res = await post("/api/connectors/shopify/webhooks/app-uninstalled", "core-app-secret");
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(H.updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ti1" },
        data: expect.objectContaining({ status: "DISCONNECTED", credentials: {} }),
      }),
    );
  });

  it("ALSO disables Shopify Chat - the extension left with the app", async () => {
    // Inverted at unification. Under two apps this asserted the opposite:
    // chat survived a core uninstall because it had its own install that was
    // still present. It no longer does - the Theme App Extension belongs to
    // this app - so a chat that kept claiming to be live would be claiming
    // something the storefront can no longer render.
    await post("/api/connectors/shopify/webhooks/app-uninstalled", "core-app-secret");
    await new Promise((r) => setImmediate(r));
    expect(H.disableChatOnUninstall).toHaveBeenCalledWith(SHOP);
  });

  it("still disconnects commerce when disabling chat throws", async () => {
    // Ordered second and wrapped for exactly this reason: a chat-side failure
    // must not leave the connection wrongly CONNECTED with a revoked token.
    H.disableChatOnUninstall.mockRejectedValueOnce(new Error("boom"));
    await post("/api/connectors/shopify/webhooks/app-uninstalled", "core-app-secret");
    await new Promise((r) => setImmediate(r));
    expect(H.updateConnection).toHaveBeenCalled();
  });

  it("preserves conversation history - uninstall disables, it does not delete", async () => {
    // The merchant's support record is theirs and survives an integration
    // being removed. Only the ability to serve NEW storefront chat stops.
    await post("/api/connectors/shopify/webhooks/app-uninstalled", "core-app-secret");
    await new Promise((r) => setImmediate(r));
    const deleteCalls = Object.entries(H).filter(([k]) => /delete|destroy|purge/i.test(k));
    expect(deleteCalls).toHaveLength(0);
  });

  it("refuses a body signed with the RETIRED chat secret", async () => {
    const res = await post("/api/connectors/shopify/webhooks/app-uninstalled", "chat-app-secret");
    expect(res.status).toBe(401);
    expect(H.updateConnection).not.toHaveBeenCalled();
  });

  it("ignores a shop with no matching connection", async () => {
    H.connections.current = [{ id: "ti9", tenantId: "t9", config: { shopDomain: "other.myshopify.com" } }];
    await post("/api/connectors/shopify/webhooks/app-uninstalled", "core-app-secret");
    await new Promise((r) => setImmediate(r));
    expect(H.updateConnection).not.toHaveBeenCalled();
  });
});

describe("mandatory compliance webhooks", () => {
  const topics = [
    "/api/shopify-chat/webhooks/customers-data-request",
    "/api/shopify-chat/webhooks/customers-redact",
    "/api/shopify-chat/webhooks/shop-redact",
  ];

  it.each(topics)("%s returns 401 on an invalid signature", async (path) => {
    const res = await post(path, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it.each(topics)("%s acknowledges a verified delivery", async (path) => {
    const res = await post(path, "core-app-secret");
    expect(res.status).toBe(200);
  });

  it("shop/redact clears the installation's identifiers, scoped to that shop", async () => {
    await post("/api/shopify-chat/webhooks/shop-redact", "core-app-secret");
    await new Promise((r) => setImmediate(r));
    expect(H.updateInstallations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: SHOP },
        data: expect.objectContaining({ accessToken: null, status: "UNINSTALLED" }),
      }),
    );
  });

  it("shop/redact is idempotent across redeliveries", async () => {
    await post("/api/shopify-chat/webhooks/shop-redact", "core-app-secret", { shop_domain: SHOP });
    await new Promise((r) => setImmediate(r));
    await post("/api/shopify-chat/webhooks/shop-redact", "core-app-secret", { shop_domain: SHOP });
    await new Promise((r) => setImmediate(r));
    expect(H.updateInstallations).toHaveBeenCalledTimes(1);
  });
});

// ── Commerce events → cart left behind ─────────────────────────────────────

import { cartEventFromShopifyCheckout, cartCompletionFromShopifyOrder, orderEventFromShopifyOrder } from "../services/shopify-cart-events";

const CHECKOUT = {
  token: "chk_tok_1", updated_at: "2026-10-07T10:00:00Z", completed_at: null,
  email: "dana@example.com", phone: "+972501234567", currency: "ILS", total_price: "590.00",
  abandoned_checkout_url: "https://my-store.myshopify.com/checkouts/recover",
  buyer_accepts_marketing: true, buyer_accepts_sms: false,
  customer: { first_name: "Dana" },
  line_items: [{ title: "Cotton Trench Coat", quantity: 1, price: "590.00" }],
};

async function postTopic(path: string, topic: string, body: any, id = "d-1", secret = "core-app-secret") {
  const raw = JSON.stringify(body);
  return request(app()).post(path).set("Content-Type", "application/json")
    .set("X-Shopify-Hmac-Sha256", sign(raw, secret)).set("X-Shopify-Shop-Domain", SHOP)
    .set("X-Shopify-Topic", topic).set("X-Shopify-Webhook-Id", id).send(raw);
}

describe("★ checkouts and orders → cart events", () => {
  it("a checkout becomes the shared cart event, with the store's consent", () => {
    expect(cartEventFromShopifyCheckout("t1", CHECKOUT)).toEqual({
      tenantId: "t1", source: "shopify", checkoutId: "chk_tok_1", completed: false, updatedAt: "2026-10-07T10:00:00Z",
      customer: { email: "dana@example.com", phone: "+972501234567", firstName: "Dana" },
      items: [{ title: "Cotton Trench Coat", quantity: 1, price: 590 }], total: 590, currency: "ILS",
      cartUrl: "https://my-store.myshopify.com/checkouts/recover", marketingConsent: { email: true, sms: false },
    });
    expect(cartEventFromShopifyCheckout("t1", { ...CHECKOUT, completed_at: "2026-10-07T10:05:00Z" })!.completed).toBe(true);
    expect(cartCompletionFromShopifyOrder("t1", { checkout_token: "chk_tok_1", created_at: "x" })).toMatchObject({ checkoutId: "chk_tok_1", completed: true });
    expect(cartCompletionFromShopifyOrder("t1", {})).toBeNull();
  });

  it("★ a verified delivery for a connected shop is queued once; a replay is not", async () => {
    expect((await postTopic("/api/connectors/shopify/webhooks/checkouts-update", "checkouts/update", CHECKOUT)).status).toBe(200);
    await postTopic("/api/connectors/shopify/webhooks/checkouts-update", "checkouts/update", CHECKOUT); // same webhook id
    await new Promise((r) => setImmediate(r));
    expect(H.enqueue).toHaveBeenCalledTimes(1);
    expect(H.enqueue.mock.calls[0]).toEqual(["cart-event", expect.objectContaining({ tenantId: "t1", checkoutId: "chk_tok_1" }), expect.any(Object)]);
    await postTopic("/api/connectors/shopify/webhooks/orders-create", "orders/create", { checkout_token: "chk_tok_1" }, "d-2");
    await new Promise((r) => setImmediate(r));
    expect(H.enqueue.mock.calls[1][1]).toMatchObject({ checkoutId: "chk_tok_1", completed: true });
  });

  it("a bad signature is refused; a shop with no connection is acknowledged and ignored", async () => {
    expect((await postTopic("/api/connectors/shopify/webhooks/checkouts-create", "checkouts/create", CHECKOUT, "d-3", "wrong")).status).toBe(401);
    H.connections.current = [];
    expect((await postTopic("/api/connectors/shopify/webhooks/checkouts-create", "checkouts/create", CHECKOUT, "d-4")).status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(H.enqueue).not.toHaveBeenCalled();
  });
});

describe("★ orders → order events", () => {
  const ORDER = {
    id: 5001, name: "#1042", order_number: 1042, email: "dana@example.com", current_total_price: "590.00", currency: "ILS",
    order_status_url: "https://my-store.myshopify.com/orders/abc", checkout_token: "chk_tok_1",
    customer: { first_name: "Dana", phone: "+972501234567" }, line_items: [{ title: "Cotton Trench Coat", quantity: 1 }],
  };

  it("an order payload becomes the shared order event", () => {
    expect(orderEventFromShopifyOrder("t1", ORDER, "fulfilled")).toEqual({
      tenantId: "t1", source: "shopify", orderId: "5001", status: "fulfilled", orderNumber: "#1042", total: 590, currency: "ILS",
      customer: { email: "dana@example.com", phone: "+972501234567", firstName: "Dana" },
      items: [{ title: "Cotton Trench Coat", quantity: 1 }], orderUrl: "https://my-store.myshopify.com/orders/abc",
      marketingConsent: { email: null, sms: null },
    });
    // The store's own consent record travels with the order (read like a checkout's).
    expect(orderEventFromShopifyOrder("t1", { ...ORDER, buyer_accepts_marketing: true, customer: { ...ORDER.customer, sms_marketing_consent: { state: "subscribed" } } }, "paid")!.marketingConsent)
      .toEqual({ email: true, sms: true });
    expect(orderEventFromShopifyOrder("t1", {}, "paid")).toBeNull();
  });

  it("★ each orders/* topic queues its status; orders/create also completes the checkout", async () => {
    await postTopic("/api/connectors/shopify/webhooks/orders-create", "orders/create", ORDER, "o-1");
    for (const [path, topic, id] of [["orders-paid", "orders/paid", "o-2"], ["orders-fulfilled", "orders/fulfilled", "o-3"], ["orders-cancelled", "orders/cancelled", "o-4"]]) {
      expect((await postTopic(`/api/connectors/shopify/webhooks/${path}`, topic, ORDER, id)).status).toBe(200);
    }
    await postTopic("/api/connectors/shopify/webhooks/orders-paid", "orders/paid", ORDER, "o-2"); // a replay
    await new Promise((r) => setImmediate(r));
    expect(H.enqueue.mock.calls.map((c: any) => [c[0], c[1].status ?? (c[1].completed ? "checkout-bought" : "?")])).toEqual([
      ["cart-event", "checkout-bought"], ["order-event", "created"], ["order-event", "paid"], ["order-event", "fulfilled"], ["order-event", "cancelled"],
    ]);
  });

  it("a forged orders/paid is refused", async () => {
    expect((await postTopic("/api/connectors/shopify/webhooks/orders-paid", "orders/paid", ORDER, "o-9", "wrong")).status).toBe(401);
    await new Promise((r) => setImmediate(r));
    expect(H.enqueue).not.toHaveBeenCalled();
  });
});

