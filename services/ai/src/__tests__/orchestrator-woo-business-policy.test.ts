/**
 * ★ Trap 4 (2026-10-14, Omer's decision): WooCommerce refunds and coupons go
 * through the tenant's business policy, with the REAL policy engine (only the
 * database and the approval writer are doubles):
 *   - woocommerce.create_refund is a REFUND
 *   - woocommerce.create_coupon WITH order_id (a store credit) is a REFUND:
 *     bounded by the refund caps, allowed with approval when none is set
 *   - woocommerce.create_coupon WITHOUT order_id is a COUPON: denied unless
 *     the tenant has a coupon policy (like Shopify's create_discount_code)
 *   - Woo amounts are strings ("600.00"): they are compared with the cap
 *     (a number-only check let every string amount past it)
 *   - a percent coupon proposes "percentage_coupon", which a policy may prohibit
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ policies: [] as any[], approvals: [] as any[], decisions: [] as any[] }));

vi.mock("../services/connectors/integration-framework", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  executeAdapterTool: vi.fn(async () => ({ ok: true, result: { currency: "ILS" } })),
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const store = new Map<string, string>();
  return {
    ...actual,
    readDurableSetting: async () => null,
    // The wrapper's own I/O (load the policy, write the audit row) replaced;
    // the RULES are the real ones: evaluateConfig and the no-policy default.
    evaluateBusinessPolicy: async (opts: any) => {
      const bp: any = await import("@chatcenter/shared/src/lib/business-policy");
      const pol = H.policies.find((p) => p.tenantId === opts.tenantId && p.actionKind === opts.actionKind);
      const result = pol ? bp.evaluateConfig(pol.config, opts.facts, { policyId: pol.id, policyVersion: pol.version }) : bp.defaultDecisionWithoutPolicy(opts.actionKind);
      H.decisions.push({ actionKind: opts.actionKind, decision: result.decision, inputFacts: opts.facts });
      return result;
    },
    prisma: {
      businessActionPolicy: { findFirst: async (a: any) => H.policies.find((p) => p.tenantId === a.where.tenantId && p.actionKind === a.where.actionKind) ?? null },
      policyDecision: { create: async (a: any) => { H.decisions.push(a.data); return a.data; } },
      toolExecutionRequest: { upsert: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    },
    publishEvent: vi.fn().mockResolvedValue(undefined),
    evaluatePolicies: vi.fn().mockResolvedValue({ decision: "REQUIRE_APPROVAL", reason: "ask" }),
    createApprovalRequest: vi.fn(async (input: any) => { H.approvals.push(input); return { id: "appr_1", expiresAt: new Date() }; }),
    getRedis: () => ({
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => { store.set(k, v); return "OK"; },
    }),
  };
});

import { ActionOrchestrator } from "../services/orchestrator/action-orchestrator";
import { actionKindForCall, couponRequestedType, policyRequestedAmount, policyAmount } from "@chatcenter/shared";

const submit = (tool: string, args: Record<string, any>) =>
  new ActionOrchestrator().submit(
    { id: `a_${Math.random()}`, conversationId: "conv1", tenantId: "T", proposedBy: { mode: "chat", system: "ai-bot" }, actor: { agentId: "" }, tool, args, rationale: "r", urgency: "low" } as any,
    () => Promise.resolve({ toolCallId: "tc", content: "{}" }) as any,
    { idempotency: false },
  );
const policy = (actionKind: string, config: any) => ({ id: `p_${actionKind}`, tenantId: "T", actionKind, enabled: true, version: 1, config, effectiveFrom: new Date(0) });

beforeEach(() => { H.policies = []; H.approvals = []; H.decisions = []; });

describe("★ which kind each call is", () => {
  it("refund; a coupon for an order is a refund (store credit); an open coupon is a coupon", () => {
    expect(actionKindForCall("woocommerce.create_refund", { order_id: "1", amount: "10" })).toBe("REFUND");
    expect(actionKindForCall("woocommerce.create_coupon", { order_id: "575", amount: "549" })).toBe("REFUND");
    expect(actionKindForCall("woocommerce.create_coupon", { code: "x", amount: "10" })).toBe("COUPON");
    expect(actionKindForCall("woocommerce.create_coupon", { order_id: "  " })).toBe("COUPON");
    expect(actionKindForCall("woocommerce.cancel_order", {})).toBe("CANCEL_ORDER");
    expect(actionKindForCall("shopify.create_discount_code", {})).toBe("COUPON");
  });
  it("amounts: numbers and numeric strings; a percent coupon has none and says so", () => {
    expect(policyAmount("600.00")).toBe(600);
    expect(policyAmount(" 49.9 ")).toBe(49.9);
    for (const v of ["10%", "abc", "", null, {}]) expect(policyAmount(v)).toBeUndefined();
    expect(couponRequestedType("woocommerce.create_coupon", { discount_type: "fixed_cart" })).toBe("fixed_coupon");
    expect(couponRequestedType("woocommerce.create_coupon", { amount: "10" })).toBe("percentage_coupon");
    expect(policyRequestedAmount("woocommerce.create_coupon", { amount: "10" })).toBeUndefined();
    expect(policyRequestedAmount("woocommerce.create_coupon", { amount: "549", discount_type: "fixed_cart" })).toBe(549);
  });
});

describe("★ through the orchestrator, with the real policy engine", () => {
  it("create_refund with a STRING amount above the refund cap: denied, naming the max; within it: an approval", async () => {
    H.policies = [policy("REFUND", { maxAmount: 500 })];
    const over: any = await submit("woocommerce.create_refund", { order_id: "575", amount: "600.00" });
    expect(JSON.stringify(over)).toMatch(/business_policy_amount_capped: the maximum permitted is 500/);
    expect(H.approvals).toHaveLength(0);
    await submit("woocommerce.create_refund", { order_id: "575", amount: "400" });
    expect(H.approvals).toHaveLength(1);
    expect(H.decisions.map((d) => d.actionKind)).toEqual(["REFUND", "REFUND"]);
  });

  it("★ a store credit (coupon WITH order_id) is bounded by the REFUND cap; with no policy it still asks", async () => {
    H.policies = [policy("REFUND", { maxAmount: 500 })];
    const over: any = await submit("woocommerce.create_coupon", { order_id: "575", code: "credit575", amount: "549.00", discount_type: "fixed_cart" });
    expect(JSON.stringify(over)).toMatch(/maximum permitted is 500/);
    expect(H.approvals).toHaveLength(0);
    H.policies = [];
    await submit("woocommerce.create_coupon", { order_id: "575", code: "credit575", amount: "549.00", discount_type: "fixed_cart" });
    expect(H.approvals).toHaveLength(1);
  });

  it("★ an open coupon (no order_id) is a COUPON: denied with no coupon policy, like Shopify", async () => {
    const r: any = await submit("woocommerce.create_coupon", { code: "free100", amount: "100", discount_type: "fixed_cart" });
    expect(JSON.stringify(r)).toMatch(/business_policy_denied: no_compensation_policy_configured/);
    expect(H.approvals).toHaveLength(0);
    expect(H.decisions[0]).toMatchObject({ actionKind: "COUPON", decision: "DENIED" });
  });

  it("a percent coupon proposes percentage_coupon, which a policy may prohibit", async () => {
    H.policies = [policy("COUPON", { prohibitedTypes: ["percentage_coupon"] })];
    const r: any = await submit("woocommerce.create_coupon", { code: "p10", amount: "10" });
    expect(JSON.stringify(r)).toMatch(/business_policy_denied/);
    expect(H.decisions[0].inputFacts).toMatchObject({ requestedType: "percentage_coupon" });
    expect(H.decisions[0].inputFacts.requestedAmount).toBeUndefined();
  });
});
