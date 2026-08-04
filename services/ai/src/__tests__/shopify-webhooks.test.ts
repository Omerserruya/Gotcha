/**
 * Shopify webhooks — one app, one secret, two consequences.
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
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withCrossTenantAccess: async (fn: any) => fn(),
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

  it("ALSO disables Shopify Chat — the extension left with the app", async () => {
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

  it("preserves conversation history — uninstall disables, it does not delete", async () => {
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
