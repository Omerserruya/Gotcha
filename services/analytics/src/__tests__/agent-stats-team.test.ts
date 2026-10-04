/**
 * GET /api/analytics/agents - who is on the team.
 *
 * It selected `role: "AGENT"` only, and no dev tenant has an AGENT, so the
 * team was empty in every tenant. Decided: ADMIN and AGENT count, SYSTEM_ADMIN
 * (the platform operator) does not, and AI employees are listed with
 * `kind: "ai"` and null - not 0 - for the two human-only figures.
 *
 * Two tenants, every role in each, plus an inactive user and a DRAFT AI. The
 * fake evaluates `where` the way the database would and REFUSES a tenant-less
 * bulk query the way the shared Prisma guard does, so a filter that loses
 * its tenant scope fails here instead of passing quietly.
 */
import { describe, it, expect, vi } from "vitest";

const db = vi.hoisted(() => ({
  users: [
    { id: "a-admin", tenantId: "A", role: "ADMIN", isActive: true, name: "Ada", email: "ada@a" },
    { id: "a-agent", tenantId: "A", role: "AGENT", isActive: true, name: "Avi", email: "avi@a" },
    { id: "a-sys", tenantId: "A", role: "SYSTEM_ADMIN", isActive: true, name: "Ops", email: "ops@a" },
    { id: "a-gone", tenantId: "A", role: "AGENT", isActive: false, name: "Gone", email: "gone@a" },
    { id: "b-admin", tenantId: "B", role: "ADMIN", isActive: true, name: "Bea", email: "bea@b" },
    { id: "b-agent", tenantId: "B", role: "AGENT", isActive: true, name: "Ben", email: "ben@b" },
  ],
  ai: [
    { id: "ai-maya", tenantId: "A", status: "ACTIVE", name: "Maya", createdAt: 1 },
    { id: "ai-paused", tenantId: "A", status: "PAUSED", name: "Noa", createdAt: 2 },
    { id: "ai-draft", tenantId: "A", status: "DRAFT", name: "Draft", createdAt: 3 },
    { id: "ai-b", tenantId: "B", status: "ACTIVE", name: "Bot B", createdAt: 1 },
  ],
  conversations: [
    { tenantId: "A", assignedAiAgentId: "ai-maya", status: "OPEN", isTest: false, customerExternalId: "972500000001" },
    { tenantId: "A", assignedAiAgentId: "ai-maya", status: "WAITING", isTest: false, customerExternalId: "972500000002" },
    { tenantId: "A", assignedAiAgentId: "ai-maya", status: "CLOSED", isTest: false, customerExternalId: "972500000003" },
    { tenantId: "A", assignedAiAgentId: "ai-maya", status: "OPEN", isTest: true, customerExternalId: "972500000004" },
    { tenantId: "A", assignedAiAgentId: "ai-maya", status: "OPEN", isTest: false, customerExternalId: "sandbox:rehearsal" },
    // Same AI id in another tenant must never count toward A.
    { tenantId: "B", assignedAiAgentId: "ai-maya", status: "OPEN", isTest: false, customerExternalId: "972500000009" },
  ],
}));

function holds(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === "NOT") { if (holds(row, v)) return false; continue; }
    if (v && typeof v === "object") {
      const o = v as any;
      if ("in" in o && !o.in.includes(row[k])) return false;
      if ("not" in o && row[k] === o.not) return false;
      if ("startsWith" in o && !String(row[k]).startsWith(o.startsWith)) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}
function guard(model: string, where: any) {
  if (!where?.tenantId) throw new Error(`tenant guard: ${model} bulk query without tenantId`);
}

vi.mock("@chatcenter/shared", () => ({
  getRedis: () => ({ hgetall: async () => ({ claimed: "3" }), lrange: async () => [] }),
  prisma: {
    user: {
      findMany: async (a: any) => {
        guard("user", a.where);
        return db.users.filter((u) => holds(u, a.where)).map((u) => ({ ...u, _count: { conversations: 0 } }));
      },
    },
    aIAgent: {
      findMany: async (a: any) => {
        guard("aIAgent", a.where);
        return db.ai.filter((x) => holds(x, a.where)).sort((p, q) => p.createdAt - q.createdAt);
      },
    },
    conversation: {
      groupBy: async (a: any) => {
        guard("conversation", a.where);
        const rows = db.conversations.filter((c) => holds(c, a.where));
        const m = new Map<string, number>();
        for (const r of rows) m.set(r.assignedAiAgentId, (m.get(r.assignedAiAgentId) ?? 0) + 1);
        return [...m].map(([id, n]) => ({ assignedAiAgentId: id, _count: { _all: n } }));
      },
    },
  },
}));

import { getAgentStats } from "../services/analytics.service";

const ids = (rows: any[]) => rows.map((r) => r.agentId);

describe("getAgentStats - the team, per tenant", () => {
  it("★ tenant A: its ADMIN and AGENT, no SYSTEM_ADMIN, no inactive user", async () => {
    const humans = (await getAgentStats("A")).filter((r: any) => r.kind === "human");
    expect(ids(humans).sort()).toEqual(["a-admin", "a-agent"]);
  });

  it("★ tenant B sees only B's people and B's AI", async () => {
    const rows = await getAgentStats("B");
    expect(ids(rows).sort()).toEqual(["ai-b", "b-admin", "b-agent"]);
  });

  it("AI employees: ACTIVE and PAUSED listed, DRAFT not", async () => {
    const ai = (await getAgentStats("A")).filter((r: any) => r.kind === "ai");
    expect(ids(ai)).toEqual(["ai-maya", "ai-paused"]);
  });

  it("★ AI rows carry null with a reason, never 0, for the human-only figures", async () => {
    const maya = (await getAgentStats("A")).find((r: any) => r.agentId === "ai-maya") as any;
    expect(maya.claimedToday).toBeNull();
    expect(maya.avgResponseTimeMs).toBeNull();
    expect(maya.nullReasons).toEqual({ claimedToday: "ai_does_not_claim", avgResponseTimeMs: "not_measured_for_ai" });
    expect(maya.email).toBeNull();
  });

  it("★ AI open conversations: this tenant only, not CLOSED, not test, not sandbox", async () => {
    const rows = await getAgentStats("A");
    // 6 rows carry ai-maya; only the OPEN and WAITING real ones in tenant A count.
    expect((rows.find((r: any) => r.agentId === "ai-maya") as any).activeConversations).toBe(2);
    expect((rows.find((r: any) => r.agentId === "ai-paused") as any).activeConversations).toBe(0);
  });

  it("human rows keep their real claimed count", async () => {
    const ada = (await getAgentStats("A")).find((r: any) => r.agentId === "a-admin") as any;
    expect(ada).toMatchObject({ kind: "human", claimedToday: 3 });
  });
});
