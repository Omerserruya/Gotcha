/**
 * ★ A channel's error carries a machine code beside its sentence (twin of the
 * assistant's lib/error-code): GET /api/channels (with and without a window)
 * and GET /api/channels/state serve { lastError: sentence, lastErrorCode }.
 * A row written before the codes is recognised by its exact old sentence; any
 * other error keeps its text and has no code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.SLACK_CLIENT_ID = "";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-0123456789abcdef";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); publish = vi.fn(); subscribe = vi.fn(); async get() { return null; } async set() { return "OK"; } async del() { return 0; } } }));

const H = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      channelAccount: { findMany: async () => H.rows.map((r) => ({ ...r })) },
      conversation: { groupBy: async () => [] },
    },
    getRedis: () => ({ get: async () => null, set: async () => "OK", del: async () => 0 }),
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
    validate: () => (_q: any, _s: any, n: any) => n(),
  };
});

import router from "../routes/channels";

const app = express();
app.use(express.json());
app.use("/api/channels", router);

const row = (id: string, lastError: string | null) => ({ id, channel: "SHOPIFY_LIVE_CHAT", externalId: id, displayName: id, isActive: false, connectionStatus: "DISCONNECTED", connectedAt: null, tokenExpiresAt: null, lastError, lastHealthCheck: null, platformMeta: {}, createdAt: new Date(), updatedAt: new Date(), _count: { conversations: 0 } });

beforeEach(() => {
  H.rows = [
    row("coded", "[SHOPIFY_CHAT_UNINSTALLED] Shopify Chat app was uninstalled from the store."),
    row("legacy", "Shopify Chat app was uninstalled from the store."),
    row("other", "Token is invalid or expired"),
    row("fine", null),
  ];
});

const EXPECTED = {
  coded: { lastError: "Shopify Chat app was uninstalled from the store.", lastErrorCode: "SHOPIFY_CHAT_UNINSTALLED" },
  legacy: { lastError: "Shopify Chat app was uninstalled from the store.", lastErrorCode: "SHOPIFY_CHAT_UNINSTALLED" },
  other: { lastError: "Token is invalid or expired", lastErrorCode: null },
  fine: { lastError: null, lastErrorCode: null },
};
const pick = (data: any[]) => Object.fromEntries(data.map((d) => [d.id, { lastError: d.lastError, lastErrorCode: d.lastErrorCode }]));

describe("★ a channel's error code, served apart from its sentence", () => {
  it("the channel list, without and with a window", async () => {
    expect(pick((await request(app).get("/api/channels")).body.data)).toEqual(EXPECTED);
    expect(pick((await request(app).get("/api/channels").query({ from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" })).body.data)).toEqual(EXPECTED);
  });

  it("the channel state", async () => {
    expect(pick((await request(app).get("/api/channels/state")).body.data)).toEqual(EXPECTED);
  });
});
