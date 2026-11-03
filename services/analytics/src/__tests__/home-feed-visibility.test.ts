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
  requests: [] as any[],
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
        else if (op === "endsWith") { if (!(typeof val === "string" && val.endsWith(x))) return false; }
        else if (op === "lt") { if (!(val !== null && val < x)) return false; }
        else if (op === "gt") { if (!(val !== null && val > x)) return false; }
        else throw new Error(`double: unknown operator ${op}`);
      }
    } else if (val !== v) return false;
  }
  return true;
}

function page(rows: any[], a: any, key = "createdAt") {
  const hit = rows.filter((r) => matches(r, a.where))
    .sort((x, y) => y[key].getTime() - x[key].getTime() || (y.id < x.id ? -1 : 1));
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
      // The AI employees' actions (2026-11-03): ordered by when they finished.
      toolExecutionRequest: {
        findMany: async (a: any) => {
          H.calls++;
          expect(a.orderBy).toEqual([{ completedAt: "desc" }, { id: "desc" }]);
          return page(H.requests, a, "completedAt").map((r) => Object.fromEntries(Object.keys(a.select).map((k) => [k, r[k] ?? null])));
        },
      },
      insightDismissal: { upsert: async (a: any) => { H.calls++; H.upserts.push(a); return {}; } },
    },
  };
});

import router from "../routes/analytics";

const app = express();
app.use("/api/analytics", router);

const DASH = "analytics:dashboard:read";
// The queue and activity are inbox data: gated on the inbox read, not analytics.
const INBOX = "conversation:messages:read";
const ADMIN = { userId: "admin", role: "ADMIN", perms: [DASH, INBOX] };
// A department manager: holds the dashboard permission, restricted to D1.
const MANAGER_D1 = { userId: "m1", role: "AGENT", departmentId: "D1", perms: [DASH, INBOX] };
// A plain agent: the inbox read, no analytics permission (the built-in Agent role).
const AGENT_D1 = { userId: "m1", role: "AGENT", departmentId: "D1", perms: [INBOX] };
// Analytics alone does not open inbox data.
const DASH_ONLY = { userId: "m1", role: "AGENT", departmentId: "D1", perms: [DASH] };
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
const req = (id: string, conversationId: string | null, min: number, tool = "shopify.process_refund", status = "completed", o: any = {}) => ({
  id, tenantId: "T", conversationId, tool, status, args: {}, result: {},
  proposedAt: at(min + 1), completedAt: status === "completed" || status === "failed" ? at(min) : null, ...o,
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
  H.requests = [];
});

describe("GET /queue/items", () => {
  it("403 without the inbox read, before any read; the dashboard permission alone does not open it", async () => {
    for (const u of [AGENT_NO_PERM, DASH_ONLY]) {
      const r = await request(app).get("/api/analytics/queue/items").set(as(u));
      expect(r.status).toBe(403);
    }
    expect(H.calls).toBe(0);
  });

  it("a plain agent (inbox read, no analytics) gets their own scoped queue", async () => {
    const r = await request(app).get("/api/analytics/queue/items").set(as(AGENT_D1));
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.conversationId).sort()).toEqual(["d1", "nodept"]);
    expect(r.body.totalWaiting).toBe(2);
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
  it("403 without the inbox read, before any read; the dashboard permission alone does not open it", async () => {
    for (const u of [AGENT_NO_PERM, DASH_ONLY]) {
      const r = await request(app).get("/api/analytics/activity").set(as(u));
      expect(r.status).toBe(403);
    }
    expect(H.calls).toBe(0);
  });

  it("a plain agent (inbox read, no analytics) gets their own scoped activity", async () => {
    const r = await request(app).get("/api/analytics/activity").set(as(AGENT_D1));
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.id)).toEqual(["e-d1", "e-nodept", "e-mine", "a-d1", "a-system"]);
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

describe("GET /activity: the AI employees' actions (tool_execution_requests, 2026-11-03)", () => {
  it("a completed, mapped action is on the feed in the same event shape, its bare tool naming the noun", async () => {
    H.executions = [];
    H.approvals = [];
    H.requests = [
      req("r-refund", "d1", 0, "shopify.process_refund", "completed", {
        args: { orderId: "gid://1", reason: "damaged" },
        result: { orderNumber: "#1842", amount: 179, currency: "ILS", address: "secret st 1" },
      }),
    ];
    const r = await request(app).get("/api/analytics/activity").set(as(ADMIN));
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([{
      id: "r-refund",
      at: at(0).toISOString(),
      outcome: "completed",
      kind: "refund.completed",
      values: { amount: 179, currency: "ILS", reason: "damaged" },
      subject: { type: "order", id: "#1842" },
      conversationId: "d1",
    }]);
  });

  it("only completed, only tools the contract names: catalogue reads, proposals, denials and failures stay off", async () => {
    H.executions = [];
    H.approvals = [];
    H.requests = [
      req("r-list", "d1", 1, "woocommerce.list_products"),
      req("r-escalate", "d1", 2, "escalate_to_human"),
      req("r-proposed", "d1", 3, "shopify.cancel_order", "proposed"),
      req("r-denied", "d1", 4, "shopify.cancel_order", "denied"),
      req("r-failed", "d1", 5, "shopify.cancel_order", "failed"),
      req("r-bare", "d1", 6, "cancel_order"),
      req("r-woo", "d1", 7, "woocommerce.get_order"),
      req("r-other", "other-tenant", 8, "cancel_order", "completed", { tenantId: "U" }),
    ];
    const r = await request(app).get("/api/analytics/activity").set(as(ADMIN));
    expect(r.body.data.map((x: any) => [x.id, x.kind])).toEqual([
      ["r-bare", "order_cancel.completed"],
      ["r-woo", "order_lookup.completed"],
    ]);
  });

  it("merged with the legacy runs and the approvals on one timeline, newest first", async () => {
    H.requests = [req("r-d1", "d1", 2.5), req("r-sys", null, 7.5)];
    const r = await request(app).get("/api/analytics/activity").set(as(ADMIN));
    expect(r.body.data.map((x: any) => x.id)).toEqual(
      ["e-d1", "e-d2", "r-d1", "e-nodept", "e-mine", "a-d2", "a-d1", "r-sys", "a-system", "e-cross"]);
  });

  it("a department-restricted viewer never sees another department's actions", async () => {
    H.executions = [];
    H.approvals = [];
    H.requests = [req("r-d1", "d1", 1), req("r-d2", "d2", 2), req("r-mine", "mine-d2", 3), req("r-sys", null, 4)];
    const r = await request(app).get("/api/analytics/activity").set(as(MANAGER_D1));
    expect(r.body.data.map((x: any) => x.id)).toEqual(["r-d1", "r-mine", "r-sys"]);
  });

  it("pages through actions by when they finished: a cursor, then the rest, nothing twice", async () => {
    H.executions = [];
    H.approvals = [];
    H.requests = [req("r1", "d1", 1), req("r2", "d1", 2), req("r3", "d1", 3)];
    for (const u of [ADMIN, MANAGER_D1]) {
      const r = await request(app).get("/api/analytics/activity?limit=2").set(as(u));
      expect(r.body.data.map((x: any) => x.id)).toEqual(["r1", "r2"]);
      expect(r.body.nextCursor).toBe(at(2).toISOString());
      const next = await request(app).get(`/api/analytics/activity?limit=2&cursor=${r.body.nextCursor}`).set(as(u));
      expect(next.body.data.map((x: any) => x.id)).toEqual(["r3"]);
      expect(next.body.nextCursor).toBeNull();
    }
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
