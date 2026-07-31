/**
 * runApprovedAction routing + execution state machine.
 *
 * The Matan Amran incident: an approved `shopify.cancel_order` fell through to
 * the legacy action-planner (which throws `unsupported tool`), the failure was
 * swallowed, and nothing ever reached Shopify. These tests lock the contract
 * that killed that bug class:
 *
 *   - dotted `<provider>.<tool>` approvals dispatch through the AI service's
 *     adapter bridge (the SAME executor the live bot uses);
 *   - an inner { ok:false } from the bridge fails the execution - transport
 *     200 alone never marks SUCCEEDED, and never triggers the customer
 *     "it's done" message;
 *   - the execution claim (CAS) prevents duplicate dispatch;
 *   - the customer notification is claimed exactly once;
 *   - a failed execution escalates the conversation to a human.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const shared = vi.hoisted(() => ({
  prisma: {
    approvalRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    conversation: { findFirst: vi.fn(), update: vi.fn() },
    message: { findMany: vi.fn(), create: vi.fn() },
    tenantTool: { findFirst: vi.fn() },
    user: { findMany: vi.fn() },
  },
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
  claimForExecution: vi.fn(),
  recordExecutionOutcome: vi.fn(),
  claimCustomerNotification: vi.fn(),
  linkCustomerMessage: vi.fn(),
  findPendingByConversation: vi.fn(),
  publishEvent: vi.fn(async () => {}),
  outgoingMessageQueue: { add: vi.fn() },
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
  ...shared,
  authenticate: vi.fn(),
  resolveTenant: vi.fn(),
  requireActiveTenant: () => vi.fn(),
  requireInternalKey: (_req: any, _res: any, next: any) => next(),
  revalidateBeforeExecution: vi.fn(async () => ({ ok: true, decision: "ALLOWED" })),
  getInternalServiceKey: () => "test-internal-key",
}));

import { runApprovedAction } from "../routes/approvals";

const TENANT = "tenant_a";
const BASE = {
  tenantId: TENANT,
  approvalId: "apv_1",
  conversationId: "conv_1",
  approvedBy: "user_mgr",
};

function fetchStub(handler: (url: string, init?: RequestInit) => { status?: number; body?: any }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init) ?? {};
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) } as any;
  });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default row: not kernel-originated, claim wins, conversation lookup empty.
  shared.prisma.approvalRequest.findFirst.mockResolvedValue({ resumeEnvelope: null });
  shared.prisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
  shared.prisma.conversation.findFirst.mockResolvedValue(null);
  shared.prisma.conversation.update.mockResolvedValue({});
  shared.prisma.message.findMany.mockResolvedValue([]);
  shared.prisma.message.create.mockResolvedValue({ id: "msg_1" });
  shared.claimForExecution.mockResolvedValue({ id: "apv_1" });
  shared.recordExecutionOutcome.mockResolvedValue(undefined);
  shared.claimCustomerNotification.mockResolvedValue(false);
});

describe("runApprovedAction - dotted adapter tools", () => {
  it("dispatches shopify.* through the adapter bridge and records SUCCEEDED on inner ok", async () => {
    const calls = fetchStub((url) =>
      url.includes("/adapter-tools/execute")
        ? { body: { data: { ok: true, output: { cancelled_at: "2026-07-20T10:00:00Z" } } } }
        : { status: 500, body: {} },
    );

    const r = await runApprovedAction({ ...BASE, tool: "shopify.cancel_order", params: { order_name: "#1004" } });

    expect(r.ok).toBe(true);
    const bridge = calls.find((c) => c.url.includes("/adapter-tools/execute"));
    expect(bridge).toBeTruthy();
    expect(bridge!.url).toContain("/api/ai-assist/conv_1/adapter-tools/execute");
    const body = JSON.parse(String(bridge!.init?.body));
    expect(body.toolFunctionName).toBe("shopify.cancel_order");
    expect(body.args).toEqual({ order_name: "#1004" });
    // tenant isolation: the executor receives THIS tenant, nothing else
    expect((bridge!.init?.headers as any)["x-tenant-id"]).toBe(TENANT);
    expect(shared.claimForExecution).toHaveBeenCalledWith(TENANT, "apv_1");
    expect(shared.recordExecutionOutcome).toHaveBeenCalledWith(TENANT, "apv_1", expect.objectContaining({ ok: true }));
  });

  it("inner { ok:false } from the bridge → FAILED outcome, no customer notification, human escalation", async () => {
    fetchStub((url) =>
      url.includes("/adapter-tools/execute")
        ? { body: { data: { ok: false, error: "not_connected:shopify" } } }
        : { status: 500 },
    );
    shared.prisma.conversation.findFirst.mockResolvedValue({ channel: "WHATSAPP" });

    const r = await runApprovedAction({ ...BASE, tool: "shopify.process_refund", params: { order_id: "1" } });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not_connected/);
    expect(shared.recordExecutionOutcome).toHaveBeenCalledWith(
      TENANT, "apv_1", expect.objectContaining({ ok: false, error: expect.stringContaining("not_connected") }),
    );
    // Failure must NEVER reach the customer as success…
    expect(shared.claimCustomerNotification).not.toHaveBeenCalled();
    expect(shared.outgoingMessageQueue.add).not.toHaveBeenCalled();
    // …and the conversation is handed to a human who can recover.
    expect(shared.prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ handledBy: "human" }) }),
    );
  });

  it("transport 200 with a malformed bridge envelope is a FAILURE, not a success", async () => {
    fetchStub(() => ({ body: { unexpected: true } }));
    const r = await runApprovedAction({ ...BASE, tool: "shopify.add_tag", params: { tag: "vip" } });
    expect(r.ok).toBe(false);
    expect(shared.recordExecutionOutcome).toHaveBeenCalledWith(TENANT, "apv_1", expect.objectContaining({ ok: false }));
  });

  it("unknown dotted provider fails visibly through the bridge error", async () => {
    fetchStub((url) =>
      url.includes("/adapter-tools/execute")
        ? { body: { data: { ok: false, error: "unknown_provider:notaprovider" } } }
        : { status: 500 },
    );
    const r = await runApprovedAction({ ...BASE, tool: "notaprovider.do_thing", params: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown_provider/);
  });
});

describe("runApprovedAction - duplicate / retry protection", () => {
  it("does NOT dispatch when the execution claim is lost (already in flight)", async () => {
    shared.claimForExecution.mockResolvedValue(null);
    const calls = fetchStub(() => ({ body: {} }));
    const r = await runApprovedAction({ ...BASE, tool: "shopify.cancel_order", params: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("execution_already_in_flight");
    expect(calls.length).toBe(0);
    // and it must not overwrite the real execution's outcome
    expect(shared.recordExecutionOutcome).not.toHaveBeenCalled();
  });

  it("customer notification is sent at most once (claim lost → no message, no queue add)", async () => {
    fetchStub((url) =>
      url.includes("/adapter-tools/execute") ? { body: { data: { ok: true, output: {} } } } : { status: 500 },
    );
    shared.claimCustomerNotification.mockResolvedValue(false); // another worker already told the customer
    const r = await runApprovedAction({ ...BASE, tool: "shopify.cancel_order", params: {} });
    expect(r.ok).toBe(true);
    expect(shared.prisma.message.create).not.toHaveBeenCalled();
    expect(shared.outgoingMessageQueue.add).not.toHaveBeenCalled();
  });
});

describe("runApprovedAction - routing table", () => {
  it("legacy (undotted) tools still go to the action-planner executor", async () => {
    const calls = fetchStub((url) =>
      url.includes("/api/action-planner/execute") ? { body: { results: [{ ok: true }] } } : { status: 500 },
    );
    const r = await runApprovedAction({ ...BASE, tool: "schedule_followup", params: {} });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.url.includes("/api/action-planner/execute"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/adapter-tools/execute"))).toBe(false);
  });

  it("kernel-originated approvals resume through /agent-loop/execute-approved", async () => {
    shared.prisma.approvalRequest.findFirst.mockResolvedValue({
      resumeEnvelope: { kind: "kernel_operation", operation: "calendar.book" },
    });
    const calls = fetchStub((url) =>
      url.includes("/agent-loop/execute-approved") ? { body: { data: { status: "EXECUTED" } } } : { status: 500 },
    );
    const r = await runApprovedAction({ ...BASE, tool: "integration.calendar.book", params: {} });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.url.includes("/agent-loop/execute-approved"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/adapter-tools/execute"))).toBe(false);
  });
});
