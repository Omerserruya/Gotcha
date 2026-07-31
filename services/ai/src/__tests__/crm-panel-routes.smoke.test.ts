/**
 * Smoke test for /api/crm/conversation/:id/* routes.
 *
 * Wires the route into a real Express app via supertest and verifies the
 * full flow:
 *   1. GET /context → unmapped → upgrades to linked after Zoho search hit
 *   2. POST /notes → posts manual note (refuses with 409 when unlinked)
 *   3. POST /sync-close → fires summary + engagement to CRM
 *   4. POST /create-lead → creates a Zoho lead and pins the linkage
 *
 * Everything is mocked: prisma rows for Conversation / Contact / Tenant,
 * Zoho HTTP (fetch), the conversation-intelligence service.
 *
 * Confirms the vertical slice end to end without needing a live Zoho.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => {
  const tenantId = "t1";
  const conversationId = "conv_abc";
  const contactId = "contact_abc";
  const prismaMock: any = {
    tenantIntegration: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn() },
    contact: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    conversation: { findFirst: vi.fn() },
    message: { findFirst: vi.fn(), count: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    prismaMock,
    tenantId,
    conversationId,
    contactId,
    analyzeConversationMock: vi.fn(),
    getConversationIntelligenceMock: vi.fn(),
    getConversationReplayMock: vi.fn(),
    maybeRefreshZohoTokenMock: vi.fn(),
    executeAdapterToolMock: vi.fn(),
  };
});

vi.mock("@chatcenter/shared", () => ({
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: mocks.prismaMock,
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { id: "u_test", role: "ADMIN" };
    next();
  },
  resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = mocks.tenantId; next(); },
  // Factory that returns the middleware - matches the real shared signature.
  requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  encryptCredentials: (x: any) => x,
  decryptCredentials: (x: any) => x,
}));

vi.mock("../services/conversation-intelligence.service", () => ({
  analyzeConversation: mocks.analyzeConversationMock,
  getConversationIntelligence: mocks.getConversationIntelligenceMock,
  getConversationReplay: mocks.getConversationReplayMock,
}));

vi.mock("../services/zoho.service", () => ({
  maybeRefreshZohoToken: mocks.maybeRefreshZohoTokenMock,
  ZOHO_DEFAULT_SCOPES: "",
  exchangeZohoCode: vi.fn(),
  getZohoAccountsUrl: () => "https://accounts.zoho.com",
  refreshZohoAccessToken: vi.fn(),
}));

vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: mocks.executeAdapterToolMock,
  loadConnection: vi.fn(),
  registerAdapter: vi.fn(),
  ensureFreshToken: vi.fn(),
  setConnectionStatus: vi.fn(),
  persistCredentials: vi.fn(),
  idempotencyKey: vi.fn().mockReturnValue("idemp_test"),
}));

import crmPanelRoutes from "../routes/crm-panel";
import { __resetCrmAdapterCache } from "../services/connectors/crm-adapter-resolver";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/crm", crmPanelRoutes);
  return app;
}

const originalFetch = global.fetch;
function stubFetch(impl: (url: string, init: any) => Promise<Response>) {
  // @ts-ignore
  global.fetch = vi.fn(impl);
}
function restoreFetch() { global.fetch = originalFetch; }
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function emptyResp(status: number): Response { return new Response("", { status }); }

function setupZohoConnected() {
  mocks.prismaMock.tenantIntegration.findFirst.mockResolvedValue({
    id: "ti_z",
    credentials: { accessToken: "stale" },
    config: { baseUrl: "https://www.zohoapis.com", authScheme: "Zoho-oauthtoken" },
    integration: { slug: "zoho_crm" },
  });
  mocks.maybeRefreshZohoTokenMock.mockResolvedValue("zoho_access_fresh");
}

function setupConversation(opts: {
  channel?: string;
  customerExternalId?: string;
  startedAt?: Date;
  closedAt?: Date | null;
  email?: string | null;
  phone?: string | null;
  displayName?: string | null;
  crmContactId?: string | null;
  crmObjectKind?: string | null;
} = {}) {
  mocks.prismaMock.conversation.findFirst.mockResolvedValue({
    id: mocks.conversationId,
    channel: opts.channel ?? "WHATSAPP",
    customerExternalId: opts.customerExternalId ?? "+15551111",
    status: "OPEN",
    createdAt: opts.startedAt ?? new Date("2026-05-12T10:00:00Z"),
    closedAt: opts.closedAt ?? null,
    aiSummary: null,
  });
  const meta: Record<string, any> = {};
  if (opts.crmContactId) meta.crmContactId = opts.crmContactId;
  if (opts.crmObjectKind) meta.crmObjectKind = opts.crmObjectKind;
  mocks.prismaMock.contact.findFirst.mockResolvedValue({
    id: mocks.contactId,
    email: opts.email ?? "jane@example.com",
    phone: opts.phone ?? "+15551111",
    displayName: opts.displayName ?? "Jane Doe",
    metadata: meta,
  });
  mocks.prismaMock.contact.findUnique.mockResolvedValue({ metadata: meta });
}

beforeEach(() => {
  __resetCrmAdapterCache();
  vi.clearAllMocks();
  restoreFetch();
  // Tenant row is the gate in resolveFromDb - must return a row or the resolver
  // short-circuits to NoOpCRMAdapter.
  mocks.prismaMock.tenant.findUnique.mockResolvedValue({ id: mocks.tenantId });
  // analyzeConversation default - most tests don't care; sync-close tests override.
  mocks.analyzeConversationMock.mockResolvedValue(undefined);
});

// ─── /context ──────────────────────────────────────────

describe("GET /api/crm/conversation/:id/context", () => {
  it("returns status=unmapped when Zoho is connected but search yields no match", async () => {
    setupZohoConnected();
    setupConversation();
    stubFetch(async (url) => {
      if (url.includes("/Leads/search") || url.includes("/Contacts/search")) return emptyResp(204);
      return emptyResp(204);
    });
    const res = await request(makeApp()).get(`/api/crm/conversation/${mocks.conversationId}/context`);
    expect(res.status).toBe(200);
    expect(res.body.data.vendor).toBe("zoho");
    expect(res.body.data.status).toBe("unmapped");
    expect(res.body.data.fallback).toMatchObject({ email: "jane@example.com" });
  });

  it("returns status=linked when Zoho search finds the contact, and pins the linkage", async () => {
    setupZohoConnected();
    setupConversation();
    stubFetch(async (url) => {
      if (url.includes("/Leads/search")) {
        return json(200, {
          data: [{
            id: "lead_42",
            Full_Name: "Jane Doe",
            First_Name: "Jane",
            Last_Name: "Doe",
            Email: "jane@example.com",
            Phone: "+15551111",
            Lead_Status: "Working",
            Modified_Time: "2026-05-10T10:00:00Z",
            Owner: { id: "ow_1" },
          }],
        });
      }
      if (url.includes("/crm/v6/Leads/lead_42")) {
        return json(200, { data: [{ id: "lead_42", Full_Name: "Jane Doe", Email: "jane@example.com", Modified_Time: "2026-05-10T10:00:00Z" }] });
      }
      return emptyResp(204);
    });

    const res = await request(makeApp()).get(`/api/crm/conversation/${mocks.conversationId}/context`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("linked");
    expect(res.body.data.contact).toMatchObject({ id: "lead_42", display_name: "Jane Doe", kind: "lead" });
    // Linkage pinned on Contact.metadata for v1.
    expect(mocks.prismaMock.contact.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: mocks.contactId },
      data: expect.objectContaining({ metadata: expect.objectContaining({ crmContactId: "lead_42", crmVendor: "zoho" }) }),
    }));
  });

  it("returns status=linked directly when Contact.metadata.crmContactId is already pinned", async () => {
    setupZohoConnected();
    setupConversation({ crmContactId: "lead_pinned", crmObjectKind: "lead" });
    stubFetch(async (url) => {
      if (url.includes("/crm/v6/Leads/lead_pinned")) {
        return json(200, { data: [{ id: "lead_pinned", Full_Name: "P P", Modified_Time: "2026-05-10T10:00:00Z" }] });
      }
      // search should NOT be called
      throw new Error(`unexpected url ${url}`);
    });
    const res = await request(makeApp()).get(`/api/crm/conversation/${mocks.conversationId}/context`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("linked");
    expect(res.body.data.contact.id).toBe("lead_pinned");
  });

  it("returns 404 for unknown conversation", async () => {
    mocks.prismaMock.conversation.findFirst.mockResolvedValueOnce(null);
    const res = await request(makeApp()).get(`/api/crm/conversation/missing/context`);
    expect(res.status).toBe(404);
  });

  it("returns no_crm_configured when no integration is connected", async () => {
    mocks.prismaMock.tenantIntegration.findFirst.mockResolvedValue(null);
    setupConversation();
    const res = await request(makeApp()).get(`/api/crm/conversation/${mocks.conversationId}/context`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("no_crm_configured");
    expect(res.body.data.fallback).toMatchObject({ email: "jane@example.com" });
  });
});

// ─── /notes ────────────────────────────────────────────

describe("POST /api/crm/conversation/:id/notes", () => {
  it("posts a Zoho Note when conversation is linked", async () => {
    setupZohoConnected();
    setupConversation({ crmContactId: "lead_999", crmObjectKind: "lead" });
    let captured: any = null;
    stubFetch(async (url, init) => {
      if (url.includes("/crm/v6/Notes")) {
        captured = JSON.parse(init.body);
        return json(201, { data: [{ status: "success", details: { id: "note_xyz" } }] });
      }
      return emptyResp(204);
    });
    const res = await request(makeApp())
      .post(`/api/crm/conversation/${mocks.conversationId}/notes`)
      .send({ body: "Customer prefers email follow-up." });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ vendor: "zoho", note_id: "note_xyz" });
    expect(captured.data[0]).toMatchObject({
      Parent_Id: { id: "lead_999", module: { api_name: "Leads" } },
      se_module: "Leads",
      Note_Title: "GOTCHA Note",
    });
    expect(captured.data[0].Note_Content).toContain("Customer prefers email follow-up.");
    expect(captured.data[0].Note_Content).toContain(`[gotcha_source_interaction_id=${mocks.conversationId} v=1]`);
  });

  it("returns 400 when body is missing", async () => {
    setupZohoConnected();
    setupConversation({ crmContactId: "lead_999", crmObjectKind: "lead" });
    const res = await request(makeApp())
      .post(`/api/crm/conversation/${mocks.conversationId}/notes`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("body_required");
  });

  it("returns 409 when the conversation has no CRM link yet", async () => {
    setupZohoConnected();
    setupConversation();
    const res = await request(makeApp())
      .post(`/api/crm/conversation/${mocks.conversationId}/notes`)
      .send({ body: "hi" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_crm_link");
  });
});

// ─── /sync-close ───────────────────────────────────────

describe("POST /api/crm/conversation/:id/sync-close", () => {
  it("emits a Zoho note with summary + engagement when linked", async () => {
    setupZohoConnected();
    setupConversation({
      crmContactId: "lead_close",
      crmObjectKind: "lead",
      closedAt: new Date("2026-05-12T10:05:00Z"),
    });
    mocks.prismaMock.message.count.mockResolvedValue(8);
    mocks.prismaMock.message.findFirst.mockResolvedValue({ direction: "INBOUND" });
    mocks.getConversationIntelligenceMock.mockResolvedValue({
      summary: "Customer wants Pro demo.",
      sentiment: "positive",
      qualification: "warm",
      actionItems: ["Send pricing PDF", "Schedule call"],
    });
    let captured: any = null;
    stubFetch(async (url, init) => {
      if (url.includes("/crm/v6/Notes")) {
        captured = JSON.parse(init.body);
        return json(201, { data: [{ status: "success", details: { id: "note_close" } }] });
      }
      return emptyResp(204);
    });

    const res = await request(makeApp())
      .post(`/api/crm/conversation/${mocks.conversationId}/sync-close`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ synced: true, vendor: "zoho", crm_activity_id: "note_close" });
    const body = captured.data[0].Note_Content as string;
    expect(captured.data[0].Note_Title).toBe("GOTCHA - WHATSAPP inbound");
    expect(body).toContain("Duration: 5m 0s");
    expect(body).toContain("Messages: 8");
    expect(body).toContain("Summary:");
    expect(body).toContain("Customer wants Pro demo.");
    expect(body).toContain("Sentiment: positive");
    expect(body).toContain("Qualification: warm");
    expect(body).toContain("- Send pricing PDF");
    expect(body).toContain(`[gotcha_source_interaction_id=${mocks.conversationId} v=1]`);
  });

  it("invokes analyzeConversation when intelligence is missing", async () => {
    setupZohoConnected();
    setupConversation({ crmContactId: "lead_a", crmObjectKind: "lead" });
    mocks.prismaMock.message.count.mockResolvedValue(2);
    mocks.prismaMock.message.findFirst.mockResolvedValue({ direction: "INBOUND" });
    mocks.getConversationIntelligenceMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ summary: "Generated after analyze.", sentiment: null, qualification: null, actionItems: [] });
    stubFetch(async () => json(201, { data: [{ status: "success", details: { id: "note_post" } }] }));

    const res = await request(makeApp())
      .post(`/api/crm/conversation/${mocks.conversationId}/sync-close`)
      .send({});
    expect(res.status).toBe(200);
    expect(mocks.analyzeConversationMock).toHaveBeenCalledWith(mocks.tenantId, mocks.conversationId);
  });

  it("returns synced=false reason=no_crm_link when conversation isn't linked", async () => {
    setupZohoConnected();
    setupConversation();
    const res = await request(makeApp())
      .post(`/api/crm/conversation/${mocks.conversationId}/sync-close`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.synced).toBe(false);
    expect(res.body.data.reason).toBe("no_crm_link");
  });

  it("returns synced=false reason=no_crm_configured when no CRM is connected", async () => {
    mocks.prismaMock.tenantIntegration.findFirst.mockResolvedValue(null);
    setupConversation({ crmContactId: "x", crmObjectKind: "lead" });
    const res = await request(makeApp())
      .post(`/api/crm/conversation/${mocks.conversationId}/sync-close`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.synced).toBe(false);
    expect(res.body.data.reason).toBe("no_crm_configured");
  });
});

// ─── /create-lead ──────────────────────────────────────

describe("POST /api/crm/conversation/:id/create-lead", () => {
  it("creates a Zoho lead and pins the linkage", async () => {
    setupZohoConnected();
    setupConversation();
    let captured: any = null;
    stubFetch(async (url, init) => {
      if (url.endsWith("/crm/v6/Leads")) {
        captured = JSON.parse(init.body);
        return json(201, { data: [{ status: "success", details: { id: "newlead_77" } }] });
      }
      return emptyResp(204);
    });
    const res = await request(makeApp())
      .post(`/api/crm/conversation/${mocks.conversationId}/create-lead`)
      .send({ company: "Acme" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ vendor: "zoho", crm_contact_id: "newlead_77", kind: "lead" });
    expect(captured.data[0]).toMatchObject({
      Email: "jane@example.com",
      Phone: "+15551111",
      Company: "Acme",
      Lead_Source: expect.stringContaining("GOTCHA"),
    });
    expect(mocks.prismaMock.contact.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: mocks.contactId },
      data: expect.objectContaining({ metadata: expect.objectContaining({ crmContactId: "newlead_77" }) }),
    }));
  });
});
