/**
 * POST /api/conversations/:id/stop-ai - stop the AI without assigning anyone.
 *
 * The bot skips a conversation that is handed over (isHandedOver) or assigned.
 * Until now the latch was set only by claim (which assigns the clicker) or by
 * escalation. stop-ai sets it with nobody assigned, records the handover, and
 * posts an "ai_stopped" system message; return-to-ai undoes it. The REAL
 * recordHandover runs against an in-memory conversation table.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const DB = vi.hoisted(() => ({ convs: new Map<string, any>(), handovers: [] as any[], messages: [] as any[] }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const conversation = {
    findFirst: async (a: any) => {
      const c = DB.convs.get(a.where.id);
      return c && c.tenantId === a.where.tenantId ? { ...c } : null;
    },
    findUniqueOrThrow: async (a: any) => ({ ...DB.convs.get(a.where.id), assignedAgent: null }),
    update: async (a: any) => { Object.assign(DB.convs.get(a.where.id), a.data); return DB.convs.get(a.where.id); },
  };
  const prisma: any = {
    conversation,
    conversationHandover: { create: async (a: any) => { DB.handovers.push(a.data); return { id: "h1", at: new Date(), ...a.data }; } },
    message: { create: async (a: any) => { DB.messages.push(a.data); return { id: "m1", ...a.data }; } },
  };
  prisma.$transaction = async (fn: any) => fn(prisma);
  return {
    ...actual,
    prisma,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "agent_1", role: "AGENT" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    // The real one reaches the shared package's own prisma client; this is the
    // same contract (move handler, apply data, record the move) on this table.
    recordHandover: async (input: any) => {
      const c = DB.convs.get(input.conversationId);
      if (!c || c.tenantId !== input.tenantId) return null;
      const from = c.handledBy;
      Object.assign(c, input.data ?? {}, { handledBy: input.to });
      if (from === input.to) return null;
      const row = { from, to: input.to, reason: input.reason, actorUserId: input.actorUserId ?? null };
      DB.handovers.push(row);
      return { id: "h1", at: new Date(), ...row };
    },
    getRedis: () => ({ get: async () => null, set: async () => "OK", del: async () => 0, publish: async () => 0 }),
    publishEvent: async () => undefined,
  };
});
vi.mock("../services/message.service", () => ({
  create: async (d: any) => { DB.messages.push(d); return { id: "m1", ...d }; },
}));
vi.mock("../lib/socket", () => ({ emitToTenant: () => undefined, emitToConversation: () => undefined }));

import router from "../routes/conversations";

const app = express();
app.use(express.json());
app.use("/api/conversations", router);

beforeEach(() => {
  DB.convs.clear(); DB.handovers = []; DB.messages = [];
  DB.convs.set("c1", { id: "c1", tenantId: "T", status: "OPEN", handledBy: "ai_agent", isHandedOver: false, assignedAgentId: null, assignedAiAgentId: "ai_1" });
});

describe("stop-ai", () => {
  it("★ hands over to a human with NOBODY assigned, records it, and says so in the thread", async () => {
    const r = await request(app).post("/api/conversations/c1/stop-ai");
    expect(r.status).toBe(200);
    expect(DB.convs.get("c1")).toMatchObject({ isHandedOver: true, handledBy: "human", assignedAgentId: null, status: "OPEN" });
    expect(DB.handovers[0]).toMatchObject({ from: "ai_agent", to: "human", reason: "ai_stopped", actorUserId: "agent_1" });
    expect(DB.messages.some((m) => m.metadata?.systemEvent === "ai_stopped")).toBe(true);
  });

  it("★ return-to-ai restores it", async () => {
    await request(app).post("/api/conversations/c1/stop-ai");
    const r = await request(app).post("/api/conversations/c1/return-to-ai");
    expect(r.status).toBe(200);
    expect(DB.convs.get("c1")).toMatchObject({ isHandedOver: false, handledBy: "ai_agent", assignedAgentId: null });
  });

  it("another tenant's conversation is a 404 and nothing changes", async () => {
    DB.convs.get("c1").tenantId = "OTHER";
    const r = await request(app).post("/api/conversations/c1/stop-ai");
    expect(r.status).toBe(404);
    expect(DB.convs.get("c1").isHandedOver).toBe(false);
  });
});
