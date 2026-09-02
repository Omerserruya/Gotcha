/**
 * The Shopify OAuth callback, and the four checks that must pass before a
 * token is exchanged or a workspace is written.
 *
 *   1. the callback query is SIGNED (this was previously unchecked)
 *   2. the `state` is single-use
 *   3. the returned shop equals the shop bound INTO that state
 *   4. only then, the code exchange
 *
 * Then the workspace decision, which is the part with the sharpest edges:
 * an install that began on Shopify has no workspace, and must become a
 * pending claim rather than being attached to whoever happens to be nearby.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.SHOPIFY_API_KEY = "core-client-id";
  process.env.SHOPIFY_API_SECRET = "core-app-secret";
  process.env.SHOPIFY_REDIRECT_URI =
    "https://app.gotcha.co.il/api/connectors/shopify/oauth/callback";
  process.env.FRONTEND_URL = "https://app.gotcha.co.il";
  process.env.OAUTH_STATE_SECRET = "oauth-state-secret-for-tests-only-32chars";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    tenantId: { current: "tenant-A" as string | null },
    permission: { granted: true },
    /** What consumeOAuthState will answer. */
    stateResult: { current: null as any },
    connection: { current: null as any },
    linkResult: { current: { ok: true, connectionId: "c1", reconnected: false } as any },
    linkCalls: [] as any[],
    pendingCalls: [] as any[],
    exchange: v.fn(async () => ({ accessToken: "shpat_verysecret", scope: "read_orders" })),
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: "user-1", tenantId: H.tenantId.current, role: "ADMIN" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = H.tenantId.current; next(); },
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requireOnboardingOrActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requirePermission: () => (_req: any, res: any, next: any) =>
      H.permission.granted ? next() : res.status(403).json({ error: "forbidden" }),
    mintOAuthState: () => ({ state: "minted-state", jti: "jti-1" }),
    consumeOAuthState: vi.fn(async () => H.stateResult.current),
  };
});

vi.mock("../services/connector-connection.service", () => ({
  findCatalog: vi.fn(async () => ({ id: "cat-shopify" })),
  upsertConnection: vi.fn(async () => ({ id: "conn-1" })),
}));

// PARTIAL mock: connectors-admin pulls in every adapter, and each one calls
// `registerAdapter` at module load. Replacing the whole module would break
// that import chain before a single test ran.
vi.mock("../services/connectors/integration-framework", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadConnection: vi.fn(async () => H.connection.current),
    refreshCapabilityState: vi.fn(async () => ({ missingScopes: [] })),
  };
});

vi.mock("../services/tool-permission-reconcile.service", () => ({
  reconcileAgentToolPermissions: vi.fn(async () => ({ added: [] })),
}));

vi.mock("../services/shopify-connection-link.service", () => ({
  SHOPIFY_OAUTH_SCOPES: "read_orders,read_products",
  linkShopifyShopToTenant: vi.fn(async (input: any) => {
    H.linkCalls.push(input);
    return H.linkResult.current;
  }),
  exchangeShopifyCode: H.exchange,
  findShopOwner: vi.fn(async () => null),
}));

vi.mock("../services/shopify-install-intent.service", () => ({
  INSTALL_INTENT_COOKIE: "gotcha_shopify_intent",
  INSTALL_INTENT_TTL_SECONDS: 1800,
  createPendingConnection: vi.fn(async (input: any) => {
    H.pendingCalls.push(input);
    return "p".repeat(64);
  }),
  consumeInstallIntent: vi.fn(async () => null),
}));

vi.mock("../services/integration-provisioning.service", () => ({
  provisionIntegrationTools: vi.fn(async () => ({ granted: 0, preserved: 0, byCategory: {} })),
}));

import router from "../routes/connectors-admin";

const SECRET = "core-app-secret";
const SHOP = "urban-supply-dev.myshopify.com";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", router);
  return a;
}

function sign(params: Record<string, string>, secret = SECRET): string {
  const message = Object.keys(params)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

function callback(over: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    shop: SHOP,
    code: "auth-code-123",
    state: "minted-state",
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...over,
  };
  return new URLSearchParams({ ...base, hmac: sign(base) }).toString();
}

/** The state a signed-in install produces. */
const WITH_INTENT = {
  ok: true,
  claims: {
    tenantId: "tenant-A",
    provider: "shopify",
    shop: SHOP,
    hasIntent: true,
    userId: "user-1",
    jti: "jti-1",
  },
};

/** The state an App-Store install produces: verified shop, no workspace. */
const WITHOUT_INTENT = {
  ok: true,
  claims: { tenantId: "", provider: "shopify", shop: SHOP, hasIntent: false, jti: "jti-2" },
};

beforeEach(() => {
  vi.clearAllMocks();
  H.tenantId.current = "tenant-A";
  H.permission.granted = true;
  H.stateResult.current = WITH_INTENT;
  H.connection.current = null;
  H.linkResult.current = { ok: true, connectionId: "c1", reconnected: false };
  H.linkCalls.length = 0;
  H.pendingCalls.length = 0;
  H.exchange.mockResolvedValue({ accessToken: "shpat_verysecret", scope: "read_orders" });
});

// ─── Signature ───────────────────────────────────────────────

describe("callback signature", () => {
  it("accepts a correctly signed callback and links the workspace", async () => {
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${callback()}`);
    expect(res.status).toBe(302);
    expect(H.linkCalls[0]).toMatchObject({ tenantId: "tenant-A", shopDomain: SHOP });
  });

  it("rejects an UNSIGNED callback before touching state or the token exchange", async () => {
    const q = new URLSearchParams(callback());
    q.delete("hmac");
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${q}`);
    expect(res.status).toBe(400);
    expect(H.exchange).not.toHaveBeenCalled();
    expect(H.linkCalls).toHaveLength(0);
  });

  it("rejects a forged signature", async () => {
    const q = new URLSearchParams(callback());
    q.set("hmac", "0".repeat(64));
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${q}`);
    expect(res.status).toBe(400);
    expect(H.exchange).not.toHaveBeenCalled();
  });

  it("rejects a callback whose shop was swapped after signing", async () => {
    const base = { shop: SHOP, code: "auth-code-123", state: "minted-state" };
    const q = new URLSearchParams({ ...base, hmac: sign(base), shop: "attacker.myshopify.com" });
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${q}`);
    expect(res.status).toBe(400);
    expect(H.exchange).not.toHaveBeenCalled();
  });
});

// ─── State ───────────────────────────────────────────────────

describe("callback state", () => {
  it("rejects an EXPIRED state", async () => {
    H.stateResult.current = { ok: false, reason: "expired" };
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${callback()}`);
    expect(res.status).toBe(400);
    expect(res.text).toBe("bad_state");
    expect(H.exchange).not.toHaveBeenCalled();
  });

  it("rejects a REUSED state and says so distinctly", async () => {
    H.stateResult.current = { ok: false, reason: "replayed" };
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${callback()}`);
    expect(res.status).toBe(400);
    expect(res.text).toBe("state_already_used");
    expect(H.exchange).not.toHaveBeenCalled();
  });

  it("rejects a missing state", async () => {
    const base = { shop: SHOP, code: "auth-code-123" };
    const q = new URLSearchParams({ ...base, hmac: sign(base) });
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${q}`);
    expect(res.status).toBe(400);
    expect(H.exchange).not.toHaveBeenCalled();
  });

  it("rejects a state minted for a DIFFERENT shop", async () => {
    // The state is valid and unused, but it was issued for another store.
    // Without this check a state captured from store A could be replayed
    // against store B's callback.
    H.stateResult.current = {
      ok: true,
      claims: { ...WITH_INTENT.claims, shop: "some-other-store.myshopify.com" },
    };
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${callback()}`);
    expect(res.status).toBe(400);
    expect(res.text).toBe("bad_state");
    expect(H.exchange).not.toHaveBeenCalled();
    expect(H.linkCalls).toHaveLength(0);
  });
});

// ─── Workspace linking ───────────────────────────────────────

describe("workspace linking", () => {
  it("parks the install as PENDING when there was no GOTCHA session", async () => {
    H.stateResult.current = WITHOUT_INTENT;
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${callback()}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/settings/business-systems/shopify/finish");
    expect(res.headers.location).toContain("handle=");
    // Nothing is written to any tenant yet.
    expect(H.linkCalls).toHaveLength(0);
    expect(H.pendingCalls[0]).toMatchObject({ shopDomain: SHOP });
  });

  it("never infers a workspace from a blank tenantId", async () => {
    // A state claiming hasIntent with an empty tenant is a bug, not an
    // authorization. It must degrade to pending, never to "some tenant".
    H.stateResult.current = {
      ok: true,
      claims: { tenantId: "", provider: "shopify", shop: SHOP, hasIntent: true, jti: "j" },
    };
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${callback()}`);
    expect(res.headers.location).toContain("/shopify/finish");
    expect(H.linkCalls).toHaveLength(0);
  });

  it("ignores a tenantId supplied in the QUERY - cross-tenant attempt", async () => {
    H.stateResult.current = WITH_INTENT; // signed state says tenant-A
    const q = `${callback()}&tenantId=tenant-EVIL&workspaceId=tenant-EVIL`;
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${q}`);
    // Adding params breaks the signature, which is itself the defence.
    expect(res.status).toBe(400);
    expect(H.linkCalls).toHaveLength(0);
  });

  it("takes the workspace from the SIGNED state, never from the caller's session", async () => {
    // The callback is unauthenticated; a session that happens to exist must
    // not influence which workspace the store lands in.
    H.tenantId.current = "tenant-SOMEONE-ELSE";
    H.stateResult.current = WITH_INTENT;
    await request(app()).get(`/api/connectors/shopify/oauth/callback?${callback()}`);
    expect(H.linkCalls[0].tenantId).toBe("tenant-A");
  });

  it("redirects with a conflict marker when the store belongs to another workspace", async () => {
    H.linkResult.current = { ok: false, reason: "shop_taken", conflictingTenantId: "tenant-Z" };
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${callback()}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("shopify_install_error=shop_connected_elsewhere");
    expect(res.headers.location).not.toContain("tenant-Z");
  });

  it("never puts the access token in the redirect", async () => {
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${callback()}`);
    expect(res.headers.location).not.toContain("shpat_verysecret");
    expect(res.text || "").not.toContain("shpat_verysecret");
  });

  it("never logs the access token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await request(app()).get(`/api/connectors/shopify/oauth/callback?${callback()}`);
    const all = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(all).not.toContain("shpat_verysecret");
    log.mockRestore(); warn.mockRestore(); error.mockRestore();
  });

  it("reports a failed token exchange without leaking detail", async () => {
    H.exchange.mockResolvedValue(null);
    const res = await request(app()).get(`/api/connectors/shopify/oauth/callback?${callback()}`);
    expect(res.status).toBe(400);
    expect(res.text).toBe("token_exchange_failed");
  });
});

// ─── Reauthorization (init) ──────────────────────────────────

describe("GET /connectors/shopify/oauth/init - reauthorization only", () => {
  it("IGNORES a shop supplied in the query and uses the stored connection", async () => {
    H.connection.current = { config: { shopDomain: SHOP } };
    const res = await request(app()).get(
      "/api/connectors/shopify/oauth/init?shop=attacker-store.myshopify.com",
    );
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    // The typed domain is gone: the host is the store this tenant already has.
    expect(url.origin).toBe(`https://${SHOP}`);
    expect(res.body.url).not.toContain("attacker-store");
  });

  it("refuses when the tenant has no Shopify connection, pointing at the install flow", async () => {
    H.connection.current = null;
    const res = await request(app()).get("/api/connectors/shopify/oauth/init");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("shopify_not_connected");
  });

  it("still works for a DISCONNECTED connection - the revoked-token path", async () => {
    // An uninstall clears the token but keeps the row and its shopDomain, so a
    // merchant can re-authorize without reinstalling from scratch.
    H.connection.current = { status: "DISCONNECTED", config: { shopDomain: SHOP } };
    const res = await request(app()).get("/api/connectors/shopify/oauth/init");
    expect(res.status).toBe(200);
    expect(new URL(res.body.url).origin).toBe(`https://${SHOP}`);
  });

  it("requires the connect permission", async () => {
    H.permission.granted = false;
    H.connection.current = { config: { shopDomain: SHOP } };
    const res = await request(app()).get("/api/connectors/shopify/oauth/init");
    expect(res.status).toBe(403);
  });
});
