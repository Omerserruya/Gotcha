/**
 * ★ Channel rows a client receives, and two ways back from a disconnect
 * (2026-10-10).
 *
 * E2: every route that answers with a ChannelAccount row passes it through
 *     publicChannelAccount: no `credentials`, no secret-named field, and no
 *     secret-named key at any depth of platformMeta. The email connect used to
 *     answer with its encrypted SMTP/IMAP credentials.
 * E1: an email address whose account is DISCONNECTED reconnects (same id)
 *     instead of answering 409; a live one or another tenant's is refused.
 * W:  disconnecting the website widget keeps its settings, and /webchat/create
 *     brings the SAME widget back (PENDING, which /bootstrap and /init accept)
 *     instead of returning a record they refuse.
 *
 * Every request goes through the real router; only Redis, axios and prisma are
 * doubled, and the prisma double honours `where` (equality, `not`, `in`, the
 * compound unique key) and `select`.
 */
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

const DB = vi.hoisted(() => ({ rows: [] as any[], seq: 0 }));

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
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
    assertWithinLimit: async () => {},
    hasPermission: async () => true,
  };
});

import { encryptCredentials, decryptCredentials } from "@chatcenter/shared";
import router from "../routes/channels";
import { publicChannelAccount } from "../lib/channel-account-dto";

const app = express();
app.use(express.json());
app.use("/api/channels", router);

/** platformMeta as the writers have actually left it: secrets beside the fields screens read. */
const LEAKY_META = () => ({
  clientState: "PLANTED_client_state",
  subscriptionId: "sub_1",
  webhookSecret: "PLANTED_webhook_secret",
  apiKey: "PLANTED_api_key",
  api_key: "PLANTED_api_key_snake",
  password: "PLANTED_password",
  nested: { accessToken: "PLANTED_nested_token", keep: 1 },
  list: [{ refresh_token: "PLANTED_list_token", label: "kept" }],
  shopifyLiveChat: { enabled: true, shopDomain: "acme.myshopify.com" },
});

const seed = (o: any) => {
  const row = {
    id: `seed_${++DB.seq}`,
    tenantId: "tenant_a",
    displayName: "Seeded",
    isActive: true,
    connectionStatus: "CONNECTED",
    lastError: null,
    platformMeta: null,
    tokenExpiresAt: null,
    createdAt: new Date(),
    credentials: encryptCredentials({ accessToken: "PLANTED_seed_token", refreshToken: "PLANTED_seed_refresh" }),
    ...o,
  };
  DB.rows.push(row);
  return row;
};

const keysOf = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
  return out;
};

/** No secret name, no planted value, no stored credential blob anywhere in the answer. */
function expectNoSecrets(body: unknown) {
  const text = JSON.stringify(body);
  for (const name of ["credentials", "accessToken", "refreshToken", "clientState"]) expect(text).not.toContain(name);
  for (const k of keysOf(body)) expect(k).not.toMatch(/secret|credential|accesstoken|refreshtoken|refresh_token|clientstate|password|apikey/i);
  expect(text).not.toContain("PLANTED");
  for (const r of DB.rows) if (typeof r.credentials === "string") expect(text).not.toContain(r.credentials);
}

beforeEach(() => {
  DB.rows = [];
  DB.seq = 0;
  G.user = { userId: "u_admin", tenantId: "tenant_a", role: "ADMIN" };
});

// ─── E2 ──────────────────────────────────────────────────────

describe("★ E2: no route answers with a secret", () => {
  it("GET / and the windowed GET /: platformMeta scrubbed at every depth, readable fields kept", async () => {
    seed({ channel: "OUTLOOK", externalId: "ops@acme.test", displayName: "Ops inbox", platformMeta: LEAKY_META(), tokenExpiresAt: new Date("2026-12-01T00:00:00Z") });
    for (const r of [
      await request(app).get("/api/channels"),
      await request(app).get("/api/channels").query({ from: "2026-10-01T00:00:00Z" }),
    ]) {
      expect(r.status).toBe(200);
      expectNoSecrets(r.body);
      const row = r.body.data[0];
      expect(row).toMatchObject({ displayName: "Ops inbox", connectionStatus: "CONNECTED", tokenExpiresAt: "2026-12-01T00:00:00.000Z" });
      expect(row.platformMeta).toEqual({
        subscriptionId: "sub_1",
        nested: { keep: 1 },
        list: [{ label: "kept" }],
        shopifyLiveChat: { enabled: true, shopDomain: "acme.myshopify.com" },
      });
    }
  });

  it("GET /state and GET /:id/status", async () => {
    const row = seed({ channel: "MESSENGER", externalId: "pg_1", displayName: "Acme Page", platformMeta: LEAKY_META() });
    const state = await request(app).get("/api/channels/state");
    expect(state.status).toBe(200);
    expectNoSecrets(state.body);
    expect(state.body.data[0]).toMatchObject({ displayName: "Acme Page", connectionStatus: "CONNECTED" });

    const status = await request(app).get(`/api/channels/${row.id}/status`);
    expect(status.status).toBe(200);
    expectNoSecrets(status.body);
    expect(status.body.data.status).toBe("CONNECTED");
  });

  it("POST /connect/whatsapp: the new token and an old row's platformMeta secrets stay home", async () => {
    seed({ channel: "WHATSAPP", externalId: "pn_1", platformMeta: LEAKY_META() });
    const r = await request(app).post("/api/channels/connect/whatsapp").send({ code: "c1", wabaId: "waba_1", phoneNumberId: "pn_1" });
    expect(r.status).toBe(201);
    expectNoSecrets(r.body);
    expect(r.body.data[0]).toMatchObject({ displayName: "Acme WA", connectionStatus: "CONNECTED" });
    expect(r.body.data[0].platformMeta).toMatchObject({ wabaId: "waba_1", displayPhoneNumber: "+972 50-000-0001", subscriptionId: "sub_1" });
  });

  it("POST /connect/whatsapp-session", async () => {
    const r = await request(app).post("/api/channels/connect/whatsapp-session").send({ wabaId: "waba_1", phoneNumberId: "pn_1" });
    expect(r.status).toBe(201);
    expectNoSecrets(r.body);
    expect(r.body.data[0]).toMatchObject({ displayName: "Acme WA", connectionStatus: "CONNECTED" });
  });

  it("POST /connect/email: { data: [account] } with no credentials", async () => {
    const r = await request(app).post("/api/channels/connect/email").send(EMAIL("PLANTED_smtp_pass"));
    expect(r.status).toBe(200);
    expectNoSecrets(r.body);
    expect(Array.isArray(r.body.data)).toBe(true);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ displayName: "Support", connectionStatus: "CONNECTED", externalId: "support@acme.test" });
    // Stored, just not served.
    expect(decryptCredentials(DB.rows[0].credentials).smtpPass).toBe("PLANTED_smtp_pass");
  });

  it("POST /webchat/create (new and existing) and PUT /webchat/:id/settings", async () => {
    const created = await request(app).post("/api/channels/webchat/create").send({});
    expect(created.status).toBe(201);
    expectNoSecrets(created.body);
    expect(created.body.data).toMatchObject({ displayName: "Website Chat Widget", connectionStatus: "PENDING" });

    const put = await request(app).put(`/api/channels/webchat/${created.body.data.id}/settings`).send({ title: "Acme Help", color: "#112233" });
    expect(put.status).toBe(200);
    expectNoSecrets(put.body);
    expect(put.body.data.displayName).toBe("Website Chat Widget");
    expect(put.body.data.config).toBeTruthy();

    const again = await request(app).post("/api/channels/webchat/create").send({});
    expect(again.status).toBe(200);
    expectNoSecrets(again.body);
    expect(again.body.data).toMatchObject({ id: created.body.data.id, connectionStatus: "PENDING" });
  });

  it("the serializer keeps tokenExpiresAt and drops any other secret-named row field", () => {
    const out: any = publicChannelAccount({ id: "x", credentials: "blob", tokenExpiresAt: "t", appSecret: "s", platformMeta: null });
    expect(out).toEqual({ id: "x", tokenExpiresAt: "t", platformMeta: null });
  });
});

// ─── E1 ──────────────────────────────────────────────────────

const EMAIL = (smtpPass = "new-pass") => ({
  emailAddress: "support@acme.test",
  displayName: "Support",
  smtpHost: "smtp.acme.test",
  smtpPort: 587,
  smtpUser: "support",
  smtpPass,
});

describe("★ E1: a disconnected email address reconnects", () => {
  it("same tenant, DISCONNECTED: same id, CONNECTED, active, error cleared, new credentials", async () => {
    const old = seed({
      channel: "EMAIL", externalId: "support@acme.test", displayName: "Old name",
      connectionStatus: "DISCONNECTED", isActive: false, lastError: "[AUTH_FAILED] gone", credentials: {},
    });
    const r = await request(app).post("/api/channels/connect/email").send(EMAIL("fresh-pass"));
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ id: old.id, connectionStatus: "CONNECTED", isActive: true, lastError: null, displayName: "Support" });
    expectNoSecrets(r.body);
    expect(DB.rows).toHaveLength(1);
    expect(DB.rows[0]).toMatchObject({ id: old.id, connectionStatus: "CONNECTED", isActive: true, lastError: null });
    expect(decryptCredentials(DB.rows[0].credentials)).toMatchObject({ smtpPass: "fresh-pass", fromAddress: "support@acme.test" });
  });

  it.each([
    ["same tenant, CONNECTED", { tenantId: "tenant_a", connectionStatus: "CONNECTED" }],
    ["same tenant, ERROR", { tenantId: "tenant_a", connectionStatus: "ERROR" }],
    ["another tenant, CONNECTED", { tenantId: "tenant_b", connectionStatus: "CONNECTED" }],
    ["another tenant, DISCONNECTED", { tenantId: "tenant_b", connectionStatus: "DISCONNECTED", isActive: false }],
  ])("%s: still 409, nothing written", async (_label, o) => {
    const row = seed({ channel: "EMAIL", externalId: "support@acme.test", credentials: "untouched", ...o });
    const before = { ...row };
    const r = await request(app).post("/api/channels/connect/email").send(EMAIL());
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("This email address is already connected");
    expect(DB.rows).toEqual([before]);
  });
});

// ─── W ───────────────────────────────────────────────────────

describe("★ W: the website widget survives a disconnect", () => {
  async function configuredWidget() {
    const created = await request(app).post("/api/channels/webchat/create").send({});
    const id = created.body.data.id;
    await request(app).put(`/api/channels/webchat/${id}/settings`).send({ title: "Acme Help", color: "#112233", welcome: "Hello there" });
    const settings = (await request(app).get(`/api/channels/webchat/${id}/settings`)).body.data;
    return { id, externalId: created.body.data.externalId, settings };
  }

  it("disconnect keeps the settings and only turns it off", async () => {
    const w = await configuredWidget();
    const stored = structuredClone(DB.rows[0].credentials);
    const r = await request(app).post(`/api/channels/${w.id}/disconnect`);
    expect(r.status).toBe(200);
    expect(DB.rows[0]).toMatchObject({ connectionStatus: "DISCONNECTED", isActive: false });
    expect(DB.rows[0].credentials).toEqual(stored);
    expect((await request(app).get(`/api/channels/webchat/${w.id}/settings`)).body.data).toEqual(w.settings);
  });

  it("create after disconnect returns the SAME widget, PENDING and active, settings intact", async () => {
    const w = await configuredWidget();
    await request(app).post(`/api/channels/${w.id}/disconnect`);
    // A writer may have recorded an error while it was off.
    DB.rows[0].lastError = "stale";
    const r = await request(app).post("/api/channels/webchat/create").send({});
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: w.id, externalId: w.externalId, connectionStatus: "PENDING", isActive: true, lastError: null });
    expectNoSecrets(r.body);
    expect(DB.rows).toHaveLength(1);
    expect((await request(app).get(`/api/channels/webchat/${w.id}/settings`)).body.data).toEqual(w.settings);
  });

  it("a live widget is returned as it is, never re-set to PENDING", async () => {
    const w = await configuredWidget();
    DB.rows[0].connectionStatus = "CONNECTED";
    const r = await request(app).post("/api/channels/webchat/create").send({});
    expect(r.body.data).toMatchObject({ id: w.id, connectionStatus: "CONNECTED" });
    expect(DB.rows[0].connectionStatus).toBe("CONNECTED");
  });

  it("another tenant's widgets are untouched by this tenant's disconnect and create", async () => {
    const theirsLive = seed({ tenantId: "tenant_b", channel: "WEBCHAT", externalId: "widget_b_live", credentials: { v: 2, displayName: "B" } });
    const w = await configuredWidget();
    await request(app).post(`/api/channels/${w.id}/disconnect`);
    await request(app).post("/api/channels/webchat/create").send({});
    expect(DB.rows.find((r) => r.id === theirsLive.id)).toMatchObject({ connectionStatus: "CONNECTED", credentials: { v: 2, displayName: "B" } });

    // Tenant C has no widget; tenant B's dead one is not handed to it.
    DB.rows.find((r) => r.id === theirsLive.id).connectionStatus = "DISCONNECTED";
    G.user = { userId: "u_c", tenantId: "tenant_c", role: "ADMIN" };
    const c = await request(app).post("/api/channels/webchat/create").send({});
    expect(c.status).toBe(201);
    expect(c.body.data.id).not.toBe(theirsLive.id);
    expect(DB.rows.find((r) => r.id === theirsLive.id).connectionStatus).toBe("DISCONNECTED");
  });

  it("any other channel's disconnect still wipes its credentials", async () => {
    const row = seed({ channel: "SLACK", externalId: "T1" });
    await request(app).post(`/api/channels/${row.id}/disconnect`);
    expect(DB.rows[0]).toMatchObject({ connectionStatus: "DISCONNECTED", isActive: false });
    expect(DB.rows[0].credentials).toEqual({});
  });
});
