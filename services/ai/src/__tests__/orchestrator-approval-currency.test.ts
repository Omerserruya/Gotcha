/**
 * The bot's HITL path writes the ORDER's currency into a refund approval -
 * wired, not just available. The order read goes through the adapter's own
 * read tool (stubbed here at executeAdapterTool); everything else is the
 * same harness as orchestrator-approval-row-survives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const lookups = vi.hoisted(() => ({ calls: [] as any[], answer: { ok: true, result: { currency: "ILS" } } as any }));
vi.mock("../services/connectors/integration-framework", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  executeAdapterTool: vi.fn(async (opts: any) => { lookups.calls.push(opts); return lookups.answer; }),
}));


/**
 * A gated action must still produce an approval row when the shared helper that
 * writes its title is missing.
 *
 * ★ THIS IS NOT A HYPOTHETICAL. The `ai` service mounts `services/ai/src` but
 * NOT `packages/shared`, which is a symlink to the BAKED copy. So this file can
 * be newer than the shared package the container loads, and on 2026-09-27 it
 * was: the mounted source called `describeApprovalAction` and the baked August
 * shared did not export it - verified inside the running container, file present,
 * 0 matches.
 *
 * ★★ AND THE FAILURE WAS SILENT BECAUSE OF THE MODULE FORMAT. Neither package
 * declares `"type": "module"`, so tsx emits CommonJS and a missing named import
 * is a property read that yields `undefined` rather than a load error. The call
 * threw, the orchestrator's own catch turned it into a `console.warn`, and no row
 * was written - a tool requiring approval made invisible to its approver. Under
 * ESM the service would have refused to start, which is louder and safer.
 *
 * So the barrel below deliberately OMITS `describeApprovalAction`, reproducing
 * the container exactly. A stale title is recoverable; a lost approval row is not.
 */

const { redisStore, redisMock, approvalCalls } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    redisStore: store,
    approvalCalls: [] as any[],
    redisMock: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string, ..._rest: any[]) => {
        if (_rest.includes("NX") && store.has(k)) return null;
        store.set(k, v);
        return "OK";
      }),
    },
  };
});

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  actionKindForTool: () => null,
  actionKindForCall: () => null,
  couponRequestedType: () => undefined,
  policyRequestedAmount: (_t: string, a: any) => (typeof a?.amount === "number" ? a.amount : undefined),
  evaluateBusinessPolicy: async () => ({ decision: "ALLOWED", policyId: null, policyVersion: null, matchedRules: [], reasonCodes: [] }),
  revalidateBeforeExecution: async () => ({ ok: true, decision: "ALLOWED" }),
  prisma: {
    toolExecutionRequest: { upsert: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
  },
  publishEvent: vi.fn().mockResolvedValue(undefined),
  // The gate that sends this down the approval path at all.
  evaluatePolicies: vi.fn().mockResolvedValue({ decision: "REQUIRE_APPROVAL", reason: "high risk tool" }),
  createApprovalRequest: vi.fn(async (input: any) => {
    approvalCalls.push(input);
    return { id: "appr_1", expiresAt: new Date() };
  }),
  getRedis: () => redisMock,
  // ★★ `undefined`, NOT OMITTED - AND THE DIFFERENCE INVERTS THE USUAL PROBLEM.
  //
  // Omitting it makes vitest's mock proxy THROW on property access ("No export
  // is defined on the mock"), which is HARSHER than production: neither package
  // declares `"type": "module"`, so tsx emits CommonJS and a missing named
  // export is an ordinary property read that yields `undefined`.
  //
  // Measured in the real image rather than argued:
  //
  //   docker run --rm --user root --entrypoint sh chatcenter-ai
  //     require("@chatcenter/shared").createApprovalRequest   -> function
  //     require("@chatcenter/shared").describeApprovalAction  -> undefined
  //
  // So `undefined` is the faithful double. Omitting it made the guard look
  // broken when the guard is correct - a double that is STRICTER than production
  // fails a working control, which is the mirror of the forgiving doubles that
  // pass a broken one, and just as misleading.
  describeApprovalAction: undefined,
}));

import { ActionOrchestrator } from "../services/orchestrator/action-orchestrator";

const action = (tool: string, args: Record<string, any>) => ({
  id: "a1", conversationId: "conv1", tenantId: "t1",
  proposedBy: { mode: "chat", system: "ai-bot" }, actor: { agentId: "" },
  tool, args, rationale: "r", urgency: "low",
}) as any;

const submit = (tool: string, args: Record<string, any>) =>
  new ActionOrchestrator().submit(action(tool, args), () => Promise.resolve({ toolCallId: "tc", content: "{}" }) as any, { idempotency: false });

beforeEach(() => {
  redisStore.clear();
  approvalCalls.length = 0;
  lookups.calls = [];
  lookups.answer = { ok: true, result: { currency: "ILS" } };
});

describe("refund approvals carry the order's currency", () => {
  it("★ the approval row gets the order's currency, read internally by order_name", async () => {
    await submit("shopify.process_refund", { amount: 179, order_name: "#1006" });
    expect(approvalCalls[0].params).toEqual({ amount: 179, order_name: "#1006", currency: "ILS" });
    expect(lookups.calls[0]).toMatchObject({
      tenantId: "t1", toolFunctionName: "shopify.get_financial_status", args: { order_name: "#1006" }, accessScope: "internal",
    });
  });

  it("★ the order cannot be read → the row is still written, without a currency", async () => {
    lookups.answer = { ok: false, reason: "order_not_found", failure: "refused" };
    await submit("shopify.process_refund", { amount: 179, order_name: "#1006" });
    expect(approvalCalls).toHaveLength(1);
    expect(approvalCalls[0].params).not.toHaveProperty("currency");
  });

  it("other gated tools are not looked up and get nothing added", async () => {
    await submit("shopify.cancel_order", { order_name: "#1006" });
    expect(approvalCalls[0].params).toEqual({ order_name: "#1006" });
    expect(lookups.calls).toHaveLength(0);
  });
});
