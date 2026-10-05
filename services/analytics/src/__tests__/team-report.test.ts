/**
 * GET /api/analytics/team - 06c, people and AI employees.
 *
 * Pinned: ownership attribution (assigned person / bound AI), the first-reply
 * gap measured to the right KIND of replier, resolved = CLOSED now, load per
 * day, SYSTEM_ADMIN left out by the query, test/sandbox excluded, and the
 * cards (people only, handed-back count, busiest hour).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DB = vi.hoisted(() => ({ users: [] as any[], ais: [] as any[], messages: [] as any[], handbacks: 0 }));

vi.mock("@chatcenter/shared", () => ({
  getRedis: () => ({}),
  prisma: {
    user: { findMany: async (a: any) => { if (!a.where?.tenantId) throw new Error("guard"); return DB.users.filter((u) => a.where.role.in.includes(u.role) && u.isActive); } },
    aIAgent: { findMany: async (a: any) => { if (!a.where?.tenantId) throw new Error("guard"); return DB.ais.filter((x) => a.where.status.in.includes(x.status)); } },
    message: {
      findMany: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("guard");
        return DB.messages
          .filter((m) => m.createdAt >= a.where.createdAt.gte && m.createdAt <= a.where.createdAt.lte && !m.conversation.isTest && !String(m.conversation.customerExternalId).startsWith("sandbox:"))
          .sort((x, y) => x.createdAt - y.createdAt);
      },
    },
    conversationHandover: { count: async () => DB.handbacks },
  },
}));

import { getTeamReport } from "../services/analytics.service";

const now = new Date();
const at = (dayAgo: number, h: number, min = 0) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayAgo, h, min));
const conv = (id: string, o: any = {}) => ({ id, status: "OPEN", assignedAgentId: null, assignedAiAgentId: null, isTest: false, customerExternalId: "972", ...o });
const msg = (c: any, direction: string, t: Date, ai = false) =>
  ({ conversationId: c.id, direction, createdAt: t, metadata: ai ? { source: "ai_bot" } : {}, conversation: c });

beforeEach(() => {
  DB.users = [
    { id: "u_admin", role: "ADMIN", isActive: true, name: "Dana" },
    { id: "u_agent", role: "AGENT", isActive: true, name: "Avi" },
    { id: "u_sys", role: "SYSTEM_ADMIN", isActive: true, name: "Ops" },
  ];
  DB.ais = [{ id: "ai_1", status: "ACTIVE", name: "Maya" }];
  const c1 = conv("c1", { assignedAgentId: "u_admin", status: "CLOSED" });
  const c2 = conv("c2", { assignedAiAgentId: "ai_1" });
  const ct = conv("ct", { assignedAgentId: "u_admin", isTest: true });
  DB.messages = [
    msg(c1, "INBOUND", at(1, 9, 0)),
    msg(c1, "OUTBOUND", at(1, 9, 1), true), // the AI's reply does not count as the person's
    msg(c1, "OUTBOUND", at(1, 9, 10)),      // the person: 10 min after the first message
    msg(c2, "INBOUND", at(0, 9, 0)),
    msg(c2, "OUTBOUND", at(0, 9, 0) && new Date(at(0, 9, 0).getTime() + 4000), true),
    msg(ct, "INBOUND", at(0, 9, 0)),
    msg(ct, "OUTBOUND", at(0, 9, 30)),
  ];
  DB.handbacks = 2;
});

describe("getTeamReport", () => {
  it("★ people (no SYSTEM_ADMIN) and the AI, each with what they handled", async () => {
    const r = await getTeamReport("T", 3);
    const by = Object.fromEntries(r.members.map((m) => [m.id, m]));
    expect(Object.keys(by).sort()).toEqual(["ai_1", "u_admin", "u_agent"]);
    expect(by.u_admin).toMatchObject({ kind: "human", handled: 1, firstReplyMedianMs: 600_000, resolvedRate: 1, loadByDay: [0, 1, 0] });
    expect(by.ai_1).toMatchObject({ kind: "ai", handled: 1, firstReplyMedianMs: 4000, resolvedRate: 0, loadByDay: [0, 0, 1] });
    expect(by.u_agent).toMatchObject({ handled: 0, firstReplyMedianMs: null, resolvedRate: null });
  });

  it("★ the cards: people only, test conversations excluded", async () => {
    const r = await getTeamReport("T", 3);
    expect(r.cards).toMatchObject({ handledByPeople: 1, firstReplyMedianMs: 600_000, resolvedRate: 1, handedBackToGotcha: 2, busiestHourUtc: 9 });
    expect(r.cards.inboundByHourUtc[9]).toBe(2);
  });
});
