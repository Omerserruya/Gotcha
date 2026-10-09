/**
 * /api/policy-decisions applies the inbox visibility rule (2026-10-09): a
 * decision about a conversation the viewer may not see is neither listed nor
 * counted. A decision with no conversation stays visible. Unrestricted viewers
 * (ADMIN) get the exact where they had.
 *
 * Through the real router. The prisma doubles honour the where they are given
 * (OR / AND / in / not, plus distinct, order, take and cursor), so a filter the
 * route drops, or applies after the LIMIT, is caught.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  viewer: { userId: "admin1", role: "ADMIN", departmentId: undefined as string | undefined },
  convs: [] as any[],
  decisions: [] as any[],
  seenListWhere: null as any,
}));

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
    if (v && typeof v === "object" && "not" in v) return (row[k] ?? null) !== v.not;
    return (row[k] ?? null) === v;
  });
}
const newestFirst = (a: any, b: any) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1);

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    policyDecision: {
      findMany: async (a: any) => {
        let rows = H.decisions.filter((d) => matches(d, a.where)).sort(newestFirst);
        if (a.distinct) {
          const seen = new Set();
          rows = rows.filter((r) => { const key = a.distinct.map((f: string) => r[f]).join("|"); if (seen.has(key)) return false; seen.add(key); return true; });
        } else {
          H.seenListWhere = a.where;
        }
        if (a.cursor) rows = rows.slice(rows.findIndex((r) => r.id === a.cursor.id) + (a.skip ?? 0));
        return rows.slice(0, a.take ?? 1e9).map((r) => ({ ...r }));
      },
      count: async (a: any) => H.decisions.filter((d) => matches(d, a.where)).length,
      groupBy: async (a: any) => {
        const groups = new Map<string, any>();
        for (const d of H.decisions.filter((x) => matches(x, a.where))) {
          const key = a.by.map((f: string) => d[f]).join("|");
          const g = groups.get(key) ?? { ...Object.fromEntries(a.by.map((f: string) => [f, d[f]])), _count: { _all: 0 } };
          g._count._all++;
          groups.set(key, g);
        }
        return [...groups.values()];
      },
    },
    conversation: {
      findMany: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("tenant guard: conversation");
        return H.convs.filter((c) => matches(c, a.where)).map((c) => ({ id: c.id }));
      },
    },
  },
  authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.viewer }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
}));

import router from "../routes/policy-decisions";

const app = express();
app.use(express.json());
app.use("/api/policy-decisions", router);

const decision = (id: string, conversationId: string | null, createdAt: number, over: Record<string, unknown> = {}) => ({
  id, tenantId: "T", conversationId, createdAt, decision: "ALLOWED", actionKind: "REFUND", evaluationPoint: "OFFER",
  tool: "shopify.process_refund", maxAmount: null, matchedRules: [], reasonCodes: [], policyId: null, policyVersion: null,
  aiEmployeeId: null, ...over,
});

beforeEach(() => {
  H.viewer = { userId: "admin1", role: "ADMIN", departmentId: undefined };
  H.seenListWhere = null;
  H.convs = [
    { id: "c_sales", tenantId: "T", departmentId: "sales", assignedAgentId: null },
    { id: "c_support", tenantId: "T", departmentId: "support", assignedAgentId: null },
  ];
  H.decisions = [
    decision("d_support_new", "c_support", 50, { decision: "DENIED" }),
    decision("d_sales", "c_sales", 40),
    decision("d_support_old", "c_support", 30, { decision: "DENIED" }),
    decision("d_none", null, 20, { actionKind: "BROADCAST" }),
    // Another tenant's decision on a visible-looking id: never served.
    { ...decision("d_other", "c_sales", 60), tenantId: "OTHER" },
  ];
});
const agentOfSales = () => { H.viewer = { userId: "agent1", role: "AGENT", departmentId: "sales" }; };

describe("GET /api/policy-decisions", () => {
  it("★ a Sales agent sees decisions on Sales threads and on no thread, never Support's", async () => {
    agentOfSales();
    const r = await request(app).get("/api/policy-decisions");
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: any) => d.id)).toEqual(["d_sales", "d_none"]);
    expect(JSON.stringify(r.body)).not.toContain("c_support");
  });

  it("★ the filter is in the WHERE, so pages stay whole and the cursor is honest", async () => {
    agentOfSales();
    const p1 = await request(app).get("/api/policy-decisions?limit=1");
    expect(p1.body.data.map((d: any) => d.id)).toEqual(["d_sales"]);
    expect(p1.body.nextCursor).toBe("d_sales");
    const p2 = await request(app).get(`/api/policy-decisions?limit=1&cursor=${p1.body.nextCursor}`);
    expect(p2.body.data.map((d: any) => d.id)).toEqual(["d_none"]);
    expect(p2.body.nextCursor).toBeNull();
  });

  it("a thread in another department assigned to the viewer is theirs", async () => {
    agentOfSales();
    H.convs[1].assignedAgentId = "agent1";
    const r = await request(app).get("/api/policy-decisions");
    expect(r.body.data.map((d: any) => d.id)).toEqual(["d_support_new", "d_sales", "d_support_old", "d_none"]);
  });

  it("an ADMIN sees every decision in the tenant, with the where exactly as before", async () => {
    const r = await request(app).get("/api/policy-decisions");
    expect(r.body.data.map((d: any) => d.id)).toEqual(["d_support_new", "d_sales", "d_support_old", "d_none"]);
    expect(H.seenListWhere).toEqual({ tenantId: "T" });
  });
});

describe("GET /api/policy-decisions/summary", () => {
  it("★ a Sales agent's totals count only what their list shows", async () => {
    agentOfSales();
    const r = await request(app).get("/api/policy-decisions/summary");
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBe(2);
    expect(r.body.data.byDecision).toEqual([{ decision: "ALLOWED", count: 2 }]);
    expect(r.body.data.byActionKind.find((g: any) => g.decision === "DENIED")).toBeUndefined();
  });

  it("an ADMIN's totals are the whole tenant", async () => {
    const r = await request(app).get("/api/policy-decisions/summary");
    expect(r.body.data.total).toBe(4);
    expect(r.body.data.byDecision).toEqual(expect.arrayContaining([{ decision: "DENIED", count: 2 }, { decision: "ALLOWED", count: 2 }]));
  });
});
