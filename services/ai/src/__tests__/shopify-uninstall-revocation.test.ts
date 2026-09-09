/**
 * An uninstall must ALWAYS reach billing, including when the legacy row is
 * missing.
 *
 * The bug this pins: `notifyShopifyUninstalled` sat below the `!match` early
 * return. The legacy `tenant_integrations` lookup only considers
 * CONNECTED/ERROR rows, so a store whose legacy row was already DISCONNECTED -
 * or that only ever had a `CommerceConnection` - produced `no_connection`,
 * returned, and told billing nothing.
 *
 * Observed in production on activewaer.myshopify.com: the merchant uninstalled,
 * the webhook logged `outcome=no_connection`, billing logged nothing at all,
 * and the commerce connection stayed CONNECTED with all four Shopify-funded
 * entitlements intact. A merchant who uninstalls and does not come back would
 * have kept paid capability forever.
 *
 * The existing bridge tests covered what the bridge does WHEN CALLED. Nothing
 * covered whether the webhook calls it, which is where the fault was.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

const SECRET = "core-app-secret-for-tests";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.SHOPIFY_API_SECRET = "core-app-secret-for-tests";
  process.env.INTERNAL_SERVICE_KEY = "internal-key-for-tests-only-32-chars-min";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => ({
  /** Legacy tenant_integrations rows the lookup will return. */
  legacyRows: [] as any[],
  notifyUninstalled: null as any,
  updated: [] as any[],
}));

vi.mock("../services/shopify-billing-bridge.service", () => ({
  notifyShopifyUninstalled: (...a: unknown[]) => H.notifyUninstalled(...a),
  notifyShopifyConnected: vi.fn(),
  resolveShopifyBillingOutcome: vi.fn(),
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withCrossTenantAccess: async (fn: any) => fn(),
    prisma: {
      tenantIntegration: {
        findMany: async () => H.legacyRows,
        update: async (args: any) => { H.updated.push(args); return {}; },
      },
      shopifyChatInstallation: { findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
      shopifyWebhookDelivery: { create: async () => ({}), findFirst: async () => null },
    },
  };
});

function sign(body: string) {
  return crypto.createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
}

async function app() {
  const routes = (await import("../routes/shopify-webhooks")).default;
  const a = express();
  a.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  a.use("/api", routes);
  return a;
}

async function fireUninstall(shop = "activewaer.myshopify.com", shopId = "101829345594") {
  const body = JSON.stringify({ id: Number(shopId), domain: shop });
  return request(await app())
    .post("/api/connectors/shopify/webhooks/app-uninstalled")
    .set("x-shopify-hmac-sha256", sign(body))
    .set("x-shopify-shop-domain", shop)
    .set("x-shopify-topic", "app/uninstalled")
    .set("x-shopify-webhook-id", `wh-${Math.random().toString(36).slice(2)}`)
    .set("Content-Type", "application/json")
    .send(body);
}

beforeEach(() => {
  H.legacyRows = [];
  H.updated = [];
  H.notifyUninstalled = vi.fn(async () => undefined);
});

describe("billing is told even when there is no legacy row", () => {
  it("THE REGRESSION: no_connection must still revoke Shopify-funded access", async () => {
    H.legacyRows = []; // nothing CONNECTED/ERROR - the production case
    const res = await fireUninstall();
    expect(res.status).toBe(200);

    // Shopify's delivery timeout is short, so the handler answers first and
    // works after. Give the async tail a turn.
    await new Promise((r) => setTimeout(r, 50));

    expect(H.notifyUninstalled).toHaveBeenCalledTimes(1);
    const arg = H.notifyUninstalled.mock.calls[0][0];
    expect(arg.shopDomain).toBe("activewaer.myshopify.com");
    expect(arg.externalShopId).toBe("101829345594");
  });

  it("still notifies when a legacy row DOES exist", async () => {
    H.legacyRows = [
      { id: "ti-1", tenantId: "t-1", config: { shopDomain: "activewaer.myshopify.com" } },
    ];
    await fireUninstall();
    await new Promise((r) => setTimeout(r, 50));

    expect(H.notifyUninstalled).toHaveBeenCalledTimes(1);
    // And the legacy row is still disconnected - one path must not replace
    // the other.
    expect(H.updated).toHaveLength(1);
    expect(H.updated[0].data.status).toBe("DISCONNECTED");
    expect(H.updated[0].data.credentials).toEqual({});
  });

  it("passes the shop id from the payload, with the domain as fallback", async () => {
    H.legacyRows = [];
    await fireUninstall("other.myshopify.com", "555000111");
    await new Promise((r) => setTimeout(r, 50));

    const arg = H.notifyUninstalled.mock.calls[0][0];
    // By uninstall time the token is revoked, so the id cannot be looked up
    // from Shopify any more - both are sent.
    expect(arg.externalShopId).toBe("555000111");
    expect(arg.shopDomain).toBe("other.myshopify.com");
  });

  it("an UNVERIFIED webhook notifies nobody", async () => {
    // The signature gate must still come first: anyone able to forge this
    // could otherwise revoke any merchant's access.
    const body = JSON.stringify({ id: 1, domain: "activewaer.myshopify.com" });
    const res = await request(await app())
      .post("/api/connectors/shopify/webhooks/app-uninstalled")
      .set("x-shopify-hmac-sha256", "not-a-valid-signature")
      .set("x-shopify-shop-domain", "activewaer.myshopify.com")
      .set("x-shopify-topic", "app/uninstalled")
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    expect(H.notifyUninstalled).not.toHaveBeenCalled();
  });
});
