/**
 * Smoke tests for the new CRMAdapter slice.
 *
 * Verifies:
 *   • Resolver maps the slug "zoho_crm" → ZohoCRMAdapter (the live tenant CRM).
 *   • Resolver returns NoOpCRMAdapter when no TenantIntegration is connected.
 *   • Zoho adapter constructs valid v6 requests (URL, headers, body) and
 *     parses responses for find/createLead/createNote/appendInteraction.
 *   • HubSpot adapter dispatches via executeAdapterTool with the right tool
 *     name + args shape.
 *   • renderInteractionBody includes summary + engagement + idempotency marker.
 *
 * Uses vitest.mock to stub `prisma`, `fetch`, and `executeAdapterTool` so the
 * tests run hermetically with zero network or DB.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Stubs that must be set up BEFORE importing the adapter files ────
//
// vi.mock factories are hoisted ABOVE all variable declarations. Anything
// the factory closes over must be declared via vi.hoisted().

const mocks = vi.hoisted(() => {
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
    executeAdapterToolMock: vi.fn(),
    maybeRefreshZohoTokenMock: vi.fn(),
  };
});
const { prismaMock, executeAdapterToolMock, maybeRefreshZohoTokenMock } = mocks;

vi.mock("@chatcenter/shared", () => ({
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: mocks.prismaMock,
  authenticate: (_req: any, _res: any, next: any) => next(),
  resolveTenant: (_req: any, _res: any, next: any) => next(),
  requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  encryptCredentials: (x: any) => x,
  decryptCredentials: (x: any) => x,
  // SSRF guard is a no-op passthrough in tests (returns the parsed URL).
  assertPublicUrl: async (u: string) => new URL(u),
}));

vi.mock("../services/connectors/integration-framework", async () => ({
  executeAdapterTool: mocks.executeAdapterToolMock,
  loadConnection: vi.fn(),
  registerAdapter: vi.fn(),
  ensureFreshToken: vi.fn(),
  setConnectionStatus: vi.fn(),
  persistCredentials: vi.fn(),
  idempotencyKey: vi.fn().mockReturnValue("idemp_test"),
}));

vi.mock("../services/zoho.service", () => ({
  maybeRefreshZohoToken: mocks.maybeRefreshZohoTokenMock,
  ZOHO_DEFAULT_SCOPES: "",
  exchangeZohoCode: vi.fn(),
  getZohoAccountsUrl: () => "https://accounts.zoho.com",
  refreshZohoAccessToken: vi.fn(),
}));

// Now import the modules under test.
import { getCrmAdapter, __resetCrmAdapterCache } from "../services/connectors/crm-adapter-resolver";
import {
  HubSpotCRMAdapter,
  SalesforceCRMAdapter,
  ZohoCRMAdapter,
  NoOpCRMAdapter,
  renderInteractionBody,
} from "../services/connectors/crm-adapter.impl";

// ─── fetch stub helpers ──────────────────────────────────

const originalFetch = global.fetch;
function stubFetch(impl: (url: string, init: any) => Promise<Response>) {
  // @ts-ignore
  global.fetch = vi.fn(impl);
}
function restoreFetch() { global.fetch = originalFetch; }
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function emptyResp(status: number): Response {
  return new Response("", { status });
}

beforeEach(() => {
  __resetCrmAdapterCache();
  vi.clearAllMocks();
  prismaMock.tenantIntegration.findFirst.mockReset();
  prismaMock.tenant.findUnique.mockReset();
  prismaMock.tenant.findUnique.mockResolvedValue({ id: "t1" });
  executeAdapterToolMock.mockReset();
  maybeRefreshZohoTokenMock.mockReset();
  maybeRefreshZohoTokenMock.mockResolvedValue("zoho_access_xyz");
  restoreFetch();
});

// ─── Resolver ────────────────────────────────────────────

describe("getCrmAdapter resolver", () => {
  it("returns ZohoCRMAdapter when slug=zoho_crm is the connected integration", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValueOnce({
      id: "ti_z",
      integration: { slug: "zoho_crm" },
    });
    const adapter = await getCrmAdapter("t1");
    expect(adapter).toBeInstanceOf(ZohoCRMAdapter);
    expect(adapter.vendor).toBe("zoho");
  });

  it("returns HubSpotCRMAdapter when slug=hubspot", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValueOnce({
      id: "ti_h",
      integration: { slug: "hubspot" },
    });
    const adapter = await getCrmAdapter("t2");
    expect(adapter).toBeInstanceOf(HubSpotCRMAdapter);
    expect(adapter.vendor).toBe("hubspot");
  });

  it("returns SalesforceCRMAdapter when slug=salesforce", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValueOnce({
      id: "ti_s",
      integration: { slug: "salesforce" },
    });
    const adapter = await getCrmAdapter("t3");
    expect(adapter).toBeInstanceOf(SalesforceCRMAdapter);
    expect(adapter.vendor).toBe("salesforce");
  });

  it("returns NoOpCRMAdapter when no integration is connected", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValueOnce(null);
    const adapter = await getCrmAdapter("t_nox");
    expect(adapter).toBeInstanceOf(NoOpCRMAdapter);
    const r = await adapter.findCustomer({ email: "x@y" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_crm_configured");
  });

  it("caches resolution across calls in the same window", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValueOnce({
      id: "ti_z2", integration: { slug: "zoho_crm" },
    });
    await getCrmAdapter("tcache");
    await getCrmAdapter("tcache");
    expect(prismaMock.tenantIntegration.findFirst).toHaveBeenCalledTimes(1);
  });
});

// ─── ZohoCRMAdapter ──────────────────────────────────────

describe("ZohoCRMAdapter (live tenant CRM)", () => {
  function withZohoConnected() {
    prismaMock.tenantIntegration.findFirst.mockResolvedValue({
      id: "ti_zoho",
      credentials: { accessToken: "old_token" },
      config: { baseUrl: "https://www.zohoapis.com", authScheme: "Zoho-oauthtoken" },
    });
  }

  it("findCustomer hits /crm/v6/Leads/search with Zoho-oauthtoken auth and parses lead row", async () => {
    withZohoConnected();
    const calls: Array<{ url: string; method: string; headers: any }> = [];
    stubFetch(async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers });
      if (url.includes("/crm/v6/Leads/search")) {
        return json(200, {
          data: [{
            id: "1234567890",
            First_Name: "Jane",
            Last_Name: "Doe",
            Full_Name: "Jane Doe",
            Email: "jane@example.com",
            Phone: "+155512345671111",
            Lead_Status: "New",
            Lead_Source: "GOTCHA",
            Modified_Time: "2026-05-10T12:00:00Z",
            Owner: { id: "u_42" },
          }],
        });
      }
      return emptyResp(204);
    });

    const adapter = new ZohoCRMAdapter("t1");
    const r = await adapter.findCustomer({ email: "jane@example.com" });
    expect(r.ok).toBe(true);
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0]).toMatchObject({
      id: "1234567890",
      kind: "lead",
      display_name: "Jane Doe",
      email: "jane@example.com",
      phone: "+155512345671111",
      owner_id: "u_42",
      stage: "New",
      vendor: "zoho",
    });
    expect(calls[0].headers["Authorization"]).toBe("Zoho-oauthtoken zoho_access_xyz");
    expect(calls[0].url).toContain("https://www.zohoapis.com/crm/v6/Leads/search?email=jane%40example.com");
  });

  it("findCustomer falls through to Contacts on 204 from Leads", async () => {
    withZohoConnected();
    let leadsHit = false, contactsHit = false;
    stubFetch(async (url) => {
      if (url.includes("/Leads/search")) { leadsHit = true; return emptyResp(204); }
      if (url.includes("/Contacts/search")) {
        contactsHit = true;
        return json(200, {
          data: [{ id: "c1", Full_Name: "Bob Roe", Email: "bob@x.com", Modified_Time: "2026-05-10T12:00:00Z" }],
        });
      }
      return emptyResp(204);
    });
    const r = await new ZohoCRMAdapter("t1").findCustomer({ email: "bob@x.com" });
    expect(leadsHit && contactsHit).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.contacts[0].kind).toBe("contact");
    expect(r.contacts[0].id).toBe("c1");
  });

  it("findCustomer returns reason when no Zoho integration is connected", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValue(null);
    const r = await new ZohoCRMAdapter("t_no_zoho").findCustomer({ email: "any@x.com" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("zoho_not_connected");
  });

  it("createLead POSTs /crm/v6/Leads with required fields", async () => {
    withZohoConnected();
    let captured: any = null;
    stubFetch(async (url, init) => {
      captured = { url, method: init.method, body: init.body ? JSON.parse(init.body) : null };
      return json(201, { data: [{ status: "success", details: { id: "999000111" } }] });
    });
    const r = await new ZohoCRMAdapter("t1").createLead({
      email: "n@new.com", phone: "+15551234567", first_name: "New", last_name: "Lead", source: "WhatsApp",
    });
    expect(r.ok).toBe(true);
    expect(r.id).toBe("999000111");
    expect(r.kind).toBe("lead");
    expect(captured.method).toBe("POST");
    expect(captured.url).toContain("/crm/v6/Leads");
    expect(captured.body.data[0]).toMatchObject({
      Last_Name: "Lead",
      First_Name: "New",
      Email: "n@new.com",
      Phone: "+15551234567",
      Lead_Source: "WhatsApp",
    });
  });

  it("createNote POSTs /crm/v6/Notes with Parent_Id + se_module and the idempotency marker", async () => {
    withZohoConnected();
    let captured: any = null;
    stubFetch(async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return json(201, { data: [{ status: "success", details: { id: "note_42" } }] });
    });
    const r = await new ZohoCRMAdapter("t1").createNote({
      contact_id: "lead_777",
      kind: "lead",
      body: "Customer wants Pro plan demo.",
      source_interaction_id: "conv_abc",
      payload_version: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.id).toBe("note_42");
    expect(captured.url).toContain("/crm/v6/Notes");
    expect(captured.body.data[0]).toMatchObject({
      Note_Title: "GOTCHA Note",
      Parent_Id: { id: "lead_777", module: { api_name: "Leads" } },
      se_module: "Leads",
    });
    expect(captured.body.data[0].Note_Content).toContain("[gotcha_source_interaction_id=conv_abc v=1]");
    expect(captured.body.data[0].Note_Content).toContain("Customer wants Pro plan demo.");
  });

  it("appendInteraction emits a rendered envelope as a Note", async () => {
    withZohoConnected();
    let captured: any = null;
    stubFetch(async (_, init) => {
      captured = JSON.parse(init.body);
      return json(201, { data: [{ status: "success", details: { id: "note_close" } }] });
    });
    const r = await new ZohoCRMAdapter("t1").appendInteraction({
      contact_id: "lead_777",
      kind: "lead",
      interaction: {
        source_interaction_id: "conv_abc",
        channel: "whatsapp",
        direction: "inbound",
        started_at: "2026-05-12T10:00:00Z",
        ended_at: "2026-05-12T10:05:00Z",
        duration_seconds: 300,
        message_count: 12,
        summary: "Discussed pricing.",
        engagement: { sentiment: "positive", qualification: "warm", action_items: ["Send pricing PDF"] },
      },
      payload_version: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.id).toBe("note_close");
    const noteBody = captured.data[0].Note_Content as string;
    expect(noteBody).toContain("Inbound WHATSAPP");
    expect(noteBody).toContain("Duration: 5m 0s");
    expect(noteBody).toContain("Messages: 12");
    expect(noteBody).toContain("Discussed pricing.");
    expect(noteBody).toContain("Sentiment: positive");
    expect(noteBody).toContain("Qualification: warm");
    expect(noteBody).toContain("- Send pricing PDF");
    expect(noteBody).toContain("[gotcha_source_interaction_id=conv_abc v=1]");
  });

  it("surfaces Zoho non-2xx responses as ok:false with reason", async () => {
    withZohoConnected();
    stubFetch(async () => json(401, { code: "INVALID_TOKEN", message: "invalid oauth token" }));
    const r = await new ZohoCRMAdapter("t1").createNote({
      contact_id: "x", kind: "lead", body: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/zoho_401/);
  });
});

// ─── HubSpotCRMAdapter (via executeAdapterTool dispatch) ─

describe("HubSpotCRMAdapter (via existing executeAdapterTool)", () => {
  it("findCustomer by email dispatches hubspot.get_contact", async () => {
    executeAdapterToolMock.mockResolvedValueOnce({
      ok: true,
      result: { id: "12345", properties: { firstname: "Jane", lastname: "Smith", email: "j@s.com", phone: "+15551234567", lifecyclestage: "lead", lastmodifieddate: "2026-05-10T10:00Z" } },
    });
    const r = await new HubSpotCRMAdapter("t1").findCustomer({ email: "j@s.com" });
    expect(r.ok).toBe(true);
    expect(r.contacts[0]).toMatchObject({ id: "12345", display_name: "Jane Smith", email: "j@s.com", vendor: "hubspot" });
    expect(executeAdapterToolMock).toHaveBeenCalledWith(expect.objectContaining({
      toolFunctionName: "hubspot.get_contact",
      args: expect.objectContaining({ email: "j@s.com" }),
    }));
  });

  it("findCustomer by phone dispatches hubspot.search_with_criteria with phone + mobilephone EQ filters", async () => {
    executeAdapterToolMock.mockResolvedValueOnce({
      ok: true,
      result: [{ id: "9", properties: { firstname: "Ph", lastname: "One", phone: "+15551234567" } }],
    });
    const r = await new HubSpotCRMAdapter("t1").findCustomer({ phone: "+15551234567" });
    expect(r.ok).toBe(true);
    expect(executeAdapterToolMock).toHaveBeenCalledWith(expect.objectContaining({
      toolFunctionName: "hubspot.search_with_criteria",
      args: expect.objectContaining({
        object: "contacts",
        filterGroups: expect.arrayContaining([
          expect.objectContaining({ filters: [{ propertyName: "phone", operator: "EQ", value: "+15551234567" }] }),
        ]),
      }),
    }));
    expect(r.contacts[0].id).toBe("9");
  });

  it("createNote dispatches hubspot.log_activity with kind=NOTE + marker in body", async () => {
    executeAdapterToolMock.mockResolvedValueOnce({ ok: true, result: { id: "noteid_77" } });
    const r = await new HubSpotCRMAdapter("t1").createNote({
      contact_id: "c1",
      kind: "contact",
      body: "Hello world",
      source_interaction_id: "conv_q",
      payload_version: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.id).toBe("noteid_77");
    const call = executeAdapterToolMock.mock.calls[0]?.[0];
    expect(call.toolFunctionName).toBe("hubspot.log_activity");
    expect(call.args.kind).toBe("NOTE");
    expect(call.args.body).toContain("Hello world");
    expect(call.args.body).toContain("[gotcha_source_interaction_id=conv_q v=1]");
  });

  it("createLead via hubspot.create_contact upsert when email present", async () => {
    executeAdapterToolMock.mockResolvedValueOnce({ ok: true, result: { id: "newhsid" } });
    const r = await new HubSpotCRMAdapter("t1").createLead({
      email: "new@x.com", first_name: "A", last_name: "B", source: "GOTCHA",
    });
    expect(r.ok).toBe(true);
    expect(r.id).toBe("newhsid");
    expect(r.kind).toBe("contact");
    expect(executeAdapterToolMock).toHaveBeenCalledWith(expect.objectContaining({
      toolFunctionName: "hubspot.create_contact",
    }));
  });

  it("createLead refuses gracefully when only phone is provided (HubSpot upsert needs email)", async () => {
    const r = await new HubSpotCRMAdapter("t1").createLead({ phone: "+15551234567" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("hubspot_requires_email_for_create");
  });
});

// ─── SalesforceCRMAdapter ───────────────────────────────

describe("SalesforceCRMAdapter (via existing executeAdapterTool)", () => {
  it("findCustomer builds a SOQL WHERE with Email/Phone clauses", async () => {
    executeAdapterToolMock.mockResolvedValueOnce({
      ok: true,
      result: [{ Id: "00Q...", FirstName: "Sam", LastName: "Lee", Email: "s@l.com", Phone: "+14441234567", Status: "Open", LastModifiedDate: "2026-05-10T12:00Z" }],
    });
    const r = await new SalesforceCRMAdapter("t1").findCustomer({ email: "s@l.com", phone: "+14441234567" });
    expect(r.ok).toBe(true);
    expect(r.contacts[0]).toMatchObject({ kind: "lead", id: "00Q...", display_name: "Sam Lee", email: "s@l.com" });
    const call = executeAdapterToolMock.mock.calls[0]?.[0];
    expect(call.toolFunctionName).toBe("salesforce.search_with_criteria");
    expect(call.args.where).toContain("Email = 's@l.com'");
    expect(call.args.where).toContain("(Phone = '+14441234567' OR MobilePhone = '+14441234567')");
  });

  it("createNote dispatches salesforce.log_task with WhoId + marker", async () => {
    executeAdapterToolMock.mockResolvedValueOnce({ ok: true, result: { id: "00T..." } });
    const r = await new SalesforceCRMAdapter("t1").createNote({
      contact_id: "00Q_lead", kind: "lead", body: "x", source_interaction_id: "conv_s",
    });
    expect(r.ok).toBe(true);
    const call = executeAdapterToolMock.mock.calls[0]?.[0];
    expect(call.toolFunctionName).toBe("salesforce.log_task");
    expect(call.args.WhoId).toBe("00Q_lead");
    expect(call.args.Description).toContain("[gotcha_source_interaction_id=conv_s]");
  });
});

// ─── renderInteractionBody ──────────────────────────────

describe("renderInteractionBody", () => {
  it("includes channel, direction, duration, message count, summary, sentiment, qualification, action items", () => {
    const body = renderInteractionBody({
      source_interaction_id: "conv_x",
      channel: "voice",
      direction: "inbound",
      started_at: "2026-05-12T10:00:00Z",
      ended_at: "2026-05-12T10:07:30Z",
      duration_seconds: 450,
      message_count: 8,
      summary: "Caller asked about pricing.",
      engagement: { sentiment: "neutral", qualification: "hot", action_items: ["Send quote", "Schedule demo"] },
    });
    expect(body).toContain("Inbound VOICE");
    expect(body).toContain("Duration: 7m 30s");
    expect(body).toContain("Messages: 8");
    expect(body).toContain("Caller asked about pricing.");
    expect(body).toContain("Sentiment: neutral");
    expect(body).toContain("Qualification: hot");
    expect(body).toContain("- Send quote");
    expect(body).toContain("- Schedule demo");
    expect(body).toContain("[gotcha_source_interaction_id=conv_x]");
  });
});

// ─── NoOpCRMAdapter ─────────────────────────────────────

describe("NoOpCRMAdapter", () => {
  it("every method returns no_crm_configured", async () => {
    const a = new NoOpCRMAdapter("t1");
    expect((await a.findCustomer({ email: "x@y" })).reason).toBe("no_crm_configured");
    expect((await a.getCustomerContext({ contact_id: "x", kind: "contact" })).reason).toBe("no_crm_configured");
    expect((await a.createLead({})).reason).toBe("no_crm_configured");
    expect((await a.createNote({ contact_id: "x", kind: "contact", body: "x" })).reason).toBe("no_crm_configured");
    expect((await a.appendInteraction({
      contact_id: "x", kind: "contact",
      interaction: { source_interaction_id: "s", channel: "whatsapp", direction: "inbound", started_at: "now" },
    })).reason).toBe("no_crm_configured");
  });
});
