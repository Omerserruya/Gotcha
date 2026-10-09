/**
 * ★ GET /api/channels/state is for every member, but a channel's identifier
 * and its last error are for people who manage channels (2026-10-09 review):
 *   - channels:manage:read: identifier, lastError and lastErrorCode as stored
 *   - without it: the same rows and states, identifier and error null
 *   - the permission is asked for this reader in this workspace
 *   - a failing permission check reads as "without"
 *   - /summary stays counts for every member
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-0123456789abcdef";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); publish = vi.fn(); subscribe = vi.fn(); async get() { return null; } async set() { return "OK"; } async del() { return 0; } } }));

const H = vi.hoisted(() => ({ manages: false as boolean | "throw", asked: [] as any[] }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      channelAccount: {
        findMany: async () => [
          { id: "wa", channel: "WHATSAPP", displayName: "Demo WhatsApp", externalId: "1010938148762991", connectionStatus: "ERROR", isActive: true, platformMeta: {}, lastError: "[SHOPIFY_APP_UNINSTALLED] Token is invalid", createdAt: new Date() },
        ],
      },
    },
    getRedis: () => ({ get: async () => null, set: async () => "OK", del: async () => 0 }),
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "AGENT", departmentRole: "AGENT" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    hasPermission: async (p: any, key: string) => { H.asked.push({ p, key }); if (H.manages === "throw") throw new Error("db down"); return H.manages; },
  };
});

import router from "../routes/channels";

const app = express();
app.use(express.json());
app.use("/api/channels", router);
const state = async () => (await request(app).get("/api/channels/state")).body.data[0];

beforeEach(() => { H.manages = false; H.asked = []; });

describe("★ /channels/state: identifier and error only for channel managers", () => {
  it("channels:manage:read: as stored", async () => {
    H.manages = true;
    expect(await state()).toMatchObject({ identifier: "1010938148762991", lastError: "Token is invalid", lastErrorCode: "SHOPIFY_APP_UNINSTALLED", connectionStatus: "ERROR", displayName: "Demo WhatsApp" });
  });

  it("without it: the same row and state, identifier and error null", async () => {
    expect(await state()).toMatchObject({ id: "wa", channel: "WHATSAPP", displayName: "Demo WhatsApp", connectionStatus: "ERROR", identifier: null, lastError: null, lastErrorCode: null });
  });

  it("asked for this reader in this workspace, for exactly that permission", async () => {
    await state();
    expect(H.asked).toEqual([{ p: { userId: "u1", tenantId: "T", role: "AGENT", departmentRole: "AGENT" }, key: "channels:manage:read" }]);
  });

  it("a failing check reads as without", async () => {
    H.manages = "throw";
    const r = await request(app).get("/api/channels/state");
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ identifier: null, lastError: null });
  });

  it("/summary stays counts for every member", async () => {
    const r = await request(app).get("/api/channels/summary");
    expect(r.body.data).toEqual({ total: 1, connected: 0, unhealthy: 1, pending: 0 });
  });
});
