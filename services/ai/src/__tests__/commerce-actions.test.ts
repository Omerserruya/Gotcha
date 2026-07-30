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
  computeOperationKey: (tool: string, params: any) =>
    `${tool}:${params.order_id ?? params.customer_id}:${params.tag ?? ""}:${params._idem}`,
  // Real behaviour, not a stub: routing an action to the wrong path is exactly
  // the kind of bug these tests exist to catch.
  isCustomerScopedAction: (a: string) => ["add_tag", "remove_tag", "add_note"].includes(a),
}));

import { executeCommerceAction } from "../services/commerce-actions.service";

const PAID_ORDER = {
  id: 5001, name: "#1246", currency: "USD", total_price: "120.00",
  financial_status: "paid", cancelled_at: null, customer: { id: 999 },
};

function baseOpts(overrides: any = {}) {
  return {
    tenantId: "t1", conversationId: "c1", actorUserId: "u1",
    perms: { canCancel: true, canRefund: true, canTag: true, canNote: true },
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

/**
 * Customer-scoped actions (tag / untag / note).
 *
 * These carry NO order id, so the whole class of "act on someone else's order
 * by guessing an id" cannot arise: the customer comes from the conversation's
 * verified link. What still has to hold is that permission is checked per
 * action, that a write is verified before it is reported, and that a replay
 * does not write twice.
 */
describe("customer-scoped actions", () => {
  const customerOpts = (action: string, params: any = {}, perms: any = {}) =>
    baseOpts({
      perms: { canCancel: true, canRefund: true, canTag: true, canNote: true, ...perms },
      request: { action, idempotencyKey: "idem-c1", params },
    });

  beforeEach(() => {
    resolveVerifiedMock.mockResolvedValue("999");
    auditFindFirstMock.mockResolvedValue(null);
    evalPolicyMock.mockResolvedValue({ decision: "ALLOWED", reasonCodes: [] });
  });

  it("adds a tag through the adapter and reports the VERIFIED list", async () => {
    execMock.mockImplementation(async ({ toolFunctionName }: any) => {
      if (toolFunctionName === "shopify.add_tag") return { ok: true, result: {} };
      if (toolFunctionName === "shopify.get_customer_tags") return { ok: true, result: { tags: ["vip", "wholesale"] } };
      return { ok: false, reason: "unexpected" };
    });
    const res: any = await executeCommerceAction(customerOpts("add_tag", { tag: "wholesale" }) as any);
    expect(res.state).toBe("executed_customer");
    expect(res.tags).toEqual(["vip", "wholesale"]);
    const call = execMock.mock.calls.find((c: any[]) => c[0].toolFunctionName === "shopify.add_tag")![0];
    // The customer id is server-resolved; nothing from the request reaches it.
    expect(call.args.customer_id).toBe("999");
    expect(call.args.tag).toBe("wholesale");
  });

  it("does NOT report success when the tag is absent from the verified list", async () => {
    // Shopify said OK, but the tag is not actually on the record. Reporting
    // success here is how a UI ends up lying about the store's state.
    execMock.mockImplementation(async ({ toolFunctionName }: any) => {
      if (toolFunctionName === "shopify.add_tag") return { ok: true, result: {} };
      if (toolFunctionName === "shopify.get_customer_tags") return { ok: true, result: { tags: ["vip"] } };
      return { ok: false, reason: "unexpected" };
    });
    const res: any = await executeCommerceAction(customerOpts("add_tag", { tag: "wholesale" }) as any);
    expect(res.state).toBe("unavailable");
    expect(res.reason).toBe("action_not_verified");
  });

  it("removing a tag is verified by its ABSENCE", async () => {
    execMock.mockImplementation(async ({ toolFunctionName }: any) => {
      if (toolFunctionName === "shopify.remove_tag") return { ok: true, result: {} };
      if (toolFunctionName === "shopify.get_customer_tags") return { ok: true, result: { tags: ["vip"] } };
      return { ok: false, reason: "unexpected" };
    });
    const gone: any = await executeCommerceAction(customerOpts("remove_tag", { tag: "wholesale" }) as any);
    expect(gone.state).toBe("executed_customer");

    const stillThere: any = await executeCommerceAction(customerOpts("remove_tag", { tag: "vip" }) as any);
    expect(stillThere.state).toBe("unavailable");
  });

  it("checks the tag permission, not the refund permission", async () => {
    const res: any = await executeCommerceAction(customerOpts("add_tag", { tag: "x" }, { canTag: false }) as any);
    expect(res.state).toBe("denied");
    expect(res.reason).toBe("permission_denied");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("checks the note permission separately from the tag permission", async () => {
    execMock.mockImplementation(async ({ toolFunctionName }: any) =>
      toolFunctionName === "shopify.get_customer_tags"
        ? { ok: true, result: { tags: ["x"] } }
        : { ok: true, result: {} });
    const res: any = await executeCommerceAction(customerOpts("add_note", { note: "hi" }, { canNote: false }) as any);
    expect(res.state).toBe("denied");
    // Holding canTag must not buy the ability to write notes - nor cost it.
    const ok: any = await executeCommerceAction(customerOpts("add_tag", { tag: "x" }, { canNote: false }) as any);
    expect(ok.state).not.toBe("denied");
  });

  it("refuses an empty tag or note instead of writing a blank one", async () => {
    expect((await executeCommerceAction(customerOpts("add_tag", { tag: "   " }) as any) as any).reason).toBe("tag_required");
    expect((await executeCommerceAction(customerOpts("add_note", { note: "" }) as any) as any).reason).toBe("note_required");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("refuses to act when the conversation has no verified customer", async () => {
    resolveVerifiedMock.mockResolvedValue(null);
    const res: any = await executeCommerceAction(customerOpts("add_tag", { tag: "x" }) as any);
    expect(res.state).toBe("denied");
    expect(res.reason).toBe("customer_not_linked");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("treats a prior success as a replay and does not write again", async () => {
    auditFindFirstMock.mockResolvedValue({ id: "prior" });
    execMock.mockImplementation(async ({ toolFunctionName }: any) =>
      toolFunctionName === "shopify.get_customer_tags"
        ? { ok: true, result: { tags: ["vip"] } }
        : { ok: false, reason: "should_not_be_called" });
    const res: any = await executeCommerceAction(customerOpts("add_tag", { tag: "vip" }) as any);
    expect(res.state).toBe("executed_customer");
    expect(execMock.mock.calls.some((c: any[]) => c[0].toolFunctionName === "shopify.add_tag")).toBe(false);
  });

  it("honours a policy denial", async () => {
    evalPolicyMock.mockResolvedValue({ decision: "DENIED", reasonCodes: ["tagging_disabled"] });
    const res: any = await executeCommerceAction(customerOpts("add_tag", { tag: "x" }) as any);
    expect(res.state).toBe("denied");
    expect(res.reason).toBe("tagging_disabled");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("routes through HITL when policy requires approval", async () => {
    evalPolicyMock.mockResolvedValue({ decision: "REQUIRES_HUMAN_APPROVAL", reasonCodes: [] });
    createApprovalMock.mockResolvedValue({ id: "appr-9" });
    const res: any = await executeCommerceAction(customerOpts("add_note", { note: "n" }) as any);
    expect(res.state).toBe("pending_approval");
    expect(res.approvalRequestId).toBe("appr-9");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("an order-scoped action with no order id is refused, not silently reinterpreted", async () => {
    const res: any = await executeCommerceAction(
      baseOpts({ request: { action: "refund", idempotencyKey: "i", params: {} } }) as any,
    );
    expect(res.state).toBe("denied");
    expect(res.reason).toBe("orderId_required");
  });
});
