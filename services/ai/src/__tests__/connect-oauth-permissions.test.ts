/**
 * 2026-10-09: who may START a legacy OAuth connect, and what "not configured"
 * says to a machine.
 *
 *   - Zoho, Google Calendar and Calendly gate on the connect permission every
 *     other integration uses (integrations:connections:connect OR
 *     business-systems:connections:connect), not role ADMIN. A member who was
 *     delegated connect got 403 here while HubSpot let them in.
 *   - Drive and Confluence gate on ai:knowledge:write (like every knowledge
 *     write), with the ADMIN role fallback routes/knowledge.ts uses.
 *   - A missing client id / redirect answers 500 with the human text it always
 *     had PLUS `code: "NOT_CONFIGURED"`.
 *
 * The REAL gates and the REAL permission resolver run here; only the rows they
 * read are doubled, and each double honours its `where`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.FRONTEND_URL = "https://app.example.test";
  process.env.OAUTH_STATE_SECRET = "oauth-state-secret-for-tests-only-32chars";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});

vi.mock("ioredis", () => ({
  default: class { on = vi.fn(); quit = vi.fn(); publish = vi.fn(); subscribe = vi.fn(); async set() { return "OK"; } async get() { return null; } },
}));
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));

const DB = vi.hoisted(() => ({
  grants: [] as Array<{ userId: string; feature: string; granted: boolean; expiresAt: Date | null }>,
  license: [] as Array<{ tenantId: string; feature: string; enabled: boolean }>,
  knowledgeIntegrations: [] as any[],
}));

const prismaDouble = vi.hoisted(() => ({
  userFeatureGrant: { findMany: async (a: any) => DB.grants.filter((g) => g.userId === a.where.userId) },
  tenantFeature: { findMany: async (a: any) => DB.license.filter((l) => l.tenantId === a.where.tenantId) },
  // No assignment rows: every user resolves through the legacy-enum bridge.
  userRoleAssignment: { findMany: async () => [], findFirst: async () => null },
  knowledgeIntegration: {
    findFirst: async (a: any) =>
      DB.knowledgeIntegrations.find((k) =>
        k.tenantId === a.where.tenantId && k.knowledgeBaseId === a.where.knowledgeBaseId && k.provider === a.where.provider) ?? null,
  },
}));

vi.mock("../../../../packages/shared/src/lib/prisma", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, prisma: prismaDouble };
});

const USERS: Record<string, { userId: string; role: string }> = {
  admin: { userId: "u_admin", role: "ADMIN" },
  connector: { userId: "u_connector", role: "AGENT" },
  bsConnector: { userId: "u_bs", role: "AGENT" },
  writer: { userId: "u_writer", role: "AGENT" },
  agent: { userId: "u_agent", role: "AGENT" },
};

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    prisma: prismaDouble,
    authenticate: (req: any, _r: any, n: any) => {
      const u = USERS[String(req.headers["x-test-user"])];
      req.user = { ...u, tenantId: "tenant_a" };
      req.userId = u.userId;
      n();
    },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = String(req.headers["x-test-tenant"] || "tenant_a"); n(); },
    requireActiveTenant: () => pass,
    requireOnboardingOrActiveTenant: () => pass,
  };
});

import crmRouter from "../routes/crm-oauth";
import calendarRouter from "../routes/calendar-oauth";
import knowledgeRouter from "../routes/knowledge-oauth";
import { invalidatePermissionsCache } from "@chatcenter/shared";

const app = express();
app.use("/api/integrations", crmRouter);
app.use("/api/integrations", calendarRouter);
app.use("/api/knowledge", knowledgeRouter);

const ENV: Record<string, string> = {
  ZOHO_CLIENT_ID: "z",
  ZOHO_REDIRECT_URI: "https://app.example.test/api/integrations/oauth/zoho_crm/callback",
  GOOGLE_CLIENT_ID: "g",
  GOOGLE_CALENDAR_REDIRECT_URI: "https://app.example.test/api/integrations/oauth/google_calendar/callback",
  GOOGLE_REDIRECT_URI: "https://app.example.test/api/knowledge/oauth/google-drive/callback",
  CALENDLY_CLIENT_ID: "c",
  CALENDLY_REDIRECT_URI: "https://app.example.test/api/integrations/oauth/calendly/callback",
  CONFLUENCE_CLIENT_ID: "cf",
  CONFLUENCE_REDIRECT_URI: "https://app.example.test/api/knowledge/oauth/confluence/callback",
};

const grant = (userId: string, feature: string) => ({ userId, feature, granted: true, expiresAt: null });

beforeEach(() => {
  Object.assign(process.env, ENV);
  DB.grants = [
    grant("u_connector", "integrations:connections:connect"),
    grant("u_bs", "business-systems:connections:connect"),
    grant("u_writer", "ai:knowledge:write"),
  ];
  DB.license = [];
  DB.knowledgeIntegrations = [];
  invalidatePermissionsCache();
});

const get = (path: string, user: string, tenant = "tenant_a") =>
  request(app).get(path).set("x-test-user", user).set("x-test-tenant", tenant);

const CONNECT_INITS = [
  { name: "Zoho", path: "/api/integrations/oauth/zoho_crm/init", env: "ZOHO_CLIENT_ID", text: "Zoho OAuth not configured (set ZOHO_CLIENT_ID + ZOHO_REDIRECT_URI)" },
  { name: "Google Calendar", path: "/api/integrations/oauth/google_calendar/init?aiAgentId=ag_1", env: "GOOGLE_CALENDAR_REDIRECT_URI", text: "Google Calendar OAuth not configured" },
  { name: "Google Calendar (dashed alias)", path: "/api/integrations/oauth/google-calendar/init?aiAgentId=ag_1", env: "GOOGLE_CLIENT_ID", text: "Google Calendar OAuth not configured" },
  { name: "Calendly", path: "/api/integrations/oauth/calendly/init?aiAgentId=ag_1", env: "CALENDLY_CLIENT_ID", text: "Calendly OAuth not configured" },
] as const;

const KNOWLEDGE_INITS = [
  { name: "Google Drive", path: "/api/knowledge/oauth/google-drive/init?kbId=kb_1", env: "GOOGLE_REDIRECT_URI", text: "Google Drive OAuth not configured" },
  { name: "Confluence", path: "/api/knowledge/oauth/confluence/init?kbId=kb_1", env: "CONFLUENCE_CLIENT_ID", text: "Confluence OAuth not configured" },
] as const;

describe.each(CONNECT_INITS)("$name init: the integrations connect permission", (c) => {
  it("ADMIN still starts it", async () => {
    const r = await get(c.path, "admin");
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\//);
  });

  // Role ceilings (Omer, 2026-10-11): connecting a system is something an
  // Agent can NEVER hold - a per-user grant of either connect key no longer
  // lifts it (permission-catalog ROLE_CEILINGS, enforced in hasPermission).
  // These two cases asserted the opposite before the ceilings existed.
  it("★ an Agent GRANTED integrations:connections:connect is still refused: the Agent ceiling", async () => {
    const r = await get(c.path, "connector");
    expect(r.status).toBe(403);
    expect(r.body.url).toBeUndefined();
  });

  it("★ an Agent GRANTED business-systems:connections:connect is still refused: the Agent ceiling", async () => {
    expect((await get(c.path, "bsConnector")).status).toBe(403);
  });

  it("★ a member without it is refused, and so is a knowledge-only writer", async () => {
    const r = await get(c.path, "agent");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("PERMISSION_DENIED");
    expect(r.body.url).toBeUndefined();
    expect((await get(c.path, "writer")).status).toBe(403);
  });

  it("a revoked grant refuses even where the role would allow", async () => {
    DB.grants.push({ userId: "u_admin", feature: "integrations:connections:connect", granted: false, expiresAt: null });
    DB.grants.push({ userId: "u_admin", feature: "business-systems:connections:connect", granted: false, expiresAt: null });
    expect((await get(c.path, "admin")).status).toBe(403);
  });

  it("★ not configured → 409 (a 4xx, 2026-10-09) with the same text and code NOT_CONFIGURED", async () => {
    delete process.env[c.env];
    const r = await get(c.path, "admin");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: c.text, code: "NOT_CONFIGURED" });
  });
});

describe.each(KNOWLEDGE_INITS)("$name init: the knowledge write permission", (c) => {
  it("ADMIN still starts it", async () => {
    const r = await get(c.path, "admin");
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\//);
  });

  it("★ a non-admin holding ai:knowledge:write starts it", async () => {
    const r = await get(c.path, "writer");
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\//);
  });

  it("★ a member without it is refused, and so is an integrations-only connector", async () => {
    const r = await get(c.path, "agent");
    expect(r.status).toBe(403);
    expect(r.body.url).toBeUndefined();
    expect((await get(c.path, "connector")).status).toBe(403);
  });

  it("★ ADMIN passes on the role fallback where the licence turns the permission off; a writer does not", async () => {
    DB.license = [{ tenantId: "tenant_unlicensed", feature: "ai", enabled: false }];
    expect((await get(c.path, "admin", "tenant_unlicensed")).status).toBe(200);
    expect((await get(c.path, "writer", "tenant_unlicensed")).status).toBe(403);
    // The licence row is tenant-scoped: the writer still passes on tenant_a.
    expect((await get(c.path, "writer", "tenant_a")).status).toBe(200);
  });

  it("★ not configured → 409 (a 4xx, 2026-10-09) with the same text and code NOT_CONFIGURED", async () => {
    delete process.env[c.env];
    const r = await get(c.path, "admin");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: c.text, code: "NOT_CONFIGURED" });
  });
});

describe("★ the knowledge management routes behind init take the knowledge write permission (2026-10-09)", () => {
  // A writer who could start a Drive connect could not then browse or sync it.
  it("a writer gets past the gate; a member without the permission does not", async () => {
    expect((await get("/api/knowledge/kb/kb_1/integrations", "writer")).status).not.toBe(403);
    expect((await get("/api/knowledge/kb/kb_1/integrations", "agent")).status).toBe(403);
    expect((await get("/api/knowledge/kb/kb_1/integrations", "admin")).status).not.toBe(403);
  });
});
