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

const H = vi.hoisted(() => ({ subscribeFails: false, existing: null as any, writes: [] as any[], numbers: [] as any[], legacy: [] as any[], details: {} as any, accounts: [] as any[], slots: new Set<string>(), detailsFail: false, graphReads: 0 }));

vi.mock("axios", () => ({
  default: {
    get: async (url: string) => {
      if (url.endsWith("/oauth/access_token")) return { data: { access_token: "business-token-0123456789" } };
      if (url.endsWith("/pn_1")) { H.graphReads++; if (H.detailsFail) throw new Error("graph down"); return { data: H.details }; }
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url: string) => {
      if (H.subscribeFails && url.endsWith("/subscribed_apps")) throw Object.assign(new Error("refused"), { response: { data: { error: { message: "refused" } } } });
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
        findUnique: async () => H.existing,
        // Honours select, so a field the route stops selecting is gone here too.
        findMany: async (a: any) => H.legacy.map((r) => (a?.select ? Object.fromEntries(Object.keys(a.select).map((k) => [k, r[k]])) : r)),
        findFirst: async (a: any) => H.accounts.find((r) => r.id === a.where.id && r.tenantId === a.where.tenantId && r.channel === a.where.channel) ?? null,
        create: async (a: any) => { H.writes.push({ op: "create", data: a.data }); return { id: "ca_new", ...a.data }; },
        update: async (a: any) => {
          H.writes.push({ op: "update", data: a.data });
          const row = H.accounts.find((r) => r.id === a.where.id);
          if (row) { Object.assign(row, a.data); return row; }
          return { id: a.where.id, ...a.data };
        },
      },
      whatsAppNumber: {
        findMany: async () => H.numbers,
        findFirst: async (a: any) => H.numbers.find((n) => (a.where.id ? n.id === a.where.id : n.phoneNumberId === a.where.phoneNumberId) && n.tenantId === a.where.tenantId) ?? null,
      },
    },
    // SET NX honoured, so the once-a-minute refresh is real here.
    getRedis: () => ({ get: async () => null, set: async (k: string, _v: string, ...args: any[]) => { if (args.includes("NX")) { if (H.slots.has(k)) return null; H.slots.add(k); } return "OK"; }, del: async () => 0 }),
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
  };
});

import { encryptCredentials } from "@chatcenter/shared";
import channelsRouter from "../routes/channels";
import whatsappRouter from "../routes/whatsapp-numbers";

const app = express();
app.use(express.json());
app.use("/api/channels/whatsapp", whatsappRouter);
app.use("/api/channels", channelsRouter);

const connect = () => request(app).post("/api/channels/connect/whatsapp").send({ code: "c1", wabaId: "waba_1", phoneNumberId: "pn_1" });

beforeEach(() => {
  H.subscribeFails = false;
  H.existing = null; H.writes = []; H.numbers = []; H.legacy = []; H.accounts = []; H.slots = new Set(); H.detailsFail = false; H.graphReads = 0;
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

  it("the channel's data beside it: verified name, quality and when it was last checked", async () => {
    H.legacy = [
      { id: "ca_1", externalId: "pn_1", displayName: "Demo WhatsApp", connectionStatus: "CONNECTED", lastHealthCheck: new Date("2026-10-09T06:00:00Z"), platformMeta: { displayPhoneNumber: "+972 55-777-3421", verifiedName: "gotcha", qualityRating: "GREEN" } },
      { id: "ca_2", externalId: "pn_2", displayName: "Old", connectionStatus: "ERROR", lastHealthCheck: null, platformMeta: null },
    ];
    const r = await request(app).get("/api/channels/whatsapp/numbers");
    expect(r.body.unprofiled[0]).toMatchObject({ phoneNumber: "+972 55-777-3421", verifiedName: "gotcha", qualityRating: "GREEN", lastHealthCheck: "2026-10-09T06:00:00.000Z", connectionStatus: "CONNECTED" });
    expect(r.body.unprofiled[1]).toMatchObject({ phoneNumber: null, verifiedName: null, qualityRating: null, lastHealthCheck: null, connectionStatus: "ERROR" });
  });
});

describe("★ refresh from Meta, for an unprofiled account (POST /numbers/:channelAccountId/refresh)", () => {
  const account = (o: any = {}) => ({ id: "ca_1", tenantId: "T", channel: "WHATSAPP", externalId: "pn_1", displayName: "Demo WhatsApp", connectionStatus: "CONNECTED", lastHealthCheck: null, platformMeta: { wabaId: "waba_1" }, credentials: encryptCredentials({ accessToken: "tok" }), ...o });
  const refresh = (id = "ca_1") => request(app).post(`/api/channels/whatsapp/numbers/${id}/refresh`);

  it("one Graph read, merged into platformMeta (nothing erased), last checked now, the fresh row back", async () => {
    H.accounts = [account()];
    const r = await refresh();
    expect(r.status).toBe(200);
    expect(H.graphReads).toBe(1);
    expect(r.body.data).toMatchObject({ channelAccountId: "ca_1", phoneNumber: "+972 52-540-1686", verifiedName: "GOTCHA Demo", qualityRating: "GREEN" });
    expect(Date.now() - Date.parse(r.body.data.lastHealthCheck)).toBeLessThan(5000);
    expect(H.accounts[0].platformMeta).toEqual({ wabaId: "waba_1", displayPhoneNumber: "+972 52-540-1686", verifiedName: "GOTCHA Demo", qualityRating: "GREEN" });
  });

  it("once a minute per account: the second call is 429 and reads nothing", async () => {
    H.accounts = [account(), account({ id: "ca_2", externalId: "pn_1" })];
    expect((await refresh()).status).toBe(200);
    const again = await refresh();
    expect(again.status).toBe(429);
    expect(again.headers["retry-after"]).toBe("60");
    expect(H.graphReads).toBe(1);
    expect((await refresh("ca_2")).status).toBe(200);
  });

  it("Meta not answering: 502, nothing written", async () => {
    H.accounts = [account()];
    H.detailsFail = true;
    const r = await refresh();
    expect(r.status).toBe(502);
    expect(H.writes).toEqual([]);
    expect(H.accounts[0].platformMeta).toEqual({ wabaId: "waba_1" });
  });

  it("another workspace's account, or one that is not WhatsApp: 404, no read", async () => {
    H.accounts = [account({ tenantId: "OTHER" }), account({ id: "ca_ig", channel: "INSTAGRAM" })];
    expect((await refresh("ca_1")).status).toBe(404);
    expect((await refresh("ca_ig")).status).toBe(404);
    expect(H.graphReads).toBe(0);
  });

  it("a profiled number's id still takes its own refresh path; its channel account id is not a second door", async () => {
    H.accounts = [account()];
    H.numbers = [{ id: "num_1", tenantId: "T", phoneNumberId: "pn_1" }];
    expect((await refresh("ca_1")).status).toBe(404);
    expect(H.graphReads).toBe(0);
  });
});


describe("★ a refused webhook subscription is PENDING with a code (2026-10-10)", () => {
  it("lastError carries SUBSCRIBE_FAILED, so a token check cannot erase it and v2 can name it", async () => {
    H.subscribeFails = true;
    const r = await connect();
    expect(r.status).toBe(201);
    expect(H.writes[0].data.connectionStatus).toBe("PENDING");
    expect(H.writes[0].data.lastError).toMatch(/^\[SUBSCRIBE_FAILED\] Webhook subscription failed/);
  });
});
