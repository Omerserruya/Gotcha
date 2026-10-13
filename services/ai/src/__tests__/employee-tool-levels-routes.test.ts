/**
 * An AI employee's own tool levels, through the routes (A1, Omer 2026-10-13):
 * GET /:id/tools lists each tool with the workspace level and what this
 * employee may choose; PUT /:id/tool-levels/:toolName refuses anything looser
 * than the workspace (422 LOOSER_THAN_WORKSPACE) and stores only stricter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ levels: {} as Record<string, string>, writes: [] as any[], audits: [] as any[], rows: [] as any[], grants: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requirePermissionOrRole: () => pass,
    requireEntitlement: () => pass,
    requireCapacity: () => pass,
    readAgentToolLevels: vi.fn(async () => ({ ...H.levels })),
    writeAgentToolLevel: vi.fn(async (t: string, a: string, tool: string, level: string | null) => {
      H.writes.push([t, a, tool, level]);
      if (level) H.levels[tool] = level; else delete H.levels[tool];
      return { ...H.levels };
    }),
    writeAudit: vi.fn(async (e: any) => { H.audits.push(e); }),
    prisma: {
      aIAgent: { findFirst: async (a: any) => (a.where.id === "maya" && a.where.tenantId === "T" ? { id: "maya" } : null) },
      agentToolPermission: {
        findMany: async (a: any) => (a.where.tenantId === "T" && a.where.aiAgentId === "maya" && a.where.isAllowed === true ? H.grants : []),
      },
    },
  };
});
vi.mock("../routes/tool-permissions", () => ({ listWorkspaceTools: vi.fn(async () => H.rows), default: (_q: any, _s: any, n: any) => n() }));
vi.mock("../lib/reader-locale", () => ({ readerLocale: async () => "he" }));

import router from "../routes/ai-agents";
const app = express();
app.use(express.json());
app.use("/api/ai-agents", router);

const row = (toolName: string, enabled: boolean, requiresApproval: boolean, over: any = {}) =>
  ({ toolName, enabled, requiresApproval, description: `${toolName} desc`, integration: null, riskGroup: "create_update", ...over });

beforeEach(() => {
  H.levels = {}; H.writes = []; H.audits = []; H.grants = [];
  H.rows = [
    row("send_message", true, false),
    row("woocommerce.create_coupon", true, true, { integration: "woocommerce", integrationConnected: true, riskGroup: "financial" }),
    row("delete_note", false, true, { riskGroup: "delete" }),
  ];
});

describe("GET /:id/tools", () => {
  it("★ each tool with the workspace level, the employee's, and what it may choose", async () => {
    H.levels = { send_message: "ask" };
    const r = await request(app).get("/api/ai-agents/maya/tools");
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.data.tools.map((t: any) => [t.toolName, t]));
    expect(by.send_message).toMatchObject({ workspaceLevel: "execute", ownLevel: "ask", employeeLevel: "ask", allowedLevels: ["execute", "ask", "never"] });
    expect(by["woocommerce.create_coupon"]).toMatchObject({ workspaceLevel: "ask", ownLevel: null, employeeLevel: "ask", allowedLevels: ["ask", "never"], riskGroup: "financial", label: "יצירת קופון" });
    expect(by.delete_note).toMatchObject({ workspaceLevel: "never", employeeLevel: "never", allowedLevels: ["never"] });
  });

  it("a workspace that tightened later wins in what applies", async () => {
    H.levels = {};
    H.rows = [row("send_message", true, true)];
    H.levels = { send_message: "ask" };
    H.rows[0].enabled = false;
    const t = (await request(app).get("/api/ai-agents/maya/tools")).body.data.tools[0];
    expect(t).toMatchObject({ workspaceLevel: "never", employeeLevel: "never" });
  });

  it("★ only tools that can run: a disconnected or failing store's tools are not listed", async () => {
    H.rows.push(
      row("shopify.create_discount", true, true, { integration: "shopify", integrationConnected: false, riskGroup: "financial" }),
      row("hubspot.create_contact", true, false, { integration: "hubspot", riskGroup: "create_update" }),
    );
    const names = (await request(app).get("/api/ai-agents/maya/tools")).body.data.tools.map((t: any) => t.toolName);
    expect(names.sort()).toEqual(["delete_note", "send_message", "woocommerce.create_coupon"]);
  });

  it("★ each integration tool says whether THIS employee was given it; built-ins need no grant", async () => {
    H.rows = [
      row("send_message", true, false),
      row("woocommerce.create_coupon", true, true, { integration: "woocommerce", integrationConnected: true, catalogToolId: "c1", state: "enabled" }),
      row("woocommerce.get_order", true, false, { integration: "woocommerce", integrationConnected: true, catalogToolId: "c2", state: "enabled" }),
      row("woocommerce.create_refund", false, true, { integration: "woocommerce", integrationConnected: true, catalogToolId: "c3", state: "not_provisioned" }),
    ];
    H.grants = [{ tenantTool: { catalogToolId: "c1" } }];
    const by = Object.fromEntries((await request(app).get("/api/ai-agents/maya/tools")).body.data.tools.map((t: any) => [t.toolName, t]));
    expect(by.send_message).toMatchObject({ granted: null, grantable: false });
    expect(by["woocommerce.create_coupon"]).toMatchObject({ granted: true, grantable: true });
    expect(by["woocommerce.get_order"]).toMatchObject({ granted: false, grantable: true });
    expect(by["woocommerce.create_refund"]).toMatchObject({ granted: false, grantable: false });
  });

  it("another tenant's employee: 404", async () => {
    expect((await request(app).get("/api/ai-agents/other/tools")).status).toBe(404);
  });
});

describe("PUT /:id/tool-levels/:toolName", () => {
  const put = (tool: string, level: any) => request(app).put(`/api/ai-agents/maya/tool-levels/${tool}`).send({ level });

  it("★ stricter is stored and audited", async () => {
    const r = await put("send_message", "never");
    expect(r.status).toBe(200);
    expect(H.writes).toEqual([["T", "maya", "send_message", "never"]]);
    expect(H.audits[0]).toMatchObject({ actorId: "u1", targetId: "maya", metadata: { change: "employee_tool_level", tool: "send_message", workspaceLevel: "execute", level: "never" } });
  });

  it("★ looser than the workspace: 422, nothing stored", async () => {
    const r = await put("woocommerce.create_coupon", "execute");
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: "LOOSER_THAN_WORKSPACE", workspaceLevel: "ask", allowedLevels: ["ask", "never"] });
    expect((await put("delete_note", "ask")).status).toBe(422);
    expect(H.writes).toHaveLength(0);
  });

  it("equal to the workspace (or null) clears the employee's own level", async () => {
    H.levels = { send_message: "ask" };
    await put("send_message", "execute");
    expect(H.writes).toEqual([["T", "maya", "send_message", null]]);
    await put("woocommerce.create_coupon", null);
    expect(H.writes[1]).toEqual(["T", "maya", "woocommerce.create_coupon", null]);
  });

  it("an unknown tool or level is refused", async () => {
    expect((await put("nope", "ask")).body.code).toBe("UNKNOWN_TOOL");
    expect((await put("send_message", "maybe")).body.code).toBe("BAD_LEVEL");
  });
});
