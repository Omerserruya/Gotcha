/**
 * ★ A WhatsApp number's account remembers the number itself (2026-10-09: the
 * channels screen named "Demo WhatsApp" but could never show its phone number;
 * connect fetched display_phone_number and dropped it).
 *   - POST /api/channels/connect/whatsapp stores displayPhoneNumber and
 *     verifiedName beside wabaId and qualityRating; a reconnect merges into
 *     what the row already holds instead of erasing it
 *   - GET /api/channels/whatsapp/numbers: an unprofiled (legacy) row carries
 *     exactly `phoneNumber: string | null`
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

const H = vi.hoisted(() => ({ existing: null as any, writes: [] as any[], numbers: [] as any[], legacy: [] as any[], details: {} as any }));

vi.mock("axios", () => ({
  default: {
    get: async (url: string) => {
      if (url.endsWith("/oauth/access_token")) return { data: { access_token: "business-token-0123456789" } };
      if (url.endsWith("/pn_1")) return { data: H.details };
      throw new Error(`unexpected GET ${url}`);
    },
    post: async () => ({ data: { success: true } }),
  },
}));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      channelAccount: {
        count: async () => 0,
        findUnique: async () => H.existing,
        // Honours select, so a field the route stops selecting is gone here too.
        findMany: async (a: any) => H.legacy.map((r) => (a?.select ? Object.fromEntries(Object.keys(a.select).map((k) => [k, r[k]])) : r)),
        create: async (a: any) => { H.writes.push({ op: "create", data: a.data }); return { id: "ca_new", ...a.data }; },
        update: async (a: any) => { H.writes.push({ op: "update", data: a.data }); return { id: a.where.id, ...a.data }; },
      },
      whatsAppNumber: { findMany: async () => H.numbers },
    },
    getRedis: () => ({ get: async () => null, set: async () => "OK", del: async () => 0 }),
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
  };
});

import channelsRouter from "../routes/channels";
import whatsappRouter from "../routes/whatsapp-numbers";

const app = express();
app.use(express.json());
app.use("/api/channels/whatsapp", whatsappRouter);
app.use("/api/channels", channelsRouter);

const connect = () => request(app).post("/api/channels/connect/whatsapp").send({ code: "c1", wabaId: "waba_1", phoneNumberId: "pn_1" });

beforeEach(() => {
  H.existing = null; H.writes = []; H.numbers = []; H.legacy = [];
  H.details = { id: "pn_1", display_phone_number: "+972 52-540-1686", verified_name: "GOTCHA Demo", quality_rating: "GREEN" };
});

describe("★ connect stores the number", () => {
  it("a new account: the number and its name beside the WABA and quality", async () => {
    const r = await connect();
    expect(r.status).toBe(201);
    expect(H.writes).toHaveLength(1);
    expect(H.writes[0].op).toBe("create");
    expect(H.writes[0].data.platformMeta).toEqual({ wabaId: "waba_1", qualityRating: "GREEN", displayPhoneNumber: "+972 52-540-1686", verifiedName: "GOTCHA Demo" });
  });

  it("a reconnect merges: what the row holds stays, the number is refreshed", async () => {
    H.existing = { id: "ca_1", tenantId: "T", platformMeta: { wabaId: "waba_old", historyImport: "done", displayPhoneNumber: "+972 50-000-0000" } };
    await connect();
    expect(H.writes[0].op).toBe("update");
    expect(H.writes[0].data.platformMeta).toEqual({ wabaId: "waba_1", historyImport: "done", qualityRating: "GREEN", displayPhoneNumber: "+972 52-540-1686", verifiedName: "GOTCHA Demo" });
  });

  it("a details read that came back empty never erases a stored number", async () => {
    H.existing = { id: "ca_1", tenantId: "T", platformMeta: { wabaId: "waba_1", displayPhoneNumber: "+972 52-540-1686" } };
    H.details = { id: "pn_1" };
    await connect();
    expect(H.writes[0].data.platformMeta).toEqual({ wabaId: "waba_1", displayPhoneNumber: "+972 52-540-1686" });
  });
});

describe("★ the numbers list: an unprofiled row carries phoneNumber", () => {
  it("the stored number, or null when none is stored", async () => {
    H.legacy = [
      { id: "ca_1", externalId: "pn_1", displayName: "Demo WhatsApp", connectionStatus: "CONNECTED", platformMeta: { wabaId: "w", displayPhoneNumber: " +972 52-540-1686 " } },
      { id: "ca_2", externalId: "pn_2", displayName: "Old", connectionStatus: "CONNECTED", platformMeta: null },
      { id: "ca_3", externalId: "pn_3", displayName: "Odd", connectionStatus: "CONNECTED", platformMeta: { displayPhoneNumber: 972 } },
    ];
    const r = await request(app).get("/api/channels/whatsapp/numbers");
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.unprofiled.map((c: any) => [c.channelAccountId, c.phoneNumber]));
    expect(byId).toEqual({ ca_1: "+972 52-540-1686", ca_2: null, ca_3: null });
    expect(r.body.unprofiled[0]).not.toHaveProperty("platformMeta");
  });
});
