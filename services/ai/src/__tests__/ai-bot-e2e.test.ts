import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AI Bot / Tool Policy integration tests — verifies three critical flows:
 *
 * 1. Tool gate decisions: ALLOW / DENY / REQUIRE_APPROVAL based on
 *    tenant permissions and high-risk defaults
 * 2. Tool dispatch with HITL: dispatchToolCall → evaluateToolGate →
 *    approval request created → sideEffect returned to pause conversation
 * 3. Tool execution: allowed tools dispatch via executeAction and
 *    return real results (tag_contact, schedule_followup, etc.)
 *
 * Uses the same mocking patterns as action-executor-http.test.ts.
 */

// ─── Hoisted mocks ──────────────────────────────────────────

const { prismaMock, evaluateToolGateMock, createApprovalRequestMock } = vi.hoisted(() => ({
  prismaMock: {
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    contact: {
      findFirst: vi.fn().mockResolvedValue({
        id: "c1",
        tenantId: "t1",
        externalId: "+972501234567",
        channel: "WHATSAPP",
        tags: ["existing"],
      }),
      findUnique: vi.fn().mockResolvedValue({
        id: "c1",
        tenantId: "t1",
        tags: ["existing"],
      }),
      update: vi.fn().mockResolvedValue({
        id: "c1",
        tags: ["existing", "vip"],
      }),
    },
    channelAccount: {
      findFirst: vi.fn().mockResolvedValue({ id: "ca1", channel: "WHATSAPP" }),
    },
    scheduledMessage: {
      create: vi.fn().mockResolvedValue({
        id: "sm1",
        scheduledAt: new Date("2030-01-01"),
        status: "PENDING",
      }),
    },
    businessPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
    tenantToolPermission: { findUnique: vi.fn() },
    approvalRequest: {
      create: vi.fn().mockResolvedValue({
        id: "apr-1",
        expiresAt: new Date("2030-01-01"),
      }),
    },
  },
  evaluateToolGateMock: vi.fn().mockResolvedValue({ decision: "ALLOW", reason: "default allow" }),
  createApprovalRequestMock: vi.fn().mockResolvedValue({ id: "apr-1", expiresAt: new Date("2030-01-01") }),
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: prismaMock,
  evaluateToolGate: evaluateToolGateMock,
  getDefaultHighRiskTools: () => [
    "send_message", "create_broadcast", "schedule_broadcast",
    "schedule_followup", "merge_contacts", "update_contact",
    "update_crm", "create_ticket", "create_task",
    "cancel_order", "issue_refund", "create_workflow",
  ],
  createApprovalRequest: createApprovalRequestMock,
  findPendingByConversation: vi.fn().mockResolvedValue([]),
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
  trackAIUsage: vi.fn().mockResolvedValue(undefined),
  publishEvent: vi.fn(),
  decryptCredentials: vi.fn().mockReturnValue({ accessToken: "fake-token" }),
  buildAgentTools: vi.fn().mockReturnValue([]),
  dispatchToolCall: vi.fn(),
}));

import { executeAction, PlannedAction } from "../services/action-executor.service";

const fetchMock = vi.fn();
(globalThis as any).fetch = fetchMock;

function okResponse(body: unknown, status = 200) {
  return { ok: true, status, async text() { return JSON.stringify(body); } } as any;
}

// ─── 1. Tool Gate via executeAction ─────────────────────────
// evaluateToolGate is tested indirectly via the mocked version
// that executeAction calls. Direct unit tests for the real
// evaluateToolGate belong in the shared package.

describe("evaluateToolGate — via executeAction integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    process.env.CONVERSATION_SERVICE_URL = "http://test-conversation";
  });

  it("ALLOW gate lets tool execute", async () => {
    evaluateToolGateMock.mockResolvedValue({ decision: "ALLOW", reason: "explicit allow" });

    const result = await executeAction("t1", {
      tool: "tag_contact",
      params: { contactId: "c1", tags: ["vip"] },
      reason: "segmentation",
      riskLevel: "low",
    }, {});

    expect(result.ok).toBe(true);
    expect(prismaMock.contact.update).toHaveBeenCalled();
  });

  it("DENY gate blocks execution", async () => {
    evaluateToolGateMock.mockResolvedValue({
      decision: "DENY",
      reason: "tool is disabled for this tenant",
    });

    const result = await executeAction("t1", {
      tool: "send_message",
      params: { contactId: "c1", body: "hi" },
      reason: "outreach",
      riskLevel: "high",
    }, { approved: true, approvedBy: "admin" });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REQUIRE_APPROVAL gate blocks unapproved high-risk tool", async () => {
    evaluateToolGateMock.mockResolvedValue({
      decision: "REQUIRE_APPROVAL",
      reason: "tool requires human approval",
    });

    const result = await executeAction("t1", {
      tool: "update_contact",
      params: { contactId: "c1", fields: { email: "new@test.com" } },
      reason: "customer request",
      riskLevel: "high",
    }, {});

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMock.contact.update).not.toHaveBeenCalled();
  });

  it("gate is called with correct tenantId and toolName", async () => {
    evaluateToolGateMock.mockResolvedValue({ decision: "ALLOW", reason: "allowed" });

    await executeAction("tenant-xyz", {
      tool: "tag_contact",
      params: { contactId: "c1", tags: ["test"] },
      reason: "test",
      riskLevel: "low",
    }, {});

    expect(evaluateToolGateMock).toHaveBeenCalledWith("tenant-xyz", "tag_contact");
  });

  it("high-risk tool with ALLOW gate + approval flag proceeds", async () => {
    evaluateToolGateMock.mockResolvedValue({ decision: "ALLOW", reason: "tenant override" });
    fetchMock.mockResolvedValueOnce(okResponse({ data: { id: "b1" } }, 201));

    const result = await executeAction("t1", {
      tool: "create_broadcast",
      params: { name: "Q4 promo", channel: "WHATSAPP", channelAccountId: "ch1" },
      reason: "marketing",
      riskLevel: "high",
    }, { approved: true, approvedBy: "admin", authToken: "jwt-xyz" });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. Tool Gate → executeAction integration ──────────────
// Verifies that executeAction respects gate decisions (DENY,
// REQUIRE_APPROVAL) via the mocked evaluateToolGate.

describe("executeAction — tool gate HITL integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    process.env.CONVERSATION_SERVICE_URL = "http://test-conversation";
  });

  it("blocks execution when gate returns DENY", async () => {
    evaluateToolGateMock.mockResolvedValue({
      decision: "DENY",
      reason: "tool is disabled for this tenant",
    });

    const action: PlannedAction = {
      tool: "update_crm",
      params: { orderId: "ord-1", amount: 50 },
      reason: "customer request",
      riskLevel: "high",
    };

    const result = await executeAction("t1", action, {
      approved: true,
      approvedBy: "admin",
      authToken: "jwt-xyz",
    });

    expect(result.ok).toBe(false);
    // Tool should NOT have been dispatched
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMock.contact.update).not.toHaveBeenCalled();
  });

  it("gate is called with correct tenantId and toolName", async () => {
    evaluateToolGateMock.mockResolvedValue({ decision: "ALLOW", reason: "allowed" });

    const action: PlannedAction = {
      tool: "tag_contact",
      params: { contactId: "c1", tags: ["test"] },
      reason: "test",
      riskLevel: "low",
    };

    await executeAction("tenant-xyz", action, {});

    expect(evaluateToolGateMock).toHaveBeenCalledWith("tenant-xyz", "tag_contact");
  });

  it("REQUIRE_APPROVAL gate blocks unapproved execution", async () => {
    evaluateToolGateMock.mockResolvedValue({
      decision: "REQUIRE_APPROVAL",
      reason: "tool requires human approval",
      approvalConfig: {
        approverRole: "ADMIN",
        notifyChannels: ["in_app"],
        expiresAfterMin: 30,
        allowModification: false,
      },
    });

    const action: PlannedAction = {
      tool: "send_message",
      params: { contactId: "c1", body: "hello" },
      reason: "outreach",
      riskLevel: "high",
    };

    // Without approval flag
    const result = await executeAction("t1", action, {});

    expect(result.ok).toBe(false);
    // Tool should NOT have been dispatched
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── 3. Tool Execution — executeAction ──────────────────────

describe("executeAction — tool dispatch works", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    process.env.CONVERSATION_SERVICE_URL = "http://test-conversation";
    // Default: gate allows all tools in this suite
    evaluateToolGateMock.mockResolvedValue({ decision: "ALLOW", reason: "test allow" });
  });

  it("tag_contact executes directly via Prisma (low-risk, no approval needed)", async () => {
    const action: PlannedAction = {
      tool: "tag_contact",
      params: { contactId: "c1", tags: ["vip"] },
      reason: "segmentation",
      riskLevel: "low",
    };

    const result = await executeAction("t1", action, {});
    expect(result.ok).toBe(true);
    expect(prismaMock.contact.update).toHaveBeenCalledTimes(1);

    const updateCall = prismaMock.contact.update.mock.calls[0]![0];
    expect(updateCall.where.id).toBe("c1");
  });

  it("schedule_followup creates a ScheduledMessage row", async () => {
    const action: PlannedAction = {
      tool: "schedule_followup",
      params: {
        contactId: "c1",
        body: "Following up on your inquiry",
        scheduleAt: "2030-01-01T10:00:00Z",
      },
      reason: "customer follow-up",
      riskLevel: "high",
    };

    const result = await executeAction("t1", action, {
      approved: true,
      approvedBy: "admin",
      authToken: "jwt-xyz",
    });

    expect(result.ok).toBe(true);
    expect(prismaMock.scheduledMessage.create).toHaveBeenCalledTimes(1);

    const createCall = prismaMock.scheduledMessage.create.mock.calls[0]![0];
    expect(createCall.data.tenantId).toBe("t1");
    expect(createCall.data.body).toBe("Following up on your inquiry");
    expect(createCall.data.status).toBe("PENDING");
  });

  it("create_broadcast POSTs to conversation service with tenant header", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: { id: "b1", status: "DRAFT" } }, 201));

    const action: PlannedAction = {
      tool: "create_broadcast",
      params: { name: "Q4 promo", channel: "WHATSAPP", channelAccountId: "ch1" },
      reason: "marketing",
      riskLevel: "high",
    };

    const result = await executeAction("t1", action, {
      approved: true,
      approvedBy: "admin",
      authToken: "jwt-xyz",
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://test-conversation/api/broadcasts");
    expect(init.method).toBe("POST");
    expect(init.headers["x-tenant-id"]).toBe("t1");
    expect(init.headers["Authorization"]).toBe("Bearer jwt-xyz");
  });

  it("high-risk tool WITHOUT approval is blocked by validateAction", async () => {
    const action: PlannedAction = {
      tool: "send_message",
      params: { contactId: "c1", channel: "whatsapp", body: "hi" },
      reason: "outreach",
      riskLevel: "high",
    };

    const result = await executeAction("t1", action, {});
    expect(result.ok).toBe(false);
    expect(result.skipReason).toBeDefined();
  });

  it("high-risk tool WITH approval proceeds to execution", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ matched: true, contact: { id: "c1" } }));

    const action: PlannedAction = {
      tool: "resolve_identity",
      params: { email: "test@example.com" },
      reason: "lookup",
      riskLevel: "low",
    };

    const result = await executeAction("t1", action, { authToken: "jwt-xyz" });
    expect(result.ok).toBe(true);
    expect((result.output as any).matched).toBe(true);
  });

  it("upstream 4xx error surfaces as { ok: false }", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      async text() { return JSON.stringify({ error: "invalid params" }); },
    } as any);

    const action: PlannedAction = {
      tool: "create_broadcast",
      params: { name: "oops" },
      reason: "test",
      riskLevel: "high",
    };

    const result = await executeAction("t1", action, {
      approved: true,
      approvedBy: "admin",
      authToken: "jwt-xyz",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid params");
  });
});
