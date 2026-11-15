/**
 * The tenant Embedded Signup connect, pinned call by call (2026-11-15, before
 * the code exchange / WABA discovery / subscribe / register moved into
 * @chatcenter/shared signup-connect for the platform alerts number). Every
 * Graph call the route makes, in order, with its method, URL and body, and
 * every row it writes: the refactor must leave all of it exactly as it was,
 * register pin "000000" included.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.META_APP_ID = "app_1";
  process.env.META_APP_SECRET = "secret_1";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-0123456789abcdef";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); publish = vi.fn(); subscribe = vi.fn(); async get() { return null; } async set() { return "OK"; } async del() { return 0; } } }));

const H = vi.hoisted(() => ({
  calls: [] as Array<[string, string, any]>,
  failExchange: 0, subscribeFails: false, registerFails: false, phonesFail: false,
  scopes: [] as any[], phones: [] as string[], existing: {} as Record<string, any>, writes: [] as any[], dels: [] as string[],
}));
const fail = (m: string, code?: number) => Object.assign(new Error(m), { response: { data: { error: { message: m, code } } } });

vi.mock("axios", () => ({
  default: {
    get: async (url: string, cfg?: any) => {
      H.calls.push(["GET", url, cfg?.params ?? null]);
      if (url.endsWith("/oauth/access_token")) {
        if (H.failExchange > 0) { H.failExchange--; throw fail("bad code"); }
        return { data: { access_token: "business-token-0123456789" } };
      }
      if (url.endsWith("/debug_token")) return { data: { data: { granular_scopes: H.scopes } } };
      if (url.endsWith("/phone_numbers")) { if (H.phonesFail) throw fail("waba gone", 100); return { data: { data: H.phones.map((id) => ({ id })) } }; }
      const id = url.split("/").pop()!;
      return { data: { id, display_phone_number: `+972 ${id}`, verified_name: `Name ${id}`, quality_rating: "GREEN" } };
    },
    post: async (url: string, data?: any) => {
      H.calls.push(["POST", url, data ?? null]);
      if (url.endsWith("/oauth/access_token")) { if (H.failExchange > 0) { H.failExchange--; throw fail("bad code"); } return { data: { access_token: "business-token-0123456789" } }; }
      if (url.endsWith("/subscribed_apps") && H.subscribeFails) throw fail("refused");
      if (url.endsWith("/register") && H.registerFails) throw fail("already registered");
      return { data: { success: true } };
    },
  },
}));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      channelAccount: {
        count: async () => 0,
        findUnique: async (a: any) => H.existing[a.where.channel_externalId.externalId] ?? null,
        findFirst: async () => null,
        create: async (a: any) => { H.writes.push({ op: "create", data: a.data }); return { id: `ca_${H.writes.length}`, ...a.data }; },
        update: async (a: any) => { H.writes.push({ op: "update", id: a.where.id, data: a.data }); return { id: a.where.id, ...a.data }; },
      },
      whatsAppNumber: { findFirst: async () => null, findMany: async () => [] },
    },
    getRedis: () => ({ get: async () => null, set: async () => "OK", del: async (k: string) => { H.dels.push(k); return 0; } }),
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
  };
});

import { decryptCredentials, metaGraphBaseUrl, EMBEDDED_SIGNUP_DIALOG_VERSION } from "@chatcenter/shared";
import channelsRouter from "../routes/channels";

const app = express();
app.use(express.json());
app.use("/api/channels", channelsRouter);
const connect = (body: any) => request(app).post("/api/channels/connect/whatsapp").send(body);
const G = metaGraphBaseUrl(undefined);
const SDK = `https://graph.facebook.com/${EMBEDDED_SIGNUP_DIALOG_VERSION}`;
const EXCHANGE = { client_id: "app_1", client_secret: "secret_1", code: "c1" };
const AUTH = "business-token-0123456789";

beforeEach(() => {
  H.calls = []; H.failExchange = 0; H.subscribeFails = false; H.registerFails = false; H.phonesFail = false;
  H.scopes = []; H.phones = []; H.existing = {}; H.writes = []; H.dels = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("tenant /connect/whatsapp, call by call", () => {
  it("session ids: exchange, subscribe, details, register 000000, one CONNECTED row", async () => {
    const r = await connect({ code: "c1", wabaId: "waba_1", phoneNumberId: "pn_1" });
    expect(r.status).toBe(201);
    expect(r.body.webhookSubscribed).toBe(true);
    expect(H.calls).toEqual([
      ["GET", `${G}/oauth/access_token`, EXCHANGE],
      ["POST", `${G}/waba_1/subscribed_apps`, {}],
      ["GET", `${G}/pn_1`, { fields: "id,display_phone_number,verified_name,quality_rating" }],
      ["POST", `${G}/pn_1/register`, { messaging_product: "whatsapp", pin: "000000" }],
    ]);
    expect(H.writes).toHaveLength(1);
    const w = H.writes[0];
    expect(w.op).toBe("create");
    expect(w.data).toMatchObject({ tenantId: "T", channel: "WHATSAPP", externalId: "pn_1", displayName: "Name pn_1", connectionStatus: "CONNECTED", lastError: null, connectedBy: "u1", isActive: true });
    expect(decryptCredentials(w.data.credentials)).toEqual({ accessToken: AUTH, wabaId: "waba_1", phoneNumber: "+972 pn_1" });
    expect(H.dels).toEqual(["channel_account:WHATSAPP:pn_1"]);
    expect(JSON.stringify(r.body)).not.toContain(AUTH);
  });

  it("the exchange falls through its four attempts in order, then succeeds on the SDK version", async () => {
    H.failExchange = 3;
    const r = await connect({ code: "c1", wabaId: "waba_1", phoneNumberId: "pn_1" });
    expect(r.status).toBe(201);
    expect(H.calls.slice(0, 4)).toEqual([
      ["GET", `${G}/oauth/access_token`, EXCHANGE],
      ["GET", `${SDK}/oauth/access_token`, EXCHANGE],
      ["POST", `${G}/oauth/access_token`, EXCHANGE],
      ["POST", `${SDK}/oauth/access_token`, { ...EXCHANGE, grant_type: "authorization_code" }],
    ]);
  });

  it("every exchange failing: 400, nothing else called", async () => {
    H.failExchange = 4;
    const r = await connect({ code: "c1" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Failed to exchange code for business token. Check Facebook App redirect_uri settings.");
    expect(H.calls).toHaveLength(4);
    expect(H.writes).toHaveLength(0);
  });

  it("no session ids: debug_token finds the WABA, phone_numbers lists two, both connected", async () => {
    H.scopes = [{ scope: "whatsapp_business_messaging", target_ids: ["x"] }, { scope: "whatsapp_business_management", target_ids: ["waba_7", "waba_8"] }];
    H.phones = ["pn_a", "pn_b"];
    const r = await connect({ code: "c1" });
    expect(r.status).toBe(201);
    expect(H.calls).toEqual([
      ["GET", `${G}/oauth/access_token`, EXCHANGE],
      ["GET", `${G}/debug_token`, { input_token: AUTH }],
      ["POST", `${G}/waba_7/subscribed_apps`, {}],
      ["GET", `${G}/waba_7/phone_numbers`, null],
      ["GET", `${G}/pn_a`, { fields: "id,display_phone_number,verified_name,quality_rating" }],
      ["POST", `${G}/pn_a/register`, { messaging_product: "whatsapp", pin: "000000" }],
      ["GET", `${G}/pn_b`, { fields: "id,display_phone_number,verified_name,quality_rating" }],
      ["POST", `${G}/pn_b/register`, { messaging_product: "whatsapp", pin: "000000" }],
    ]);
    expect(H.writes.map((w) => w.data.externalId)).toEqual(["pn_a", "pn_b"]);
  });

  it("no WABA anywhere: 400", async () => {
    const r = await connect({ code: "c1" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("No WhatsApp Business Account found. Please complete the Embedded Signup flow.");
  });

  it("a WABA with no numbers: 400", async () => {
    const r = await connect({ code: "c1", wabaId: "waba_1" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("No phone numbers found in the WhatsApp Business Account.");
  });

  it("the phone list failing at Meta: 400 with Meta's message and code", async () => {
    H.phonesFail = true;
    const r = await connect({ code: "c1", wabaId: "waba_1" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "waba gone", code: 100 });
  });

  it("subscribe failing: PENDING with the coded error, webhookSubscribed false", async () => {
    H.subscribeFails = true;
    const r = await connect({ code: "c1", wabaId: "waba_1", phoneNumberId: "pn_1" });
    expect(r.status).toBe(201);
    expect(r.body.webhookSubscribed).toBe(false);
    expect(H.writes[0].data.connectionStatus).toBe("PENDING");
    expect(H.writes[0].data.lastError).toBe("[SUBSCRIBE_FAILED] Webhook subscription failed - messages cannot arrive yet: refused");
  });

  it("register failing is a note, the number still connects", async () => {
    H.registerFails = true;
    const r = await connect({ code: "c1", wabaId: "waba_1", phoneNumberId: "pn_1" });
    expect(r.status).toBe(201);
    expect(H.writes[0].data.connectionStatus).toBe("CONNECTED");
  });

  it("a number on another tenant is skipped; none left: 400", async () => {
    H.existing.pn_1 = { id: "ca_x", tenantId: "OTHER" };
    const r = await connect({ code: "c1", wabaId: "waba_1", phoneNumberId: "pn_1" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Could not connect any phone numbers.");
    expect(H.writes).toHaveLength(0);
  });

  it("our own number again: updated in place", async () => {
    H.existing.pn_1 = { id: "ca_1", tenantId: "T", platformMeta: null };
    const r = await connect({ code: "c1", wabaId: "waba_1", phoneNumberId: "pn_1" });
    expect(r.status).toBe(201);
    expect(H.writes[0]).toMatchObject({ op: "update", id: "ca_1", data: { connectionStatus: "CONNECTED", isActive: true } });
  });
});
