/**
 * The voice call transcript, through the tenant guard.
 *
 * ★ THIS ROUTE HAS NEVER WORKED. `Message` has been tenant-guarded since
 * 2026-04-15 (b8a9f493) and `GET /:id/transcript` was written on 2026-05-12
 * (d2433aab). Its `message.findMany` carried no `tenantId`, the guard refused
 * it, and the catch turned that into `500 failed_to_load_transcript` - from the
 * day it was written.
 *
 * ★★ AND IT DID NOT SHOW, BECAUSE ALMOST NOBODY CAN REACH IT. Every route here
 * sits behind `voiceCopilotGate`, which 404s any tenant whose
 * `voiceCopilotEnabled` is false - the default for every production tenant
 * during the rollout (1 of 13 in dev). So the failure is not a live outage; it
 * is a landmine on the rollout path, and it goes off the day the feature is
 * switched on.
 *
 * The message fake below refuses a missing tenantId exactly as the guard does,
 * so this test reproduces the 500 rather than approving a route the guard would
 * reject.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  voiceEnabled: true,
  sessions: [] as any[],
  messages: [] as any[],
  seenMessageWhere: null as any,
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    tenant: { findUnique: async () => ({ voiceCopilotEnabled: state.voiceEnabled }) },
    voiceCallSession: {
      findUnique: async ({ where }: any) => state.sessions.find((s) => s.id === where.id) ?? null,
    },
    message: {
      findMany: async ({ where }: any) => {
        state.seenMessageWhere = where;
        if (!where || where.tenantId === undefined) {
          throw new Error("[TenantGuard] Message.findMany blocked: where clause is missing tenantId.");
        }
        return state.messages.filter(
          (m) => m.tenantId === where.tenantId && m.conversationId === where.conversationId && m.channel === where.channel,
        );
      },
    },
  },
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "AGENT" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  getInternalServiceKey: () => "test-key",
  validateE164: () => true,
  claimIncomingCall: async () => null,
  transitionVoiceCallSessionState: async () => null,
  fromLegacyStatus: (s: any) => s,
  LIVE_STATES: [],
  markOnline: async () => undefined,
  heartbeat: async () => undefined,
}));
vi.mock("../services/conversation.service", () => ({ getHistoryByCustomerExternalId: async () => [] }));

import voiceRouter from "../routes/voice-sessions";

const app = express();
app.use(express.json());
app.use("/api/voice-sessions", voiceRouter);

beforeEach(() => {
  state.voiceEnabled = true;
  state.sessions = [{ id: "vs1", tenantId: "t1", conversationId: "conv1" }];
  state.messages = [
    { id: "m1", tenantId: "t1", conversationId: "conv1", channel: "VOICE", direction: "INBOUND", body: "Hi", messageType: "text", senderName: "Caller", createdAt: new Date(), metadata: null },
    { id: "m2", tenantId: "t1", conversationId: "conv1", channel: "VOICE", direction: "OUTBOUND", body: "Hello", messageType: "text", senderName: "Agent", createdAt: new Date(), metadata: null },
  ];
  state.seenMessageWhere = null;
});

describe("GET /api/voice-sessions/:id/transcript", () => {
  it("★ loads, instead of the 500 it returned since it was written", async () => {
    const res = await request(app).get("/api/voice-sessions/vs1/transcript");
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: any) => m.id)).toEqual(["m1", "m2"]);
  });

  it("★ carries tenantId in the WHERE, which is what the guard requires", async () => {
    // Asserted on the clause, not just the rows: a fake that ignored the where
    // would return these rows whether or not the route scoped its query.
    await request(app).get("/api/voice-sessions/vs1/transcript");
    expect(state.seenMessageWhere).toEqual({ tenantId: "t1", conversationId: "conv1", channel: "VOICE" });
  });

  it("still 404s another tenant's session before reaching the query", async () => {
    state.sessions = [{ id: "vs1", tenantId: "t2", conversationId: "conv1" }];
    const res = await request(app).get("/api/voice-sessions/vs1/transcript");
    expect(res.status).toBe(404);
    expect(state.seenMessageWhere).toBeNull();
  });

  it("404s for a tenant without Voice Copilot - which is why the bug never showed", async () => {
    state.voiceEnabled = false;
    const res = await request(app).get("/api/voice-sessions/vs1/transcript");
    expect(res.status).toBe(404);
    expect(state.seenMessageWhere).toBeNull();
  });
});
