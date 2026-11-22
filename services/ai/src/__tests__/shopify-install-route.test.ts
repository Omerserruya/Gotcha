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
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    /** The store a connect would REPLACE. null = nothing to replace. */
    replacing: { current: null as string | null },
    /** Durable per-tenant settings, keyed `${tenant}|${key}`. */
    settings: new Map<string, string | null>(),
    /** Which workspace holds a shop, for the billing return. */
    owner: { current: null as { tenantId: string; connectionId: string; status: string } | null },
    /** Is GOTCHA Core paid (the claim's own rule)? */
    corePaid: { yes: true },
    /** Billing's answer to the link: an outcome, null (unreachable), or "taken" (409). */
    billing: { current: { connectionId: "cc-1", state: "PLAN_SELECTION_REQUIRED", grandfathered: false, requiresPlanSelection: false, planSelectionUrl: null } as any },
    billingCalls: [] as any[],
    /** The workspace's own Shopify store as the claim prompt describes it (App Review 132211). */
    current: { current: null as { shopDomain: string; status: "CONNECTED" | "DISCONNECTED" } | null },
    dismissed: [] as any[],
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
    requireCoreForShopifyConnect: () => (_req: any, res: any, next: any) =>
      H.corePaid.yes ? next() : res.status(402).json({ error: "core_plan_required", scope: "gotcha_core", billedBy: "gotcha" }),
    requireOnboardingOrActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requirePermission: () => (_req: any, res: any, next: any) =>
      H.permission.granted ? next() : res.status(403).json({ error: "forbidden" }),
    readDurableSetting: async (t: string, k: string) => H.settings.get(`${t}|${k}`) ?? null,
    writeDurableSetting: async (t: string, k: string, v: string | null) => { H.settings.set(`${t}|${k}`, v); },
    coreAllowsShopifyConnect: async () => ({ allowed: H.corePaid.yes }),
  };
});

// The intent/pending store is exercised for its CONTRACT (single use, opaque
// handle, no token to the browser), not for its Redis wiring.
vi.mock("../services/shopify-install-intent.service", () => ({
  INSTALL_INTENT_COOKIE: "gotcha_shopify_intent",
  INSTALL_INTENT_TTL_SECONDS: 1800,
  PENDING_INSTALL_COOKIE: "gotcha_shopify_pending",
  // Real cookie writes, so the tests assert the header the browser actually
  // gets rather than that a helper was called.
  setPendingInstallCookie: (res: any, handle: string) =>
    res.cookie("gotcha_shopify_pending", handle, { httpOnly: true, sameSite: "lax", path: "/" }),
  clearPendingInstallCookie: (res: any) =>
    res.clearCookie("gotcha_shopify_pending", { path: "/" }),
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
  peekPendingAccessToken: vi.fn(async (h: any) => H.pendings.get(h)?.credentials?.accessToken ?? null),
  discardPendingConnection: vi.fn(async (h: any) => { H.dismissed.push(h); H.pendings.delete(h); }),
  PENDING_CONNECTION_TTL_SECONDS: 7200,
}));

// Billing's link, as the bridge reports it. The real class, so the route's
// instanceof check is the one under test.
vi.mock("../services/shopify-billing-bridge.service", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    resolveShopifyBillingOutcome: vi.fn(async (input: any) => {
      H.billingCalls.push(input);
      if (H.billing.current === "taken") throw new actual.CrossTenantShopError("held elsewhere");
      return H.billing.current;
    }),
  };
});

vi.mock("../services/shopify-connection-link.service", () => ({
  SHOPIFY_OAUTH_SCOPES: "read_orders,read_products",
  linkShopifyShopToTenant: vi.fn(async (input: any) => {
    H.linkCalls.push(input);
    return H.linkResult.current;
  }),
  exchangeShopifyCode: vi.fn(async () => ({ accessToken: "shpat_secret", scope: "read_orders" })),
  // Returns the store this workspace would REPLACE, or null. Defaults to null
  // (nothing to replace) so existing cases keep the plain connect path; the
  // multiple-store cases override H.replacing.
  pendingStoreReplacement: vi.fn(async () => H.replacing.current),
  findShopOwner: vi.fn(async () => H.owner.current),
  shopHeldElsewhere: (owner: any, tenantId: string) => !!owner && owner.tenantId !== tenantId && owner.status !== "DISCONNECTED",
  currentStoreOf: vi.fn(async () => H.current.current),
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
  H.current.current = null;
  H.dismissed = [];
  H.corePaid.yes = true;
  H.permission.granted = true;
  H.tenantId.current = "tenant-A";
  H.authed.yes = true;
  H.intents.clear();
  H.pendings.clear();
  H.linkCalls.length = 0;
  H.linkResult.current = { ok: true, connectionId: "conn-1", reconnected: false };
  H.replacing.current = null;
  H.owner.current = null;
  H.billingCalls.length = 0;
  H.billing.current = { connectionId: "cc-1", state: "PLAN_SELECTION_REQUIRED", grandfathered: false, requiresPlanSelection: false, planSelectionUrl: null };
  process.env.SHOPIFY_APP_HANDLE = "gotcha";
  // Both split variables start clear so a case that sets one is testing that
  // one. `SHOPIFY_APP_HANDLE` above remains the compatibility fallback.
  delete process.env.SHOPIFY_APP_STORE_HANDLE;
  delete process.env.SHOPIFY_APP_PRICING_HANDLE;
  // Default OFF, matching production before the listing is approved.
  delete process.env.SHOPIFY_APP_STORE_LISTING_LIVE;
});

// ─── The button ──────────────────────────────────────────────

// 2026-10-09: a refused install lands on the v2 studio with the same code it
// always carried; v1's /settings/business-systems never read the param.
const INSTALL_REFUSED = "https://app.gotcha.co.il/studio/capabilities?system=shopify&error=invalid_request";

describe("GET /connectors/shopify/install/start", () => {
  it("returns a SHOPIFY-owned URL and never asks for a shop domain", async () => {
    // The listing has to be marked live for a URL to exist at all; before
    // approval the honest answer is "not_published", covered separately below.
    process.env.SHOPIFY_APP_STORE_LISTING_LIVE = "true";
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

    // The redesigned app's flow, so its callback can land in /v2.
    await request(app()).get("/api/connectors/shopify/install/start?flow=redesign_studio");
    expect(H.intents.get(INTENT).flow).toBe("redesign_studio");
  });

  it("does NOT send the merchant to a listing that is not live yet", async () => {
    // THE SECOND REGRESSION, AND THE SUBTLER ONE.
    //
    // This route first answered 503 when the slug was unset, which review
    // 132211 quoted back under 4.5.5. The fix always returned a URL - but an
    // unapproved App Store listing 404s for anyone not signed in to a Partner
    // account, so the button stopped refusing and started leading to a dead
    // page. Shopify Support confirmed the in-app button is not the reviewer's
    // entry point before publication and that no pre-publication URL is needed.
    process.env.SHOPIFY_APP_STORE_HANDLE = "gotcha-3";
    delete process.env.SHOPIFY_APP_STORE_LISTING_LIVE;

    const res = await request(app()).get("/api/connectors/shopify/install/start");
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.mode).toBe("not_published");
    expect(res.body.url).toBeNull();
    // Still not an error, so the intent is still minted and the flow is intact.
    expect(H.intents.size).toBe(1);
  });

  it("uses the listing once it is explicitly marked live", async () => {
    process.env.SHOPIFY_APP_STORE_HANDLE = "gotcha-3";
    process.env.SHOPIFY_APP_STORE_LISTING_LIVE = "true";
    const res = await request(app()).get("/api/connectors/shopify/install/start");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("listing");
    expect(res.body.url).toBe("https://apps.shopify.com/gotcha-3");
  });

  it("keeps the listing slug independent of the admin/pricing handle", async () => {
    // These were ONE variable before review 132211, and the coupling was the
    // defect: the pricing handle was known and correct, the listing slug was
    // not, and the only way to keep the pricing URL right was to blank the
    // variable - which silently disabled this button.
    delete process.env.SHOPIFY_APP_STORE_HANDLE;
    delete process.env.SHOPIFY_APP_HANDLE;
    process.env.SHOPIFY_APP_PRICING_HANDLE = "gotcha-3";
    process.env.SHOPIFY_APP_STORE_LISTING_LIVE = "true";

    const res = await request(app()).get("/api/connectors/shopify/install/start");
    expect(res.status).toBe(200);
    // The pricing handle must NOT be borrowed as a listing slug.
    expect(res.body.mode).toBe("not_published");
    expect(JSON.stringify(res.body)).not.toContain("gotcha-3");
    delete process.env.SHOPIFY_APP_PRICING_HANDLE;
  });

  it("never offers a shop-domain fallback, in either state", async () => {
    // Someone "temporarily" restoring a domain prompt so merchants can connect
    // before the listing is live is the exact flow requirement 2.3.1 rejects,
    // and a temporary one is never removed.
    for (const live of [undefined, "true"]) {
      if (live) process.env.SHOPIFY_APP_STORE_LISTING_LIVE = live;
      else delete process.env.SHOPIFY_APP_STORE_LISTING_LIVE;
      const res = await request(app()).get("/api/connectors/shopify/install/start");
      const body = JSON.stringify(res.body);
      expect(body, String(live)).not.toContain("myshopify.com");
      expect(body, String(live)).not.toMatch(/enter|type|paste/i);
    }
  });

  it("ignores a custom-distribution install URL if one is ever put in the env", async () => {
    // Public distribution has ONE install surface. A per-store custom link
    // must not be honoured here - it would pin every merchant's button to one
    // merchant's shop.
    process.env.SHOPIFY_APP_STORE_LISTING_LIVE = "true";
    process.env.SHOPIFY_APP_INSTALL_URL =
      "https://admin.shopify.com/oauth/install_custom_app?client_id=abc";
    try {
      const res = await request(app()).get("/api/connectors/shopify/install/start");
      expect(JSON.stringify(res.body)).not.toContain("install_custom_app");
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
    expect(res.headers.location).toBe(INSTALL_REFUSED);
    expect(res.headers.location).not.toContain("myshopify.com/admin/oauth");
  });

  it("rejects a missing HMAC", async () => {
    const q = new URLSearchParams(entryQuery());
    q.delete("hmac");
    const res = await request(app()).get(`/api/connectors/shopify/install?${q}`);
    expect(res.headers.location).toBe(INSTALL_REFUSED);
  });

  it("rejects a stale timestamp", async () => {
    const stale = entryQuery({}, Date.now() - 3600_000);
    const res = await request(app()).get(`/api/connectors/shopify/install?${stale}`);
    expect(res.headers.location).toBe(INSTALL_REFUSED);
  });

  it("rejects deceptive shop hostnames, signed or not", async () => {
    for (const shop of ["evil.com", "shop.myshopify.com.evil.com", "evil", "a.b.myshopify.com"]) {
      const base = { shop, timestamp: String(Math.floor(Date.now() / 1000)) };
      const q = new URLSearchParams({ ...base, hmac: sign(base) }).toString();
      const res = await request(app()).get(`/api/connectors/shopify/install?${q}`);
      expect(res.headers.location, shop).toBe(INSTALL_REFUSED);
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
    expect(res.headers.location).toBe(INSTALL_REFUSED);
  });

  it("★ an unconfigured app lands on v2 with error=not_configured (2026-10-09)", async () => {
    const saved = process.env.SHOPIFY_REDIRECT_URI;
    delete process.env.SHOPIFY_REDIRECT_URI;
    try {
      const res = await request(app()).get(`/api/connectors/shopify/install?${entryQuery()}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("https://app.gotcha.co.il/studio/capabilities?system=shopify&error=not_configured");
    } finally {
      process.env.SHOPIFY_REDIRECT_URI = saved;
    }
  });

  it("the refusal landing ignores the request's Host", async () => {
    const q = new URLSearchParams(entryQuery());
    q.set("hmac", "0".repeat(64));
    const res = await request(app()).get(`/api/connectors/shopify/install?${q}`)
      .set("Host", "evil.example").set("X-Forwarded-Host", "evil.example");
    expect(res.headers.location).toBe(INSTALL_REFUSED);
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

// ─── Recovering an install after the URL handle is gone ──────

describe("pending install survives a lost URL", () => {
  // THE REGRESSION THIS EXISTS FOR.
  //
  // The pending handle lived only in the redirect's query string. A merchant
  // who installs from Shopify with no GOTCHA session is bounced to /login, and
  // that bounce discarded the URL - so the store they had just authorized
  // became permanently unreachable. They signed in, saw Shopify as
  // DISCONNECTED, and had no way to ask for it back. Shopify App Store review
  // 132211 recorded exactly that and failed us under 4.5.5.
  //
  // The handle is now ALSO an HttpOnly cookie, set at the OAuth callback.

  const COOKIE = "gotcha_shopify_pending";
  const PENDING = "p".repeat(64);

  beforeEach(() => {
    // A verified-but-unclaimed installation, exactly as the OAuth callback
    // would have parked it.
    H.pendings.set(PENDING, {
      shopDomain: SHOP,
      credentials: { accessToken: "shpat_secret" },
    });
  });

  it("finds the store from the cookie with NO handle in the URL", async () => {
    const res = await request(app())
      .get("/api/connectors/shopify/install/pending")
      .set("Cookie", `${COOKIE}=${PENDING}`);

    expect(res.status).toBe(200);
    expect(res.body.data.shopDomain).toBe(SHOP);
    // Flagged as recovered, so the UI can say "we found the store you just
    // authorized" instead of implying the merchant navigated here on purpose.
    expect(res.body.data.recovered).toBe(true);
  });

  it("claims from the cookie with no handle in the body", async () => {
    const res = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .set("Cookie", `${COOKIE}=${PENDING}`)
      .send({});

    expect(res.status).toBe(200);
    expect(H.linkCalls[0]).toMatchObject({ shopDomain: SHOP });
  });

  it("clears the cookie once the store is connected", async () => {
    // Otherwise the next page load would keep offering to finish an
    // installation that is already a connection.
    const res = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .set("Cookie", `${COOKIE}=${PENDING}`)
      .send({});

    expect(res.status).toBe(200);
    const setCookie = String(res.headers["set-cookie"] ?? "");
    expect(setCookie).toContain(COOKIE);
    // An expiry in the past is how Express clears a cookie.
    expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it("clears a cookie pointing at an installation that is gone", async () => {
    const res = await request(app())
      .get("/api/connectors/shopify/install/pending")
      .set("Cookie", `${COOKIE}=${"z".repeat(64)}`);

    expect(res.status).toBe(404);
    expect(String(res.headers["set-cookie"] ?? "")).toContain(COOKIE);
  });

  it("prefers an explicit URL handle over the cookie", async () => {
    // A stale cookie must never win over what the merchant was actually sent
    // to. Both resolve here, and the URL is the more specific statement.
    const stale = "y".repeat(64);
    H.pendings.set(stale, { shopDomain: "stale-store.myshopify.com", credentials: { accessToken: "t" } });
    const res = await request(app())
      .get(`/api/connectors/shopify/install/pending?handle=${PENDING}`)
      .set("Cookie", `${COOKIE}=${stale}`);

    expect(res.body.data.shopDomain).toBe(SHOP);
    expect(res.body.data.recovered).toBe(false);
  });

  it("still requires authentication and the connect permission", async () => {
    // The cookie proves the browser completed Shopify's OAuth. It proves
    // nothing about WHO may attach that store to a workspace, and must never
    // be treated as authorization on its own.
    H.authed.yes = false;
    expect(
      (await request(app()).get("/api/connectors/shopify/install/pending").set("Cookie", `${COOKIE}=${PENDING}`)).status,
    ).toBe(401);

    H.authed.yes = true;
    H.permission.granted = false;
    expect(
      (await request(app()).post("/api/connectors/shopify/install/claim").set("Cookie", `${COOKIE}=${PENDING}`).send({})).status,
    ).toBe(403);
  });

  it("two concurrent claims produce exactly ONE connection", async () => {
    // The pending record is consumed with GETDEL, which is atomic, so only one
    // caller can ever win. Asserted rather than assumed: a non-atomic read+
    // delete here would let a double-submit create two connections for one
    // store, and the second would silently replace the first.
    const [a, b] = await Promise.all([
      request(app())
        .post("/api/connectors/shopify/install/claim")
        .set("Cookie", `${COOKIE}=${PENDING}`)
        .send({}),
      request(app())
        .post("/api/connectors/shopify/install/claim")
        .set("Cookie", `${COOKIE}=${PENDING}`)
        .send({}),
    ]);

    // Exactly one winner. The loser's status depends on where it lands in the
    // race and BOTH answers are correct refusals: 404 if its peek ran after the
    // winner consumed the record, 409 if the peek succeeded and the consume
    // then lost. Pinning one of them would make this test fail on timing
    // rather than on behaviour.
    const ok = [a.status, b.status].filter((c) => c === 200);
    const refused = [a.status, b.status].filter((c) => c === 404 || c === 409);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // The invariant that actually matters: one store, one connection attempt.
    expect(H.linkCalls).toHaveLength(1);
  });

  it("a forged cookie naming no real installation gets nothing", async () => {
    const res = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .set("Cookie", `${COOKIE}=${"f".repeat(64)}`)
      .send({});
    expect(res.status).toBe(404);
    expect(H.linkCalls).toHaveLength(0);
  });
});

// ─── One store per workspace, replaced only on purpose ───────

describe("multiple stores", () => {
  // A workspace holds at most one Shopify store: `tenantIntegration` is unique
  // on (tenantId, integrationId). So connecting a second store necessarily
  // disconnects the first, and that USED to happen silently - the row's
  // shopDomain and token were overwritten, the old store kept the app
  // installed on Shopify's side, and every AI answer quietly began reading a
  // different catalogue. The merchant was shown "Connected" either way.

  const OTHER = "second-store.myshopify.com";

  function pend(handle: string, shop: string) {
    H.pendings.set(handle, { shopDomain: shop, credentials: { accessToken: "t" } });
  }

  it("refuses to replace a different store that was not confirmed", async () => {
    H.replacing.current = "first-store.myshopify.com";
    const handle = "q".repeat(64);
    pend(handle, OTHER);

    const res = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .send({ handle });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("another_store_connected");
    // Both stores are NAMED, so the UI can ask a real question instead of
    // reporting that something went wrong.
    expect(res.body.data.currentShopDomain).toBe("first-store.myshopify.com");
    expect(res.body.data.incomingShopDomain).toBe(OTHER);
    // Nothing was written.
    expect(H.linkCalls).toHaveLength(0);
  });

  it("does not spend the single-use handle on the question", async () => {
    // The check runs BEFORE the handle is consumed. Otherwise answering "yes,
    // replace it" would require reinstalling from Shopify, because the handle
    // is one-shot by construction.
    H.replacing.current = "first-store.myshopify.com";
    const handle = "r".repeat(64);
    pend(handle, OTHER);

    const first = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .send({ handle });
    expect(first.status).toBe(409);
    expect(first.body.data.handle).toBe(handle);
    expect(H.pendings.has(handle)).toBe(true);

    // The merchant's answer goes straight back.
    const second = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .send({ handle, replace: true });
    expect(second.status).toBe(200);
    expect(H.linkCalls[0]).toMatchObject({ shopDomain: OTHER, allowReplace: true });
  });

  it("does not ask when the SAME store reconnects", async () => {
    // Reinstall and reauthorization must stay a plain update. `replacing` is
    // null for the same shop, which is what the service reports.
    H.replacing.current = null;
    const handle = "s".repeat(64);
    pend(handle, SHOP);

    const res = await request(app())
      .post("/api/connectors/shopify/install/claim")
      .send({ handle });
    expect(res.status).toBe(200);
    expect(H.linkCalls[0]).toMatchObject({ shopDomain: SHOP, allowReplace: false });
  });

  it("passes allowReplace only when the merchant actually said so", async () => {
    // A truthy-ish value is not consent. Only `true` counts, so a stray
    // `replace: "false"` or `replace: 1` cannot disconnect a store.
    H.replacing.current = null;
    for (const [i, value] of [undefined, "true", 1, "yes", false].entries()) {
      H.linkCalls.length = 0;
      const handle = String(i).repeat(64);
      pend(handle, SHOP);
      await request(app())
        .post("/api/connectors/shopify/install/claim")
        .send(value === undefined ? { handle } : { handle, replace: value });
      expect(H.linkCalls[0].allowReplace, String(value)).toBe(false);
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
    expect(res.headers.location).toBe(INSTALL_REFUSED);
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
    // An explicit key allow-list rather than a shape snapshot: the point is
    // that nothing SENSITIVE creeps in, and a new presentational field should
    // not have to weaken the guard to be added.
    // App Review 132211 (2026-11-22) added what the prompt may offer: the action, the workspace's own
    // current store and when this approval lapses. Still no token and no handle.
    expect(Object.keys(res.body.data).sort()).toEqual(["action", "current", "expiresAt", "recovered", "shopDomain"]);
    expect(res.body.data.shopDomain).toBe(SHOP);
    expect(JSON.stringify(res.body)).not.toContain("shpat_secret");
    // The HANDLE is the key to the stored access token, so it must not be
    // echoed back either. The browser carries it in an HttpOnly cookie.
    expect(JSON.stringify(res.body)).not.toContain(PENDING);
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

  // ── 2026-10-29: billing refused, the claim said 200, ai said Connected ──
  const claim = () => request(app()).post("/api/connectors/shopify/install/claim").send({ handle: PENDING });

  it("billing refuses (held live elsewhere): 409 with the handle unspent, ai never written", async () => {
    H.billing.current = "taken";
    const res = await claim();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "shop_connected_to_another_workspace", data: { handle: PENDING } });
    expect(H.linkCalls).toHaveLength(0);
    expect(H.pendings.has(PENDING)).toBe(true);
  });

  it("billing unreachable: 503 billing_link_failed, handle unspent, ai never written; a retry then succeeds", async () => {
    H.billing.current = null;
    const res = await claim();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "billing_link_failed", data: { handle: PENDING } });
    expect(H.linkCalls).toHaveLength(0);
    expect(H.pendings.has(PENDING)).toBe(true);

    H.billing.current = { connectionId: "cc-1", state: "ACTIVE", grandfathered: false, requiresPlanSelection: false, planSelectionUrl: null };
    const again = await claim();
    expect(again.status).toBe(200);
    expect(again.body.data.billingState).toBe("ACTIVE");
    expect(H.linkCalls).toHaveLength(1);
  });

  it("a LIVE ai row in another workspace refuses before billing is even asked", async () => {
    H.owner.current = { tenantId: "tenant-Z", connectionId: "ti-z", status: "CONNECTED" };
    const res = await claim();
    expect([res.status, res.body.error]).toEqual([409, "shop_connected_to_another_workspace"]);
    expect(H.billingCalls).toHaveLength(0);
    expect(H.linkCalls).toHaveLength(0);
  });

  it("a DISCONNECTED ai row in another workspace does not block", async () => {
    H.owner.current = { tenantId: "tenant-Z", connectionId: "ti-z", status: "DISCONNECTED" };
    const res = await claim();
    expect(res.status).toBe(200);
    expect(H.billingCalls).toHaveLength(1);
    expect(H.linkCalls).toHaveLength(1);
  });

  it("billing is linked with the pending token for the CALLER's workspace, before ai", async () => {
    await claim();
    expect(H.billingCalls[0]).toMatchObject({ tenantId: "tenant-A", accessToken: expect.any(String), acquisitionSource: "app_store" });
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


// ─── The return from Shopify's plan page ─────────────────────

describe("GET /connectors/shopify/billing/return", () => {
  beforeEach(() => { H.settings.clear(); H.owner.current = null; });
  const ret = (q: string) => request(app()).get(`/api/connectors/shopify/billing/return?${q}`);

  it("★ install/start remembers which app the connect began in (and forgets on an old-app start)", async () => {
    await request(app()).get("/api/connectors/shopify/install/start?flow=redesign_studio");
    expect(H.settings.get("tenant-A|shopify.returnFlow")).toBe("redesign_studio");
    await request(app()).get("/api/connectors/shopify/install/start");
    expect(H.settings.get("tenant-A|shopify.returnFlow")).toBeNull();
  });

  it("★ a v2 workspace's return lands in the app to verify there (at the root since 2026-10-21)", async () => {
    H.owner.current = { tenantId: "tenant-A", connectionId: "c1", status: "CONNECTED" };
    H.settings.set("tenant-A|shopify.returnFlow", "redesign_studio");
    const r = await ret(`plan_handle=pro&shop=${SHOP}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/[^2]\/studio\/capabilities\?system=shopify&billing=verify&shop=urban-supply-dev\.myshopify\.com$/);
    expect(r.headers.location).not.toContain("/v2/");
  });

  it("★ everyone else gets today's page, with Shopify's query passed through untouched", async () => {
    H.owner.current = { tenantId: "tenant-A", connectionId: "c1", status: "CONNECTED" };
    const r = await ret(`plan_handle=pro&shop=${SHOP}`);
    expect(r.headers.location).toMatch(new RegExp(`/integrations/shopify/billing/complete\\?plan_handle=pro&shop=${SHOP.replace(/\./g, "\\.")}$`));
  });

  it("★ an onboarding start is remembered and its billing return lands on the systems step", async () => {
    await request(app()).get("/api/connectors/shopify/install/start?flow=onboarding_systems");
    expect(H.settings.get("tenant-A|shopify.returnFlow")).toBe("onboarding_systems");
    H.owner.current = { tenantId: "tenant-A", connectionId: "c1", status: "CONNECTED" };
    const r = await ret(`plan_handle=pro&shop=${SHOP}`);
    expect(r.headers.location).toMatch(/\/onboarding\/systems\?system=shopify&billing=verify&shop=urban-supply-dev\.myshopify\.com$/);
  });

  it("an unknown shop, or no shop, gets today's page - never a guess", async () => {
    expect((await ret(`plan_handle=pro&shop=nobody.myshopify.com`)).headers.location).toContain("/integrations/shopify/billing/complete?");
    expect((await ret(`plan_handle=pro`)).headers.location).toContain("/integrations/shopify/billing/complete?plan_handle=pro");
  });
});

describe("a store connects only after GOTCHA Core is paid (split billing 2026-10-28)", () => {
  it("install/start and the claim refuse core_plan_required, scoped to Core, before anything is created", async () => {
    H.corePaid.yes = false;
    const start = await request(app()).get("/api/connectors/shopify/install/start");
    expect(start.status).toBe(402);
    expect(start.body).toMatchObject({ error: "core_plan_required", scope: "gotcha_core", billedBy: "gotcha" });
    expect(H.intents.size).toBe(0);
    const claim = await request(app()).post("/api/connectors/shopify/install/claim").send({ handle: "anything" });
    expect(claim.status).toBe(402);
    expect(claim.body.error).toBe("core_plan_required");
    expect(H.linkCalls).toHaveLength(0);
  });
  it("wired on both routes", () => {
    const src = readFileSync(join(__dirname, "../routes/shopify-install.ts"), "utf8");
    expect(src.match(/requireCoreForShopifyConnect\(\),/g)?.length).toBe(2);
    expect(src).not.toContain("requireActiveTenant()");
  });
});

describe("App Review 132211: the claim prompt from any page, and Not now (2026-11-22)", () => {
  const P = "p".repeat(64);
  const C = "gotcha_shopify_pending";
  const NEW = "random-randomizer.myshopify.com";
  const pending = () => request(app()).get("/api/connectors/shopify/install/pending").set("Cookie", `${C}=${P}`);
  beforeEach(() => {
    H.owner.current = null;
    H.pendings.set(P, { shopDomain: NEW, credentials: { accessToken: "shpat_new" } });
  });

  it("★ an empty workspace: attach, with when it lapses, nothing about another store", async () => {
    const r = await pending();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ shopDomain: NEW, action: "attach", current: null });
    expect(r.body.data.blockedReason).toBeUndefined();
    expect(Date.parse(r.body.data.expiresAt) - Date.now()).toBeGreaterThan(7190_000);
    expect(JSON.stringify(r.body)).not.toMatch(/shpat_|pppp/);
  });

  it("★ the old store uninstalled (DISCONNECTED): attach directly, the old one named", async () => {
    H.current.current = { shopDomain: "app-review-old.myshopify.com", status: "DISCONNECTED" };
    const r = await pending();
    expect(r.body.data).toMatchObject({ action: "attach", current: { shopDomain: "app-review-old.myshopify.com", status: "DISCONNECTED" } });
  });

  it("★ another store connected: replace, the current one named", async () => {
    H.current.current = { shopDomain: "app-review-old.myshopify.com", status: "CONNECTED" };
    const r = await pending();
    expect(r.body.data).toMatchObject({ action: "replace", current: { shopDomain: "app-review-old.myshopify.com", status: "CONNECTED" } });
  });

  it("the same store coming back: attach, no current", async () => {
    H.current.current = { shopDomain: NEW, status: "CONNECTED" };
    const r = await pending();
    expect(r.body.data).toMatchObject({ action: "attach", current: null });
  });

  it("blocked before a claim would refuse: Core unpaid, or the store held by another workspace", async () => {
    H.corePaid.yes = false;
    expect((await pending()).body.data).toMatchObject({ action: "blocked", blockedReason: "core_plan_required" });
    H.corePaid.yes = true;
    H.owner.current = { tenantId: "tenant-B", connectionId: "c9", status: "CONNECTED" };
    expect((await pending()).body.data).toMatchObject({ action: "blocked", blockedReason: "held_by_other_workspace" });
    H.owner.current = { tenantId: "tenant-B", connectionId: "c9", status: "DISCONNECTED" };
    expect((await pending()).body.data).toMatchObject({ action: "attach" });
  });

  it("★ Not now: the parked install is dropped and the cookie cleared; nothing else is called", async () => {
    const r = await request(app()).post("/api/connectors/shopify/install/pending/dismiss").set("Cookie", `${C}=${P}`).send({});
    expect(r.status).toBe(204);
    expect(H.dismissed).toEqual([P]);
    expect(String(r.headers["set-cookie"] ?? "")).toMatch(/gotcha_shopify_pending=;.*(Expires=Thu, 01 Jan 1970|Max-Age=0)/);
    expect(H.linkCalls).toEqual([]);
    expect(H.billingCalls).toEqual([]);
    expect((await pending()).status).toBe(404);
  });

  it("Not now needs the same sign-in and permission as the claim", async () => {
    H.permission.granted = false;
    expect((await request(app()).post("/api/connectors/shopify/install/pending/dismiss").set("Cookie", `${C}=${P}`)).status).toBe(403);
    H.permission.granted = true;
    H.authed.yes = false;
    expect((await request(app()).post("/api/connectors/shopify/install/pending/dismiss").set("Cookie", `${C}=${P}`)).status).toBe(401);
    expect(H.dismissed).toEqual([]);
  });
});
