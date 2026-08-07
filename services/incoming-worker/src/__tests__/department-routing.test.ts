import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the shared package: the department-routing service only touches
// prisma.aIAgent, prisma.department, and prisma.conversation. `vi.hoisted`
// exposes the mocks to the hoisted vi.mock factory below.
const { aIAgent, department, conversation } = vi.hoisted(() => ({
  aIAgent: { findFirst: vi.fn() },
  department: { upsert: vi.fn() },
  conversation: { update: vi.fn() },
}));

vi.mock("@chatcenter/shared", () => ({
  // Durable tenant settings (business hours, auto-greeting, SLA). Exhaustive
  // mocks of this barrel must supply them or the read path throws instead of
  // returning "not configured". Default: nothing configured.
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: { aIAgent, department, conversation },
}));

import {
  applyDepartmentPickerReply,
  resolveDepartmentSelection,
} from "../services/department-routing.service";

const TENANT = "tenant-1";
const CONV = "conv-1";

describe("resolveDepartmentSelection", () => {
  it("maps sales tokens (Hebrew + English) to the sales role", () => {
    expect(resolveDepartmentSelection("מכירה")).toEqual({ role: "sales", departmentName: "Sales" });
    expect(resolveDepartmentSelection("Sales")).toEqual({ role: "sales", departmentName: "Sales" });
  });

  it("maps service tokens to the customer_support role", () => {
    expect(resolveDepartmentSelection("שירות")).toEqual({
      role: "customer_support",
      departmentName: "Customer Support",
    });
  });

  it("returns null for unrelated payloads and empty input", () => {
    expect(resolveDepartmentSelection("מכירה מיוחדת")).toBeNull();
    expect(resolveDepartmentSelection("yes")).toBeNull();
    expect(resolveDepartmentSelection("")).toBeNull();
    expect(resolveDepartmentSelection(null)).toBeNull();
  });
});

describe("applyDepartmentPickerReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes "מכירה" to an ACTIVE sales-role employee and sets the Sales department', async () => {
    aIAgent.findFirst.mockResolvedValue({ id: "sales-agent" });
    department.upsert.mockResolvedValue({ id: "dept-sales" });
    conversation.update.mockResolvedValue({});

    const res = await applyDepartmentPickerReply({
      tenantId: TENANT,
      conversationId: CONV,
      payload: "מכירה", activeFlowCursor: null,
    });

    expect(res).toEqual({
      handled: true,
      assignedAiAgentId: "sales-agent",
      departmentId: "dept-sales",
      role: "sales",
    });
    // Employee lookup is role- and tenant-scoped and requires ACTIVE status.
    expect(aIAgent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, role: "sales", status: "ACTIVE" },
      }),
    );
    // Department looked up / created by (tenant, name).
    expect(department.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_name: { tenantId: TENANT, name: "Sales" } },
      }),
    );
    // Conversation pinned to the sales employee + department.
    expect(conversation.update).toHaveBeenCalledWith({
      where: { id: CONV },
      data: {
        departmentId: "dept-sales",
        assignedAiAgentId: "sales-agent",
        handledBy: "ai_agent",
        chatbotNodeId: null,
      },
    });
  });

  it('routes "שירות" to an ACTIVE customer_support employee', async () => {
    aIAgent.findFirst.mockResolvedValue({ id: "support-agent" });
    department.upsert.mockResolvedValue({ id: "dept-support" });
    conversation.update.mockResolvedValue({});

    const res = await applyDepartmentPickerReply({
      tenantId: TENANT,
      conversationId: CONV,
      payload: "שירות", activeFlowCursor: null,
    });

    expect(res.handled).toBe(true);
    expect(res.assignedAiAgentId).toBe("support-agent");
    expect(res.role).toBe("customer_support");
    expect(aIAgent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, role: "customer_support", status: "ACTIVE" },
      }),
    );
  });

  it("leaves a normal text message untouched (no picker match, no writes)", async () => {
    const res = await applyDepartmentPickerReply({
      tenantId: TENANT,
      conversationId: CONV,
      payload: "hello there", activeFlowCursor: null,
    });

    expect(res).toEqual({ handled: false });
    expect(aIAgent.findFirst).not.toHaveBeenCalled();
    expect(department.upsert).not.toHaveBeenCalled();
    expect(conversation.update).not.toHaveBeenCalled();
  });

  it("does not assign across tenants: no ACTIVE matching employee => leave assignment, no writes", async () => {
    // Employee of the requested role lives in a different tenant, so the
    // tenant-scoped lookup returns null.
    aIAgent.findFirst.mockResolvedValue(null);

    const res = await applyDepartmentPickerReply({
      tenantId: TENANT,
      conversationId: CONV,
      payload: "מכירה", activeFlowCursor: null,
    });

    expect(res).toEqual({ handled: false });
    expect(aIAgent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, role: "sales", status: "ACTIVE" } }),
    );
    // No department created and no assignment made when the role is unfilled.
    expect(department.upsert).not.toHaveBeenCalled();
    expect(conversation.update).not.toHaveBeenCalled();
  });
});

// ─── An authored flow outranks the picker ───────────────────────
//
// The production incident: a customer inside a working flow tapped a button
// labelled "שירות". The picker fired first, pinned an agent, NULLED the flow
// cursor and called the AI directly - so send_message C and send_interactive D
// never ran, nothing could resume, and with an exhausted wallet the AI turn
// escalated to a human. The flow was authored correctly the whole time.
describe("active flow cursor outranks the department picker", () => {
  const ACTIVE = "quick-reply-node-B";

  beforeEach(() => {
    vi.clearAllMocks();
    aIAgent.findFirst.mockResolvedValue({ id: "agent-support" });
    department.upsert.mockResolvedValue({ id: "dept-1" });
    conversation.update.mockResolvedValue({});
  });

  for (const payload of ["שירות", "תמיכה", "support", "service", "מכירה", "מכירות", "sales"]) {
    it(`refuses "${payload}" while a flow cursor is parked`, async () => {
      const res = await applyDepartmentPickerReply({
        tenantId: TENANT,
        conversationId: CONV,
        payload,
        activeFlowCursor: ACTIVE,
      });

      expect(res.handled).toBe(false);
      expect(res.skippedReason).toBe("active_flow_cursor");
    });
  }

  it("performs NO side effects at all - no pin, no department, no cursor clear", async () => {
    await applyDepartmentPickerReply({
      tenantId: TENANT, conversationId: CONV, payload: "שירות", activeFlowCursor: ACTIVE,
    });

    // The three writes that abandoned the flow. None may happen.
    expect(conversation.update).not.toHaveBeenCalled();
    expect(department.upsert).not.toHaveBeenCalled();
    expect(aIAgent.findFirst).not.toHaveBeenCalled();
  });

  it("refuses before even resolving the selection, so token changes cannot reintroduce it", async () => {
    // The guard runs ahead of resolveDepartmentSelection: whatever the token
    // table grows to later, an active flow still owns the reply.
    const res = await applyDepartmentPickerReply({
      tenantId: TENANT, conversationId: CONV, payload: "anything at all", activeFlowCursor: ACTIVE,
    });
    expect(res.skippedReason).toBe("active_flow_cursor");
  });

  it("still routes normally when no flow is driving the conversation", async () => {
    const res = await applyDepartmentPickerReply({
      tenantId: TENANT, conversationId: CONV, payload: "שירות", activeFlowCursor: null,
    });

    expect(res.handled).toBe(true);
    expect(res.role).toBe("customer_support");
    expect(conversation.update).toHaveBeenCalled();
  });

  it("treats undefined the same as null - fallback still available", async () => {
    const res = await applyDepartmentPickerReply({
      tenantId: TENANT, conversationId: CONV, payload: "sales", activeFlowCursor: undefined,
    });
    expect(res.handled).toBe(true);
    expect(res.role).toBe("sales");
  });

  it("is idempotent under retry - a repeated reply routes once per call, never twice", async () => {
    for (let i = 0; i < 3; i++) {
      vi.clearAllMocks();
      const res = await applyDepartmentPickerReply({
        tenantId: TENANT, conversationId: CONV, payload: "שירות", activeFlowCursor: ACTIVE,
      });
      expect(res.handled).toBe(false);
      expect(conversation.update).not.toHaveBeenCalled();
    }
  });
});

// ─── Free text can never reach the picker ───────────────────────

describe("free text never triggers department routing", () => {
  it("does not match a sentence that merely contains a token", () => {
    // The worker only calls the picker for an INTERACTIVE reply payload, and
    // the matcher is exact-normalized on top of that. Both layers matter.
    expect(resolveDepartmentSelection("אני צריך שירות בבקשה")).toBeNull();
    expect(resolveDepartmentSelection("I need support with my order")).toBeNull();
    expect(resolveDepartmentSelection("pre-sales question")).toBeNull();
  });
});
