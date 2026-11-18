/** The relevance filter per connected channel account (2026-11-18, Omer). */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.META_APP_ID = "meta-app";
  process.env.META_APP_SECRET = "meta-secret";
  process.env.OAUTH_REDIRECT_URI = "https://dev.example.test/api/channels/oauth/callback";
  process.env.APP_PUBLIC_URL = "https://dev.example.test";
  process.env.FRONTEND_URL = "https://dev.example.test";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-0123456789abcdef";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});

// ─── Doubles ─────────────────────────────────────────────────

vi.mock("ioredis", () => ({
  default: class {
    on = vi.fn(); quit = vi.fn(); publish = vi.fn(); subscribe = vi.fn();
    async set() { return "OK"; }
    async get() { return null; }
    async del() { return 0; }
  },
}));

vi.mock("axios", () => {
  const get = async (url: string) => {
    if (url.endsWith("/oauth/access_token")) return { data: { access_token: "PLANTED_wa_business_token" } };
    if (url.endsWith("/pn_1")) return { data: { id: "pn_1", display_phone_number: "+972 50-000-0001", verified_name: "Acme WA" } };
    if (url.endsWith("/debug_token")) return { data: { data: { is_valid: true } } };
    throw new Error(`unexpected GET ${url}`);
  };
  const post = async (url: string) => {
    if (url.endsWith("/subscribed_apps") || url.endsWith("/register")) return { data: { success: true } };
    throw new Error(`unexpected POST ${url}`);
  };
  const axiosMock = { get, post, delete: async () => ({ data: {} }) };
  return { default: axiosMock, ...axiosMock };
});

const DB = vi.hoisted(() => ({ rows: [] as any[], seq: 0, locale: "en", full: false }));

const isPlain = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
const cond = (actual: unknown, v: any): boolean => {
  if (isPlain(v) && "not" in v) return actual !== v.not;
  if (isPlain(v) && "in" in v) return (v.in as unknown[]).includes(actual);
  return actual === v;
};
/** `where` as Prisma reads it; a nested object without an operator is the compound unique key. */
const matches = (row: any, where: any = {}) =>
  Object.entries(where).every(([k, v]: [string, any]) =>
    isPlain(v) && !("not" in v) && !("in" in v)
      ? Object.entries(v).every(([kk, vv]) => cond(row[kk], vv))
      : cond(row[k], v),
  );
const project = (row: any, select?: any) => {
  if (!select) return { ...row };
  const out: any = {};
  for (const [k, v] of Object.entries(select)) {
    if (k === "_count") out._count = { conversations: 0 };
    else if (v) out[k] = row[k];
  }
  return out;
};

const G = vi.hoisted(() => ({ user: { userId: "u_admin", tenantId: "tenant_a", role: "ADMIN" } as any }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      channelAccount: {
        findUnique: async ({ where }: any) => DB.rows.find((r) => matches(r, where)) ?? null,
        findFirst: async ({ where, select }: any) => {
          const r = DB.rows.find((x) => matches(x, where));
          return r ? project(r, select) : null;
        },
        findMany: async ({ where, select }: any = {}) => DB.rows.filter((r) => matches(r, where)).map((r) => project(r, select)),
        count: async ({ where }: any = {}) => DB.rows.filter((r) => matches(r, where)).length,
        create: async ({ data }: any) => {
          const row = { id: `ca_${++DB.seq}`, isActive: true, lastError: null, platformMeta: null, tokenExpiresAt: null, createdAt: new Date(), ...data };
          DB.rows.push(row);
          return { ...row };
        },
        update: async ({ where, data }: any) => {
          const row = DB.rows.find((r) => matches(r, where));
          if (!row) throw new Error("Record to update not found");
          Object.assign(row, data);
          return { ...row };
        },
      },
      tenant: { findUnique: async () => ({ defaultLocale: DB.locale }) },
      conversation: { groupBy: async () => [] },
      routerRule: { findMany: async () => [], create: async (a: any) => a.data, update: async (a: any) => a.data },
      $transaction: async (ops: any[]) => Promise.all(ops),
    },
    getRedis: () => ({
      get: async (k: string) => (k.startsWith("wa_pending_token:") ? "PLANTED_pending_token" : null),
      set: async () => "OK",
      del: async () => 0,
    }),
    authenticate: (req: any, _res: any, next: any) => { req.user = { ...G.user }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = G.user.tenantId; next(); },
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    // Refuses when DB.full, so a route that must stay open at the limit can be proven to.
    requireCapacity: () => (_q: any, res: any, n: any) => (DB.full ? res.status(402).json({ code: "PLAN_LIMIT_REACHED" }) : n()),
    assertWithinLimit: async () => {},
    hasPermission: async () => true,
  };
});

import router from "../routes/channels";

const app = express();
app.use(express.json());
app.use("/api/channels", router);


const row = (o: any) => { const r = { id: `ca_${++DB.seq}`, tenantId: "tenant_a", displayName: "x", isActive: true, connectionStatus: "CONNECTED", lastError: null, platformMeta: null, tokenExpiresAt: null, createdAt: new Date(), relevanceFilterEnabled: true, ...o }; DB.rows.push(r); return r; };

describe("the relevance filter per channel account (2026-11-18)", () => {
  beforeEach(() => { DB.rows = []; DB.seq = 0; G.user = { userId: "u_admin", tenantId: "tenant_a", role: "ADMIN" }; });

  it("★ the list carries relevanceFilterEnabled for message channels, null for a site chat or voice", async () => {
    row({ channel: "WHATSAPP", externalId: "pn1" });
    row({ channel: "GMAIL", externalId: "a@b.c", relevanceFilterEnabled: false });
    row({ channel: "WEBCHAT", externalId: "w1" });
    row({ channel: "VOICE", externalId: "v1" });
    const r = await request(app).get("/api/channels");
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.data.map((a: any) => [a.channel, a.relevanceFilterEnabled]));
    expect(by).toEqual({ WHATSAPP: true, GMAIL: false, WEBCHAT: null, VOICE: null });
  });

  it("★ PATCH turns it off and on; validated; tenant-scoped; not for a site chat", async () => {
    const wa = row({ channel: "WHATSAPP", externalId: "pn1" });
    const off = await request(app).patch(`/api/channels/${wa.id}/relevance-filter`).send({ relevanceFilterEnabled: false });
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({ id: wa.id, relevanceFilterEnabled: false });
    expect(DB.rows[0].relevanceFilterEnabled).toBe(false);
    expect((await request(app).patch(`/api/channels/${wa.id}/relevance-filter`).send({ relevanceFilterEnabled: true })).body.data.relevanceFilterEnabled).toBe(true);
    expect((await request(app).patch(`/api/channels/${wa.id}/relevance-filter`).send({ relevanceFilterEnabled: "no" })).status).toBe(400);
    const other = row({ channel: "WHATSAPP", externalId: "pn2", tenantId: "tenant_b" });
    expect((await request(app).patch(`/api/channels/${other.id}/relevance-filter`).send({ relevanceFilterEnabled: false })).status).toBe(404);
    const web = row({ channel: "WEBCHAT", externalId: "w1" });
    const r = await request(app).patch(`/api/channels/${web.id}/relevance-filter`).send({ relevanceFilterEnabled: false });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("RELEVANCE_FILTER_NOT_APPLICABLE");
  });
});
