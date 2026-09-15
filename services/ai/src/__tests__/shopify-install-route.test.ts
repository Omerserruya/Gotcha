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
    /** The store a connect would REPLACE. null = nothing to replace. */
    replacing: { current: null as string | null },
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
}));

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
  H.replacing.current = null;
  process.env.SHOPIFY_APP_HANDLE = "gotcha";
  // Both split variables start clear so a case that sets one is testing that
  // one. `SHOPIFY_APP_HANDLE` above remains the compatibility fallback.
  delete process.env.SHOPIFY_APP_STORE_HANDLE;
  delete process.env.SHOPIFY_APP_PRICING_HANDLE;
  // Default OFF, matching production before the listing is approved.
  delete process.env.SHOPIFY_APP_STORE_LISTING_LIVE;
});

// ─── The button ──────────────────────────────────────────────

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
    // An explicit key allow-list rather than a shape snapshot: the point is
    // that nothing SENSITIVE creeps in, and a new presentational field should
    // not have to weaken the guard to be added.
    expect(Object.keys(res.body.data).sort()).toEqual(["recovered", "shopDomain"]);
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
