/**
 * Approval → execution dispatch routing.
 *
 * The Matan Amran incident: an approved `shopify.cancel_order` fell through
 * to the legacy action-planner executor ("unsupported tool"), yet the row
 * was recorded SUCCEEDED and the customer stamp set - Shopify was never
 * called. These tests lock the three routing branches and the honesty
 * invariants of runApprovedAction:
 *
 *   1. dotted "<provider>.<tool>" → AI adapter bridge (/adapter-tools/execute)
 *   2. "integration_<slug>"       → catalog tool executor (/tools/execute)
 *   3. everything else            → legacy action-planner (/execute)
 *
 * Invariants:
 *   - transport 200 alone is NEVER success (inner ok must be true)
 *   - a failed dispatch records FAILED and never notifies the customer
 *   - a successful dispatch records SUCCEEDED and claims the notification
 *   - a lost execution claim dispatches nothing
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { claimForExecution, recordExecutionOutcome, claimCustomerNotification, prismaMock } = vi.hoisted(() => {
  return {
    claimForExecution: vi.fn(),
    recordExecutionOutcome: vi.fn(),
    claimCustomerNotification: vi.fn(),
    prismaMock: {
      approvalRequest: { findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      tenantTool: { findFirst: vi.fn() },
      conversation: { findFirst: vi.fn(), update: vi.fn() },
      message: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    } as any,
  };
});

vi.mock("@chatcenter/shared", () => ({
  prisma: prismaMock,
  authenticate: vi.fn(),
  resolveTenant: vi.fn(),
  requireActiveTenant: () => vi.fn(),
  requireInternalKey: (_req: any, _res: any, next: any) => next(),
  revalidateBeforeExecution: vi.fn(async () => ({ ok: true, decision: "ALLOWED" })),
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
  claimForExecution: (...a: any[]) => claimForExecution(...a),
  recordExecutionOutcome: (...a: any[]) => recordExecutionOutcome(...a),
  claimCustomerNotification: (...a: any[]) => claimCustomerNotification(...a),
  linkCustomerMessage: vi.fn(),
  findPendingByConversation: vi.fn(),
  publishEvent: vi.fn().mockResolvedValue(undefined),
  outgoingMessageQueue: { add: vi.fn() },
  getInternalServiceKey: () => "test-key",
}));

import { runApprovedAction } from "../routes/approvals";

const TENANT = "tenant_1";
const CONV = "conv_1";

function baseOpts(tool: string, params: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    approvalId: "ap_1",
    conversationId: CONV,
    tool,
    params,
    approvedBy: "user_9",
  };
}

/** fetch stub returning per-URL responses; records calls. */
function stubFetch(routes: Array<{ match: string; status?: number; body: any }>) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const route = routes.find((r) => String(url).includes(r.match));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json: async () => route.body,
    } as any;
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  claimForExecution.mockResolvedValue(true);
  claimCustomerNotification.mockResolvedValue(false); // notification path exercised separately
  prismaMock.approvalRequest.findFirst.mockResolvedValue({ resumeEnvelope: null });
  prismaMock.conversation.findFirst.mockResolvedValue({
    id: CONV, channel: "WHATSAPP", channelAccountId: "acct_1",
    customerExternalId: "97250000", customerName: "Matan", assignedAiAgentId: "agent_1",
  });
  prismaMock.conversation.update.mockResolvedValue({});
  prismaMock.message.create.mockResolvedValue({ id: "msg_1" });
});

describe("dotted adapter tools (shopify.*)", () => {
  it("routes shopify.cancel_order to the adapter bridge and records SUCCEEDED on inner ok", async () => {
    const { calls } = stubFetch([
      { match: "/adapter-tools/execute", body: { data: { ok: true, output: { id: 1, cancelled_at: "2026-07-20" } } } },
    ]);
    const r = await runApprovedAction(baseOpts("shopify.cancel_order", { order_name: "#1004" }));
    expect(r.ok).toBe(true);
    const call = calls.find((c) => c.url.includes("/adapter-tools/execute"))!;
    expect(call.url).toContain(`/api/ai-assist/${CONV}/adapter-tools/execute`);
    expect(JSON.parse(call.init.body)).toMatchObject({
      toolFunctionName: "shopify.cancel_order",
      args: { order_name: "#1004" },
    });
    expect(recordExecutionOutcome).toHaveBeenCalledWith(TENANT, "ap_1", expect.objectContaining({ ok: true }));
    // Success is what unlocks the customer notification claim.
    expect(claimCustomerNotification).toHaveBeenCalledWith(TENANT, "ap_1");
  });

  it("inner ok:false on HTTP 200 is a FAILURE - transport success is never enough", async () => {
    stubFetch([
      { match: "/adapter-tools/execute", body: { data: { ok: false, error: "shopify_403: missing write scope" } } },
    ]);
    const r = await runApprovedAction(baseOpts("shopify.cancel_order"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("shopify_403");
    expect(recordExecutionOutcome).toHaveBeenCalledWith(
      TENANT, "ap_1", expect.objectContaining({ ok: false, error: expect.stringContaining("shopify_403") }),
    );
    // Failure NEVER notifies the customer of success...
    expect(claimCustomerNotification).not.toHaveBeenCalled();
    // ...and escalates the conversation to a human.
    expect(prismaMock.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ handledBy: "human", isHandedOver: true }) }),
    );
  });

  it("missing envelope on HTTP 200 is a FAILURE", async () => {
    stubFetch([{ match: "/adapter-tools/execute", body: {} }]);
    const r = await runApprovedAction(baseOpts("shopify.process_refund", { order_name: "#1004", amount: 50 }));
    expect(r.ok).toBe(false);
    expect(recordExecutionOutcome).toHaveBeenCalledWith(TENANT, "ap_1", expect.objectContaining({ ok: false }));
  });

  it("an unknown provider fails visibly (structured reason from the framework)", async () => {
    stubFetch([
      { match: "/adapter-tools/execute", body: { data: { ok: false, error: "unknown_provider:notashop" } } },
    ]);
    const r = await runApprovedAction(baseOpts("notashop.do_thing"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unknown_provider");
  });
});

describe("routing exclusions", () => {
  it("custom. / custom_db. / integration. dotted names do NOT hit the adapter bridge", async () => {
    for (const tool of ["custom.my_api", "custom_db.my_query", "integration.create_lead"]) {
      vi.clearAllMocks();
      claimForExecution.mockResolvedValue(true);
      claimCustomerNotification.mockResolvedValue(false);
      prismaMock.approvalRequest.findFirst.mockResolvedValue({ resumeEnvelope: null });
      prismaMock.conversation.findFirst.mockResolvedValue({ channel: "WHATSAPP" });
      const { calls } = stubFetch([
        { match: "/action-planner/execute", body: { results: [{ ok: false, error: `unsupported tool: ${tool}` }] } },
      ]);
      const r = await runApprovedAction(baseOpts(tool));
      expect(calls.some((c) => c.url.includes("/adapter-tools/execute"))).toBe(false);
      expect(r.ok).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("integration_<slug> goes to the catalog executor with the resolved tenantToolId", async () => {
    prismaMock.tenantTool.findFirst.mockResolvedValue({ id: "tt_42" });
    const { calls } = stubFetch([
      { match: "/tools/execute", body: { data: { ok: true, output: { created: true } } } },
    ]);
    const r = await runApprovedAction(baseOpts("integration_create_lead", { name: "X" }));
    expect(r.ok).toBe(true);
    const call = calls.find((c) => c.url.includes("/tools/execute"))!;
    expect(JSON.parse(call.init.body)).toMatchObject({ tenantToolId: "tt_42" });
  });
});

describe("execution state machine honesty", () => {
  it("a lost claim dispatches NOTHING (no double execution)", async () => {
    claimForExecution.mockResolvedValue(false);
    const { fn } = stubFetch([]);
    const r = await runApprovedAction(baseOpts("shopify.cancel_order"));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("execution_already_in_flight");
    expect(fn).not.toHaveBeenCalled();
    expect(recordExecutionOutcome).not.toHaveBeenCalled();
  });

  it("legacy executor step failure records FAILED (never SUCCEEDED without provider execution)", async () => {
    stubFetch([
      { match: "/action-planner/execute", body: { results: [{ ok: false, error: "unsupported tool: bogus_tool" }] } },
    ]);
    const r = await runApprovedAction(baseOpts("bogus_tool"));
    expect(r.ok).toBe(false);
    expect(recordExecutionOutcome).toHaveBeenCalledWith(
      TENANT, "ap_1", expect.objectContaining({ ok: false, error: expect.stringContaining("unsupported tool") }),
    );
    expect(claimCustomerNotification).not.toHaveBeenCalled();
  });

  it("success sends exactly one customer continuation when the claim is won", async () => {
    claimCustomerNotification.mockResolvedValue(true);
    const { calls } = stubFetch([
      { match: "/adapter-tools/execute", body: { data: { ok: true, output: { refund_id: 7 } } } },
      { match: "/ai-bot/execution-message", body: { reply: "הזיכוי בוצע", grounded: true } },
    ]);
    const shared = await import("@chatcenter/shared");
    const r = await runApprovedAction(baseOpts("shopify.process_refund", { order_name: "#1004" }));
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.url.includes("/ai-bot/execution-message"))).toBe(true);
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
    expect((shared as any).outgoingMessageQueue.add).toHaveBeenCalledTimes(1);
  });

  it("a lost notification claim after success sends nothing (retry cannot double-notify)", async () => {
    claimCustomerNotification.mockResolvedValue(false);
    const { calls } = stubFetch([
      { match: "/adapter-tools/execute", body: { data: { ok: true, output: {} } } },
    ]);
    const r = await runApprovedAction(baseOpts("shopify.cancel_order"));
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.url.includes("/ai-bot/execution-message"))).toBe(false);
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });
});
