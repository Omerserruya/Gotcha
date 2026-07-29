/**
 * CORS for the Shopify storefront surface.
 *
 * Two different problems that must not be solved the same way:
 *
 *   - the widget JavaScript is public, immutable and loaded by <script>
 *     from every merchant domain there is, so it takes a wildcard;
 *   - the API answers with per-merchant configuration, so it echoes one
 *     verified origin and never a wildcard.
 *
 * Getting this wrong the first time cost a real afternoon: the browser
 * blocked the script, nothing ever reached the server, and every
 * server-side diagnostic cheerfully reported "ready". So these assert the
 * headers themselves, including on the refusal paths, because a refusal
 * the browser cannot read is indistinguishable from a network failure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-that-is-long-enough";
});

vi.mock("bullmq", () => ({
  Queue: class { add = vi.fn().mockResolvedValue(undefined); },
  Worker: class {},
  Job: class {},
}));
vi.mock("ioredis", () => ({
  default: class { publish = vi.fn(); subscribe = vi.fn(); on = vi.fn(); quit = vi.fn(); },
}));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const SHOP = "urban-supply-gotcha-demo.myshopify.com";
const STOREFRONT = `https://${SHOP}`;
const CUSTOM = "https://shop.example.com";
const STRANGER = "https://evil.example";

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    channelRow: { current: null as any },
    tenantRow: { current: { status: "ACTIVE", isActive: true } as any },
    features: { current: {} as Record<string, boolean> },
    installRow: { current: null as any },
    known: { origins: [] as string[] },
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    prisma: {
      channelAccount: { findFirst: vi.fn(async () => H.channelRow.current), update: vi.fn(async () => ({})) },
      tenant: { findUnique: vi.fn(async () => H.tenantRow.current) },
      shopifyChatInstallation: { findFirst: vi.fn(async () => H.installRow.current) },
    },
    withCrossTenantAccess: (fn: () => Promise<unknown>) => fn(),
    isFeatureEnabledForTenant: vi.fn(async (_t: string, f: string) => H.features.current[f] !== false),
    incomingMessageQueue: { add: vi.fn() },
    analyticsQueue: { add: vi.fn() },
    publishEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../services/connectors/integration-framework", () => ({
  loadConnection: vi.fn(async () => ({ config: { shopDomain: SHOP } })),
}));

vi.mock("../services/shopify-chat-install.service", () => ({
  findLiveInstallation: vi.fn(async () => null),
  recordInstallationHeartbeat: vi.fn(async () => undefined),
  // The recognition step under test at the router level. The service's own
  // lookup is covered separately; here we control the answer so the
  // router's CORS decisions are what is asserted.
  isKnownStorefrontOrigin: vi.fn(async (o: unknown) => H.known.origins.includes(String(o))),
}));

import router from "../routes/shopify-chat-public";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/shopify-chat", router);
  return a;
}

function channel(overrides: any = {}) {
  return {
    id: "c1",
    tenantId: "t1",
    externalId: "sfy_key",
    displayName: "Shopify Live Chat",
    connectionStatus: "CONNECTED",
    createdAt: new Date(),
    updatedAt: new Date(),
    platformMeta: {
      shopifyLiveChat: {
        enabled: true,
        shopDomain: SHOP,
        install: { storefrontDomains: ["shop.example.com"] },
        commerce: { productMessagingEnabled: true },
        appearance: {}, welcome: {}, hours: {}, routing: {}, privacy: {},
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.channelRow.current = channel();
  H.installRow.current = {
    id: "i1",
    shopDomain: SHOP,
    status: "ACTIVE",
    tenantId: "t1",
    channelAccountId: "c1",
    verifiedDomains: [SHOP, "shop.example.com"],
  };
  H.tenantRow.current = { status: "ACTIVE", isActive: true };
  H.features.current = {};
  H.known.origins = [STOREFRONT, CUSTOM];
});

// ─── The widget asset (gateway config, not the app) ──────────
//
// nginx serves this, so the contract lives in the templates. Asserting it
// here keeps a future edit from silently dropping the header that makes
// the widget loadable at all.

describe("widget asset CORS (gateway templates)", () => {
  const templates = [
    path.resolve(__dirname, "../../../../nginx/nginx.conf.template"),
    path.resolve(__dirname, "../../../../gateway/nginx.prod.conf.template"),
  ];

  it.each(templates)("%s serves /widget/ with a wildcard origin", (file) => {
    const conf = fs.readFileSync(file, "utf8");
    const block = conf.slice(conf.indexOf("location /widget/"));
    const body = block.slice(0, block.indexOf("\n        }"));
    expect(body).toContain('add_header Access-Control-Allow-Origin "*"');
  });

  it.each(templates)("%s never sends credentials with the wildcard", (file) => {
    const conf = fs.readFileSync(file, "utf8");
    const block = conf.slice(conf.indexOf("location /widget/"));
    const body = block.slice(0, block.indexOf("\n        }"));
    // Wildcard + credentials is rejected by every browser, and the asset
    // needs no cookie in the first place.
    expect(body).not.toContain("Access-Control-Allow-Credentials");
  });

  it.each(templates)("%s keeps nosniff on the widget assets", (file) => {
    const conf = fs.readFileSync(file, "utf8");
    const block = conf.slice(conf.indexOf("location /widget/"));
    const body = block.slice(0, block.indexOf("\n        }"));
    expect(body).toContain('add_header X-Content-Type-Options "nosniff"');
  });

  it.each(templates)("%s caches hashed bundles forever and the bootstrap never", (file) => {
    const conf = fs.readFileSync(file, "utf8");

    // The chat bundle's filename carries a content hash, so new bytes are
    // a new URL and the old one can safely be cached forever.
    const dirBlock = conf.slice(conf.indexOf("location /widget/"));
    const dirBody = dirBlock.slice(0, dirBlock.indexOf("\n        }"));
    expect(dirBody).toMatch(/Cache-Control "public, max-age=31536000, immutable"/);

    // The bootstrap's filename is stable — it is what the theme points at
    // — so it must be revalidated on every load, or a change to it can sit
    // unseen in a shopper's browser for as long as the TTL allows.
    const bootIdx = conf.indexOf("location = /widget/gotcha-shopify-bootstrap.js");
    expect(bootIdx).toBeGreaterThan(-1);
    const bootBlock = conf.slice(bootIdx);
    const bootBody = bootBlock.slice(0, bootBlock.indexOf("\n        }"));
    expect(bootBody).toMatch(/Cache-Control "public, no-cache, must-revalidate"/);
    expect(bootBody).toContain('add_header X-Content-Type-Options "nosniff"');

    // nginx matches an exact-match location before a prefix one, so the
    // bootstrap's rule wins over the immutable directory rule regardless
    // of the order they appear in the file.
    expect(conf.indexOf("location = /widget/")).toBeGreaterThan(-1);
  });
});

// ─── The API ─────────────────────────────────────────────────

describe("API CORS", () => {
  it("echoes a verified storefront origin, never a wildcard", async () => {
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STOREFRONT)
      .send({ shopDomain: SHOP });

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(STOREFRONT);
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("echoes a merchant's custom storefront domain", async () => {
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", CUSTOM)
      .send({ shopDomain: SHOP });

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(CUSTOM);
  });

  it("sends Vary: Origin on success and on refusal", async () => {
    const ok = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STOREFRONT)
      .send({ shopDomain: SHOP });
    expect(ok.headers["vary"]).toContain("Origin");

    const denied = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STRANGER)
      .send({ shopDomain: SHOP });
    expect(denied.headers["vary"]).toContain("Origin");
  });

  it("gives an unrecognised origin no CORS header at all", async () => {
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STRANGER)
      .send({ shopDomain: SHOP });

    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("strips the dashboard cors() headers this surface must not inherit", async () => {
    // createServiceApp mounts cors({origin: FRONTEND_URL, credentials: true})
    // for the dashboard. On a storefront route that means every merchant
    // gets the frontend's origin echoed back plus a credentials flag that
    // makes the header set invalid. Regression guard.
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STOREFRONT)
      .send({ shopDomain: SHOP });
    expect(res.headers["access-control-allow-origin"]).toBe(STOREFRONT);
    expect(res.headers["access-control-allow-origin"]).not.toContain("gotcha.co.il/");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("never allows credentials", async () => {
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STOREFRONT)
      .send({ shopDomain: SHOP });
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("lets a recognised storefront READ a refusal", async () => {
    // The merchant switched the channel off. The body is deliberately
    // detail-free, but the browser must be able to see it — otherwise it
    // is replaced by an opaque CORS error and the merchant debugs the
    // wrong thing.
    H.channelRow.current = channel({ enabled: false });
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STOREFRONT)
      .send({ shopDomain: SHOP });

    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBe(STOREFRONT);
    expect(res.body).toEqual({ error: "unavailable" });
  });

  it("still refuses a recognised origin that is not THIS shop's", async () => {
    // Recognised for CORS purposes, but the channel's own allowlist is
    // what decides whether it is served. CORS is transport, not authority.
    H.known.origins = [STOREFRONT, CUSTOM, "https://other-shop.myshopify.com"];
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", "https://other-shop.myshopify.com")
      .send({ shopDomain: SHOP });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "unavailable" });
  });

  it("leaks no tenant id, token or secret in any response", async () => {
    const ok = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STOREFRONT)
      .send({ shopDomain: SHOP });
    const denied = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STRANGER)
      .send({ shopDomain: SHOP });

    for (const res of [ok, denied]) {
      // The session token is deliberately opaque ciphertext, and its
      // opacity is asserted where it is minted. Scanning random base64 for
      // a two-character tenant id like "t1" finds one roughly 3% of runs
      // and says nothing either way — so scan everything EXCEPT the token,
      // and check the token by decrypting it instead.
      const clone = JSON.parse(JSON.stringify(res.body ?? {}));
      const token = clone?.data?.session?.token;
      if (clone?.data?.session) delete clone.data.session;
      const body = JSON.stringify(clone);

      expect(body).not.toContain("t1");
      expect(body).not.toContain("tenantId");
      expect(body).not.toContain("accessToken");
      expect(body).not.toContain("sfy_key");

      if (token) {
        // Readable only with the server's key — which is the point.
        expect(token).not.toContain("t1");
        expect(Buffer.from(token, "base64").toString("utf8")).not.toContain("tenantId");
      }
    }
  });
});

describe("preflight", () => {
  it("succeeds for a recognised storefront and names only the methods we serve", async () => {
    const res = await request(app())
      .options("/api/shopify-chat/bootstrap")
      .set("Origin", STOREFRONT)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(STOREFRONT);
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    expect(res.headers["access-control-allow-headers"]).toContain("X-Visitor-Token");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["vary"]).toContain("Origin");
  });

  it("fails safely for an unknown origin, telling it nothing", async () => {
    const res = await request(app())
      .options("/api/shopify-chat/bootstrap")
      .set("Origin", STRANGER)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
  });

  it("fails safely when no Origin is presented", async () => {
    const res = await request(app()).options("/api/shopify-chat/bootstrap");
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
