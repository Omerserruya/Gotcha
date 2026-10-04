/**
 * POST /api/integrations/:slug/connect proves a credential before CONNECTED.
 *
 * It stored whatever was pasted and called it connected; a wrong WooCommerce
 * key surfaced only when a customer asked about an order. Now an adapter that
 * can check a credential (`validate`) is asked first, and a refusal writes
 * nothing - not even over an existing, working connection.
 *
 * The REAL WooCommerce adapter runs (its validate is the subject); the store
 * is stubbed at fetch and the DB is a recording double.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } } }));

const DB = vi.hoisted(() => ({ writes: [] as any[], existing: null as any }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      integrationCatalog: { findUnique: async (a: any) => ({ id: `cat_${a.where.slug}`, slug: a.where.slug, catalogTools: [] }) },
      tenantIntegration: {
        findFirst: async () => DB.existing,
        create: async (a: any) => { DB.writes.push(["create", a.data]); return { id: "ti_new", ...a.data }; },
        update: async (a: any) => { DB.writes.push(["update", a.data]); return { id: a.where.id, ...a.data }; },
      },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    assertPublicUrl: async (u: string) => {
      if (/localhost|127\.0\.0\.1/.test(u)) throw new Error("ssrf_blocked");
      return new URL(u);
    },
  };
});

import "../services/connectors/woocommerce.adapter";
import router from "../routes/integrations";

const app = express();
app.use(express.json());
app.use("/api/integrations", router);

const connect = (slug: string, body: any) => request(app).post(`/api/integrations/${slug}/connect`).send(body);
const WOO = { credentials: { consumerKey: "ck_1", consumerSecret: "cs_1" }, config: { storeUrl: "https://shop.example.test" } };
const store = (status: number) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => ({}) })));

beforeEach(() => { DB.writes = []; DB.existing = null; vi.unstubAllGlobals(); });

describe("WooCommerce keys are proven before CONNECTED", () => {
  it("★ working keys connect, after a real call with them", async () => {
    store(200);
    const r = await connect("woocommerce", WOO);
    expect(r.status).toBe(201);
    expect(DB.writes[0][1].status).toBe("CONNECTED");
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://shop.example.test/wp-json/wc/v3/system_status");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("ck_1:cs_1").toString("base64")}`);
  });

  it("★ rejected keys → 422 validation_failed and NOTHING written", async () => {
    store(401);
    const r = await connect("woocommerce", WOO);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("validation_failed");
    expect(r.body.message).toMatch(/rejected these keys/);
    expect(DB.writes).toEqual([]);
  });

  it("★ a refusal does not overwrite an existing working connection", async () => {
    DB.existing = { id: "ti_old" };
    store(401);
    expect((await connect("woocommerce", WOO)).status).toBe(422);
    expect(DB.writes).toEqual([]);
  });

  it("a missing or private store address is refused before any call", async () => {
    store(200);
    expect((await connect("woocommerce", { ...WOO, config: {} })).status).toBe(422);
    expect((await connect("woocommerce", { ...WOO, config: { storeUrl: "http://localhost:8090" } })).status).toBe(422);
    expect(DB.writes).toEqual([]);
  });

  it("a half-filled key pair is refused", async () => {
    store(200);
    const r = await connect("woocommerce", { ...WOO, credentials: { consumerKey: "ck_1" } });
    expect(r.status).toBe(422);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });
});

describe("integrations without a validate hook are unchanged", () => {
  it("connect as before", async () => {
    const r = await connect("airtable", { credentials: { apiKey: "k" }, config: {} });
    expect(r.status).toBe(201);
    expect(DB.writes[0][1].status).toBe("CONNECTED");
  });
});
