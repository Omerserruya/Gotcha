/**
 * The platform's feed of the AI's failed tool calls (2026-11-18, Omer): SYSTEM_ADMIN only, never a result body.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ rows: [] as any[], where: null as any, erase: [] as any[] }));

vi.mock("../services/billing-checkout", () => ({ hasOpenCheckout: async () => false }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: { auditLog: { findMany: async (a: any) => { H.where = a.where; return H.rows; } } },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "sa1", role: "SYSTEM_ADMIN", tenantId: "SYS" }; n(); },
    requireSystemAdmin: () => (_q: any, _s: any, n: any) => n(),
    crossTenantMiddleware: (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../services/invitation.service", () => ({ InviteRefused: class extends Error {}, inviteUser: async () => ({}), revokeUserAccess: async () => {}, syncIdentityNameByUser: async () => {}, syncMembershipAccess: async () => {}, tenantAdminEntry: async () => null }));
vi.mock("../services/role-guard", () => ({ ownerRemainsWithout: async () => true }));
vi.mock("../services/gdpr.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    eraseTenant: async (tenantId: string, actor: string, opts: any) => {
      H.erase.push({ tenantId, actor, opts });
      return { deleted: true, tenantId, providerLeftovers: [], uploadsRemoved: true };
    },
  };
});
vi.mock("../services/notification.service", () => ({ sendOnboardingEmail: async () => {}, sendPaidOnboardingEmail: async () => {} }));
vi.mock("../services/billing-provisioning.service", () => ({ createProvisioningRequest: async () => ({}), runProvisioning: async () => ({}), provisioningStatusForTenant: async () => ({}) }));
vi.mock("../services/nudge-engine.service", () => ({ scheduleOnboardingNudge: async () => {}, triggerNudgeNow: async () => {} }));
vi.mock("../services/onboarding-state.service", () => ({ listOnboardingSnapshots: async () => [], getOnboardingSnapshot: async () => null }));
vi.mock("../services/setup-link.service", () => ({ issueSetupLink: async () => null }));

import systemRouter from "../routes/system";

const app = express();
app.use(express.json());
app.use("/api/system", systemRouter);
const row = (o: any) => ({ id: `a${Math.random()}`, tenantId: "T1", action: `ai.tool_call.${o.tool}`, targetId: "c1", createdAt: new Date("2026-11-18T07:47:57Z"), metadata: { tool: o.tool, argsSummary: "order_id=97837", outcome: o.outcome, errorCode: o.code, decision: o.decision ?? "allow", result: "SECRET customer address", ms: 8005 } });

describe("GET /api/system/ai-actions/failures", () => {
  beforeEach(() => { H.rows = []; H.where = null; });
  it("★ grouped by tool and error, the latest listed, never a result body", async () => {
    H.rows = [row({ tool: "woocommerce.get_order", outcome: "timeout", code: "timeout" }), row({ tool: "woocommerce.get_order", outcome: "timeout", code: "timeout" }), row({ tool: "woocommerce.add_order_note", outcome: "error", code: "http_403" })];
    const r = await request(app).get("/api/system/ai-actions/failures?hours=6");
    expect(r.status).toBe(200);
    expect(r.body.groups[0]).toMatchObject({ tool: "woocommerce.get_order", errorCode: "timeout", count: 2, tenants: 1 });
    expect(r.body.recent[0]).toMatchObject({ tenantId: "T1", conversationId: "c1", argsSummary: "order_id=97837", ms: 8005 });
    expect(JSON.stringify(r.body)).not.toMatch(/SECRET/);
    expect(H.where.action).toEqual({ startsWith: "ai.tool_call." });
    expect(JSON.stringify(H.where.OR)).toMatch(/timeout/);
  });
  it("filters by tenant and tool; hours bounded", async () => {
    await request(app).get("/api/system/ai-actions/failures?tenantId=T9&tool=woocommerce.get_order&hours=99999");
    expect(H.where).toMatchObject({ tenantId: "T9", action: "ai.tool_call.woocommerce.get_order" });
    expect(H.where.createdAt.gte.getTime()).toBeGreaterThan(Date.now() - 14 * 24 * 3600_000 - 5000);
  });
});

describe("GET /api/system/ai-actions/alerts (the console badge)", () => {
  beforeEach(() => { H.rows = []; H.where = null; delete process.env.AI_ACTION_ALERT_THRESHOLD; });
  it("★ the groups over the threshold in the last hour", async () => {
    process.env.AI_ACTION_ALERT_THRESHOLD = "2";
    H.rows = [row({ tool: "woocommerce.get_order", outcome: "timeout", code: "timeout" }), row({ tool: "woocommerce.get_order", outcome: "timeout", code: "timeout" }), row({ tool: "woocommerce.add_order_note", outcome: "error", code: "http_403" })];
    const r = await request(app).get("/api/system/ai-actions/alerts");
    expect(r.body).toMatchObject({ threshold: 2, count: 1, groups: [{ tool: "woocommerce.get_order", errorCode: "timeout", count: 2 }] });
    expect(H.where.createdAt.gte.getTime()).toBeGreaterThan(Date.now() - 3600_000 - 5000);
  });
  it("5 by default", async () => {
    H.rows = [row({ tool: "x", outcome: "timeout", code: "timeout" })];
    const r = await request(app).get("/api/system/ai-actions/alerts");
    expect(r.body).toMatchObject({ threshold: 5, count: 0 });
  });
});

