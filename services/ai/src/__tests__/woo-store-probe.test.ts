/**
 * "Test GOTCHA access" (Supervisor 2026-11-15, plugin-side diagnosis (a)):
 * GOTCHA probes a store's WooCommerce API from its own servers, because a
 * Cloudflare challenge depends on the caller (prod's IP is challenged by
 * chanivainberger.co.il and alphamom.co.il, dev's is not). Only ever the
 * site a plugin key is bound to, or the workspace's own store, connected or
 * being connected: never an address a caller names.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import crypto from "crypto";

// This suite is about the plugin's behaviour, and calls the public endpoints
// for one site far more often than a minute's limit; the limits have their
// own suite (woocommerce-plugin-rate-limit.test.ts).
vi.hoisted(() => {
  process.env.WOO_PLUGIN_EXCHANGE_RPM = "10000";
  process.env.WOO_PLUGIN_SIGNAL_RPM = "10000";
});
const H = vi.hoisted(() => ({
  redis: new Map<string, string>(), settings: new Map<string, string>(), allowed: true,
  integration: { config: { storeUrl: "https://shop.example.com" } } as any, webchat: { externalId: "widget_abc" } as any,
  fetched: [] as string[], answer: null as any, guarded: [] as string[],
}));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const redis = {
    get: async (k: string) => H.redis.get(k) ?? null,
    set: async (k: string, v: string) => { H.redis.set(k, v); return "OK"; },
    del: async (k: string) => { H.redis.delete(k); return 1; },
    multi: () => {
      const ops: Array<() => any> = [];
      const m = { get: (k: string) => { ops.push(() => H.redis.get(k) ?? null); return m; }, del: (k: string) => { ops.push(() => { H.redis.delete(k); return 1; }); return m; }, exec: async () => ops.map((op) => [null, op()]) };
      return m;
    },
  };
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, res: any, n: any) => (H.allowed ? n() : res.status(403).json({ error: "forbidden" })),
    resolveAppPublicUrl: () => "https://app.test",
    assertPublicUrl: async (u: string) => { H.guarded.push(u); if (/\/\/(127\.|localhost|169\.254|10\.)/.test(u)) throw new Error("not a public address"); },
    getRedis: () => redis,
    readDurableSetting: async (t: string, k: string) => H.settings.get(`${t}:${k}`) ?? null,
    writeDurableSetting: async (t: string, k: string, v: string) => { H.settings.set(`${t}:${k}`, v); },
    prisma: {
      tenantIntegration: { findFirst: async () => H.integration },
      channelAccount: { findFirst: async () => H.webchat },
      tenant: { findUnique: async () => ({ name: "Urban Supply" }) },
      $queryRaw: async (_s: TemplateStringsArray, key: string, like: string) => {
        const needle = like.replace(/%/g, "");
        return [...H.settings.entries()].filter(([k, v]) => k.endsWith(`:${key}`) && v.includes(needle)).map(([k]) => ({ tenant_id: k.split(":")[0] }));
      },
    },
  };
});


import router from "../routes/woocommerce-plugin";
import { probeStore, rememberPendingStore, storeToProbe, PROBE_CACHE_SECONDS } from "../services/woo-store-probe.service";

const app = express();
app.use("/api/woocommerce-plugin", router);
const RETURN = "https://shop.example.com/wp-admin/admin.php?page=gotcha-for-woocommerce";
const codeOf = (redirect: string) => new URL(redirect).searchParams.get("gotcha_code")!;
async function connect(): Promise<string> {
  const b = await request(app).post("/api/woocommerce-plugin/bind").send({ siteUrl: "https://shop.example.com/", returnUrl: RETURN, nonce: "n0nce-abcdefgh" });
  return (await request(app).post("/api/woocommerce-plugin/exchange").send({ code: codeOf(b.body.data.redirect), siteUrl: "https://shop.example.com" })).body.siteKey;
}
const respond = (status: number, body: string, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300, status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => body,
});
const CHALLENGE = respond(403, "<title>Just a moment...</title><script src=\"/cdn-cgi/challenge-platform/x\"></script>", { "cf-mitigated": "challenge", server: "cloudflare" });
const WOO_401 = respond(401, "{\"code\":\"woocommerce_rest_cannot_view\",\"message\":\"Sorry, you cannot list resources.\"}");

beforeEach(() => {
  H.redis = new Map(); H.settings = new Map(); H.allowed = true; H.fetched = []; H.guarded = [];
  H.integration = { config: { storeUrl: "https://shop.example.com" } };
  H.webchat = { externalId: "widget_abc" };
  H.answer = WOO_401;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { H.fetched.push(url); expect(init?.redirect).toBe("manual"); expect(init?.headers?.Authorization).toBeUndefined(); return H.answer; }));
});

describe("the probe", () => {
  it("WooCommerce's own 401 means GOTCHA reaches it; no keys are sent and no redirect is followed", async () => {
    expect(await probeStore("https://shop.example.com")).toMatchObject({ reachable: true, reason: "reachable", status: 401 });
    expect(H.fetched).toEqual(["https://shop.example.com/wp-json/wc/v3/system_status"]);
  });
  it("Cloudflare's challenge: store_firewall_challenge, firewall cloudflare", async () => {
    H.answer = CHALLENGE;
    expect(await probeStore("https://shop.example.com")).toMatchObject({ reachable: false, reason: "store_firewall_challenge", firewall: "cloudflare" });
  });
  it("another firewall's block page is not called Cloudflare", async () => {
    H.answer = respond(403, "<html><title>Sucuri WebSite Firewall - Access Denied</title></html>");
    expect(await probeStore("https://shop.example.com")).toMatchObject({ reason: "store_firewall_challenge", firewall: "sucuri" });
  });
  it("no REST API, a redirect, a plain error, a private address", async () => {
    H.answer = respond(404, "<html>Not found</html>");
    expect((await probeStore("https://a.example.com")).reason).toBe("rest_api_not_found");
    H.answer = respond(301, "", { location: "https://elsewhere.example.net/" });
    expect((await probeStore("https://b.example.com")).reason).toBe("redirected");
    H.answer = respond(500, "oops");
    expect((await probeStore("https://c.example.com")).reason).toBe("http_500");
    const before = H.fetched.length;
    expect((await probeStore("http://127.0.0.1")).reason).toBe("unreachable");
    expect(H.fetched.length).toBe(before);
  });
  it("one probe per store a minute", async () => {
    expect(PROBE_CACHE_SECONDS).toBe(60);
    await probeStore("https://shop.example.com");
    await probeStore("https://shop.example.com");
    expect(H.fetched).toHaveLength(1);
  });
});

describe("only a store the caller already has", () => {
  it("the plugin's probe reaches only the site its key is bound to; a body naming another address is ignored", async () => {
    const key = await connect();
    H.answer = CHALLENGE;
    const r = await request(app).post("/api/woocommerce-plugin/probe").set("Authorization", `Bearer ${key}`).send({ storeUrl: "https://victim.example.org", siteUrl: "http://169.254.169.254" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ reason: "store_firewall_challenge", storeUrl: "https://shop.example.com" });
    expect(H.fetched).toEqual(["https://shop.example.com/wp-json/wc/v3/system_status"]);
  });
  it("an unknown or missing key is 401 and probes nothing", async () => {
    expect((await request(app).post("/api/woocommerce-plugin/probe").set("Authorization", "Bearer gws_nope").send({})).status).toBe(401);
    expect((await request(app).post("/api/woocommerce-plugin/probe").send({})).status).toBe(401);
    expect(H.fetched).toEqual([]);
  });
  it("from GOTCHA: the workspace's connected store; a storeUrl in the request is ignored", async () => {
    const r = await request(app).get("/api/woocommerce-plugin/probe-store?storeUrl=https://victim.example.org");
    expect(r.status).toBe(200);
    expect(r.body.data.storeUrl).toBe("https://shop.example.com");
    expect(H.fetched).toEqual(["https://shop.example.com/wp-json/wc/v3/system_status"]);
  });
  it("being connected: the store the workspace just started connecting; none at all is 404", async () => {
    H.integration = null;
    expect((await request(app).get("/api/woocommerce-plugin/probe-store")).status).toBe(404);
    await rememberPendingStore("T", "https://new-shop.example.com/");
    expect(await storeToProbe("T")).toBe("https://new-shop.example.com");
    expect((await request(app).get("/api/woocommerce-plugin/probe-store")).body.data.storeUrl).toBe("https://new-shop.example.com");
  });
  it("needs the permission to connect systems", async () => {
    H.allowed = false;
    expect((await request(app).get("/api/woocommerce-plugin/probe-store")).status).toBe(403);
    expect(H.fetched).toEqual([]);
  });
  it("the store's own connect and pasted keys record the store being connected", () => {
    const oauth = readFileSync(join(__dirname, "../routes/woocommerce-oauth.ts"), "utf8");
    expect(oauth).toContain("await rememberPendingStore(req.tenantId!, storeUrl);");
    const adapter = readFileSync(join(__dirname, "../services/connectors/woocommerce.adapter.ts"), "utf8");
    expect(adapter).toContain("await rememberPendingStore(ctx.tenantId, storeUrl);");
  });
});

describe("the plugin (0.2.0)", () => {
  const php = readFileSync(join(__dirname, "../assets/woocommerce-plugin/gotcha-for-woocommerce/gotcha-for-woocommerce.php"), "utf8");
  it("a Test GOTCHA access button that calls the probe with the site key, and the Cloudflare rule", () => {
    expect(php).toContain("define( 'GOTCHA_WC_VERSION', '0.2.0' );");
    expect(php).toContain("'/api/woocommerce-plugin/probe'");
    expect(php).toContain("'Authorization' => 'Bearer ' . $key");
    expect(php).toContain("check_admin_referer( 'gotcha_wc_probe' )");
    expect(php).toContain("<code>/wp-json/wc/</code>");
    expect(php).toContain("Super Bot Fight Mode");
    expect(php).toMatch(/HTTP_CF_RAY/);
  });
});
