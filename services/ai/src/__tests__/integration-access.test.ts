/**
 * ★ Per-employee allowlist of business systems (AIAgent.integrationAccess):
 *   - the one shared query: granted + enabled + CONNECTED + on the allowlist
 *     (a tool still granted after a reconnect is NOT reachable when its
 *     system is off the list); AUTO drops ASSIST-only tools
 *   - the dispatch gate denies an integration tool or a custom tool whose
 *     system is off the employee's list (nothing slips past the surface)
 *   - custom API tools / DB queries reach the bot only with "custom:<id>"
 *   - the kernel's grants read the same query
 *   - a new employee starts with every system the workspace has today (any
 *     connection state) and every custom tool; one connected later stays off
 *   - PATCH / POST validate keys (unknown → 422); GET lists allowed + choices
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  agents: [] as any[],
  grants: [] as any[],
  tenantIntegrations: [] as any[],
  catalog: [{ slug: "hubspot", name: "HubSpot" }, { slug: "shopify", name: "Shopify" }, { slug: "woocommerce", name: "WooCommerce" }],
  customApi: [] as any[],
  customDb: [] as any[],
  tenantTool: null as any,
  grantRow: null as any,
  created: [] as any[],
  updated: [] as any[],
  ignoreSlugFilter: false,
}));

const prismaDouble = vi.hoisted(() => {
  const inList = (v: any, list?: { in: any[] }) => !list || list.in.includes(v);
  return {
    aIAgent: {
      findFirst: async (a: any) => H.agents.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId) ?? null,
      create: async (a: any) => { const r = { id: "new_agent", ...a.data }; H.created.push(r); H.agents.push(r); return r; },
      update: async (a: any) => { H.updated.push(a.data); const r = H.agents.find((x) => x.id === a.where.id); Object.assign(r, a.data); return r; },
    },
    agentToolPermission: {
      findMany: async (a: any) => H.grants.filter((g) =>
        g.tenantId === a.where.tenantId && g.aiAgentId === a.where.aiAgentId && g.isAllowed === true
        && g.tenantTool.isEnabled === true && g.tenantTool.tenantIntegration.status === "CONNECTED"
        && (H.ignoreSlugFilter || inList(g.tenantTool.tenantIntegration.integration.slug, a.where.tenantTool?.tenantIntegration?.integration?.slug))),
      findFirst: async () => H.grantRow,
      count: async (a: any) => H.grants.filter((g) => g.aiAgentId === a.where.aiAgentId).length,
    },
    tenantIntegration: { findMany: async (a: any) => H.tenantIntegrations.filter((t) => t.tenantId === a.where.tenantId && (!a.where.status || t.status === a.where.status)) },
    integrationCatalog: { findMany: async (a: any) => H.catalog.filter((c) => inList(c.slug, a.where?.slug)) },
    customApiTool: {
      findMany: async (a: any) => H.customApi.filter((c) => c.tenantId === a.where.tenantId && inList(c.id, a.where.id)),
      findUnique: async (a: any) => H.customApi.find((c) => c.tenantId === a.where.tenantId_slug.tenantId && c.slug === a.where.tenantId_slug.slug) ?? null,
    },
    customDbQueryTool: {
      findMany: async (a: any) => H.customDb.filter((c) => c.tenantId === a.where.tenantId && inList(c.id, a.where.id)),
      findUnique: async (a: any) => H.customDb.find((c) => c.tenantId === a.where.tenantId_slug.tenantId && c.slug === a.where.tenantId_slug.slug) ?? null,
    },
    tenantTool: { findFirst: async () => H.tenantTool, findUnique: async () => ({ configOverrides: {}, isEnabled: true }) },
    tenantToolPermission: { findUnique: async () => null },
  };
});

vi.mock("../../../../packages/shared/src/lib/prisma", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, prisma: prismaDouble };
});
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    prisma: prismaDouble,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN", tenantId: "T" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requirePermissionOrRole: () => pass,
    requireEntitlement: () => pass,
    requireCapacity: () => pass,
  };
});
vi.mock("../services/connectors/custom-api.service", () => ({ listCustomApiTools: async (t: string) => H.customApi.filter((c) => c.tenantId === t).map((c) => ({ ...c, description: "d", whenToUse: "w", parameters: {} })) }));
vi.mock("../services/connectors/custom-db.service", () => ({ listCustomDbQueryTools: async (t: string) => H.customDb.filter((c) => c.tenantId === t).map((c) => ({ ...c, description: "d", whenToUse: "w", parameters: {} })) }));

import { allowedIntegrationToolKeys, defaultIntegrationAccess, validateIntegrationAccess, evaluatePolicies } from "@chatcenter/shared";
import { customToolDefinitions } from "../services/ai-bot.service";
import { loadToolGrants } from "../services/agent-loop/permissions-bridge";
import aiAgents from "../routes/ai-agents";

const grant = (integ: string, tool: string, o: any = {}) => ({
  tenantId: "T", aiAgentId: "maya", isAllowed: true,
  tenantTool: { isEnabled: true, tenantIntegration: { status: "CONNECTED", integration: { slug: integ } }, catalogTool: { slug: tool, allowedModes: o.modes ?? ["AUTO", "ASSIST"] } },
});
const app = () => { const a = express(); a.use(express.json()); a.use("/api/ai-agents", aiAgents); return a; };

beforeEach(() => {
  H.agents = [{ id: "maya", tenantId: "T", name: "Maya", status: "ACTIVE", role: "customer_support", integrationAccess: ["shopify", "custom:api_1"] }];
  H.grants = [grant("shopify", "get_order"), grant("hubspot", "create_note"), grant("shopify", "assist_only", { modes: ["ASSIST"] })];
  H.tenantIntegrations = [
    { tenantId: "T", status: "CONNECTED", integration: { slug: "shopify", name: "Shopify" } },
    { tenantId: "T", status: "ERROR", integration: { slug: "hubspot", name: "HubSpot" } },
    { tenantId: "OTHER", status: "CONNECTED", integration: { slug: "woocommerce", name: "WooCommerce" } },
  ];
  H.customApi = [{ id: "api_1", tenantId: "T", slug: "lookup", name: "Lookup", isActive: true, category: "READ", riskLevel: "LOW" }, { id: "api_2", tenantId: "T", slug: "push", name: "Push", isActive: true, category: "READ", riskLevel: "LOW" }];
  H.customDb = [{ id: "db_1", tenantId: "T", slug: "orders_sql", name: "Orders", isActive: true, category: "READ", riskLevel: "LOW" }];
  H.tenantTool = null; H.grantRow = null; H.created = []; H.updated = []; H.ignoreSlugFilter = false;
});

describe("★ the one shared query", () => {
  it("a granted tool of a system off the allowlist is not reachable; AUTO drops ASSIST-only", async () => {
    expect([...(await allowedIntegrationToolKeys("T", "maya", { mode: "AUTO" }))]).toEqual(["shopify:get_order"]);
    expect([...(await allowedIntegrationToolKeys("T", "maya"))].sort()).toEqual(["shopify:assist_only", "shopify:get_order"]);
  });

  it("even if the query let an off-list system through, the result drops it", async () => {
    H.ignoreSlugFilter = true;
    expect([...(await allowedIntegrationToolKeys("T", "maya", { mode: "AUTO" }))]).toEqual(["shopify:get_order"]);
  });

  it("an unknown employee reaches nothing", async () => {
    expect([...(await allowedIntegrationToolKeys("T", "ghost"))]).toEqual([]);
    expect([...(await allowedIntegrationToolKeys("OTHER", "maya"))]).toEqual([]);
  });

  it("the kernel's grants read it (slugs of allowed tools only)", async () => {
    const g = await loadToolGrants("T", "maya");
    expect([...g.allowedToolSlugs].sort()).toEqual(["assist_only", "get_order"]);
    expect(g.allowedToolSlugs.has("create_note")).toBe(false);
  });
});

describe("★ the dispatch gate (backstop)", () => {
  it("an integration tool granted to the employee but off its allowlist is denied; on it, allowed", async () => {
    H.tenantTool = { id: "tt1", isEnabled: true, catalogTool: { hitlPolicy: { mode: "never" } }, tenantIntegration: { status: "CONNECTED", integration: { slug: "hubspot" } } };
    H.grantRow = { isAllowed: true };
    expect((await evaluatePolicies({ tenantId: "T", toolName: "hubspot.create_note", aiAgentId: "maya" })).decision).toBe("DENY");
    H.agents[0].integrationAccess = ["hubspot"];
    expect((await evaluatePolicies({ tenantId: "T", toolName: "hubspot.create_note", aiAgentId: "maya" })).decision).toBe("ALLOW");
  });

  it("a custom tool off the allowlist is denied for the employee; on it, allowed; a human action (no employee) unaffected", async () => {
    expect((await evaluatePolicies({ tenantId: "T", toolName: "custom.push", aiAgentId: "maya" })).decision).toBe("DENY");
    expect((await evaluatePolicies({ tenantId: "T", toolName: "custom.lookup", aiAgentId: "maya" })).decision).toBe("ALLOW");
    expect((await evaluatePolicies({ tenantId: "T", toolName: "custom_db.orders_sql", aiAgentId: "maya" })).decision).toBe("DENY");
    expect((await evaluatePolicies({ tenantId: "T", toolName: "custom.push" })).decision).toBe("ALLOW");
  });
});

describe("★ custom tools on the bot's surface", () => {
  it("only those with their custom:<id> key", async () => {
    expect((await customToolDefinitions("T", "maya")).map((t) => t.function.name)).toEqual(["custom.lookup"]);
    H.agents[0].integrationAccess = ["custom:db_1", "custom:api_2"];
    expect((await customToolDefinitions("T", "maya")).map((t) => t.function.name)).toEqual(["custom.push", "custom_db.orders_sql"]);
  });
});

describe("a new employee's allowlist", () => {
  it("defaults to every system the workspace has today (any state) and every custom tool, never another tenant's", async () => {
    expect(await defaultIntegrationAccess("T")).toEqual(["custom:api_1", "custom:api_2", "custom:db_1", "hubspot", "shopify"]);
  });

  it("validation: catalog slugs and this workspace's custom ids only", async () => {
    expect(await validateIntegrationAccess("T", ["woocommerce", "custom:api_1", "woocommerce"])).toEqual({ ok: true, keys: ["custom:api_1", "woocommerce"] });
    expect(await validateIntegrationAccess("T", ["nope"])).toEqual({ ok: false, invalid: "nope" });
    H.customApi.push({ id: "api_x", tenantId: "OTHER", slug: "x" });
    expect(await validateIntegrationAccess("T", ["custom:api_x"])).toEqual({ ok: false, invalid: "custom:api_x" });
    expect((await validateIntegrationAccess("T", "shopify")).ok).toBe(false);
  });
});

describe("★ routes", () => {
  it("PATCH saves a checked list; an unknown key is 422 and nothing is saved", async () => {
    const bad = await request(app()).patch("/api/ai-agents/maya").send({ integrationAccess: ["shopify", "made_up"] });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: "INVALID_INTEGRATION_ACCESS", invalid: "made_up" });
    expect(H.updated).toEqual([]);
    const ok = await request(app()).patch("/api/ai-agents/maya").send({ integrationAccess: ["hubspot", "shopify"] });
    expect(ok.status).toBeLessThan(300);
    expect(H.agents[0].integrationAccess).toEqual(["hubspot", "shopify"]);
  });

  it("POST without a list starts with today's systems; with one, that list (checked)", async () => {
    await request(app()).post("/api/ai-agents").send({ name: "Dan", goal: "help" });
    expect(H.created[0].integrationAccess).toEqual(["custom:api_1", "custom:api_2", "custom:db_1", "hubspot", "shopify"]);
    await request(app()).post("/api/ai-agents").send({ name: "Eli", goal: "help", integrationAccess: ["shopify"] });
    expect(H.created[1].integrationAccess).toEqual(["shopify"]);
    const bad = await request(app()).post("/api/ai-agents").send({ name: "Bad", goal: "help", integrationAccess: ["zzz"] });
    expect(bad.status).toBe(422);
    expect(H.created).toHaveLength(2);
  });

  it("GET /:id/integration-access: allowed + the workspace's choices; another tenant's employee is 404", async () => {
    const r = await request(app()).get("/api/ai-agents/maya/integration-access");
    expect(r.body.data.allowed).toEqual(["shopify", "custom:api_1"]);
    expect(r.body.data.choices).toEqual([
      { key: "shopify", kind: "integration", name: "Shopify", status: "CONNECTED" },
      { key: "hubspot", kind: "integration", name: "HubSpot", status: "ERROR" },
      { key: "custom:api_1", kind: "custom_api", name: "Lookup", status: "ACTIVE" },
      { key: "custom:api_2", kind: "custom_api", name: "Push", status: "ACTIVE" },
      { key: "custom:db_1", kind: "custom_db", name: "Orders", status: "ACTIVE" },
    ]);
    H.agents[0].tenantId = "OTHER";
    expect((await request(app()).get("/api/ai-agents/maya/integration-access")).status).toBe(404);
  });
});
