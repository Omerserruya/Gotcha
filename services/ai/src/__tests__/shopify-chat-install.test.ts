/**
 * GOTCHA Shopify CHAT app — App Store installation flow.
 *
 * Drives the real router. The interesting cases are all refusals: a forged
 * signature, a replayed state, a shop that changed between request and
 * callback, and a merchant trying to claim a store that belongs to someone
 * else's organization.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.SHOPIFY_CHAT_APP_CLIENT_ID = "chat-client-id";
  process.env.SHOPIFY_CHAT_APP_SECRET = "chat-app-secret";
  process.env.SHOPIFY_CHAT_APP_URL = "https://dev.gotcha.co.il";
  process.env.SHOPIFY_CHAT_REDIRECT_URI =
    "https://dev.gotcha.co.il/api/connectors/shopify-chat/oauth/callback";
  // The Core app's credentials exist in the same process. Nothing in the
  // chat flow may use them.
  process.env.SHOPIFY_API_KEY = "core-client-id";
  process.env.SHOPIFY_API_SECRET = "core-app-secret";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    permission: { granted: true },
    tenantId: { current: "t1" },
    state: { current: { ok: true, claims: { shop: "my-store.myshopify.com", provider: "shopify-chat" } } as any },
    install: { current: null as any },
    bindResult: { current: null as any },
    snapshot: { current: null as any },
    recordAuthorizedInstall: v.fn(),
    createInstallSession: v.fn(async () => "session-token"),
    readInstallSession: v.fn(async (t: string) => (t === "session-token" ? { installationId: "i1" } : null)),
    discardInstallSession: v.fn(async () => undefined),
    bindInstallationToTenant: v.fn(),
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
    mintOAuthState: vi.fn(() => ({ state: "minted-state", jti: "j1" })),
    consumeOAuthState: vi.fn(async () => H.state.current),
  };
});

vi.mock("../services/shopify-chat-install.service", () => ({
  recordAuthorizedInstall: H.recordAuthorizedInstall,
  createInstallSession: H.createInstallSession,
  readInstallSession: H.readInstallSession,
  discardInstallSession: H.discardInstallSession,
  findInstallationById: vi.fn(async () => H.install.current),
  findLiveInstallation: vi.fn(async () => H.install.current),
  bindInstallationToTenant: H.bindInstallationToTenant,
  activationSnapshot: vi.fn(async () => H.snapshot.current),
  refreshVerifiedDomains: H.refreshVerifiedDomains,
}));

import router from "../routes/shopify-chat-install";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", router);
  return a;
}

/** Sign a query string the way Shopify does. */
function signQuery(params: Record<string, string>, secret = "chat-app-secret"): string {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

const INSTALLATION = {
  id: "i1",
  shopDomain: "my-store.myshopify.com",
  status: "PENDING" as const,
  tenantId: null,
  channelAccountId: null,
  verifiedDomains: ["my-store.myshopify.com"],
  installedAt: new Date(),
  uninstalledAt: null,
  boundAt: null,
  lastHeartbeatAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  H.permission.granted = true;
  H.tenantId.current = "t1";
  H.state.current = { ok: true, claims: { shop: "my-store.myshopify.com", provider: "shopify-chat" } };
  H.install.current = { ...INSTALLATION };
  H.recordAuthorizedInstall.mockResolvedValue({ ...INSTALLATION });
  H.createInstallSession.mockResolvedValue("session-token");
  H.readInstallSession.mockImplementation(async (t: string) =>
    t === "session-token" ? { installationId: "i1" } : null,
  );
  H.snapshot.current = {
    state: "EMBED_NOT_ENABLED",
    shopDomain: "my-store.myshopify.com",
    tenantId: "t1",
    channelId: "c1",
    channelEnabled: false,
    productMessaging: false,
    coreConnected: false,
    verifiedDomains: ["my-store.myshopify.com"],
    themeEditorDeepLink: "https://my-store.myshopify.com/admin/themes/current/editor",
    lastHeartbeatAt: null,
  };
});

// ─── Install entry ───────────────────────────────────────────

describe("install entry", () => {
  it("redirects a valid shop to Shopify authorization with the CHAT client id", async () => {
    const res = await request(app())
      .get("/api/connectors/shopify-chat/oauth/init")
      .query({ shop: "my-store" });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://my-store.myshopify.com/admin/oauth/authorize");
    expect(res.headers.location).toContain("client_id=chat-client-id");
    expect(res.headers.location).not.toContain("core-client-id");
    // No scopes in v1 — the app must not ask for access it cannot use.
    expect(res.headers.location).not.toContain("scope=");
  });

  it("rejects a shop domain that is not a Shopify store", async () => {
    const res = await request(app())
      .get("/api/connectors/shopify-chat/oauth/init")
      .query({ shop: "evil.com" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=invalid_shop");
  });

  it("rejects a signed entry whose signature does not verify", async () => {
    const res = await request(app())
      .get("/api/connectors/shopify-chat/oauth/init")
      .query({ shop: "my-store.myshopify.com", timestamp: "170", hmac: "deadbeef" });
    expect(res.headers.location).toContain("error=invalid_signature");
  });

  it("accepts a correctly signed entry", async () => {
    const params = { shop: "my-store.myshopify.com", timestamp: "170" };
    const res = await request(app())
      .get("/api/connectors/shopify-chat/oauth/init")
      .query({ ...params, hmac: signQuery(params) });
    expect(res.headers.location).toContain("/admin/oauth/authorize");
  });
});

// ─── Callback ────────────────────────────────────────────────

describe("install callback", () => {
  function callbackQuery(overrides: Record<string, string> = {}, secret?: string) {
    const params: Record<string, string> = {
      code: "auth-code",
      shop: "my-store.myshopify.com",
      state: "minted-state",
      timestamp: "170",
      ...overrides,
    };
    return { ...params, hmac: signQuery(params, secret) };
  }

  it("stores the installation and hands the browser a continuation session", async () => {
    const res = await request(app())
      .get("/api/connectors/shopify-chat/oauth/callback")
      .query(callbackQuery());

    expect(res.status).toBe(302);
    expect(H.recordAuthorizedInstall).toHaveBeenCalledWith(
      expect.objectContaining({ shopDomain: "my-store.myshopify.com" }),
    );
    expect(res.headers.location).toContain("/shopify/chat/install?session=session-token");
    const cookie = String(res.headers["set-cookie"] ?? "");
    expect(cookie).toContain("gotcha_sfy_install=session-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("stores NO token when the app requests no scopes", async () => {
    await request(app()).get("/api/connectors/shopify-chat/oauth/callback").query(callbackQuery());
    expect(H.recordAuthorizedInstall).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: null, scopes: null }),
    );
  });

  it("refuses a forged signature with 401", async () => {
    const res = await request(app())
      .get("/api/connectors/shopify-chat/oauth/callback")
      .query({ ...callbackQuery(), hmac: "deadbeef" });
    expect(res.status).toBe(401);
    expect(H.recordAuthorizedInstall).not.toHaveBeenCalled();
  });

  it("refuses a signature made with the CORE app secret", async () => {
    const res = await request(app())
      .get("/api/connectors/shopify-chat/oauth/callback")
      .query(callbackQuery({}, "core-app-secret"));
    expect(res.status).toBe(401);
    expect(H.recordAuthorizedInstall).not.toHaveBeenCalled();
  });

  it("refuses a replayed state", async () => {
    H.state.current = { ok: false, reason: "replayed" };
    const res = await request(app())
      .get("/api/connectors/shopify-chat/oauth/callback")
      .query(callbackQuery());
    expect(res.status).toBe(400);
    expect(res.text).toBe("state_already_used");
    expect(H.recordAuthorizedInstall).not.toHaveBeenCalled();
  });

  it("refuses an expired state", async () => {
    H.state.current = { ok: false, reason: "expired" };
    const res = await request(app())
      .get("/api/connectors/shopify-chat/oauth/callback")
      .query(callbackQuery());
    expect(res.status).toBe(400);
    expect(H.recordAuthorizedInstall).not.toHaveBeenCalled();
  });

  it("refuses when the returned shop is not the shop we sent them to", async () => {
    const res = await request(app())
      .get("/api/connectors/shopify-chat/oauth/callback")
      .query(callbackQuery({ shop: "other-store.myshopify.com" }));
    expect(res.status).toBe(400);
    expect(H.recordAuthorizedInstall).not.toHaveBeenCalled();
  });
});

// ─── Binding ─────────────────────────────────────────────────

describe("tenant binding", () => {
  it("returns the verified shop without leaking who owns it", async () => {
    H.install.current = { ...INSTALLATION, tenantId: "someone-else" };
    const res = await request(app())
      .get("/api/shopify-chat-install/context")
      .set("Cookie", "gotcha_sfy_install=session-token");

    expect(res.status).toBe(200);
    expect(res.body.data.shopDomain).toBe("my-store.myshopify.com");
    expect(res.body.data.claimedByAnotherOrganization).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("someone-else");
  });

  it("binds the installation to the caller's own tenant, never a body-supplied one", async () => {
    H.bindInstallationToTenant.mockResolvedValue({
      ok: true,
      installation: { ...INSTALLATION, tenantId: "t1", channelAccountId: "c1", status: "ACTIVE" },
      channel: { id: "c1" },
      created: true,
    });

    const res = await request(app())
      .post("/api/shopify-chat-install/bind")
      .set("Cookie", "gotcha_sfy_install=session-token")
      .send({ tenantId: "attacker-tenant" });

    expect(res.status).toBe(201);
    expect(H.bindInstallationToTenant).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "i1", tenantId: "t1" }),
    );
    expect(res.body.data.channelCreated).toBe(true);
  });

  it("clears the continuation session once it has been used", async () => {
    H.bindInstallationToTenant.mockResolvedValue({
      ok: true,
      installation: { ...INSTALLATION, tenantId: "t1", channelAccountId: "c1" },
      channel: { id: "c1" },
      created: false,
    });
    const res = await request(app())
      .post("/api/shopify-chat-install/bind")
      .set("Cookie", "gotcha_sfy_install=session-token")
      .send({});
    expect(H.discardInstallSession).toHaveBeenCalled();
    expect(String(res.headers["set-cookie"] ?? "")).toContain("gotcha_sfy_install=;");
  });

  it("refuses a merchant without permission to connect channels", async () => {
    H.permission.granted = false;
    const res = await request(app())
      .post("/api/shopify-chat-install/bind")
      .set("Cookie", "gotcha_sfy_install=session-token")
      .send({});
    expect(res.status).toBe(403);
    expect(H.bindInstallationToTenant).not.toHaveBeenCalled();
  });

  it("refuses a shop already claimed by another organization", async () => {
    H.bindInstallationToTenant.mockResolvedValue({ ok: false, reason: "shop_taken" });
    const res = await request(app())
      .post("/api/shopify-chat-install/bind")
      .set("Cookie", "gotcha_sfy_install=session-token")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SHOP_TAKEN");
  });

  it("refuses an organization whose plan does not include the chat", async () => {
    H.bindInstallationToTenant.mockResolvedValue({ ok: false, reason: "not_entitled" });
    const res = await request(app())
      .post("/api/shopify-chat-install/bind")
      .set("Cookie", "gotcha_sfy_install=session-token")
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_ENTITLED");
  });

  it("refuses without a continuation session", async () => {
    const res = await request(app()).post("/api/shopify-chat-install/bind").send({});
    expect(res.status).toBe(404);
    expect(H.bindInstallationToTenant).not.toHaveBeenCalled();
  });

  it("accepts the session from the URL when the cookie was dropped", async () => {
    H.bindInstallationToTenant.mockResolvedValue({
      ok: true,
      installation: { ...INSTALLATION, tenantId: "t1", channelAccountId: "c1" },
      channel: { id: "c1" },
      created: false,
    });
    const res = await request(app())
      .post("/api/shopify-chat-install/bind")
      .send({ session: "session-token" });
    expect(res.status).toBe(200);
  });
});

// ─── Activation ──────────────────────────────────────────────

describe("activation", () => {
  it("reports state for the caller's own installation", async () => {
    H.install.current = { ...INSTALLATION, tenantId: "t1", channelAccountId: "c1", status: "ACTIVE" };
    const res = await request(app())
      .get("/api/shopify-chat-install/activation")
      .query({ shop: "my-store.myshopify.com" });
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("EMBED_NOT_ENABLED");
  });

  it("pretends another organization's installation does not exist", async () => {
    H.install.current = { ...INSTALLATION, tenantId: "other-tenant", channelAccountId: "c9", status: "ACTIVE" };
    const res = await request(app())
      .get("/api/shopify-chat-install/activation")
      .query({ shop: "my-store.myshopify.com" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("APP_NOT_INSTALLED");
  });

  it("never returns a token, a tenant id or an integration id to the browser", async () => {
    H.install.current = { ...INSTALLATION, tenantId: "t1", channelAccountId: "c1", status: "ACTIVE" };
    const res = await request(app())
      .get("/api/shopify-chat-install/activation")
      .query({ shop: "my-store.myshopify.com" });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("accessToken");
    expect(body).not.toContain("tenantIntegrationId");
    expect(body).not.toContain("chat-app-secret");
    expect(body).not.toContain("core-app-secret");
  });
});
