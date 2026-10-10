/**
 * ★ Disconnect, then reconnect, leaves the system with its actions (2026-10-10).
 * POST /api/integrations/:slug/disconnect deleted the tenant tool rows and
 * /connect never recreated them on an existing connection, so a reconnect
 * left the AI with no actions for that system. Now:
 *   - disconnect keeps the rows (status DISCONNECTED, credentials cleared),
 *     as /api/connectors/:slug/disconnect always did
 *   - a reconnect recreates only the catalogue tools that are missing,
 *     enabled; rows that exist keep the admin's choices
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } } }));

const DB = vi.hoisted(() => ({ integration: null as any, tools: [] as any[] }));
const CAT_TOOLS = [{ id: "ct_a" }, { id: "ct_b" }];
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      integrationCatalog: { findUnique: async (a: any) => ({ id: "cat_custom", slug: a.where.slug, catalogTools: CAT_TOOLS }) },
      tenantIntegration: {
        findFirst: async (a: any) => (DB.integration && DB.integration.tenantId === a.where.tenantId ? { ...DB.integration } : null),
        update: async (a: any) => { Object.assign(DB.integration, a.data); return { ...DB.integration }; },
        create: async () => { throw new Error("not expected"); },
      },
      tenantTool: {
        deleteMany: async (a: any) => { const before = DB.tools.length; DB.tools = DB.tools.filter((t) => !(t.tenantId === a.where.tenantId && t.tenantIntegrationId === a.where.tenantIntegrationId)); return { count: before - DB.tools.length }; },
        findMany: async (a: any) => DB.tools.filter((t) => t.tenantId === a.where.tenantId && t.tenantIntegrationId === a.where.tenantIntegrationId),
        createMany: async (a: any) => { for (const d of a.data) if (!DB.tools.some((t) => t.tenantIntegrationId === d.tenantIntegrationId && t.catalogToolId === d.catalogToolId)) DB.tools.push({ ...d }); return { count: a.data.length }; },
      },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  };
});

import router from "../routes/integrations";

const app = express();
app.use(express.json());
app.use("/api/integrations", router);

beforeEach(() => {
  DB.integration = { id: "ti_1", tenantId: "tenant_a", integrationId: "cat_custom", status: "CONNECTED" };
  DB.tools = [
    { tenantId: "tenant_a", tenantIntegrationId: "ti_1", catalogToolId: "ct_a", isEnabled: false },
    { tenantId: "tenant_a", tenantIntegrationId: "ti_1", catalogToolId: "ct_b", isEnabled: true },
  ];
});

describe("★ disconnect keeps a system's actions", () => {
  it("disconnect: DISCONNECTED, credentials cleared, the tool rows kept as they were", async () => {
    const r = await request(app).post("/api/integrations/custom_api/disconnect").send({});
    expect(r.status).toBe(200);
    expect(DB.integration).toMatchObject({ status: "DISCONNECTED", credentials: {} });
    expect(DB.tools.map((t) => [t.catalogToolId, t.isEnabled])).toEqual([["ct_a", false], ["ct_b", true]]);
  });

  it("a reconnect after the OLD disconnect (no rows left) gets the catalogue's tools back, enabled", async () => {
    DB.tools = [];
    const r = await request(app).post("/api/integrations/custom_api/connect").send({ credentials: { token: "x" } });
    expect(r.status).toBe(201);
    expect(DB.tools.map((t) => [t.catalogToolId, t.isEnabled]).sort()).toEqual([["ct_a", true], ["ct_b", true]]);
  });

  it("a reconnect keeps the admin's choices on rows that exist, adding only the missing one", async () => {
    DB.tools = [{ tenantId: "tenant_a", tenantIntegrationId: "ti_1", catalogToolId: "ct_a", isEnabled: false }];
    await request(app).post("/api/integrations/custom_api/connect").send({ credentials: { token: "x" } });
    expect(DB.tools.map((t) => [t.catalogToolId, t.isEnabled])).toEqual([["ct_a", false], ["ct_b", true]]);
  });
});
