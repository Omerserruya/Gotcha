/**
 * Voice sessions apply the inbox visibility rule (2026-10-09). A call is a
 * conversation: for a department-restricted agent, a call on a conversation
 * they may not see is a 404 identical to a missing one on every by-id route
 * (including /missed/:id/*), is absent from history, the summary, /active and
 * /missed, is not cleared by "mark as handled", and cannot be the target of an
 * outbound call. ADMIN behaves exactly as before.
 *
 * Through the real router. The prisma doubles honour the where they are given,
 * including the `conversation` relation filter (joined to the conversation
 * rows), so a dropped filter is caught.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  viewer: { userId: "admin1", role: "ADMIN", departmentId: undefined as string | undefined },
  convs: [] as any[],
  sessions: [] as any[],
  messageQueries: 0,
  claims: [] as string[],
  fetches: [] as any[],
  seenListWhere: null as any,
}));

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (k === "conversation") {
      const conv = H.convs.find((c) => c.id === row.conversationId);
      return !!conv && matches(conv, v);
    }
    if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
    if (v && typeof v === "object" && "not" in v) return (row[k] ?? null) !== v.not;
    return (row[k] ?? null) === v;
  });
}
const tenantGuard = (m: string, w: any) => { if (!w?.tenantId) throw new Error(`tenant guard: ${m}`); };

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    tenant: { findUnique: async () => ({ voiceCopilotEnabled: true }) },
    voiceCallSession: {
      findUnique: async ({ where }: any) => H.sessions.find((s) => s.id === where.id) ?? null,
      findFirst: async ({ where }: any) => { tenantGuard("voiceCallSession", where); return H.sessions.find((s) => matches(s, where)) ?? null; },
      findMany: async ({ where, take }: any) => {
        tenantGuard("voiceCallSession", where);
        H.seenListWhere = where;
        return H.sessions.filter((s) => matches(s, where)).slice(0, take ?? 1e9).map((s) => ({ ...s }));
      },
      count: async ({ where }: any) => H.sessions.filter((s) => matches(s, where)).length,
      groupBy: async ({ by, where }: any) => {
        const groups = new Map<string, any>();
        for (const s of H.sessions.filter((x) => matches(x, where))) {
          const key = String(s[by[0]]);
          const g = groups.get(key) ?? { [by[0]]: s[by[0]], _count: { _all: 0 } };
          g._count._all++;
          groups.set(key, g);
        }
        return [...groups.values()];
      },
      aggregate: async ({ where }: any) => {
        const rows = H.sessions.filter((s) => matches(s, where) && s.durationMs != null);
        return { _avg: { durationMs: rows.length ? rows.reduce((a, s) => a + s.durationMs, 0) / rows.length : null }, _count: { durationMs: rows.length } };
      },
      updateMany: async ({ where, data }: any) => {
        tenantGuard("voiceCallSession", where);
        const rows = H.sessions.filter((s) => matches(s, where));
        rows.forEach((s) => Object.assign(s, data));
        return { count: rows.length };
      },
    },
    conversation: {
      findFirst: async ({ where }: any) => { tenantGuard("conversation", where); return H.convs.find((c) => matches(c, where)) ?? null; },
    },
    message: { findMany: async ({ where }: any) => { tenantGuard("message", where); H.messageQueries++; return []; } },
    contact: { findMany: async () => [], findFirst: async () => null },
    customerBrief: { findFirst: async () => null },
    communicationChannel: {
      findFirst: async () => ({ id: "ch1", tenantId: "T", voiceChannel: { outboundMode: "AGENT_FIRST", openWorkspaceOnAgentFirst: true } }),
    },
  },
  authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.viewer }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  getInternalServiceKey: () => "test-key",
  validateE164: (to: string) => ({ ok: true, normalized: to }),
  claimIncomingCall: async (id: string) => { H.claims.push(id); return { ok: true, session: { id } }; },
  transitionVoiceCallSessionState: async () => ({ ok: true, session: {} }),
  fromLegacyStatus: (s: any) => s,
  LIVE_STATES: new Set(["ACTIVE"]),
  markOnline: async () => undefined,
  heartbeat: async () => undefined,
}));
vi.mock("../services/conversation.service", () => ({ getHistoryByCustomerExternalId: async () => [] }));

import voiceRouter from "../routes/voice-sessions";

const app = express();
app.use(express.json());
app.use("/api/voice-sessions", voiceRouter);

const session = (id: string, conversationId: string, over: Record<string, unknown> = {}) => ({
  id, tenantId: "T", conversationId, callSid: `CA_${id}`, direction: "inbound", status: "completed",
  state: "ENDED", customerNumber: "+9725", startedAt: new Date(), durationMs: 60000, handledAt: null,
  channelId: "ch1", assignedAgentId: null, ...over,
});

beforeEach(() => {
  H.viewer = { userId: "admin1", role: "ADMIN", departmentId: undefined };
  H.messageQueries = 0;
  H.claims = [];
  H.fetches = [];
  H.seenListWhere = null;
  H.convs = [
    { id: "c_sales", tenantId: "T", departmentId: "sales", assignedAgentId: null },
    { id: "c_support", tenantId: "T", departmentId: "support", assignedAgentId: null },
    { id: "c_sales_missed", tenantId: "T", departmentId: "sales", assignedAgentId: null },
    { id: "c_support_missed", tenantId: "T", departmentId: "support", assignedAgentId: null },
    { id: "c_support_ring", tenantId: "T", departmentId: "support", assignedAgentId: null },
  ];
  H.sessions = [
    session("vs_sales", "c_sales"),
    session("vs_support", "c_support", { durationMs: 1000 }),
    session("vs_sales_missed", "c_sales_missed", { state: "MISSED", status: "no-answer", durationMs: null }),
    session("vs_support_missed", "c_support_missed", { state: "MISSED", status: "no-answer", durationMs: null }),
    session("vs_support_ring", "c_support_ring", { state: "RINGING", status: "ringing", durationMs: null }),
  ];
  global.fetch = (async (url: any, init: any) => {
    H.fetches.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { sessionId: "new", conversationId: "minted" } }) } as any;
  }) as any;
});
const agentOfSales = () => { H.viewer = { userId: "agent1", role: "AGENT", departmentId: "sales" }; };

describe("a call by id", () => {
  it("★ another department's call is 404, identical to a missing one", async () => {
    agentOfSales();
    const hidden = await request(app).get("/api/voice-sessions/vs_support");
    const missing = await request(app).get("/api/voice-sessions/nope");
    expect(hidden.status).toBe(404);
    expect([hidden.status, hidden.body]).toEqual([missing.status, missing.body]);
    expect(JSON.stringify(hidden.body)).not.toContain("CA_vs_support");
  });

  it("★ its transcript is 404 and never queried", async () => {
    agentOfSales();
    const r = await request(app).get("/api/voice-sessions/vs_support/transcript");
    expect(r.status).toBe(404);
    expect(H.messageQueries).toBe(0);
  });

  it("★ the /missed/:id routes are covered too: detail is 404", async () => {
    agentOfSales();
    const r = await request(app).get("/api/voice-sessions/missed/vs_support_missed/detail");
    expect(r.status).toBe(404);
  });

  it("★ a hidden ringing call cannot be answered", async () => {
    agentOfSales();
    const r = await request(app).post("/api/voice-sessions/vs_support_ring/answer");
    expect(r.status).toBe(404);
    expect(H.claims).toEqual([]);
  });

  it("the agent's own department's call opens", async () => {
    agentOfSales();
    const r = await request(app).get("/api/voice-sessions/vs_sales");
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe("vs_sales");
    expect((await request(app).get("/api/voice-sessions/vs_sales/transcript")).status).toBe(200);
  });

  it("an ADMIN opens any call in the tenant", async () => {
    const r = await request(app).get("/api/voice-sessions/vs_support");
    expect(r.status).toBe(200);
    expect((await request(app).post("/api/voice-sessions/vs_support_ring/answer")).status).toBe(200);
  });
});

describe("the lists and counts", () => {
  it("★ history lists only calls on conversations the agent may see", async () => {
    agentOfSales();
    const r = await request(app).get("/api/voice-sessions");
    expect(r.body.data.map((s: any) => s.id).sort()).toEqual(["vs_sales", "vs_sales_missed"]);
  });

  it("★ the summary counts what the list shows", async () => {
    agentOfSales();
    const r = await request(app).get("/api/voice-sessions/summary");
    expect(r.body.data.total).toBe(2);
    // Support's 1s call is not in the average.
    expect(r.body.data.averageDurationMs).toBe(60000);
    expect(r.body.data.durationSampleSize).toBe(1);
  });

  it("★ /active and /missed leave hidden calls out", async () => {
    agentOfSales();
    const active = await request(app).get("/api/voice-sessions/active");
    const missed = await request(app).get("/api/voice-sessions/missed");
    expect(active.body.data).toEqual([]);
    expect(missed.body.data.map((s: any) => s.id)).toEqual(["vs_sales_missed"]);
  });

  it("an ADMIN's lists and where are exactly as before", async () => {
    const r = await request(app).get("/api/voice-sessions");
    expect(r.body.data).toHaveLength(5);
    expect(H.seenListWhere).toEqual({ tenantId: "T" });
    expect((await request(app).get("/api/voice-sessions/active")).body.data.map((s: any) => s.id)).toEqual(["vs_support_ring"]);
    expect((await request(app).get("/api/voice-sessions/summary")).body.data.total).toBe(5);
  });
});

describe("writes", () => {
  it("★ mark-as-handled clears only the missed calls the agent may see from that number", async () => {
    agentOfSales();
    const r = await request(app).post("/api/voice-sessions/missed/vs_sales_missed/handle");
    expect(r.status).toBe(200);
    expect(r.body.data.handledCount).toBe(1);
    expect(H.sessions.find((s) => s.id === "vs_sales_missed").handledAt).not.toBeNull();
    expect(H.sessions.find((s) => s.id === "vs_support_missed").handledAt).toBeNull();
  });

  it("an ADMIN's mark-as-handled still cascades across the number", async () => {
    const r = await request(app).post("/api/voice-sessions/missed/vs_sales_missed/handle");
    expect(r.body.data.handledCount).toBe(2);
  });

  it("★ an outbound call names a hidden conversation: dropped like an unknown id", async () => {
    agentOfSales();
    await request(app).post("/api/voice-sessions/start-outbound").send({ to: "+9725", conversationId: "c_support" });
    expect(H.fetches[0].body.conversationId).toBeUndefined();
    await request(app).post("/api/voice-sessions/start-outbound").send({ to: "+9725", conversationId: "c_sales" });
    expect(H.fetches[1].body.conversationId).toBe("c_sales");
  });
});
