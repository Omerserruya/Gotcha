/**
 * The "Choose what needs your approval" setup step closes on an EXPLICIT
 * merchant choice made on the tool-permissions screen, not only on the legacy
 * BusinessPolicy fields - and never on a seed.
 *
 * TenantTool rows are seeded on every connect with configOverrides {}; the
 * catalogue's own "always" lives on CatalogTool, not on the tenant row. Only
 * the permissions PUT writes configOverrides.hitlPolicy, and only it writes
 * TenantToolPermission rows. The double below evaluates the same `where` the
 * route sends, including the JSON path filter, so a seeded row really is
 * excluded by the query and not by the test's goodwill.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const DB = vi.hoisted(() => ({ policy: null as any, perms: [] as any[], tools: [] as any[] }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const none = { findFirst: async () => null, findMany: async () => [], findUnique: async () => null, count: async () => 0 };
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    prisma: {
      channelAccount: none, tenantIntegration: none, knowledgeDocument: none, aIAgent: none, conversation: none,
      user: none, billableEntityTenant: none, subscription: none,
      tenant: { findUnique: async () => ({ status: "ACTIVE", createdAt: new Date("2026-09-01") }) },
      businessPolicy: { findUnique: async () => DB.policy },
      tenantToolPermission: {
        findMany: async (a: any) => {
          if (a.where.tenantId !== "T") throw new Error("tenant guard");
          return DB.perms.filter((p) => p.enabled === a.where.enabled && p.requiresApproval === a.where.requiresApproval);
        },
      },
      tenantTool: {
        findMany: async (a: any) => {
          if (a.where.tenantId !== "T") throw new Error("tenant guard");
          const cats: string[] = a.where.catalogTool.category.in;
          const { path, equals } = a.where.configOverrides;
          return DB.tools.filter((t) => {
            let v: any = t.configOverrides;
            for (const k of path) v = v?.[k];
            return t.isEnabled === a.where.isEnabled && cats.includes(t.category) && v === equals;
          });
        },
      },
    },
  };
});

import router from "../routes/setup-state";

const app = express();
app.use("/api", router);
const step = async () => {
  const r = await request(app).get("/api/setup/state");
  return r.body.data.steps.find((s: any) => s.id === "approval_limits");
};
const D1 = new Date("2026-10-01T10:00:00Z");
const D2 = new Date("2026-10-03T10:00:00Z");

beforeEach(() => { DB.policy = null; DB.perms = []; DB.tools = []; });

describe("approval_limits", () => {
  it("not done with nothing set", async () => {
    expect((await step()).state).not.toBe("done");
  });

  it("★ a SEEDED tenant tool (configOverrides {}) on a write action does NOT close it", async () => {
    DB.tools = [{ isEnabled: true, category: "ACTION", configOverrides: {}, updatedAt: D1 }];
    expect((await step()).state).not.toBe("done");
  });

  it("★ the merchant setting 'Ask me' on an action closes it, dated when they did", async () => {
    DB.tools = [{ isEnabled: true, category: "ACTION", configOverrides: { hitlPolicy: { mode: "always" } }, updatedAt: D2 }];
    expect(await step()).toMatchObject({ state: "done", completedAt: D2.toISOString() });
  });

  it("'Do it' (mode never) or a READ tool does not count", async () => {
    DB.tools = [
      { isEnabled: true, category: "ACTION", configOverrides: { hitlPolicy: { mode: "never" } }, updatedAt: D1 },
      { isEnabled: true, category: "READ", configOverrides: { hitlPolicy: { mode: "always" } }, updatedAt: D1 },
    ];
    expect((await step()).state).not.toBe("done");
  });

  it("a disabled action ('Never') does not count", async () => {
    DB.tools = [{ isEnabled: false, category: "WRITE", configOverrides: { hitlPolicy: { mode: "always" } }, updatedAt: D1 }];
    expect((await step()).state).not.toBe("done");
  });

  it("★ a static-tool permission row requiring approval counts, unless the tool is read-only", async () => {
    DB.perms = [{ toolName: "get_contact", enabled: true, requiresApproval: true, updatedAt: D1 }];
    expect((await step()).state).not.toBe("done");
    DB.perms.push({ toolName: "issue_refund", enabled: true, requiresApproval: true, updatedAt: D2 });
    expect(await step()).toMatchObject({ state: "done", completedAt: D2.toISOString() });
  });

  it("the legacy BusinessPolicy fields still close it (OR), and the earlier date wins", async () => {
    DB.policy = { data: { refundRequiresApproval: true }, updatedAt: D1 };
    expect(await step()).toMatchObject({ state: "done", completedAt: D1.toISOString() });
    DB.tools = [{ isEnabled: true, category: "ACTION", configOverrides: { hitlPolicy: { mode: "always" } }, updatedAt: D2 }];
    expect((await step()).completedAt).toBe(D1.toISOString());
  });
});
