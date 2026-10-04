/**
 * WooCommerce connect through the store's own authorization screen.
 *
 * Real state signing and single-use consume (jwt + a Redis double with SET NX
 * and GET), real encryptCredentials. The store is stubbed at fetch. What this
 * pins: the store URL is validated, the state rides as user_id and is single
 * use, keys are PROVEN against the store before CONNECTED, they are stored
 * encrypted, and the browser lands with a closed-list answer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.FRONTEND_URL = "https://dev.example.test";
  process.env.OAUTH_STATE_SECRET = "oauth-state-secret-for-tests-only-32chars";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});

const R = vi.hoisted(() => ({ kv: new Map<string, string>() }));
vi.mock("ioredis", () => ({
  default: class {
    on = vi.fn(); quit = vi.fn(); publish = vi.fn(); subscribe = vi.fn();
    async set(key: string, v: string, ...rest: unknown[]) {
      if (rest.includes("NX") && R.kv.has(key)) return null;
      R.kv.set(key, v);
      return "OK";
    }
    async get(key: string) { return R.kv.get(key) ?? null; }
  },
}));
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));

const C = vi.hoisted(() => ({ upserts: [] as any[], publicCheck: true }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "user_1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    // DNS is not the subject here; the guard's own suite covers it. The double
    // still refuses what the real one refuses on its face.
    assertPublicUrl: async (u: string) => {
      const host = new URL(u).hostname;
      if (!C.publicCheck || host === "localhost" || /^(10|127|192\.168)\./.test(host)) throw new Error("ssrf_blocked");
      return new URL(u);
    },
  };
});
vi.mock("../services/connector-connection.service", () => ({
  findCatalog: async () => ({ id: "cat_woo" }),
  upsertConnection: async (a: any) => { C.upserts.push(a); return { id: "ti_1" }; },
}));

import router from "../routes/woocommerce-oauth";
import { decryptCredentials } from "@chatcenter/shared";

const app = express();
app.use("/api/integrations", router);

const STORE = "https://shop.example.test";
const V2 = "https://dev.example.test/v2/studio/capabilities";

beforeEach(() => { R.kv.clear(); C.upserts = []; C.publicCheck = true; vi.unstubAllGlobals(); });

async function init(q: Record<string, string>) {
  return request(app).get("/api/integrations/woocommerce/oauth/init").query(q);
}
async function startFlow(flow = "redesign_studio") {
  const r = await init({ storeUrl: STORE, flow, format: "json" });
  return new URL(r.body.url);
}
const storeAnswers = (ok: boolean) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, status: ok ? 200 : 401, json: async () => ({}) })));
const callback = (body: any) => request(app).post("/api/integrations/woocommerce/oauth/callback").send(body);
const back = (q: Record<string, string>) => request(app).get("/api/integrations/woocommerce/oauth/return").query(q);
const KEYS = { key_id: 7, consumer_key: "ck_live", consumer_secret: "cs_live", key_permissions: "read_write" };

describe("init", () => {
  it("★ builds the store's authorize URL with our endpoints and the state as user_id", async () => {
    const u = await startFlow();
    expect(`${u.origin}${u.pathname}`).toBe(`${STORE}/wc-auth/v1/authorize`);
    expect(u.searchParams.get("scope")).toBe("read_write");
    expect(u.searchParams.get("app_name")).toBe("GOTCHA");
    expect(u.searchParams.get("callback_url")).toBe("https://dev.example.test/api/integrations/woocommerce/oauth/callback");
    expect(u.searchParams.get("return_url")).toBe("https://dev.example.test/api/integrations/woocommerce/oauth/return");
    const claims = JSON.parse(Buffer.from(u.searchParams.get("user_id")!.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ tenantId: "tenant_a", provider: "woocommerce", flow: "redesign_studio", storeUrl: STORE });
  });

  it("302s without format=json", async () => {
    const r = await init({ storeUrl: STORE });
    expect(r.status).toBe(302);
    expect(r.headers.location.startsWith(`${STORE}/wc-auth/v1/authorize?`)).toBe(true);
  });

  it.each([
    ["ftp://shop.example.test"],
    ["not a url"],
    ["https://user:pw@shop.example.test"],
    ["https://localhost:8090"],
    ["http://192.168.1.5"],
  ])("★ refuses store URL %s", async (storeUrl) => {
    const r = await init({ storeUrl });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_store_url");
  });

  it("keeps a sub-directory install, drops query and trailing slash", async () => {
    const r = await init({ storeUrl: "https://shop.example.test/store/?x=1#y", format: "json" });
    expect(r.body.url.startsWith("https://shop.example.test/store/wc-auth/v1/authorize?")).toBe(true);
  });

  it("an unknown flow is dropped", async () => {
    const u = await startFlow("https://evil.example");
    const claims = JSON.parse(Buffer.from(u.searchParams.get("user_id")!.split(".")[1], "base64url").toString());
    expect(claims.flow).toBeUndefined();
  });
});

describe("callback + return: the whole round-trip", () => {
  it("★ approve → keys validated → CONNECTED, stored encrypted → lands connected=1", async () => {
    const state = (await startFlow()).searchParams.get("user_id")!;
    storeAnswers(true);
    const cb = await callback({ ...KEYS, user_id: state });
    expect(cb.status).toBe(200);

    expect(C.upserts).toHaveLength(1);
    const up = C.upserts[0];
    expect(up).toMatchObject({ tenantId: "tenant_a", catalogId: "cat_woo", status: "CONNECTED", config: { storeUrl: STORE } });
    expect(up.credentialsBlob).not.toContain("ck_live");
    expect(decryptCredentials(up.credentialsBlob)).toMatchObject({ consumerKey: "ck_live", consumerSecret: "cs_live" });
    // The validation call carried the new keys.
    const [url, initArg] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe(`${STORE}/wp-json/wc/v3/system_status`);
    expect(initArg.headers.Authorization).toBe(`Basic ${Buffer.from("ck_live:cs_live").toString("base64")}`);

    const r = await back({ success: "1", user_id: state });
    expect(r.headers.location).toBe(`${V2}?system=woocommerce&connected=1`);
  });

  it("★ keys that do not work are NOT connected, and the merchant is told", async () => {
    const state = (await startFlow()).searchParams.get("user_id")!;
    storeAnswers(false);
    const cb = await callback({ ...KEYS, user_id: state });
    expect(cb.status).toBe(200); // the store must still send the merchant on
    expect(C.upserts).toHaveLength(0);
    expect((await back({ success: "1", user_id: state })).headers.location).toBe(`${V2}?system=woocommerce&error=validation_failed`);
  });

  it("read-only keys are refused before any call to the store", async () => {
    const state = (await startFlow()).searchParams.get("user_id")!;
    storeAnswers(true);
    await callback({ ...KEYS, key_permissions: "read", user_id: state });
    expect(C.upserts).toHaveLength(0);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
    expect((await back({ success: "1", user_id: state })).headers.location).toContain("error=insufficient_permissions");
  });

  it("★ the merchant pressed Deny → error=denied", async () => {
    const state = (await startFlow()).searchParams.get("user_id")!;
    expect((await back({ success: "0", user_id: state })).headers.location).toBe(`${V2}?system=woocommerce&error=denied`);
  });

  it("success=1 but the store never called us → callback_not_received, never a false connected", async () => {
    const state = (await startFlow()).searchParams.get("user_id")!;
    expect((await back({ success: "1", user_id: state })).headers.location).toBe(`${V2}?system=woocommerce&error=callback_not_received`);
  });

  it("★ a replayed callback writes nothing", async () => {
    const state = (await startFlow()).searchParams.get("user_id")!;
    storeAnswers(true);
    await callback({ ...KEYS, user_id: state });
    const again = await callback({ ...KEYS, consumer_key: "ck_attacker", user_id: state });
    expect(again.status).toBe(400);
    expect(C.upserts).toHaveLength(1);
  });

  it("★ a forged state is refused at the callback and lands as invalid_state", async () => {
    const forged = "eyJhbGciOiJIUzI1NiJ9.eyJwcm92aWRlciI6Indvb2NvbW1lcmNlIn0.x";
    expect((await callback({ ...KEYS, user_id: forged })).status).toBe(400);
    expect(C.upserts).toHaveLength(0);
    expect((await back({ success: "1", user_id: forged })).headers.location).toContain("error=invalid_state");
  });

  it("without the redesign flow the landing is the old app's marketplace page", async () => {
    const state = (await startFlow("")).searchParams.get("user_id")!;
    storeAnswers(true);
    await callback({ ...KEYS, user_id: state });
    expect((await back({ success: "1", user_id: state })).headers.location)
      .toBe("https://dev.example.test/ai-studio/marketplace/woocommerce?status=connected");
  });
});
