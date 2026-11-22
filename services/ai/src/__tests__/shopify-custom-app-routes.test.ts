/**
 * Per-merchant Shopify custom apps (2026-11-22): the merchant's request and the console. The records and
 * the switch live in a double of the durable settings; emails and billing are doubles (no mail, no
 * provider).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  records: new Map<string, any>(),
  settings: { enabled: true, entitlement: "included" } as any,
  role: "ADMIN",
  tenant: "T1",
  current: null as any,
  owner: null as any,
  emails: [] as any[],
  granted: [] as string[],
  revoked: [] as string[],
}));

vi.mock("@chatcenter/shared", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: H.role }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = H.tenant; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _r: any, n: any) => n(),
    requirePermission: () => (_q: any, _r: any, n: any) => n(),
    readCustomAppRecord: async (t: string) => H.records.get(t) ?? null,
    writeCustomAppRecord: async (t: string, r: any) => { H.records.set(t, r); },
    listCustomAppRecords: async () => [...H.records.entries()].map(([tenantId, record]) => ({ tenantId, record })),
    readPrivateAppsSettings: async () => ({ ...H.settings }),
    writePrivateAppsSettings: async (v: any) => { H.settings = v; return true; },
    sealClientSecret: (s: string) => `sealed:${s}`,
    withCrossTenantAccess: (fn: any) => fn(),
    prisma: { tenant: { findMany: async () => [{ id: "T1", name: "Acme" }] } },
  };
});
vi.mock("../services/shopify-connection-link.service", () => ({
  currentStoreOf: async () => H.current,
  findShopOwner: async () => H.owner,
  shopHeldElsewhere: (o: any, t: string) => !!o && o.tenantId !== t && o.status !== "DISCONNECTED",
}));
vi.mock("../services/shopify-custom-app-billing.service", () => ({
  grantCustomAppEntitlements: async (t: string) => { H.granted.push(t); return 4; },
  revokeCustomAppEntitlements: async (t: string) => { H.revoked.push(t); return 4; },
}));

import router from "../routes/shopify-custom-app";
const fetchMock = vi.fn(async (_u: string, init: any) => { H.emails.push(JSON.parse(init.body)); return { ok: true } as any; });
vi.stubGlobal("fetch", fetchMock);

const app = () => { const a = express(); a.use(express.json()); a.use("/api", router); return a; };
const SHOP = "random-randomizer.myshopify.com";
const LINK = "https://admin.shopify.com/oauth/install_custom_app?client_id=custom_client_1&signature=abc";
const ask = (shopDomain: any = SHOP) => request(app()).post("/api/connectors/shopify/custom-app/request").send({ shopDomain });
const link = (body: any = {}) => request(app()).post("/api/system/shopify-custom-apps/T1/link").send({ clientId: "custom_client_1", clientSecret: "shpss_secret_value", installLink: LINK, ...body });

beforeEach(() => {
  H.records.clear(); H.settings = { enabled: true, entitlement: "included" }; H.role = "ADMIN"; H.tenant = "T1";
  H.current = null; H.owner = null; H.emails = []; H.granted = []; H.revoked = [];
  process.env.SHOPIFY_API_KEY = "official_client";
});

describe("the merchant's request", () => {
  it("★ creates the request and the internal notice", async () => {
    const r = await ask();
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: "requested", shopDomain: SHOP });
    expect(H.records.get("T1")).toMatchObject({ status: "requested", shopDomain: SHOP, requestedBy: "u1" });
    expect(H.emails[0]).toMatchObject({ kind: "request_notice", tenantId: "T1", shopDomain: SHOP });
  });
  it("refused with the switch off, a bad domain, a connected store, a second request, a shop someone else asked for or holds", async () => {
    H.settings.enabled = false;
    expect((await ask()).body).toEqual({ error: "private_apps_off" });
    H.settings.enabled = true;
    expect((await ask("not a shop")).body).toEqual({ error: "invalid_shop_domain" });
    expect((await ask("shop.example.com")).body).toEqual({ error: "invalid_shop_domain" });
    H.current = { shopDomain: "old.myshopify.com", status: "CONNECTED" };
    expect((await ask()).body.error).toBe("store_connected");
    H.current = null;
    await ask();
    expect((await ask()).body.error).toBe("already_requested");
    H.tenant = "T2";
    expect((await ask()).body.error).toBe("shop_requested_elsewhere");
    H.records.clear();
    H.owner = { tenantId: "T9", status: "CONNECTED" };
    expect((await ask()).body.error).toBe("shop_requested_elsewhere");
  });
  it("reads the request back: the link only while it is usable, never the secret", async () => {
    H.records.set("T1", { status: "link_sent", shopDomain: SHOP, requestedAt: "x", requestedBy: "u1", clientId: "c", clientSecretEnc: "sealed:s", installLink: LINK, linkExpiresAt: new Date(Date.now() + 3600_000).toISOString() });
    let r = await request(app()).get("/api/connectors/shopify/custom-app/request");
    expect(r.body).toMatchObject({ data: { status: "link_sent", installLink: LINK }, enabled: true });
    expect(JSON.stringify(r.body)).not.toContain("sealed");
    H.records.get("T1").linkExpiresAt = new Date(Date.now() - 1000).toISOString();
    r = await request(app()).get("/api/connectors/shopify/custom-app/request");
    expect(r.body.data.installLink).toBeNull();
  });
});

describe("the console", () => {
  beforeEach(() => { H.role = "SYSTEM_ADMIN"; H.records.set("T1", { status: "requested", shopDomain: SHOP, requestedAt: "2026-11-22T20:00:00Z", requestedBy: "u1" }); });

  it("only a system admin", async () => {
    H.role = "ADMIN";
    expect((await request(app()).get("/api/system/shopify-custom-apps")).status).toBe(403);
    expect((await link()).status).toBe(403);
  });

  it("★ lists the requests with the workspace's name, never a secret", async () => {
    await link();
    const r = await request(app()).get("/api/system/shopify-custom-apps");
    expect(r.body.data[0]).toMatchObject({ tenantId: "T1", tenantName: "Acme", status: "link_sent", shopDomain: SHOP, clientId: "custom_client_1" });
    expect(JSON.stringify(r.body)).not.toMatch(/sealed|shpss_secret_value/);
  });

  it("★ the link: the secret sealed, 7 days by default, the merchant emailed", async () => {
    const r = await link();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: "link_sent", emailed: true });
    expect(JSON.stringify(r.body)).not.toContain("shpss_secret_value");
    const rec = H.records.get("T1");
    expect(rec.clientSecretEnc).toBe("sealed:shpss_secret_value");
    expect(Date.parse(rec.linkExpiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(H.emails.at(-1)).toMatchObject({ kind: "install_link", tenantId: "T1", userId: "u1", installLink: LINK, shopDomain: SHOP });
  });

  it("refuses a bad client id, secret or link, the official client id, and one already used elsewhere", async () => {
    expect((await link({ clientId: "a b" })).body.error).toBe("invalid_client_id");
    expect((await link({ clientSecret: "x" })).body.error).toBe("invalid_client_secret");
    expect((await link({ installLink: "https://evil.example/x" })).body.error).toBe("invalid_install_link");
    expect((await link({ clientId: "official_client" })).body.error).toBe("client_id_in_use");
    H.records.set("T2", { status: "installed", shopDomain: "other.myshopify.com", requestedAt: "x", requestedBy: null, clientId: "custom_client_1" });
    expect((await link()).body.error).toBe("client_id_in_use");
  });

  it("a new link replaces the old one and is emailed again; only after a link", async () => {
    expect((await request(app()).post("/api/system/shopify-custom-apps/T1/new-link").send({ installLink: LINK })).body.error).toBe("no_link_to_replace");
    await link();
    const NEW = LINK.replace("abc", "def");
    const r = await request(app()).post("/api/system/shopify-custom-apps/T1/new-link").send({ installLink: NEW });
    expect(r.body.data).toMatchObject({ installLink: NEW, emailed: true });
    expect(H.emails.at(-1)).toMatchObject({ kind: "install_link", installLink: NEW });
  });

  it("★ revoke: the record off, its secret and link dropped, the grant revoked", async () => {
    await link();
    const r = await request(app()).post("/api/system/shopify-custom-apps/T1/revoke").send({});
    expect(r.body.data).toMatchObject({ status: "revoked", entitlementsRevoked: 4 });
    expect(H.records.get("T1")).toMatchObject({ status: "revoked", clientSecretEnc: null, installLink: null });
    expect(H.revoked).toEqual(["T1"]);
  });

  it("grant: only an installed store", async () => {
    expect((await request(app()).post("/api/system/shopify-custom-apps/T1/grant").send({})).body.error).toBe("not_installed");
    H.records.get("T1").status = "installed";
    expect((await request(app()).post("/api/system/shopify-custom-apps/T1/grant").send({})).body.data).toEqual({ granted: 4 });
    expect(H.granted).toEqual(["T1"]);
  });

  it("the switch: read and written by a system admin; anything but true is off", async () => {
    const r = await request(app()).put("/api/system/shopify-private-apps").send({ enabled: "yes", entitlement: "manual" });
    expect(r.body.data).toEqual({ enabled: false, entitlement: "manual" });
    expect((await request(app()).get("/api/system/shopify-private-apps")).body.data).toEqual({ enabled: false, entitlement: "manual" });
  });
});
