/**
 * A delete, financial or administrative tool may be set to run without
 * approval, as an explicit, audited choice (Omer, 2026-10-12).
 *
 * Until now PUT /api/tool-permissions/:toolName answered 422
 * approval_cannot_be_removed for these groups, whatever the workspace wanted.
 * What replaces the wall:
 *   - the PUT accepts requiresApproval:false for them;
 *   - every approval change on them is audited: who, tool, before, after;
 *   - the default stays "Ask me": a first write that does not name
 *     requiresApproval keeps the gate's default instead of storing false;
 *   - HIGH_RISK_AUTORUN=off brings the 422 back everywhere;
 *   - the list read says per row what the PUT will accept (autoRunAllowed).
 *
 * The REAL classifier and guard are used, from their own module, so the route
 * is tested against the rule and not a stand-in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  writes: [] as any[],
  audits: [] as any[],
  overrides: {} as Record<string, unknown>,
  catalogHitl: { mode: "always" } as Record<string, unknown> | null,
  permissionRow: null as null | { requiresApproval: boolean },
}));

vi.mock("@chatcenter/shared", async () => {
  const ta = await vi.importActual<any>("../../../../packages/shared/src/lib/tool-availability");
  return {
    riskGroupFor: ta.riskGroupFor,
    mayBeAlwaysAllowed: ta.mayBeAlwaysAllowed,
    isHighRiskGroup: ta.isHighRiskGroup,
    highRiskAutoRunPermitted: ta.highRiskAutoRunPermitted,
    recommendedState: ta.recommendedState,
    RISK_GROUPS: ta.RISK_GROUPS,
    AuditAction: { PERMISSION_CHANGED: "permission.changed" },
    // The gate's own static defaults: these two ask unless a row says otherwise.
    getDefaultHighRiskTools: () => ["update_contact", "delete_note"],
    prisma: {
      catalogTool: {
        findFirst: async (a: any) => ({
          id: "ct1", integrationId: "i1", slug: a.where.slug, hitlPolicy: state.catalogHitl,
          integration: { slug: a.where.integration?.slug },
        }),
        findMany: async () => [],
      },
      tenantTool: {
        findFirst: async () => ({ id: "tt1", configOverrides: state.overrides }),
        update: async (a: any) => { state.writes.push(["tenantTool.update", a.data]); return { id: "tt1" }; },
        create: async (a: any) => { state.writes.push(["tenantTool.create", a.data]); return { id: "tt1" }; },
      },
      tenantToolPermission: {
        findUnique: async () => state.permissionRow,
        findMany: async () => [],
        upsert: async (a: any) => {
          state.writes.push(["permission.upsert", state.permissionRow ? a.update : a.create]);
          return { id: "p1" };
        },
      },
      tenantIntegration: {
        findMany: async () => [{ status: "CONNECTED", config: {}, integration: { slug: "woocommerce", name: "WooCommerce" } }],
      },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u-owner", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    writeAudit: async (e: any) => { state.audits.push(e); },
  };
});

vi.mock("../services/tool-registry", () => ({
  // Static tools in the shapes that matter: a delete (high-risk group), a
  // sensitive-data write whose default asks, and a write whose default runs.
  TOOL_REGISTRY: [{ name: "delete_note" }, { name: "update_contact" }, { name: "archive_note" }],
  getAvailableTools: async () => ({
    actionTools: [
      { name: "delete_note", kind: "action", category: "ACTION", description: "" },
      { name: "send_message", kind: "action", category: "ACTION", description: "" },
    ],
  }),
  getGovernableIntegrationTools: async () => [
    {
      name: "woocommerce.create_coupon", integrationSlug: "woocommerce", integrationStatus: "CONNECTED",
      catalogToolId: "ct1", slug: "create_coupon", displayName: "Create coupon", description: "",
      catalogCategory: "WRITE", riskLevel: "HIGH", catalogHitlMode: "always", requiredScopes: [],
      execution: "adapter", provisioned: true, tenantToolId: "tt1", overrideHitlMode: null,
      isEnabled: true, updatedAt: null,
    },
  ],
}));

import toolPermissionRoutes from "../routes/tool-permissions";

const app = express();
app.use(express.json());
app.use("/api/tool-permissions", toolPermissionRoutes);

const put = (tool: string, body: any) => request(app).put(`/api/tool-permissions/${tool}`).send(body);
const approvalAudits = () => state.audits.filter((a) => a.metadata?.change === "approval_policy");

let savedSwitch: string | undefined;
beforeEach(() => {
  state.writes = [];
  state.audits = [];
  state.overrides = {};
  state.catalogHitl = { mode: "always" };
  state.permissionRow = null;
  savedSwitch = process.env.HIGH_RISK_AUTORUN;
  delete process.env.HIGH_RISK_AUTORUN;
});
afterEach(() => {
  if (savedSwitch === undefined) delete process.env.HIGH_RISK_AUTORUN;
  else process.env.HIGH_RISK_AUTORUN = savedSwitch;
});

describe("★ a financial tool may be set to Execute, and it is recorded", () => {
  it("stores mode never for Create coupon and audits who, tool, before and after", async () => {
    const res = await put("woocommerce.create_coupon", { requiresApproval: false });

    expect(res.status).toBe(200);
    const write = state.writes.find(([w]) => w === "tenantTool.update");
    expect(write?.[1].configOverrides.hitlPolicy.mode).toBe("never");

    expect(approvalAudits()).toHaveLength(1);
    const a = approvalAudits()[0];
    expect(a.actorId).toBe("u-owner");
    expect(a.action).toBe("permission.changed");
    expect(a.targetType).toBe("tenant_tool");
    expect(a.targetId).toBe("tt1");
    expect(a.metadata).toEqual({
      change: "approval_policy",
      tool: "woocommerce.create_coupon",
      riskGroup: "financial",
      // No tenant override yet, so "before" is the catalog's own default.
      before: "ask",
      after: "execute",
      loosened: true,
    });
  });

  it("reads 'before' from the tenant's override when one exists", async () => {
    state.overrides = { hitlPolicy: { mode: "never" } };
    const res = await put("woocommerce.create_coupon", { requiresApproval: true });

    expect(res.status).toBe(200);
    expect(approvalAudits().map((a) => [a.metadata.before, a.metadata.after, a.metadata.loosened]))
      .toEqual([["execute", "ask", false]]);
  });

  it("names a conditional default as conditional", async () => {
    state.catalogHitl = { mode: "on_condition", condition: "args.status == \"cancelled\"" };
    await put("woocommerce.delete_order", { requiresApproval: false });

    expect(approvalAudits()[0].metadata.before).toBe("conditional");
    expect(approvalAudits()[0].metadata.riskGroup).toBe("delete");
  });

  it("writes no audit when nothing changes", async () => {
    const res = await put("woocommerce.create_coupon", { requiresApproval: true });

    expect(res.status).toBe(200);
    expect(approvalAudits()).toHaveLength(0);
  });

  it("writes no approval audit for a tool outside the three groups", async () => {
    state.catalogHitl = { mode: "always" };
    const res = await put("woocommerce.add_order_note", { requiresApproval: false });

    expect(res.status).toBe(200);
    expect(approvalAudits()).toHaveLength(0);
  });

  it("a body without requiresApproval changes no approval and audits none", async () => {
    const res = await put("woocommerce.create_coupon", { enabled: false });

    expect(res.status).toBe(200);
    expect(approvalAudits()).toHaveLength(0);
  });
});

describe("★ the static writer: the same choice, and the default kept", () => {
  it("lets a delete tool run without approval and audits it against its default", async () => {
    const res = await put("delete_note", { requiresApproval: false });

    expect(res.status).toBe(200);
    expect(state.writes[0]).toEqual(["permission.upsert", expect.objectContaining({ requiresApproval: false })]);
    expect(approvalAudits()).toHaveLength(1);
    expect(approvalAudits()[0].targetType).toBe("tenant_tool_permission");
    expect(approvalAudits()[0].metadata).toMatchObject({ tool: "delete_note", riskGroup: "delete", before: "ask", after: "execute" });
  });

  it("reads 'before' from the stored row when there is one", async () => {
    state.permissionRow = { requiresApproval: false };
    await put("delete_note", { requiresApproval: true });

    expect(approvalAudits()[0].metadata).toMatchObject({ before: "execute", after: "ask", loosened: false });
  });

  it("★ a first write that only enables a tool keeps its 'Ask me' default", async () => {
    // Was: the row was created with requiresApproval:false, so switching a tool
    // on silently made it run without approval.
    const res = await put("update_contact", { enabled: true });

    expect(res.status).toBe(200);
    expect(state.writes[0]).toEqual(["permission.upsert", expect.objectContaining({ requiresApproval: true, enabled: true })]);
  });

  it("a tool whose default runs is still created without approval", async () => {
    // The control for the test above: the default is the gate's, not "ask".
    await put("archive_note", { enabled: true });
    expect(state.writes[0]).toEqual(["permission.upsert", expect.objectContaining({ requiresApproval: false })]);
  });
});

describe("★ HIGH_RISK_AUTORUN=off restores the wall", () => {
  it("refuses Create coupon with 422 and writes and audits nothing", async () => {
    process.env.HIGH_RISK_AUTORUN = "off";
    const res = await put("woocommerce.create_coupon", { requiresApproval: false });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("approval_cannot_be_removed");
    expect(res.body.riskGroup).toBe("financial");
    expect(state.writes).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("refuses the static writer too", async () => {
    process.env.HIGH_RISK_AUTORUN = "OFF ";
    const res = await put("delete_note", { requiresApproval: false });

    expect(res.status).toBe(422);
    expect(state.writes).toHaveLength(0);
  });

  it("still lets approval be turned ON", async () => {
    process.env.HIGH_RISK_AUTORUN = "off";
    state.overrides = { hitlPolicy: { mode: "never" } };
    const res = await put("woocommerce.create_coupon", { requiresApproval: true });

    expect(res.status).toBe(200);
  });

  it("any other value leaves the choice open", async () => {
    process.env.HIGH_RISK_AUTORUN = "on";
    expect((await put("woocommerce.create_coupon", { requiresApproval: false })).status).toBe(200);
  });
});

describe("★ the list read says what the PUT will accept", () => {
  const rows = async () => {
    const res = await request(app).get("/api/tool-permissions");
    expect(res.status).toBe(200);
    return Object.fromEntries((res.body.data as any[]).map((r) => [r.toolName, r]));
  };

  it("offers Execute for every group by default, with the default still Ask me", async () => {
    const r = await rows();
    expect(r["woocommerce.create_coupon"]).toMatchObject({ riskGroup: "financial", autoRunAllowed: true, requiresApproval: true });
    expect(r["delete_note"]).toMatchObject({ riskGroup: "delete", autoRunAllowed: true, requiresApproval: true });
    expect(r["send_message"].autoRunAllowed).toBe(true);
  });

  it("withholds it for the three groups only, while the switch is off", async () => {
    process.env.HIGH_RISK_AUTORUN = "off";
    const r = await rows();
    expect(r["woocommerce.create_coupon"].autoRunAllowed).toBe(false);
    expect(r["delete_note"].autoRunAllowed).toBe(false);
    expect(r["send_message"].autoRunAllowed).toBe(true);
  });
});
