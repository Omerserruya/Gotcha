/**
 * DB-backed integration tests for department AI-employee attachments
 * (GET/POST/DELETE /api/departments/:id/ai-employees + /tree roster).
 *
 * Runs against the REAL dev postgres. Rows are uniquely prefixed and swept in
 * afterAll. Auth middlewares are pass-throughs injecting the test principal
 * (permission enforcement has its own unit coverage); routes, Prisma and the
 * RouterRule attachment model are the real thing - the point is to prove the
 * DATA behavior: multiple attachments, removal preserving others, duplicate
 * prevention, cross-tenant rejection, stale-agent safety.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";

const ctx = vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/whatsapp_cc";
  return { tenantId: "", userId: "itest-user" };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chatcenter/shared")>();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: ctx.userId, tenantId: ctx.tenantId, role: "ADMIN", email: "itest@example.com" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = ctx.tenantId;
      next();
    },
    requireRole: () => (_req: any, _res: any, next: any) => next(),
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    requireDepartmentRole: () => (_req: any, _res: any, next: any) => next(),
    enforceMfaEnrollment: () => (_req: any, _res: any, next: any) => next(),
  };
});

import { prisma } from "@chatcenter/shared";
import departmentsRoutes from "../routes/departments";

const RUN = `itestdep_${Date.now()}`;

const app = express();
app.use(express.json());
app.use("/api/departments", departmentsRoutes);

let tenantA = "";
let tenantB = "";
let deptA = "";
let agent1 = "";
let agent2 = "";
let agentB = ""; // belongs to tenant B - must never attach to A's department

beforeAll(async () => {
  const a = await prisma.tenant.create({ data: { name: `${RUN}-a`, slug: `${RUN}-a`, status: "ACTIVE" } });
  const b = await prisma.tenant.create({ data: { name: `${RUN}-b`, slug: `${RUN}-b`, status: "ACTIVE" } });
  tenantA = a.id;
  tenantB = b.id;

  deptA = (await prisma.department.create({ data: { tenantId: tenantA, name: `${RUN}-support` } })).id;
  agent1 = (await prisma.aIAgent.create({ data: { tenantId: tenantA, name: `${RUN}-Shmarit`, status: "ACTIVE" } })).id;
  agent2 = (await prisma.aIAgent.create({ data: { tenantId: tenantA, name: `${RUN}-Sales`, status: "ACTIVE" } })).id;
  agentB = (await prisma.aIAgent.create({ data: { tenantId: tenantB, name: `${RUN}-Foreign`, status: "ACTIVE" } })).id;
  ctx.tenantId = tenantA;
}, 30_000);

afterAll(async () => {
  const ids = [tenantA, tenantB].filter(Boolean);
  await prisma.routerRule.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.aIAgent.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.department.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
}, 30_000);

describe("department AI employees: multi-attach on the real DB", () => {
  it("starts empty and returns existing assignments correctly after attach", async () => {
    const empty = await request(app).get(`/api/departments/${deptA}/ai-employees`);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);

    const r1 = await request(app).post(`/api/departments/${deptA}/ai-employees`).send({ aiAgentId: agent1 });
    expect(r1.status).toBe(201);
    expect(r1.body.data.id).toBe(agent1);

    const list = await request(app).get(`/api/departments/${deptA}/ai-employees`);
    expect(list.body.data.map((a: any) => a.id)).toEqual([agent1]);
  });

  it("attaches MULTIPLE AI employees to one department", async () => {
    const r2 = await request(app).post(`/api/departments/${deptA}/ai-employees`).send({ aiAgentId: agent2 });
    expect(r2.status).toBe(201);

    const list = await request(app).get(`/api/departments/${deptA}/ai-employees`);
    expect(list.body.data.map((a: any) => a.id).sort()).toEqual([agent1, agent2].sort());

    // Each attachment is its OWN RouterRule row.
    const rules = await prisma.routerRule.count({ where: { tenantId: tenantA, routeType: "AI_AGENT", routeTarget: deptA } });
    expect(rules).toBe(2);
  });

  it("duplicate attachment is prevented (idempotent - no second rule)", async () => {
    const dup = await request(app).post(`/api/departments/${deptA}/ai-employees`).send({ aiAgentId: agent1 });
    expect(dup.status).toBe(200); // existing attachment reported, not recreated
    const rules = await prisma.routerRule.count({ where: { tenantId: tenantA, routeType: "AI_AGENT", routeTarget: deptA, aiAgentId: agent1 } });
    expect(rules).toBe(1);
  });

  it("the department tree exposes the AI roster alongside human members", async () => {
    const tree = await request(app).get("/api/departments/tree");
    expect(tree.status).toBe(200);
    const dept = (tree.body.data.tree as any[]).find((d) => d.id === deptA);
    expect(dept).toBeTruthy();
    expect((dept.aiEmployees as any[]).map((a) => a.id).sort()).toEqual([agent1, agent2].sort());
  });

  it("REJECTS a cross-tenant AI employee id", async () => {
    const r = await request(app).post(`/api/departments/${deptA}/ai-employees`).send({ aiAgentId: agentB });
    expect(r.status).toBe(404); // not found within the active tenant
    // (TenantGuard requires tenant scope on RouterRule queries - scope to A,
    // which is exactly where a leaked attachment would have landed.)
    const rules = await prisma.routerRule.count({ where: { tenantId: tenantA, routeTarget: deptA, aiAgentId: agentB } });
    expect(rules).toBe(0);
  });

  it("removing ONE attachment preserves the others", async () => {
    const r = await request(app).delete(`/api/departments/${deptA}/ai-employees/${agent1}`);
    expect(r.status).toBe(200);
    // Server returns the surviving roster.
    expect(r.body.data.map((a: any) => a.id)).toEqual([agent2]);
    const rules = await prisma.routerRule.findMany({ where: { tenantId: tenantA, routeType: "AI_AGENT", routeTarget: deptA } });
    expect(rules.map((x) => x.aiAgentId)).toEqual([agent2]);
  });

  it("a deleted AI employee disappears from the roster safely (no 500, no ghost)", async () => {
    // Simulate an agent deleted while still referenced by a rule.
    await prisma.routerRule.updateMany({
      where: { tenantId: tenantA, routeTarget: deptA, aiAgentId: agent2 },
      data: {}, // keep rule; delete the agent underneath it
    });
    await prisma.aIAgent.delete({ where: { id: agent2 } });

    const list = await request(app).get(`/api/departments/${deptA}/ai-employees`);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]); // stale id silently dropped

    const tree = await request(app).get("/api/departments/tree");
    const dept = (tree.body.data.tree as any[]).find((d) => d.id === deptA);
    expect(dept.aiEmployees).toEqual([]);
  });
});
