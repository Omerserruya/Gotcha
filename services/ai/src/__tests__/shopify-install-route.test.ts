/**
 * The Shopify-owned installation flow, end to end at the route boundary.
 *
 * The behaviours that matter here are ORDERING and AUTHORITY:
 *
 *   ordering   OAuth must begin before any GOTCHA UI. The public install
 *              handler either 302s to `/admin/oauth/authorize` or refuses -
 *              it never renders, and never asks for a login.
 *
 *   authority  The shop is whatever Shopify SIGNED. The workspace is whatever
 *              an authenticated GOTCHA session said. Neither is ever read
 *              from a query parameter, and the two are never confused for
 *              each other.
 *
 * The signature is computed here the way Shopify computes it, independently
 * of the helper under test.
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
  process.env.SHOPIFY_APP_HANDLE = "gotcha";
  process.env.FRONTEND_URL = "https://app.gotcha.co.il";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    permission: { granted: true },
    tenantId: { current: "tenant-A" as string | null },
    authed: { yes: true },
    intents: new Map<string, any>(),
    pendings: new Map<string, any>(),
    linkResult: { current: { ok: true, connectionId: "conn-1", reconnected: false } as any },
    linkCalls: [] as any[],
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authenticate: (req: any, res: any, next: any) => {
      if (!H.authed.yes) { res.status(401).json({ error: "unauthenticated" }); return; }
      req.user = { userId: "user-1", tenantId: H.tenantId.current, role: "ADMIN" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = H.tenantId.current; next(); },
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requireOnboardingOrActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requirePermission: () => (_req: any, res: any, next: any) =>
      H.permission.granted ? next() : res.status(403).json({ error: "forbidden" }),
  };
});

// The intent/pending store is exercised for its CONTRACT (single use, opaque
// handle, no token to the browser), not for its Redis wiring.
vi.mock("../services/shopify-install-intent.service", () => ({
  INSTALL_INTENT_COOKIE: "gotcha_shopify_intent",
  INSTALL_INTENT_TTL_SECONDS: 1800,
  createInstallIntent: vi.fn(async (input: any) => {
    const handle = "i".repeat(64);
    H.intents.set(handle, { ...input });
    return handle;
  }),
  readInstallIntent: vi.fn(async (h: any) => H.intents.get(h) ?? null),
  consumeInstallIntent: vi.fn(async (h: any) => {
    const v = H.intents.get(h) ?? null;
    H.intents.delete(h);
    return v;
  }),
  discardInstallIntent: vi.fn(async (h: any) => { H.intents.delete(h); }),
  createPendingConnection: vi.fn(async (input: any) => {
    const handle = "p".repeat(64);
    H.pendings.set(handle, { ...input });
    return handle;
  }),
  peekPendingConnection: vi.fn(async (h: any) => {
    const v = H.pendings.get(h);
    return v ? { shopDomain: v.shopDomain, createdAt: Date.now() } : null;
  }),
  consumePendingConnection: vi.fn(async (h: any) => {
    const v = H.pendings.get(h) ?? null;
    H.pendings.delete(h);
    return v;
  }),
}));

vi.mock("../services/shopify-connection-link.service", () => ({
  SHOPIFY_OAUTH_SCOPES: "read_orders,read_products",
  linkShopifyShopToTenant: vi.fn(async (input: any) => {
    H.linkCalls.push(input);
    return H.linkResult.current;
  }),
  exchangeShopifyCode: vi.fn(async () => ({ accessToken: "shpat_secret", scope: "read_orders" })),
  findShopOwner: vi.fn(async () => null),
}));

import router from "../routes/shopify-install";

const SECRET = "core-app-secret";
const SHOP = "urban-supply-dev.myshopify.com";
const INTENT = "i".repeat(64);

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

/** A signed app-entry query string, as Shopify would send it. */
function entryQuery(over: Record<string, string> = {}, atMs = Date.now()): string {
  const base: Record<string, string> = {
    shop: SHOP,
    timestamp: String(Math.floor(atMs / 1000)),
    host: "aG9zdA==",
    ...over,
  };
  const q = { ...base, hmac: sign(base) };
  return new URLSearchParams(q).toString();
}

beforeEach(() => {
  vi.clearAllMocks();
  H.permission.granted = true;
  H.tenantId.current = "tenant-A";
  H.authed.yes = true;
  H.intents.clear();
  H.pendings.clear();
  H.linkCalls.length = 0;
  H.linkResult.current = { ok: true, connectionId: "conn-1", reconnected: false };
  process.env.SHOPIFY_APP_HANDLE = "gotcha";
});

// ─── The button ──────────────────────────────────────────────

describe("GET /connectors/shopify/install/start", () => {
  it("returns a SHOPIFY-owned URL and never asks for a shop domain", async () => {
    const res = await request(app()).get("/api/connectors/shopify/install/start");
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://apps.shopify.com/gotcha");
    // The whole point: nothing in this response, and nothing the caller must
    // supply, is a merchant-typed store address.
    expect(JSON.stringify(res.body)).not.toContain("myshopify.com");
  });

  it("records the workspace SERVER-SIDE and returns only an opaque handle", async () => {
    const res = await request(app()).get("/api/connectors/shopify/install/start");
    const cookie = res.headers["set-cookie"]?.[0] || "";
    expect(cookie).toContain("gotcha_shopify_intent=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toMatch(/SameSite=Lax/i);
    // The tenant is in the SERVER's record, never in anything the browser holds.
    expect(H.intents.get(INTENT)).toMatchObject({ tenantId: "tenant-A", userId: "user-1" });
    expect(cookie).not.toContain("tenant-A");
  });

  it("carries only an allow-listed flow", async () => {
    await request(app()).get("/api/connectors/shopify/install/start?flow=onboarding");
    expect(H.intents.get(INTENT).flow).toBe("onboarding");
    H.intents.clear();
    await request(app()).get("/api/connectors/shopify/install/start?flow=https://evil.com");
    expect(H.intents.get(INTENT).flow).toBeUndefined();
  });

  it("says installs are not available yet when the listing is unpublished", async () => {
    delete process.env.SHOPIFY_APP_HANDLE;
    const res = await request(app()).get("/api/connectors/shopify/install/start");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("shopify_install_not_available");
    // No intent is minted for a flow that cannot start.
    expect(H.intents.size).toBe(0);
  });

  it("never offers a shop-domain fallback when the listing is unpublished", async () => {
    // The failure mode this guards: someone "temporarily" restores a domain
    // prompt so merchants can still connect before the listing is live. That
    // is the exact flow App Store requirement 2.3.1 rejects, and a temporary
    // one is never removed.
    delete process.env.SHOPIFY_APP_HANDLE;
    const res = await request(app()).get("/api/connectors/shopify/install/start");
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("myshopify.com");
    expect(body).not.toMatch(/enter|type|paste/i);
    expect(res.body.url).toBeUndefined();
  });

  it("ignores a custom-distribution install URL if one is ever put in the env", async () => {
    // Public distribution has ONE install surface. A per-store custom link
    // must not be honoured here - it would pin every merchant's button to one
    // merchant's shop.
    delete process.env.SHOPIFY_APP_HANDLE;
    process.env.SHOPIFY_APP_INSTALL_URL =
      "https://admin.shopify.com/oauth/install_custom_app?client_id=abc";
    try {
      const res = await request(app()).get("/api/connectors/shopify/install/start");
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("shopify_install_not_available");
    } finally {
      delete process.env.SHOPIFY_APP_INSTALL_URL;
    }
  });

  it("requires authentication and the connect permission", async () => {
    H.authed.yes = false;
    expect((await request(app()).get("/api/connectors/shopify/install/start")).status).toBe(401);

    H.authed.yes = true;
    H.permission.granted = false;
    expect((await request(app()).get("/api/connectors/shopify/install/start")).status).toBe(403);
  });
});

// ─── The public install handler ──────────────────────────────

describe("GET /connectors/shopify/install (public)", () => {
  it("begins OAuth immediately on a valid signed request", async () => {
    const res = await request(app()).get(`/api/connectors/shopify/install?${entryQuery()}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin).toBe(`https://${SHOP}`);
    expect(loc.pathname).toBe("/admin/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("core-client-id");
    expect(loc.searchParams.get("state")).toBeTruthy();
  });

  it("needs NO GOTCHA session - a merchant installing from the App Store has none", async () => {
    H.authed.yes = false; // would 401 any authenticated route
    const res = await request(app()).get(`/api/connectors/shopify/install?${entryQuery()}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/admin/oauth/authorize");
    // Never a login or onboarding screen before authorization.
    expect(res.headers.location).not.toContain("/login");
    expect(res.headers.location).not.toContain("/setup");
  });

  it("rejects an invalid HMAC without redirecting to Shopify", async () => {
    const q = new URLSearchParams(entryQuery());
    q.set("hmac", "0".repeat(64));
    const res = await request(app()).get(`/api/connectors/shopify/install?${q}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("shopify_install_error=invalid_request");
    expect(res.headers.location).not.toContain("myshopify.com/admin/oauth");
  });

  it("rejects a missing HMAC", async () => {
    const q = new URLSearchParams(entryQuery());
    q.delete("hmac");
    const res = await request(app()).get(`/api/connectors/shopify/install?${q}`);
    expect(res.headers.location).toContain("shopify_install_error=invalid_request");
  });

  it("rejects a stale timestamp", async () => {
    const stale = entryQuery({}, Date.now() - 3600_000);
    const res = await request(app()).get(`/api/connectors/shopify/install?${stale}`);
    expect(res.headers.location).toContain("shopify_install_error=invalid_request");
  });

  it("rejects deceptive shop hostnames, signed or not", async () => {
    for (const shop of ["evil.com", "shop.myshopify.com.evil.com", "evil", "a.b.myshopify.com"]) {
      const base = { shop, timestamp: String(Math.floor(Date.now() / 1000)) };
      const q = new URLSearchParams({ ...base, hmac: sign(base) }).toString();
      const res = await request(app()).get(`/api/connectors/shopify/install?${q}`);
      expect(res.headers.location, shop).toContain("shopify_install_error=invalid_request");
    }
  });

  it("never emits an open redirect, whatever the query says", async () => {
    // A signed request cannot smuggle a destination: the redirect host is built
    // from the verified shop, and `return_to`-shaped params are just more
    // signed noise.
    const q = entryQuery({ return_to: "https://evil.com", redirect_uri: "https://evil.com" });
    const res = await request(app()).get(`/api/connectors/shopify/install?${q}`);
    expect(new URL(res.headers.location).origin).toBe(`https://${SHOP}`);
  });

  it("rejects duplicated parameters", async () => {
    const q = `${entryQuery()}&shop=${encodeURIComponent("attacker.myshopify.com")}`;
    const res = await request(app()).get(`/api/connectors/shopify/install?${q}`);
    expect(res.headers.location).toContain("shopify_install_error=invalid_request");
  });

  it("does not log the shop or the hmac when the signature fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = new URLSearchParams(entryQuery());
    q.set("hmac", "f".repeat(64));
    await request(app()).get(`/api/connectors/shopify/install?${q}`);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("hmac_invalid");
    expect(logged).not.toContain(SHOP);
    expect(logged).not.toContain("f".repeat(64));
    warn.mockRestore();
  });

  it("binds the workspace when the browser carries a valid intent", async () => {
    H.intents.set(INTENT, { tenantId: "tenant-A", userId: "user-1", flow: "onboarding" });
    const res = await request(app())
      .get(`/api/connectors/shopify/install?${entryQuery()}`)
      .set("Cookie", `gotcha_shopify_intent=${INTENT}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/admin/oauth/authorize");
  });

  it("falls through to the anonymous path when the intent cookie is unusable", async () => {
    // A forged, expired or DUPLICATED cookie must degrade to "no workspace
    // known", never to "some workspace".
    for (const cookie of [
      `gotcha_shopify_intent=${"z".repeat(64)}`,      // not a real handle
      `gotcha_shopify_intent=${INTENT}; gotcha_shopify_intent=${"q".repeat(64)}`, // duplicate
      "gotcha_shopify_intent=",                        // empty
    ]) {
      const res = await request(app())
        .get(`/api/connectors/shopify/install?${entryQuery()}`)
        .set("Cookie", cookie);
      expect(res.status, cookie).toBe(302);
      expect(res.headers.location).toContain("/admin/oauth/authorize");
    }
  });
});

// ─── A missing listing handle blocks ONLY the button ─────────

describe("installation works with no SHOPIFY_APP_HANDLE configured", () => {
  // This is the property the whole pre-listing development-store test rests
  // on. A developer installing from the Partner Dashboard reaches
  // `application_url` directly; nothing on that path reads the listing
  // handle. If this regresses, dev-store installs start failing with a "not
  // available" error that looks nothing like its cause.

  it("the PUBLIC install handler still verifies and starts OAuth", async () => {
    delete process.env.SHOPIFY_APP_HANDLE;
    const res = await request(app()).get(`/api/connectors/shopify/install?${entryQuery()}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin).toBe(`https://${SHOP}`);
    expect(loc.pathname).toBe("/admin/oauth/authorize");
  });

  it("...and still rejects an unsigned request", async () => {
    delete process.env.SHOPIFY_APP_HANDLE;
    const q = new URLSearchParams(entryQuery());
    q.set("hmac", "0".repeat(64));
    const res = await request(app()).get(`/api/connectors/shopify/install?${q}`);
    expect(res.headers.location).toContain("shopify_install_error=invalid_request");
  });

  it("...and still works with no GOTCHA session at all", async () => {
    delete process.env.SHOPIFY_APP_HANDLE;
    H.authed.yes = false;
    const res = await request(app()).get(`/api/connectors/shopify/install?${entryQuery()}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/admin/oauth/authorize");
  });

  it("...and a pending install can still be claimed after sign-in", async () => {
    delete process.env.SHOPIFY_APP_HANDLE;
    const handle = "p".repeat(64);
    H.pendings.set(handle, { shopDomain: SHOP, credentials: { accessToken: "t" } });
    const res = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .send({ handle });
    expect(res.status).toBe(200);
    expect(H.linkCalls[0]).toMatchObject({ shopDomain: SHOP });
  });
});

// ─── Claiming ────────────────────────────────────────────────

describe("shopify install claim", () => {
  const PENDING = "p".repeat(64);

  beforeEach(() => {
    H.pendings.set(PENDING, {
      shopDomain: SHOP,
      credentials: { accessToken: "shpat_secret" },
      flow: undefined,
    });
  });

  it("shows the shop name and NOTHING else - never the access token", async () => {
    const res = await request(app()).get(
      `/api/connectors/shopify/install/pending?handle=${PENDING}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ shopDomain: SHOP });
    expect(JSON.stringify(res.body)).not.toContain("shpat_secret");
  });

  it("peeking does not burn the claim - a page reload must be safe", async () => {
    await request(app()).get(`/api/connectors/shopify/install/pending?handle=${PENDING}`);
    await request(app()).get(`/api/connectors/shopify/install/pending?handle=${PENDING}`);
    const res = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .send({ handle: PENDING });
    expect(res.status).toBe(200);
  });

  it("links to the CALLER'S validated workspace, not anything in the request", async () => {
    H.tenantId.current = "tenant-B";
    const res = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .send({ handle: PENDING, tenantId: "tenant-A", workspaceId: "tenant-A" });
    expect(res.status).toBe(200);
    // The body's tenantId is ignored outright.
    expect(H.linkCalls[0]).toMatchObject({ tenantId: "tenant-B", shopDomain: SHOP });
  });

  it("is single use", async () => {
    const first = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .send({ handle: PENDING });
    expect(first.status).toBe(200);

    const second = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .send({ handle: PENDING });
    expect(second.status).toBe(404);
    expect(H.linkCalls).toHaveLength(1);
  });

  it("refuses a store already connected to another workspace, without moving it", async () => {
    H.linkResult.current = { ok: false, reason: "shop_taken", conflictingTenantId: "tenant-Z" };
    const res = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .send({ handle: PENDING });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("shop_connected_to_another_workspace");
    // The conflicting workspace is never named to the caller.
    expect(JSON.stringify(res.body)).not.toContain("tenant-Z");
  });

  it("requires authentication and re-checks the connect permission on the CLAIMANT", async () => {
    H.authed.yes = false;
    expect(
      (await request(app()).post("/api/connectors/shopify/install/claim").send({ handle: PENDING }))
        .status,
    ).toBe(401);

    H.authed.yes = true;
    H.permission.granted = false;
    expect(
      (await request(app()).post("/api/connectors/shopify/install/claim").send({ handle: PENDING }))
        .status,
    ).toBe(403);
    expect(H.linkCalls).toHaveLength(0);
  });

  it("rejects an unknown or malformed handle", async () => {
    for (const handle of [undefined, "", "not-a-handle", "z".repeat(64), { evil: true }]) {
      const res = await request(app())
        .post("/api/connectors/shopify/install/claim")
        .send({ handle });
      expect(res.status, String(handle)).toBe(404);
    }
  });
});
