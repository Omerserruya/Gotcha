/**
 * An employee is given an integration tool by its name (2026-10-13): the key
 * the employee's tools page lists, resolved to the tool of the CONNECTED
 * connection. A tool the workspace has not set up cannot be given.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ tools: [] as any[], perms: [] as any[], ttWhere: null as any }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const matches = (t: any, w: any) =>
    t.tenantId === w.tenantId &&
    (w.id === undefined || t.id === w.id) &&
    (w.catalogTool?.slug === undefined || t.slug === w.catalogTool.slug) &&
    (w.tenantIntegration === undefined || (t.status === w.tenantIntegration.status && t.provider === w.tenantIntegration.integration.slug));
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    prisma: {
      aIAgent: { findFirst: async (a: any) => (a.where.id === "maya" && a.where.tenantId === "T" ? { id: "maya" } : null) },
      tenantTool: {
        findFirst: async (a: any) => { H.ttWhere = a.where; const t = H.tools.find((x) => matches(x, a.where)); return t ? { id: t.id } : null; },
      },
      agentToolPermission: {
        findFirst: async (a: any) => H.perms.find((p) => p.tenantId === a.where.tenantId && p.aiAgentId === a.where.aiAgentId && p.tenantToolId === a.where.tenantToolId) ?? null,
        create: async (a: any) => { H.perms.push({ id: `p${H.perms.length}`, ...a.data }); return {}; },
        update: async (a: any) => { Object.assign(H.perms.find((p) => p.id === a.where.id), a.data); return {}; },
        deleteMany: async (a: any) => { H.perms = H.perms.filter((p) => !(p.tenantId === a.where.tenantId && p.tenantToolId === a.where.tenantToolId)); return {}; },
      },
    },
  };
});
vi.mock("../services/agent-builder.service", () => ({
  runBuilder: vi.fn(), seedDraftFromGoal: vi.fn(), loadDraftSnapshot: vi.fn(async () => ({})), draftReadiness: () => ({ ready: true, missing: [] }),
}));
vi.mock("../services/agent-readiness.service", () => ({ generateReadinessReport: vi.fn() }));
vi.mock("../services/sales-context-generator.service", () => ({ generateSalesContext: vi.fn(async () => null) }));

import router from "../routes/ai-agent-builder";
const app = express();
app.use(express.json());
app.use("/api/ai-agents/builder", router);
const grant = (body: any) => request(app).post("/api/ai-agents/builder/maya/tool").send(body);

beforeEach(() => {
  H.perms = [];
  H.tools = [
    { id: "tt-broken", tenantId: "T", slug: "create_coupon", provider: "woocommerce", status: "ERROR" },
    { id: "tt-live", tenantId: "T", slug: "create_coupon", provider: "woocommerce", status: "CONNECTED" },
    { id: "tt-other", tenantId: "OTHER", slug: "get_order", provider: "woocommerce", status: "CONNECTED" },
  ];
});

describe("POST /builder/:id/tool by toolName", () => {
  it("★ gives the employee the tool of the CONNECTED connection", async () => {
    const r = await grant({ toolName: "woocommerce.create_coupon" });
    expect(r.status).toBe(200);
    expect(H.perms).toEqual([expect.objectContaining({ tenantId: "T", aiAgentId: "maya", tenantToolId: "tt-live", isAllowed: true })]);
    expect(H.ttWhere).toMatchObject({ tenantId: "T", tenantIntegration: { status: "CONNECTED", integration: { slug: "woocommerce" } } });
  });

  it("attach:false takes it away", async () => {
    await grant({ toolName: "woocommerce.create_coupon" });
    await grant({ toolName: "woocommerce.create_coupon", attach: false });
    expect(H.perms).toEqual([]);
  });

  it("★ a tool not set up in this workspace (or another workspace's): 404 TOOL_NOT_PROVISIONED, nothing given", async () => {
    const r = await grant({ toolName: "woocommerce.get_order" });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("TOOL_NOT_PROVISIONED");
    expect(H.perms).toEqual([]);
  });

  it("by tenantToolId still works", async () => {
    expect((await grant({ tenantToolId: "tt-live" })).status).toBe(200);
    expect(H.perms[0].tenantToolId).toBe("tt-live");
  });
});
