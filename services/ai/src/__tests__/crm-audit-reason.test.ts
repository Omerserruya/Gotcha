/**
 * A failed CRM close-sync is audited as "[CODE] sentence", never the
 * provider's raw error page. Found 2026-10-11: two crm.sync_close.err rows
 * each stored the first ~300 characters of Shopify's HTML 401 page from a token
 * refresh. The raw text belongs in the service log only.
 *
 * Through the real POST /sync-close route: Shopify as the CRM (the dev case,
 * whose adapter passes the provider's text through), and Zoho for the rest.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  prisma: {
    tenantIntegration: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn() },
    contact: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    conversation: { findFirst: vi.fn() },
    message: { findFirst: vi.fn(), count: vi.fn() },
    auditLog: { create: vi.fn(), findFirst: vi.fn() },
  } as any,
  refresh: vi.fn(),
  executeAdapterTool: vi.fn(),
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: mocks.prisma,
    authenticate: (req: any, _res: any, next: any) => { req.user = { id: "u", role: "ADMIN" }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "t1"; next(); },
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requireRole: () => (_req: any, _res: any, next: any) => next(),
    encryptCredentials: (x: any) => x,
    decryptCredentials: (x: any) => x,
    assertPublicUrl: async (u: string) => new URL(u),
    resolveEffectiveLocale: async () => ({ effective: "en", tenantDefault: "en", userOverride: null }),
  };
});
vi.mock("../services/conversation-intelligence.service", () => ({
  getConversationIntelligence: vi.fn().mockResolvedValue({ summary: "s", sentiment: null, qualification: null, actionItems: [] }),
  getConversationReplay: vi.fn(),
}));
vi.mock("../services/conversation-analysis.service", () => ({ analyzeConversationOnClose: vi.fn() }));
vi.mock("../services/zoho.service", () => ({
  maybeRefreshZohoToken: mocks.refresh,
  ZOHO_DEFAULT_SCOPES: "",
  exchangeZohoCode: vi.fn(),
  getZohoAccountsUrl: () => "https://accounts.zoho.com",
  refreshZohoAccessToken: vi.fn(),
}));
vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: mocks.executeAdapterTool, loadConnection: vi.fn(), registerAdapter: vi.fn(), ensureFreshToken: vi.fn(),
  setConnectionStatus: vi.fn(), persistCredentials: vi.fn(), idempotencyKey: vi.fn().mockReturnValue("k"),
}));

import crmPanelRoutes, { auditReason } from "../routes/crm-panel";
import { __resetCrmAdapterCache } from "../services/connectors/crm-adapter-resolver";

const HTML_401 = "Token refresh failed for shopify: shopify_token_refresh_failed_401: <!DOCTYPE html>\n<html lang=\"en\">\n<head><title>unauthorized - Oauth error invalid_request</title>";
const originalFetch = global.fetch;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/crm", crmPanelRoutes);
  return a;
}

let lastBody: any = null;
async function syncClose() {
  const res = await request(app()).post("/api/crm/conversation/conv1/sync-close").send({});
  lastBody = res.body;
  const row = mocks.prisma.auditLog.create.mock.calls.map((c: any) => c[0].data).find((d: any) => d.action.startsWith("crm.sync_close"));
  return row;
}

beforeEach(() => {
  __resetCrmAdapterCache();
  vi.clearAllMocks();
  global.fetch = originalFetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.prisma.tenant.findUnique.mockResolvedValue({ id: "t1" });
  mocks.prisma.auditLog.findFirst.mockResolvedValue(null);
  mocks.prisma.tenantIntegration.findFirst.mockResolvedValue({
    id: "ti", credentials: { accessToken: "a" }, config: { baseUrl: "https://www.zohoapis.com", authScheme: "Zoho-oauthtoken" },
    integration: { slug: "zoho_crm" },
  });
  mocks.prisma.conversation.findFirst.mockResolvedValue({
    id: "conv1", channel: "WHATSAPP", customerExternalId: "+15551111", status: "CLOSED",
    createdAt: new Date("2026-10-11T09:00:00Z"), closedAt: new Date("2026-10-11T09:05:00Z"), aiSummary: null,
  });
  const meta = { crmContactId: "lead_1", crmObjectKind: "lead" };
  mocks.prisma.contact.findFirst.mockResolvedValue({ id: "c1", email: "j@example.com", phone: "+15551111", displayName: "J", metadata: meta });
  mocks.prisma.contact.findUnique.mockResolvedValue({ metadata: meta });
  mocks.prisma.message.count.mockResolvedValue(3);
  mocks.prisma.message.findFirst.mockResolvedValue({ direction: "INBOUND" });
  mocks.refresh.mockResolvedValue("fresh");
});

describe("crm.sync_close.err audit reason", () => {
  it("Shopify as the CRM, its token refresh refused with an HTML 401 page: a code and a sentence, no HTML, raw text in the service log", async () => {
    mocks.prisma.tenantIntegration.findFirst.mockImplementation(async (a: any) =>
      a?.where?.integration?.slug === "shopify"
        ? { id: "ti_s", status: "ERROR", config: {}, credentials: {}, integration: { slug: "shopify" } }
        : null);
    mocks.executeAdapterTool.mockResolvedValue({ ok: false, reason: HTML_401 });

    const row = await syncClose();

    expect(row.action).toBe("crm.sync_close.err");
    expect(row.metadata.vendor).toBe("shopify");
    expect(row.metadata.reason).toBe("[CREDENTIALS_INVALID] The system rejected these credentials.");
    expect(JSON.stringify(row.metadata)).not.toMatch(/DOCTYPE|<html|Oauth error/);
    // The client gets the same code, never the page.
    expect(lastBody.data).toMatchObject({ synced: false, vendor: "shopify", reason: "[CREDENTIALS_INVALID] The system rejected these credentials." });
    expect(JSON.stringify(lastBody)).not.toMatch(/DOCTYPE|<html|Oauth error/);
    const rawLine = (console.warn as any).mock.calls.find((c: any[]) => String(c[0]).includes("crm.sync_close.err conv=conv1 reason raw:"));
    expect(String(rawLine?.[1] ?? "")).toContain("DOCTYPE");
  });

  it("the CRM answering 503: CONNECTION_FAILED", async () => {
    // @ts-ignore
    global.fetch = vi.fn(async () => new Response("<html>Service Unavailable</html>", { status: 503 }));

    const row = await syncClose();

    expect(row.action).toBe("crm.sync_close.err");
    expect(row.metadata.reason).toBe("[CONNECTION_FAILED] The system could not be reached.");
    expect(lastBody.data.reason).toBe("[CONNECTION_FAILED] The system could not be reached.");
  });

  it("a successful sync's row is untouched", async () => {
    // @ts-ignore
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ status: "success", details: { id: "n1" } }] }), { status: 201, headers: { "Content-Type": "application/json" } }));

    const row = await syncClose();

    expect(row.action).toBe("crm.sync_close.ok");
    expect(row.metadata.ok).toBe(true);
  });
});

describe("auditReason", () => {
  it("keeps a short code, maps credentials and reachability, and hides any other long text", () => {
    expect(auditReason("no_crm_link")).toBe("no_crm_link");
    expect(auditReason("not_found")).toBe("not_found");
    expect(auditReason(undefined)).toBeUndefined();
    expect(auditReason("shopify_token_refresh_failed_403")).toBe("[CREDENTIALS_INVALID] The system rejected these credentials.");
    expect(auditReason("HTTP 401 Unauthorized")).toBe("[CREDENTIALS_INVALID] The system rejected these credentials.");
    expect(auditReason("connect ECONNREFUSED 10.0.0.1:443")).toBe("[CONNECTION_FAILED] The system could not be reached.");
    expect(auditReason("zoho_http_502")).toBe("[CONNECTION_FAILED] The system could not be reached.");
    expect(auditReason("Field Lead_Source has an invalid value <b>x</b>")).toBe("[CRM_REQUEST_FAILED] The CRM did not accept the request.");
  });
});

describe("other CRM responses never carry the provider's page", () => {
  it("POST /notes failing with an HTML 401: 502 with the code", async () => {
    mocks.prisma.tenantIntegration.findFirst.mockImplementation(async (a: any) =>
      a?.where?.integration?.slug === "shopify"
        ? { id: "ti_s", status: "ERROR", config: {}, credentials: {}, integration: { slug: "shopify" } }
        : null);
    mocks.executeAdapterTool.mockResolvedValue({ ok: false, reason: HTML_401 });

    const res = await request(app()).post("/api/crm/conversation/conv1/notes").send({ body: "hello" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("[CREDENTIALS_INVALID] The system rejected these credentials.");
    expect(JSON.stringify(res.body)).not.toMatch(/DOCTYPE|<html/);
  });
});
