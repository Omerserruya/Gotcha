/**
 * Tool lifecycle events go to ONE conversation's room and carry neither what
 * the tool was given nor what it returned.
 *
 * They used to be published with no `data.channel`, so the Socket.IO bridge
 * (conversation service) sent them to `tenant:{id}` - every tab in the
 * workspace, past the `canViewConversation` check that guards joining
 * `conv:{id}`. `tool.execution.completed` carried `result` (a Shopify order
 * with the customer's name, address, phone) and `proposed` carried `args`.
 *
 * What this pins is the half that lives in this service: every event names
 * `conv:{conversationId}` as its room and has no args/result, and an event
 * with no conversation is not published at all. The other half - that joining
 * `conv:{id}` requires canViewConversation - is conversation/src/lib/socket.ts
 * (`subscribe:conversation`); it is not exercised here because no socket
 * client library is installed in this repo.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    events: [] as any[],
    gate: { decision: "ALLOWED" as string },
    redis: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, ...r: any[]) => { if (r.includes("NX") && store.has(k)) return null; store.set(k, v); return "OK"; },
    },
    store,
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
    toolExecutionRequest: {
      upsert: vi.fn().mockResolvedValue({}),
      // `approve`/`deny` read the tenant and conversation off the row they update.
      update: vi.fn(async () => ({ tenantId: "t1", conversationId: "conv1", tool: "shopify.process_refund" })),
    },
  },
  publishEvent: vi.fn(async (e: any) => { H.events.push(e); }),
  evaluatePolicies: vi.fn(async () => ({ decision: H.gate.decision, reason: "test" })),
  createApprovalRequest: vi.fn(async () => ({ id: "appr_1", expiresAt: new Date() })),
  describeApprovalAction: () => "Refund",
  getRedis: () => H.redis,
}));

import { ActionOrchestrator } from "../services/orchestrator/action-orchestrator";
import type { ProposedAction } from "../services/orchestrator/types";

const ORDER = { name: "#1006", customer: { first_name: "Dana", phone: "+972501234567" }, shipping_address: { address1: "Herzl 1" } };
const action = (tool: string, o: Partial<ProposedAction> = {}): ProposedAction => ({
  id: "a1", conversationId: "conv1", tenantId: "t1",
  proposedBy: { mode: "chat", system: "ai-bot" }, actor: { agentId: "" },
  tool, args: { order_name: "#1006", phone: "+972501234567" }, rationale: "r", urgency: "low", ...o,
} as ProposedAction);

let orch: ActionOrchestrator;
beforeEach(() => { H.events.length = 0; H.store.clear(); H.gate.decision = "ALLOWED"; orch = new ActionOrchestrator(); });

const lifecycle = () => H.events.filter((e) => e.event.startsWith("tool.execution.")).map((e) => e.event);
const activity = () => H.events.filter((e) => e.event === "ai.activity.updated").map((e) => e.data);

function assertScoped() {
  expect(H.events.length).toBeGreaterThan(0);
  for (const e of H.events) {
    expect(e.tenantId).toBe("t1");
    expect(e.data.channel).toBe("conv:conv1");
    expect(e.data).not.toHaveProperty("result");
    expect(e.data).not.toHaveProperty("args");
    // Nothing of the customer's rides along under any other key either.
    expect(JSON.stringify(e.data)).not.toMatch(/Dana|972501234567|Herzl/);
  }
}

describe("★ tool lifecycle events are scoped to the conversation and carry no tool data", () => {
  it("a run: started + completed, without the order the tool returned", async () => {
    await orch.submit(action("shopify.order_lookup"), async () => ORDER, { idempotency: false });
    expect(lifecycle()).toEqual(["tool.execution.started", "tool.execution.completed"]);
    assertScoped();
    // The panel's live line: one step per lifecycle event, labelled, same room.
    expect(activity().map((a) => [a.status, a.labelKey, a.id])).toEqual([
      ["running", "looking_up_order", "a1"],
      ["completed", "looking_up_order", "a1"],
    ]);
  });

  it("a failure", async () => {
    await orch.submit(action("shopify.order_lookup"), async () => { throw new Error("timeout"); }, { idempotency: false });
    expect(lifecycle()).toContain("tool.execution.failed");
    expect(activity().at(-1)).toMatchObject({ status: "failed", tool: "shopify.order_lookup" });
    assertScoped();
  }, 30_000); // withRetry's real backoff runs before the failure is final

  it("a proposal, without the arguments the AI proposed", async () => {
    H.gate.decision = "REQUIRE_APPROVAL";
    await orch.submit(action("shopify.process_refund"), async () => ORDER, { idempotency: false });
    expect(lifecycle()).toContain("tool.execution.proposed");
    assertScoped();
  });

  it("approve and deny by id now reach the conversation (they used to carry no tenant at all)", async () => {
    await orch.approve("a1", "agent1");
    await orch.deny("a1", "agent1", "no");
    expect(lifecycle()).toEqual(["tool.execution.approved", "tool.execution.denied"]);
    expect(activity().map((a) => a.status)).toEqual(["approved", "denied"]);
    assertScoped();
  });

  it("an event with no conversation is NOT published tenant-wide - it is not published", async () => {
    await orch.submit(action("shopify.order_lookup", { conversationId: "" }), async () => ORDER, { idempotency: false });
    expect(H.events).toHaveLength(0);
  });
});
