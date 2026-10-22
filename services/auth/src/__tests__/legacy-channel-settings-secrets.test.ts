/**
 * ★ The legacy /api/agents/settings/channels routes never keep or return a
 * token in the clear (2026-10-10). POST stored the access token as plain JSON
 * and returned the whole row, credentials included; PATCH did both too.
 *   - the stored credentials are an encrypted string that does not contain
 *     the token
 *   - the response carries the row without credentials or any secret
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); publish = vi.fn(); subscribe = vi.fn(); async get() { return null; } async set() { return "OK"; } async del() { return 0; } } }));

const DB = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      channelAccount: {
        findFirst: async (a: any) => DB.rows.find((r) => Object.entries(a.where).every(([k, v]) => r[k] === v)) ?? null,
        create: async (a: any) => { const r = { id: "ca_1", createdAt: new Date(), updatedAt: new Date(), isActive: true, ...a.data }; DB.rows.push(r); return { ...r }; },
        update: async (a: any) => { const r = DB.rows.find((x) => x.id === a.where.id); Object.assign(r, a.data); return { ...r }; },
      },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    enforceMfaEnrollment: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
  };
});

import router from "../routes/agents";

const app = express();
app.use(express.json());
app.use("/api/agents", router);
const TOKEN = "EAAG-plain-access-token-123";

beforeEach(() => { DB.rows = []; });

describe("★ legacy channel settings keep and return no token in the clear", () => {
  it("POST: stored encrypted, answered without credentials", async () => {
    const r = await request(app).post("/api/agents/settings/channels")
      .send({ channel: "WHATSAPP", externalId: "pn_1", displayName: "Line", credentials: { accessToken: TOKEN, webhookSecret: "whs" } });
    expect(r.status).toBe(201);
    expect(typeof DB.rows[0].credentials).toBe("string");
    expect(DB.rows[0].credentials).not.toContain(TOKEN);
    const body = JSON.stringify(r.body);
    expect(body).not.toMatch(/credentials|accessToken|webhookSecret/i);
    expect(body).not.toContain(TOKEN);
    expect(r.body.data).toMatchObject({ id: "ca_1", displayName: "Line", externalId: "pn_1" });
  });

  it("PATCH: new credentials stored encrypted, answered without credentials", async () => {
    DB.rows.push({ id: "ca_1", tenantId: "T", channel: "WHATSAPP", externalId: "pn_1", displayName: "Line", credentials: "old" });
    const r = await request(app).patch("/api/agents/settings/channels/ca_1").send({ credentials: { accessToken: TOKEN }, displayName: "Renamed" });
    expect(r.status).toBe(200);
    expect(DB.rows[0].credentials).not.toContain(TOKEN);
    expect(JSON.stringify(r.body)).not.toMatch(/credentials|accessToken/i);
    expect(r.body.data.displayName).toBe("Renamed");
  });
});
