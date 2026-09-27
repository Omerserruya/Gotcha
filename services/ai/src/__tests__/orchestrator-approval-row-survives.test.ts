import { describe, it, expect, vi, beforeEach } from "vitest";

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
import type { ProposedAction } from "../services/orchestrator/types";

function action(tool: string, args: Record<string, any>): ProposedAction {
  return {
    id: "a1",
    conversationId: "conv1",
    tenantId: "t1",
    proposedBy: { mode: "chat", system: "ai-bot" },
    actor: { agentId: "" },
    tool,
    args,
    rationale: "ai-bot inbox tool call",
    urgency: "low" as const,
  } as ProposedAction;
}

let orch: ActionOrchestrator;
beforeEach(() => {
  redisStore.clear();
  approvalCalls.length = 0;
  orch = new ActionOrchestrator();
});

describe("a gated action against a stale shared package", () => {
  it("STILL WRITES THE APPROVAL ROW", async () => {
    // The row is the whole point: without it a tool requiring approval is
    // invisible to the person who has to approve it.
    await orch.submit(action("shopify.process_refund", { amount: 179, order_name: "#1006" }),
      () => Promise.resolve({ toolCallId: "tc", content: "{}" }) as any, { idempotency: false });

    expect(approvalCalls).toHaveLength(1);
    expect(approvalCalls[0].tool).toBe("shopify.process_refund");
  });

  it("falls back to the OLD title rather than losing the row", async () => {
    await orch.submit(action("shopify.process_refund", { amount: 179, order_name: "#1006" }),
      () => Promise.resolve({ toolCallId: "tc", content: "{}" }) as any, { idempotency: false });

    // Degraded, not absent. This is the pre-fix string, and seeing it in a
    // running environment is the signal that `ai` is serving a stale shared.
    expect(approvalCalls[0].summary).toBe("ai-bot inbox tool call");
  });

  it("does not report success for the gated call", async () => {
    const res: any = await orch.submit(action("shopify.process_refund", { amount: 5 }),
      () => Promise.resolve({ toolCallId: "tc", content: "{}" }) as any, { idempotency: false });
    expect(res.status).toBe("proposed");
  });
});
