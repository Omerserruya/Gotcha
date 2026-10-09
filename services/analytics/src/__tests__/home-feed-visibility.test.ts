/**
 * Home's queue and activity stream follow the inbox's visibility rule, and an
 * insight is dismissed only by an ADMIN (2026-10-09).
 *
 * Through the real router. The Prisma double evaluates every `where` it is
 * given (and throws on an operator it does not know), so a dropped tenant or
 * visibility filter shows up as a row that should not be there.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  conversations: [] as any[],
  executions: [] as any[],
  approvals: [] as any[],
  upserts: [] as any[],
  calls: 0,
}));

/** Does `row` satisfy a Prisma `where`? Only the operators these reads use. */
function matches(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === "AND") { if (!(v as any[]).every((w) => matches(row, w))) return false; continue; }
    if (k === "OR") { if (!(v as any[]).some((w) => matches(row, w))) return false; continue; }
    if (k === "NOT") { if ((Array.isArray(v) ? v : [v]).some((w) => matches(row, w))) return false; continue; }
    const val = row[k] ?? null;
    if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      for (const [op, x] of Object.entries(v as Record<string, any>)) {
        if (op === "in") { if (!x.includes(val)) return false; }
        else if (op === "not") { if (val === x) return false; }
        else if (op === "startsWith") { if (!(typeof val === "string" && val.startsWith(x))) return false; }
        else if (op === "lt") { if (!(val !== null && val < x)) return false; }
        else if (op === "gt") { if (!(val !== null && val > x)) return false; }
        else throw new Error(`double: unknown operator ${op}`);
      }
    } else if (val !== v) return false;
  }
  return true;
}

function page(rows: any[], a: any) {
  const hit = rows.filter((r) => matches(r, a.where))
    .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (y.id < x.id ? -1 : 1));
  return hit.slice(a.skip ?? 0, (a.skip ?? 0) + (a.take ?? hit.length));
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = JSON.parse(String(req.headers["x-user"])); n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    // Permission: held when listed on the test user. Role: the legacy enum.
    requirePermission: (...keys: string[]) => (req: any, res: any, n: any) =>
      keys.some((k) => (req.user.perms ?? []).includes(k)) ? n() : res.status(403).json({ error: "Permission denied" }),
    requireRole: (...roles: string[]) => (req: any, res: any, n: any) =>
      roles.includes(req.user.role) || req.user.role === "SYSTEM_ADMIN" ? n() : res.status(403).json({ error: "Insufficient permissions" }),
    prisma: {
      conversation: {
        findMany: async (a: any) => { H.calls++; return page(H.conversations, a).map((c) => ({ ...c, messages: [] })); },
        count: async (a: any) => { H.calls++; return H.conversations.filter((c) => matches(c, a.where)).length; },
      },
      conversationIntelligence: { findMany: async () => { H.calls++; return []; } },
      toolExecution: { findMany: async (a: any) => { H.calls++; return page(H.executions, a); } },
      approvalRequest: { findMany: async (a: any) => { H.calls++; return page(H.approvals, a); } },
      insightDismissal: { upsert: async (a: any) => { H.calls++; H.upserts.push(a); return {}; } },
    },
  };
});

import router from "../routes/analytics";

const app = express();
app.use("/api/analytics", router);

const DASH = "analytics:dashboard:read";
const ADMIN = { userId: "admin", role: "ADMIN", perms: [DASH] };
// A department manager: holds the dashboard permission, restricted to D1.
const MANAGER_D1 = { userId: "m1", role: "AGENT", departmentId: "D1", perms: [DASH] };
const AGENT_NO_PERM = { userId: "a1", role: "AGENT", departmentId: "D1", perms: [] };

const as = (u: object) => ({ "x-user": JSON.stringify(u) });
const at = (min: number) => new Date(Date.UTC(2026, 9, 9, 12, 0) - min * 60_000);

const conv = (id: string, o: any = {}) => ({
  id, tenantId: "T", isTest: false, customerExternalId: `972${id}`, customerName: id, channel: "WHATSAPP",
  status: "OPEN", assignedAgentId: null, departmentId: null, handledBy: null, isHandedOver: false,
  createdAt: at(60), lastMessageAt: at(60), ...o,
});
const exec = (id: string, conversationId: string, min: number, tenantId = "T") => ({
  id, tenantId, conversationId, toolName: "lookup_order", input: {}, output: {}, success: true, createdAt: at(min),
});
const appr = (id: string, conversationId: string | null, min: number) => ({
  id, tenantId: "T", conversationId, tool: "issue_refund", params: {}, status: "PENDING",
  expiresAt: new Date(Date.now() + 86_400_000), createdAt: at(min),
});

beforeEach(() => {
  H.upserts = [];
  H.calls = 0;
  H.conversations = [
    conv("d1", { departmentId: "D1" }),
    conv("d2", { departmentId: "D2" }),
    conv("nodept"),
    conv("other-tenant", { tenantId: "U" }),
    // Not waiting (assigned), but its activity is the manager's own.
    conv("mine-d2", { departmentId: "D2", assignedAgentId: "m1" }),
  ];
  H.executions = [
    exec("e-d1", "d1", 1), exec("e-d2", "d2", 2), exec("e-nodept", "nodept", 3),
    exec("e-mine", "mine-d2", 4), exec("e-other", "other-tenant", 5, "U"),
    // A T row naming a conversation that is not T's: the lookup is tenant-bound.
    exec("e-cross", "other-tenant", 9),
  ];
  H.approvals = [appr("a-d2", "d2", 6), appr("a-d1", "d1", 7), appr("a-system", null, 8)];
});

describe("GET /queue/items", () => {
  it("403 without analytics:dashboard:read, before any read", async () => {
    const r = await request(app).get("/api/analytics/queue/items").set(as(AGENT_NO_PERM));
    expect(r.status).toBe(403);
    expect(H.calls).toBe(0);
  });

  it("a department-restricted viewer gets only conversations the inbox shows them, and a count to match", async () => {
    const r = await request(app).get("/api/analytics/queue/items").set(as(MANAGER_D1));
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.conversationId).sort()).toEqual(["d1", "nodept"]);
    expect(r.body.totalWaiting).toBe(2);
  });

  it("an ADMIN sees the whole tenant's queue, as before", async () => {
    const r = await request(app).get("/api/analytics/queue/items").set(as(ADMIN));
    expect(r.body.data.map((x: any) => x.conversationId).sort()).toEqual(["d1", "d2", "nodept"]);
    expect(r.body.totalWaiting).toBe(3);
  });
});

describe("GET /activity", () => {
  it("403 without analytics:dashboard:read, before any read", async () => {
    const r = await request(app).get("/api/analytics/activity").set(as(AGENT_NO_PERM));
    expect(r.status).toBe(403);
    expect(H.calls).toBe(0);
  });

  it("a department-restricted viewer never sees another department's runs or approvals", async () => {
    const r = await request(app).get("/api/analytics/activity").set(as(MANAGER_D1));
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.id)).toEqual(["e-d1", "e-nodept", "e-mine", "a-d1", "a-system"]);
    expect(r.body.nextCursor).toBeNull();
  });

  it("an ADMIN sees every row in the tenant, as before", async () => {
    const r = await request(app).get("/api/analytics/activity").set(as(ADMIN));
    expect(r.body.data.map((x: any) => x.id)).toEqual(["e-d1", "e-d2", "e-nodept", "e-mine", "a-d2", "a-d1", "a-system", "e-cross"]);
  });

  it("hidden rows newer than the visible ones do not leave a short page with no cursor", async () => {
    H.executions = [
      ...Array.from({ length: 250 }, (_, i) => exec(`hid-${String(i).padStart(3, "0")}`, "d2", i)),
      exec("v1", "d1", 300), exec("v2", "d1", 301), exec("v3", "d1", 302),
    ];
    H.approvals = [];
    const r = await request(app).get("/api/analytics/activity?limit=2").set(as(MANAGER_D1));
    expect(r.body.data.map((x: any) => x.id)).toEqual(["v1", "v2"]);
    expect(r.body.nextCursor).toBe(at(301).toISOString());
    const next = await request(app).get(`/api/analytics/activity?limit=2&cursor=${r.body.nextCursor}`).set(as(MANAGER_D1));
    expect(next.body.data.map((x: any) => x.id)).toEqual(["v3"]);
  });

  it("at the scan cap, nothing older than what was scanned is shown, and the cursor resumes there", async () => {
    H.executions = Array.from({ length: 2100 }, (_, i) => exec(`hid-${i}`, "d2", i));
    H.approvals = [appr("a-old", "d1", 5000)];
    const r = await request(app).get("/api/analytics/activity?limit=5").set(as(MANAGER_D1));
    expect(r.body.data).toEqual([]);
    expect(r.body.nextCursor).toBe(at(1999).toISOString());
  });
});

describe("POST /insights/:id/dismiss", () => {
  it("a non-admin holding the dashboard permission gets 403 and nothing is written", async () => {
    const r = await request(app).post("/api/analytics/insights/ins-1/dismiss").set(as(MANAGER_D1));
    expect(r.status).toBe(403);
    expect(H.upserts).toEqual([]);
  });

  it("an ADMIN dismisses it for the tenant", async () => {
    const r = await request(app).post("/api/analytics/insights/ins-1/dismiss").set(as(ADMIN));
    expect(r.status).toBe(200);
    expect(H.upserts).toHaveLength(1);
    expect(H.upserts[0].where).toEqual({ tenantId_insightId: { tenantId: "T", insightId: "ins-1" } });
  });
});
