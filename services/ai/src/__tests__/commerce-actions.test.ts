/**
 * executeCommerceAction - the human-agent quick-action pipeline. Reuses the
 * hardened path: ownership re-validation → business policy → optional HITL →
 * adapter execution → post-action verification → audit. A button click never
 * shows success unless Shopify confirmed AND we verified the resulting state.
 *
 * Covers spec §12 tests: 3 (cross-customer order blocked), 14 (over-max refund),
 * 15 (duplicate prevented), 16 (business policy respected), 17 (HITL required),
 * 18 (verified before success), 19 (refresh on success), 20 (failure ≠ success).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();
const resolveVerifiedMock = vi.fn();
const orderToCardMock = vi.fn(async (..._a: any[]) => ({ orderId: "5001", orderNumber: "#1246" }));

const evalPolicyMock = vi.fn();
const revalidateMock = vi.fn();
const createApprovalMock = vi.fn();
const writeAuditMock = vi.fn();
const auditFindFirstMock = vi.fn();

vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: (...a: any[]) => execMock(...a),
}));
vi.mock("../services/commerce-context.service", () => ({
  resolveVerifiedShopifyCustomerId: (...a: any[]) => resolveVerifiedMock(...a),
  orderToCard: (...a: any[]) => orderToCardMock(...a),
  invalidateCommerceCache: () => 0,
}));
vi.mock("@chatcenter/shared", () => ({
  prisma: { auditLog: { findFirst: (...a: any[]) => auditFindFirstMock(...a) } },
  writeAudit: (...a: any[]) => writeAuditMock(...a),
  actionKindForTool: (tool: string) => (/refund/.test(tool) ? "REFUND" : "CANCEL_ORDER"),
  evaluateBusinessPolicy: (...a: any[]) => evalPolicyMock(...a),
  revalidateBeforeExecution: (...a: any[]) => revalidateMock(...a),
  createApprovalRequest: (...a: any[]) => createApprovalMock(...a),
  computeOperationKey: (tool: string, params: any) => `${tool}:${params.order_id}:${params._idem}`,
}));

import { executeCommerceAction } from "../services/commerce-actions.service";

const PAID_ORDER = {
  id: 5001, name: "#1246", currency: "USD", total_price: "120.00",
  financial_status: "paid", cancelled_at: null, customer: { id: 999 },
};

function baseOpts(overrides: any = {}) {
  return {
    tenantId: "t1", conversationId: "c1", actorUserId: "u1",
    perms: { canCancel: true, canRefund: true },
    request: { orderId: "5001", action: "refund" as const, idempotencyKey: "idem-1", params: {} },
    correlationId: "corr1",
    ...overrides,
  };
}

beforeEach(() => {
  execMock.mockReset(); resolveVerifiedMock.mockReset(); orderToCardMock.mockClear();
  evalPolicyMock.mockReset(); revalidateMock.mockReset(); createApprovalMock.mockReset();
  writeAuditMock.mockReset(); auditFindFirstMock.mockReset();
  resolveVerifiedMock.mockResolvedValue("999");
  auditFindFirstMock.mockResolvedValue(null);
  evalPolicyMock.mockResolvedValue({ decision: "ALLOWED", reasonCodes: [], policyId: null, policyVersion: null, matchedRules: [] });
  revalidateMock.mockResolvedValue({ ok: true, decision: "ALLOWED" });
}

);

/** get_order returns `order`; the action tool returns `actionResult`; the
 * post-verify get_order returns `verifyOrder`. */
function wireAdapter(order: any, actionResult: any, verifyOrder: any) {
  let getOrderCalls = 0;
  execMock.mockImplementation(async ({ toolFunctionName }: any) => {
    if (toolFunctionName === "shopify.get_order") {
      getOrderCalls += 1;
      return { ok: true, result: getOrderCalls === 1 ? order : verifyOrder };
    }
    return actionResult;
  });
}

describe("ownership + eligibility", () => {
  it("3. an order belonging to another customer is blocked", async () => {
    wireAdapter({ ...PAID_ORDER, customer: { id: 111 } }, { ok: true, result: {} }, {});
    const r = await executeCommerceAction(baseOpts());
    expect(r.state).toBe("denied");
    expect((r as any).reason).toBe("order_not_owned");
  });

  it("3b. an order with NO resolvable customer (guest checkout) fails closed", async () => {
    // orderId is client-supplied; an order we can't prove belongs to the
    // verified customer must never be actionable.
    wireAdapter({ ...PAID_ORDER, customer: undefined, customer_id: undefined }, { ok: true, result: {} }, {});
    const r = await executeCommerceAction(baseOpts());
    expect(r.state).toBe("denied");
    expect((r as any).reason).toBe("order_not_owned");
    expect(execMock.mock.calls.some((c) => c[0].toolFunctionName === "shopify.process_refund")).toBe(false);
  });

  it("cancel on an already-cancelled order → unavailable", async () => {
    wireAdapter({ ...PAID_ORDER, cancelled_at: "2026-07-19T00:00:00Z" }, { ok: true, result: {} }, {});
    const r = await executeCommerceAction(baseOpts({ request: { orderId: "5001", action: "cancel", idempotencyKey: "i", params: {} } }));
    expect(r.state).toBe("unavailable");
    expect((r as any).reason).toBe("already_cancelled");
  });

  it("14. a refund above the order total is denied before any money moves", async () => {
    wireAdapter(PAID_ORDER, { ok: true, result: {} }, {});
    const r = await executeCommerceAction(baseOpts({ request: { orderId: "5001", action: "refund", idempotencyKey: "i", params: { amount: 999 } } }));
    expect(r.state).toBe("denied");
    expect((r as any).reason).toBe("amount_exceeds_refundable_maximum");
    // never called the refund tool
    expect(execMock.mock.calls.some((c) => c[0].toolFunctionName === "shopify.process_refund")).toBe(false);
  });
});

describe("idempotency (test 15)", () => {
  it("15. a prior succeeded execution short-circuits - no second refund", async () => {
    auditFindFirstMock.mockResolvedValue({ id: "audit-prev" });
    wireAdapter(PAID_ORDER, { ok: true, result: {} }, PAID_ORDER);
    const r = await executeCommerceAction(baseOpts());
    expect(r.state).toBe("executed");
    expect(execMock.mock.calls.some((c) => c[0].toolFunctionName === "shopify.process_refund")).toBe(false);
  });
});

describe("business policy + HITL (tests 16, 17)", () => {
  it("16. policy DENIED → denied, no execution", async () => {
    evalPolicyMock.mockResolvedValue({ decision: "DENIED", reasonCodes: ["not_allowed"], policyId: "p", policyVersion: 1, matchedRules: [] });
    wireAdapter(PAID_ORDER, { ok: true, result: {} }, PAID_ORDER);
    const r = await executeCommerceAction(baseOpts());
    expect(r.state).toBe("denied");
    expect(execMock.mock.calls.some((c) => c[0].toolFunctionName === "shopify.process_refund")).toBe(false);
  });

  it("17. policy REQUIRES_HUMAN_APPROVAL → pending_approval via HITL", async () => {
    evalPolicyMock.mockResolvedValue({ decision: "REQUIRES_HUMAN_APPROVAL", reasonCodes: ["amount_above_manager_threshold"], policyId: "p", policyVersion: 1, matchedRules: [] });
    createApprovalMock.mockResolvedValue({ id: "appr-1", expiresAt: new Date(0) });
    wireAdapter(PAID_ORDER, { ok: true, result: {} }, PAID_ORDER);
    const r = await executeCommerceAction(baseOpts());
    expect(r.state).toBe("pending_approval");
    expect((r as any).approvalRequestId).toBe("appr-1");
    expect(createApprovalMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls.some((c) => c[0].toolFunctionName === "shopify.process_refund")).toBe(false);
  });
});

describe("execution verification (tests 18, 19, 20)", () => {
  it("19. success path executes then refreshes the card from the VERIFIED order", async () => {
    wireAdapter(PAID_ORDER, { ok: true, result: { refund: {} } }, { ...PAID_ORDER, financial_status: "refunded" });
    const r = await executeCommerceAction(baseOpts());
    expect(r.state).toBe("executed");
    expect(orderToCardMock).toHaveBeenCalled();
    // the verified (refunded) order was mapped, not the stale one
    expect((orderToCardMock.mock.calls[0] as any[])[1].financial_status).toBe("refunded");
  });

  it("20. adapter failure → unavailable, never success", async () => {
    wireAdapter(PAID_ORDER, { ok: false, reason: "cancel_not_applied" }, PAID_ORDER);
    const r = await executeCommerceAction(baseOpts({ request: { orderId: "5001", action: "cancel", idempotencyKey: "i", params: {} } }));
    expect(r.state).toBe("unavailable");
  });

  it("18. adapter ok but state did NOT change → unavailable, not a false success", async () => {
    // refund tool returned ok, but the re-fetched order is still `paid`.
    wireAdapter(PAID_ORDER, { ok: true, result: {} }, { ...PAID_ORDER, financial_status: "paid" });
    const r = await executeCommerceAction(baseOpts());
    expect(r.state).toBe("unavailable");
    expect((r as any).reason).toBe("action_not_verified");
  });
});
