/**
 * Shopify Chat activation under the UNIFIED app.
 *
 * This suite used to drive an App Store install handshake: an OAuth entry
 * point, a signed callback, a Redis continuation session and a binding step.
 * All of that is gone. The merchant authorizes ONE Shopify app, the Theme App
 * Extension ships inside it, and enabling chat is a GOTCHA-side decision.
 *
 * What is worth testing now:
 *   • the second OAuth surface is really gone, not merely unused
 *   • the shop comes from the tenant's own Core connection, never the request
 *   • enable is idempotent and permission-gated
 *   • disable never touches the Shopify connection
 *   • another organization's installation stays invisible
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.SHOPIFY_API_KEY = "core-client-id";
  process.env.SHOPIFY_API_SECRET = "core-app-secret";
  process.env.SHOPIFY_REDIRECT_URI =
    "https://app.gotcha.co.il/api/connectors/shopify/oauth/callback";
  // The retired chat credentials are deliberately present: nothing may read
  // them, and a test that never sets them could not prove that.
  process.env.SHOPIFY_CHAT_APP_CLIENT_ID = "chat-client-id";
  process.env.SHOPIFY_CHAT_APP_SECRET = "chat-app-secret";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    permission: { granted: true },
    tenantId: { current: "t1" },
    install: { current: null as any },
    snapshot: { current: null as any },
    connection: { current: null as any },
    enableResult: { current: null as any },
    enableChatForTenant: v.fn(),
    disableChatForTenant: v.fn(async () => ({ ok: true, disabled: 1 })),
    refreshVerifiedDomains: v.fn(async () => ["my-store.myshopify.com"]),
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: "u1", tenantId: H.tenantId.current, role: "ADMIN", email: "dana@merchant.com" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = H.tenantId.current;
      next();
    },
    requireOnboardingOrActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requirePermission: () => (_req: any, res: any, next: any) =>
      H.permission.granted ? next() : res.status(403).json({ error: "forbidden" }),
  };
});

vi.mock("../services/connectors/integration-framework", () => ({
  loadConnection: vi.fn(async () => H.connection.current),
}));

vi.mock("../services/shopify-chat-install.service", () => ({
  findLiveInstallation: vi.fn(async () => H.install.current),
  activationSnapshot: vi.fn(async () => H.snapshot.current),
  refreshVerifiedDomains: H.refreshVerifiedDomains,
  enableChatForTenant: H.enableChatForTenant,
  disableChatForTenant: H.disableChatForTenant,
}));

import router from "../routes/shopify-chat-install";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", router);
  return a;
}

const SHOP = "my-store.myshopify.com";

const INSTALLATION = {
  id: "i1",
  shopDomain: SHOP,
  status: "ACTIVE" as const,
  tenantId: "t1",
  channelAccountId: "c1",
  verifiedDomains: [SHOP],
  installedAt: new Date(),
  uninstalledAt: null,
  boundAt: new Date(),
  lastHeartbeatAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  H.permission.granted = true;
  H.tenantId.current = "t1";
  H.install.current = { ...INSTALLATION };
  H.connection.current = { config: { shopDomain: SHOP } };
  H.disableChatForTenant.mockResolvedValue({ ok: true, disabled: 1 });
  H.enableChatForTenant.mockResolvedValue({
    ok: true,
    installation: { ...INSTALLATION },
    channel: { id: "c1" },
    created: true,
  });
  H.snapshot.current = {
    state: "EMBED_NOT_ENABLED",
    shopDomain: SHOP,
    tenantId: "t1",
    channelId: "c1",
    channelEnabled: false,
    productMessaging: false,
    coreConnected: true,
    verifiedDomains: [SHOP],
    themeEditorDeepLink: `https://${SHOP}/admin/themes/current/editor`,
    lastHeartbeatAt: null,
  };
});

// ─── The second OAuth surface is gone ────────────────────────

describe("retired install handshake", () => {
  it.each([
    "/api/connectors/shopify-chat/oauth/init?shop=my-store.myshopify.com",
    "/api/connectors/shopify-chat/oauth/callback?shop=my-store.myshopify.com&code=x",
  ])("no longer serves %s", async (path) => {
    // Not merely unused - unmounted. Leaving them would keep a second app
    // identity alive that the runtime no longer holds a secret for.
    const res = await request(app()).get(path);
    expect(res.status).toBe(404);
  });
});

// ─── Status ──────────────────────────────────────────────────

describe("status", () => {
  it("reports the shop from the Core connection", async () => {
    const res = await request(app()).get("/api/shopify-chat-install/status");
    expect(res.status).toBe(200);
    expect(res.body.data.shopifyConnected).toBe(true);
    expect(res.body.data.shopDomain).toBe(SHOP);
    expect(res.body.data.state).toBe("enabled");
  });

  it("says shopify_not_connected rather than pretending chat is unavailable", async () => {
    // These are different facts and the merchant's next action differs.
    H.connection.current = null;
    const res = await request(app()).get("/api/shopify-chat-install/status");
    expect(res.body.data.shopifyConnected).toBe(false);
    expect(res.body.data.state).toBe("shopify_not_connected");
  });

  it("offers no admin deep link while the app handle is unconfirmed", async () => {
    // A guessed handle 404s in the merchant's admin, which is worse than
    // showing no link.
    delete process.env.SHOPIFY_APP_HANDLE;
    const res = await request(app()).get("/api/shopify-chat-install/status");
    expect(res.body.data.appAdminLink).toBeNull();
  });

  it("reports ready_to_activate when another organization holds the install", async () => {
    H.install.current = { ...INSTALLATION, tenantId: "other-tenant" };
    const res = await request(app()).get("/api/shopify-chat-install/status");
    expect(res.body.data.state).toBe("ready_to_activate");
    expect(res.body.data.activation).toBeNull();
  });
});

// ─── Enable ──────────────────────────────────────────────────

describe("enable", () => {
  it("enables without any Shopify round trip", async () => {
    const res = await request(app()).post("/api/shopify-chat-install/enable");
    expect(res.status).toBe(201);
    expect(res.body.data.channelId).toBe("c1");
    expect(H.enableChatForTenant).toHaveBeenCalledWith({ tenantId: "t1", userId: "u1" });
  });

  it("never takes the shop from the request body", async () => {
    // Accepting one would let a tenant claim a storefront it never connected.
    await request(app())
      .post("/api/shopify-chat-install/enable")
      .send({ shop: "someone-elses-store.myshopify.com", tenantId: "t99" });
    const arg = H.enableChatForTenant.mock.calls[0][0];
    expect(arg).toEqual({ tenantId: "t1", userId: "u1" });
    expect(JSON.stringify(arg)).not.toContain("someone-elses-store");
  });

  it("is idempotent - re-enabling returns the existing channel as 200", async () => {
    H.enableChatForTenant.mockResolvedValue({
      ok: true, installation: { ...INSTALLATION }, channel: { id: "c1" }, created: false,
    });
    const res = await request(app()).post("/api/shopify-chat-install/enable");
    expect(res.status).toBe(200);
    expect(res.body.data.channelCreated).toBe(false);
  });

  it("refuses when Shopify is not connected, with a reason the UI can act on", async () => {
    H.enableChatForTenant.mockResolvedValue({ ok: false, reason: "shopify_not_connected" });
    const res = await request(app()).post("/api/shopify-chat-install/enable");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SHOPIFY_NOT_CONNECTED");
  });

  it("refuses an unentitled tenant with 403", async () => {
    H.enableChatForTenant.mockResolvedValue({ ok: false, reason: "not_entitled" });
    expect((await request(app()).post("/api/shopify-chat-install/enable")).status).toBe(403);
  });

  it("refuses a store already claimed by another organization", async () => {
    H.enableChatForTenant.mockResolvedValue({ ok: false, reason: "shop_taken" });
    expect((await request(app()).post("/api/shopify-chat-install/enable")).status).toBe(409);
  });

  it("requires the channel-manage permission", async () => {
    H.permission.granted = false;
    expect((await request(app()).post("/api/shopify-chat-install/enable")).status).toBe(403);
    expect(H.enableChatForTenant).not.toHaveBeenCalled();
  });
});

// ─── Disable ─────────────────────────────────────────────────

describe("disable", () => {
  it("switches chat off and says the Shopify connection survives", async () => {
    const res = await request(app()).post("/api/shopify-chat-install/disable");
    expect(res.status).toBe(200);
    expect(res.body.data.shopifyStillConnected).toBe(true);
    expect(H.disableChatForTenant).toHaveBeenCalledWith({ tenantId: "t1" });
  });

  it("reports that the theme embed is still installed", async () => {
    // Disabling here stops the server answering bootstrap, but the App Embed
    // stays in the merchant's theme - only they can remove it. Claiming
    // otherwise would send them looking for a change we did not make.
    const res = await request(app()).post("/api/shopify-chat-install/disable");
    expect(res.body.data.themeEmbedStillInstalled).toBe(true);
  });

  it("requires the channel-manage permission", async () => {
    H.permission.granted = false;
    expect((await request(app()).post("/api/shopify-chat-install/disable")).status).toBe(403);
    expect(H.disableChatForTenant).not.toHaveBeenCalled();
  });
});

// ─── Activation ──────────────────────────────────────────────

describe("activation", () => {
  it("returns the snapshot for the caller's own store", async () => {
    const res = await request(app()).get("/api/shopify-chat-install/activation");
    expect(res.status).toBe(200);
    expect(res.body.data.shopDomain).toBe(SHOP);
  });

  it("hides another organization's installation behind the same 404", async () => {
    H.install.current = { ...INSTALLATION, tenantId: "other-tenant" };
    const res = await request(app()).get(`/api/shopify-chat-install/activation?shop=${SHOP}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("APP_NOT_INSTALLED");
  });

  it("404s when nothing is installed", async () => {
    H.install.current = null;
    H.connection.current = null;
    expect((await request(app()).get("/api/shopify-chat-install/activation")).status).toBe(404);
  });
});
