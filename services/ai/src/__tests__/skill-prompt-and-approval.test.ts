/**
 * Where a business skill lands in the prompt, and the orchestrator's
 * tighten-only approval hook.
 *
 *   - names are in the cached prefix (BLOCK 2); the active block is NOT (it is
 *     per turn), so the prefix only changes when the employee's list changes
 *   - the active skill's requiredInfo appears in the knowledge ledger
 *   - ★ no businessSkills → the prompt is byte-identical to before
 *   - the hook turns an ALLOW into an approval and never loosens a DENY
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const O = vi.hoisted(() => ({ gate: { decision: "ALLOW" as string, reason: "" }, executed: 0, approvals: 0 }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    evaluatePolicies: async () => ({ ...O.gate }),
    evaluateBusinessPolicy: async () => ({ decision: "ALLOWED", reasonCodes: [] }),
    actionKindForTool: () => null,
    actionKindForCall: () => null,
    couponRequestedType: () => undefined,
    policyRequestedAmount: (_t: string, a: any) => (typeof a?.amount === "number" ? a.amount : undefined),
    createApprovalRequest: async () => { O.approvals++; return { id: "ap1", expiresAt: new Date() }; },
    describeApprovalAction: () => "x",
    publishEvent: async () => undefined,
    getRedis: () => ({ get: async () => null, set: async () => "OK" }),
    prisma: { toolExecutionRequest: { upsert: async () => ({}), update: async () => ({ tenantId: "t1", conversationId: "c1", tool: "x" }) } },
  };
});

import { buildAgentPrompt, stablePrefixOf, type AgentRecord } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";
import { ActionOrchestrator } from "../services/orchestrator/action-orchestrator";
import { computeStepStates, renderActiveSkillBlock, HANDOVER_WORDING_RULE } from "../services/skill-runtime.service";

const AGENT = { name: "Maya", role: "customer_support", tone: "friendly", style: {}, identity: {}, goals: {}, toneConfig: {}, behavioral: {}, persona: {}, conversationFlow: null, customGuardrails: null, escalationRules: null, behavioralAnchors: null } as AgentRecord;
const behaviorState = computeBehaviorState({
  mode: "agent",
  identity: { hasContact: true, contactLifecycle: null, priorConversationCount: 0 },
  request: { lastMessage: "where is my order", messageCount: 2, recentInboundTexts: ["where is my order"] },
});
const base = { behaviorState, agent: AGENT, context: { customerBlock: "## Customer\n- Channel: whatsapp" }, knowledge: {}, toolFunctionNames: ["escalate_to_human"] };

describe("★ the prompt", () => {
  it("no businessSkills → identical to a prompt built without the field", () => {
    expect(buildAgentPrompt({ ...base, businessSkills: undefined } as any)).toBe(buildAgentPrompt(base as any));
  });

  it("names in the cached prefix, the active block only in the turn, info in the ledger", () => {
    const p = buildAgentPrompt({
      ...base,
      businessSkills: {
        names: ["Delivery status"],
        activeBlock: "# Active Skill: Delivery status\nSteps, in order:",
        noSkillBlock: null,
        requiredInfo: [{ key: "order_number", label: "Order number", importance: "required", priority: 1 }],
      },
    } as any);
    const prefix = stablePrefixOf(p);
    expect(prefix).toContain("You have business skills for: Delivery status");
    expect(prefix).not.toContain("# Active Skill: Delivery status");
    expect(p).toContain("# Active Skill: Delivery status");
    expect(p).toMatch(/order_number|Order number/);
  });

  it("★ a live skill pauses the Current Plan's drive (capabilities stay); without one the plan drives as before", () => {
    const withSkill = buildAgentPrompt({
      ...base, businessSkills: { names: ["Delivery status"], activeName: "Delivery status", activeBlock: "# Active Skill: Delivery status", noSkillBlock: null, requiredInfo: [] },
    } as any);
    expect(withSkill).toContain("# Current Plan (paused this turn)");
    expect(withSkill).not.toContain("# Current Plan (decide and ACT this turn)");
    const without = buildAgentPrompt(base as any);
    expect(without).toContain("# Current Plan (decide and ACT this turn)");
    expect(without).not.toContain("paused this turn");
  });

  it("★ an escalation turn's prompt carries the hand-over wording rule (in the turn, not the prefix)", () => {
    const states = computeStepStates(
      [{ id: "e1", kind: "find", title: "Find the order", tools: ["shopify.order_lookup"] }, { id: "e2", kind: "change", title: "Exchange the item", tools: ["shopify.exchange_order_item"] }],
      [{ tool: "shopify.order_lookup", status: "completed", proposedAt: new Date(1) }],
      ["shopify.order_lookup"],
    );
    const active = renderActiveSkillBlock({ id: "sk", name: "Exchange a product", whenToUse: null, rules: [] } as any, states, []);
    const p = buildAgentPrompt({ ...base, businessSkills: { names: ["Exchange a product"], activeName: "Exchange a product", activeBlock: active, noSkillBlock: null, requiredInfo: [] } } as any);
    expect(p).toContain(HANDOVER_WORDING_RULE);
    expect(p).toMatch(/Exchange the item.*<- you are here\n.*do not offer it, promise it or ask the customer to confirm it/);
    expect(stablePrefixOf(p)).not.toContain(HANDOVER_WORDING_RULE);
  });

  it("the cached prefix does not change with the active skill (cache-stable)", () => {
    const mk = (active: string | null) => stablePrefixOf(buildAgentPrompt({
      ...base, businessSkills: { names: ["Delivery status"], activeBlock: active, noSkillBlock: null, requiredInfo: [] },
    } as any));
    expect(mk("# Active Skill: Delivery status\nstep 1")).toBe(mk(null));
  });
});

describe("★ the orchestrator hook only tightens", () => {
  beforeEach(() => { O.executed = 0; O.approvals = 0; });
  const action = { id: "a1", conversationId: "c1", tenantId: "t1", proposedBy: { mode: "chat", system: "ai-bot" }, actor: { agentId: "" }, tool: "shopify.exchange_order_item", args: { amount: 250 }, rationale: "r", urgency: "low" } as any;
  const run = async () => { O.executed++; return { ok: true }; };

  it("ALLOW + a reason → proposed for a person, not executed", async () => {
    O.gate = { decision: "ALLOW", reason: "" };
    const r: any = await new ActionOrchestrator().submit(action, run, { tightenApproval: () => "over 200" });
    expect(r.status).toBe("proposed");
    expect(O.executed).toBe(0);
  });

  it("ALLOW + no reason → executes as before", async () => {
    O.gate = { decision: "ALLOW", reason: "" };
    const r: any = await new ActionOrchestrator().submit(action, run, { tightenApproval: () => null });
    expect(r.status).toBe("completed");
    expect(O.executed).toBe(1);
  });

  it("★ a DENY stays a DENY (the hook is not even consulted)", async () => {
    O.gate = { decision: "DENY", reason: "blocked" };
    const hook = vi.fn(() => null);
    const r: any = await new ActionOrchestrator().submit(action, run, { tightenApproval: hook });
    expect(r.status).toBe("denied");
    expect(hook).not.toHaveBeenCalled();
  });
});
