/**
 * ★ The numbers contract for a tenant with several WABAs (2026-10-29).
 *   - GET /numbers: every row says which business account it is on
 *     (wabaId, wabaName, businessPortfolioId, businessName, from what signup
 *     stored) and whether it is the primary; the top level says which and why
 *   - PATCH /primary: choose or clear; 404 / 409 for a number that is not this
 *     tenant's or cannot send; a body that is not { channelAccountId } is a 400
 *   - DELETE /numbers/:id of the primary: the choice is dropped and the
 *     response names the next one
 *   - signup stores the WABA and portfolio names, merged over the row
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } async del() { return 0; } } }));

const H = vi.hoisted(() => ({ settings: new Map<string, string>(), accounts: [] as any[], numbers: [] as any[], disconnected: [] as string[] }));

// The settings store the primary lives in, replaced by a map.
vi.mock("../../../../packages/shared/src/lib/durable-settings", () => ({
  readDurableSetting: async (t: string, k: string) => H.settings.get(`${t}:${k}`) ?? null,
  writeDurableSetting: async (t: string, k: string, v: string | null) => {
    if (v === null) H.settings.delete(`${t}:${k}`);
    else H.settings.set(`${t}:${k}`, v);
  },
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
}));

const pick = (r: any, select?: any) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r);
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      channelAccount: {
        findMany: async (a: any) => H.accounts.filter((r) => r.tenantId === a.where.tenantId && r.channel === a.where.channel).map((r) => pick(r, a.select)),
        // Every equality in where, ordered by connectedAt when asked.
        findFirst: async (a: any) => {
          const hits = H.accounts.filter((r) => Object.entries(a.where).every(([k, v]) => r[k] === v));
          if (a.orderBy) hits.sort((x, y) => x.connectedAt - y.connectedAt);
          return hits[0] ? pick(hits[0], a.select) : null;
        },
      },
      whatsAppNumber: {
        findMany: async (a: any) => H.numbers.filter((n) => n.tenantId === a.where.tenantId),
        findFirst: async (a: any) => {
          const n = H.numbers.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId);
          return n ? pick(n, a.select) : null;
        },
      },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../services/whatsapp/health.service", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  disconnectNumber: async (id: string, tenantId: string) => {
    const n = H.numbers.find((x) => x.id === id && x.tenantId === tenantId);
    if (!n) return { succeeded: false, message: "That number is not connected here.", webhooksPreserved: false };
    H.disconnected.push(id);
    H.numbers = H.numbers.filter((x) => x !== n);
    H.accounts = H.accounts.filter((a) => a.id !== n.channelAccountId);
    return { succeeded: true, message: "Disconnected.", webhooksPreserved: false };
  },
}));

import { encryptCredentials } from "@chatcenter/shared";
import whatsappRouter from "../routes/whatsapp-numbers";
import { signupMeta } from "../services/whatsapp/onboarding.service";

const app = express();
app.use(express.json());
app.use("/api/channels/whatsapp", whatsappRouter);

const KEY = "T:whatsappPrimaryChannelAccountId";
const account = (id: string, o: Record<string, unknown> = {}) => ({
  id, tenantId: "T", channel: "WHATSAPP", isActive: true, connectionStatus: "CONNECTED", externalId: `pn_${id}`,
  displayName: id, lastHealthCheck: null, credentials: {}, platformMeta: null, connectedAt: 0, ...o,
});
const number = (id: string, channelAccountId: string, o: Record<string, unknown> = {}) => ({
  id, tenantId: "T", channelAccountId, phoneNumberId: `pn_${channelAccountId}`, wabaId: "waba_x", businessPortfolioId: null,
  displayPhoneNumber: "+972 50-000-0000", verifiedName: "Shop", state: "ACTIVE", pendingAction: null, onboardingFlow: "NEW_NUMBER",
  isOnBizApp: false, qualityRating: "GREEN", throughputLevel: null, connectedAt: null, createdAt: new Date(), ...o,
});
const list = async () => (await request(app).get("/api/channels/whatsapp/numbers")).body;

beforeEach(() => {
  H.settings.clear();
  H.disconnected = [];
  // Two WABAs: ca_a (connected second) on waba_1 with names, ca_b (connected first) on waba_2 without.
  H.accounts = [
    account("ca_a", { connectedAt: 2, platformMeta: { wabaId: "waba_1", wabaName: "Shop North", businessPortfolioId: "bp_1", businessName: "North Ltd" } }),
    account("ca_b", { connectedAt: 1, platformMeta: { wabaId: "waba_2", businessPortfolioId: "bp_2" } }),
    // Legacy: no lifecycle row; its WABA only in the encrypted credentials.
    account("ca_l", { connectedAt: 3, platformMeta: { displayPhoneNumber: "+972 52-111-1111" }, credentials: encryptCredentials({ accessToken: "tok", wabaId: "waba_legacy" }) }),
    account("ca_other", { tenantId: "OTHER", connectedAt: 0 }),
  ];
  H.numbers = [
    number("n_a", "ca_a", { wabaId: "waba_1", businessPortfolioId: "bp_1" }),
    number("n_b", "ca_b", { wabaId: "waba_2", businessPortfolioId: null }),
  ];
});

describe("GET /numbers: the WABA on every row, and the primary", () => {
  it("profiled rows carry the WABA and names signup stored; no Meta call", async () => {
    const body = await list();
    const by = Object.fromEntries(body.data.map((r: any) => [r.channelAccountId, [r.wabaId, r.wabaName, r.businessPortfolioId, r.businessName]]));
    expect(by).toEqual({
      ca_a: ["waba_1", "Shop North", "bp_1", "North Ltd"],
      ca_b: ["waba_2", null, "bp_2", null],
    });
  });

  it("an unprofiled row reads its WABA from the credentials when platformMeta has none, and never ships them", async () => {
    const legacy = (await list()).unprofiled;
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ channelAccountId: "ca_l", wabaId: "waba_legacy", wabaName: null, businessName: null, isPrimary: false });
    expect(legacy[0]).not.toHaveProperty("credentials");
    expect(legacy[0]).not.toHaveProperty("platformMeta");
  });

  it("default primary: the first connected by connectedAt, flagged on exactly one row", async () => {
    const body = await list();
    expect(body.primary).toEqual({ channelAccountId: "ca_b", source: "default" });
    const flagged = [...body.data, ...body.unprofiled].filter((r: any) => r.isPrimary).map((r: any) => r.channelAccountId);
    expect(flagged).toEqual(["ca_b"]);
  });
});

describe("PATCH /primary", () => {
  const patch = (body: unknown) => request(app).patch("/api/channels/whatsapp/primary").send(body as any);

  it("chooses a number; the list then shows it", async () => {
    const r = await patch({ channelAccountId: "ca_a" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ channelAccountId: "ca_a", source: "chosen" });
    const body = await list();
    expect(body.primary).toEqual({ channelAccountId: "ca_a", source: "chosen" });
    expect(body.data.find((x: any) => x.channelAccountId === "ca_a").isPrimary).toBe(true);
    expect(body.data.find((x: any) => x.channelAccountId === "ca_b").isPrimary).toBe(false);
  });

  it("a legacy (unprofiled) number can be the primary too", async () => {
    expect((await patch({ channelAccountId: "ca_l" })).body.data).toEqual({ channelAccountId: "ca_l", source: "chosen" });
    expect((await list()).unprofiled[0].isPrimary).toBe(true);
  });

  it("null clears the choice, back to the default", async () => {
    await patch({ channelAccountId: "ca_a" });
    const r = await patch({ channelAccountId: null });
    expect(r.body.data).toEqual({ channelAccountId: "ca_b", source: "default" });
    expect(H.settings.has(KEY)).toBe(false);
  });

  it.each([
    ["another tenant's number", "ca_other"],
    ["an unknown id", "nope"],
  ])("404 WHATSAPP_NUMBER_NOT_FOUND for %s, nothing stored", async (_n, id) => {
    const r = await patch({ channelAccountId: id });
    expect([r.status, r.body.code]).toEqual([404, "WHATSAPP_NUMBER_NOT_FOUND"]);
    expect(H.settings.size).toBe(0);
  });

  it("409 WHATSAPP_NUMBER_NOT_ACTIVE for a disconnected number, nothing stored", async () => {
    H.accounts[0].isActive = false;
    H.accounts[0].connectionStatus = "DISCONNECTED";
    const r = await patch({ channelAccountId: "ca_a" });
    expect([r.status, r.body.code]).toEqual([409, "WHATSAPP_NUMBER_NOT_ACTIVE"]);
    expect(H.settings.size).toBe(0);
  });

  it.each([[{}], [{ channelAccountId: "" }], [{ channelAccountId: 5 }]])("400 for %j", async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(H.settings.size).toBe(0);
  });
});

describe("DELETE /numbers/:id of the primary", () => {
  it("drops the choice and names the next by connectedAt", async () => {
    await request(app).patch("/api/channels/whatsapp/primary").send({ channelAccountId: "ca_b" });
    const r = await request(app).delete("/api/channels/whatsapp/numbers/n_b");
    expect(r.status).toBe(200);
    expect(r.body.primary).toEqual({ channelAccountId: "ca_a", source: "default" });
    expect(H.settings.has(KEY)).toBe(false);
  });

  it("removing another number keeps the choice", async () => {
    await request(app).patch("/api/channels/whatsapp/primary").send({ channelAccountId: "ca_a" });
    const r = await request(app).delete("/api/channels/whatsapp/numbers/n_b");
    expect(r.body.primary).toEqual({ channelAccountId: "ca_a", source: "chosen" });
  });

  it("an unknown number is still a 404", async () => {
    const r = await request(app).delete("/api/channels/whatsapp/numbers/n_zzz");
    expect([r.status, r.body.code]).toEqual([404, "NUMBER_NOT_FOUND"]);
  });
});

describe("signup stores the names, merged over the row", () => {
  it("names from the inspection beside the WABA; what the row held stays", () => {
    expect(signupMeta({ displayPhoneNumber: "+972 50", historyImport: "done" }, { wabaId: "w1", businessPortfolioId: "bp", wabaName: "Shop North", businessName: "North Ltd" }))
      .toEqual({ displayPhoneNumber: "+972 50", historyImport: "done", wabaId: "w1", businessPortfolioId: "bp", wabaName: "Shop North", businessName: "North Ltd" });
  });
  it("a name Meta did not give this time leaves the stored one", () => {
    expect(signupMeta({ wabaName: "Old name" }, { wabaId: "w1" })).toMatchObject({ wabaId: "w1", wabaName: "Old name" });
  });
});
