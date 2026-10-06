/**
 * Business skills in the loop (docs/product/ai-studio-skills-automations.md
 * §3.2): selection, stickiness, topic change, edits/removal, step states,
 * watch never shapes the reply, approval only tightens, and - the regression
 * that matters most - an employee with no skills gets exactly the prompt and
 * the judgement call it got before skills existed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ calls: [] as any[], reply: "{}" }));
vi.mock("../services/ai.service", () => ({
  generateResponse: async (p: any) => { H.calls.push(p); return { content: H.reply }; },
  getMicroModel: () => "micro",
  getDefaultModel: () => "gpt",
}));

import {
  decideSkillTurn,
  computeStepStates,
  currentStepOf,
  isSkillComplete,
  sameTool,
  renderActiveSkillBlock,
  businessSkillsForPrompt,
  skillApprovalReason,
  selectionCandidates,
  traceAsRequests,
  outcomeOfCall,
  HANDOVER_WORDING_RULE,
  withStartSkill,
  type SkillCandidate,
  type SkillContext,
} from "../services/skill-runtime.service";
import { evaluateWizardBinding } from "../services/wizard-binding.service";

const skill = (o: Partial<SkillCandidate> = {}): SkillCandidate => ({
  id: "sk_delivery", name: "Delivery status", situation: "where is my order", whenToUse: "asks where an order is",
  examples: ["where is my order"], exclusions: [],
  steps: [
    { id: "s1", kind: "find", title: "Find the order", tools: ["shopify.order_lookup"] },
    { id: "s2", kind: "check", title: "Check the shipment", tools: ["shopify.track_shipment"], elseNote: "offer a person" },
    { id: "s3", kind: "message", title: "Tell the customer", tools: [] },
  ],
  rules: [{ type: "never", text: "promise a date the carrier did not give" }],
  requiredInfo: [{ key: "order_number", label: "Order number", priority: 1 }],
  version: 1, mode: "on", order: 0, ...o,
});
const exchange = skill({ id: "sk_exchange", name: "Exchange a product", order: 1, steps: [
  { id: "e1", kind: "find", title: "Find the order", tools: ["shopify.order_lookup"] },
  { id: "e2", kind: "change", title: "Exchange the item", tools: ["shopify.exchange_order_item"], approvalOverAmount: 200 },
] });
const ctx = (o: Partial<SkillContext> = {}): SkillContext => ({ candidates: [skill(), exchange], openRun: null, noSkillPolicy: "answer_from_knowledge", ...o });
const open = (o: any = {}) => ({ id: "run1", skillId: "sk_delivery", skillVersion: 1, mode: "on" as const, currentStepId: "s1", missedTurns: 0, startedAt: new Date(0), ...o });

describe("★ selection and continuity (decideSkillTurn)", () => {
  it("starts the matched skill; nothing when none fits", () => {
    expect(decideSkillTurn(ctx(), "sk_delivery")).toMatchObject({ starts: true, close: null, active: { skill: { id: "sk_delivery" }, runId: null } });
    expect(decideSkillTurn(ctx(), null)).toEqual({ active: null, close: null, starts: false });
  });

  it("an id that is not a candidate counts as none", () => {
    expect(decideSkillTurn(ctx(), "sk_other_tenant").active).toBeNull();
  });

  it("★ sticky: the open run continues on its own skill, and on ONE turn that fits nothing", () => {
    expect(decideSkillTurn(ctx({ openRun: open() }), "sk_delivery")).toMatchObject({ starts: false, active: { runId: "run1", missedTurns: 0 } });
    expect(decideSkillTurn(ctx({ openRun: open() }), null)).toMatchObject({ starts: false, active: { runId: "run1", missedTurns: 1 }, close: null });
  });

  it("★ two turns that fit nothing close the run as a topic change", () => {
    expect(decideSkillTurn(ctx({ openRun: open({ missedTurns: 1 }) }), null)).toEqual({ active: null, close: { runId: "run1", reason: "topic_changed" }, starts: false });
  });

  it("★ a clear switch to another skill closes the open run and starts the new one", () => {
    expect(decideSkillTurn(ctx({ openRun: open() }), "sk_exchange")).toMatchObject({
      starts: true, close: { runId: "run1", reason: "topic_changed" }, active: { skill: { id: "sk_exchange" } },
    });
  });

  it("no verdict (the judgement failed) changes nothing: the open run continues, nothing starts", () => {
    expect(decideSkillTurn(ctx({ openRun: open() }), undefined)).toMatchObject({ active: { runId: "run1" }, starts: false });
    expect(decideSkillTurn(ctx(), undefined)).toEqual({ active: null, close: null, starts: false });
  });

  it("★ removed / off / archived mid-conversation → the run ends skill_removed", () => {
    expect(decideSkillTurn(ctx({ candidates: [exchange], openRun: open() }), null)).toEqual({
      active: null, close: { runId: "run1", reason: "skill_removed" }, starts: false,
    });
  });

  it("★ edited mid-conversation → the run ends skill_changed, the new version starts if it still fits", () => {
    const edited = ctx({ candidates: [skill({ version: 2 }), exchange], openRun: open() });
    expect(decideSkillTurn(edited, "sk_delivery")).toMatchObject({
      close: { runId: "run1", reason: "skill_changed" }, starts: true, active: { skill: { version: 2 }, runId: null },
    });
  });

  it("candidates go to the judgement in the employee's order, with exclusions naming the other skill", () => {
    const c = ctx({ candidates: [exchange, skill({ exclusions: [{ text: "wants to swap a size", skillId: "sk_exchange" }] })] });
    const out = selectionCandidates(c);
    expect(out.map((k) => k.id)).toEqual(["sk_delivery", "sk_exchange"]);
    expect(out[0].exclusions).toEqual([{ text: "wants to swap a size", useSkillInstead: "Exchange a product" }]);
  });
});

describe("★ step states come from tool requests, never from the model", () => {
  const surface = ["shopify.order_lookup", "shopify.track_shipment", "escalate_to_human"];
  const req = (tool: string, status: string, t: number) => ({ tool, status, proposedAt: new Date(t) });

  it("done / waiting for approval / current step", () => {
    const st = computeStepStates(skill().steps, [req("shopify.order_lookup", "completed", 1), req("shopify.track_shipment", "proposed", 2)], surface);
    expect(st.map((s) => s.state)).toEqual(["done", "awaiting_approval", "todo"]);
    expect(currentStepOf(st)?.id).toBe("s2");
    expect(isSkillComplete(st)).toBe(false);
  });

  it("★ a tool the employee does not have makes the step unavailable (the hand-over point)", () => {
    const st = computeStepStates(skill().steps, [], ["shopify.order_lookup"]);
    expect(st.map((s) => s.state)).toEqual(["todo", "unavailable", "todo"]);
  });

  it("complete when every step with tools is done; integration naming matches both ways", () => {
    expect(sameTool("integration.order_lookup", "integration_order_lookup")).toBe(true);
    const st = computeStepStates(skill().steps, [req("shopify.order_lookup", "completed", 1), req("shopify.track_shipment", "completed", 2)], surface);
    expect(isSkillComplete(st)).toBe(true);
  });

  it("the newest request wins (a failed retry that later succeeded is done)", () => {
    const st = computeStepStates(skill().steps, [req("shopify.order_lookup", "failed", 1), req("shopify.order_lookup", "completed", 2)], surface);
    expect(st[0].state).toBe("done");
  });
});

describe("★ the prompt", () => {
  const base = { requests: [], surface: ["shopify.order_lookup", "shopify.track_shipment"], factText: "" };

  it("★ NO skills and the default policy → undefined (the prompt is what it was before)", () => {
    expect(businessSkillsForPrompt({ ...base, ctx: ctx({ candidates: [] }), activeOnSkill: null })).toBeUndefined();
  });

  it("a live skill: names in BLOCK 2, the block in the turn, its info in the ledger", () => {
    const out = businessSkillsForPrompt({ ...base, ctx: ctx(), activeOnSkill: skill() })!;
    expect(out.names).toEqual(["Delivery status", "Exchange a product"]);
    expect(out.activeBlock).toContain("# Active Skill: Delivery status");
    expect(out.activeBlock).toContain("<- you are here");
    expect(out.activeBlock).toContain("Still needed from the customer: Order number");
    expect(out.requiredInfo).toEqual([{ key: "order_number", label: "Order number", importance: "required", priority: 1 }]);
    expect(out.noSkillBlock).toBeNull();
    expect(out.activeName).toBe("Delivery status");
  });

  it("★ watch mode never reaches the prompt (no block, not in the names, no ledger fields)", () => {
    const watchCtx = ctx({ candidates: [skill({ mode: "watch" })] });
    const out = businessSkillsForPrompt({ ...base, ctx: watchCtx, activeOnSkill: skill({ mode: "watch" }) })!;
    expect(out).toEqual({ names: [], activeName: null, activeBlock: null, noSkillBlock: null, requiredInfo: [] });
  });

  it("no skill fits + a non-default policy → the policy block", () => {
    const out = businessSkillsForPrompt({ ...base, ctx: ctx({ noSkillPolicy: "always_handover" }), activeOnSkill: null })!;
    expect(out.noSkillBlock).toContain("escalate_to_human");
    expect(out.activeBlock).toBeNull();
  });

  it("the block forbids claiming a step that is not done, and carries no wide dash", () => {
    const block = renderActiveSkillBlock(skill(), computeStepStates(skill().steps, [], ["shopify.order_lookup"]), []);
    expect(block).toContain("Never claim a step you have not seen marked [done]");
    expect(block).toContain("You do not have the tool for this step");
    expect(block).toContain("If it cannot be done: offer a person");
    expect(block).not.toMatch(/[–—―]/);
  });

  it("★ at a step it cannot do, the hand-over turn may not offer or ask to do it", () => {
    // Exchange: the order is found, the swap tool is not on this employee.
    const out = businessSkillsForPrompt({
      ...base, ctx: ctx({ candidates: [exchange] }), activeOnSkill: exchange,
      requests: [{ tool: "shopify.order_lookup", status: "completed", proposedAt: new Date(1) }],
      surface: ["shopify.order_lookup"],
    })!;
    const here = out.activeBlock!.split("\n").findIndex((l) => l.includes("<- you are here"));
    expect(out.activeBlock!.split("\n")[here]).toContain("[you cannot do this step] Exchange the item");
    expect(out.activeBlock!.split("\n")[here + 1]).toMatch(/do not offer it, promise it or ask the customer to confirm it/);
    expect(out.activeBlock).toContain("a person will continue it");
    expect(out.activeBlock).toContain(HANDOVER_WORDING_RULE);
  });

  it("the hand-over wording rule rides every active block (an escalation can come from any step)", () => {
    const block = renderActiveSkillBlock(skill(), computeStepStates(skill().steps, [], ["shopify.order_lookup", "shopify.track_shipment"]), []);
    expect(block).toContain(HANDOVER_WORDING_RULE);
    expect(HANDOVER_WORDING_RULE).toMatch(/must not offer, promise or ask the customer to confirm any further step/);
    expect(HANDOVER_WORDING_RULE).not.toMatch(/[–—―]/);
  });
});

describe("★ a skill can only TIGHTEN approval", () => {
  it("over the step's amount → a reason; at or under → null", () => {
    expect(skillApprovalReason(exchange, "shopify.exchange_order_item", { amount: 250 })).toMatch(/asks a person over 200/);
    expect(skillApprovalReason(exchange, "shopify.exchange_order_item", { amount: 200 })).toBeNull();
    expect(skillApprovalReason(exchange, "shopify.exchange_order_item", {})).toBeNull();
  });

  it("only for a tool of that step, and only in mode on", () => {
    expect(skillApprovalReason(exchange, "shopify.order_lookup", { amount: 999 })).toBeNull();
    expect(skillApprovalReason({ ...exchange, mode: "watch" }, "shopify.exchange_order_item", { amount: 999 })).toBeNull();
    expect(skillApprovalReason(null, "shopify.exchange_order_item", { amount: 999 })).toBeNull();
  });
});

describe("★ selection rides the existing judgement call", () => {
  beforeEach(() => { H.calls = []; H.reply = "{}"; });
  const sel = selectionCandidates(ctx());

  it("no config and no skills → no call at all (unchanged)", async () => {
    const f = await evaluateWizardBinding({ tenantId: "T", conversationId: "c", role: "customer_support", transcript: "Customer: hi" });
    expect(H.calls).toHaveLength(0);
    expect(f.matchedSkillId).toBeUndefined();
  });

  it("★ config but no skills → the prompt does not mention skills (byte-identical to before)", async () => {
    await evaluateWizardBinding({ tenantId: "T", conversationId: "c", role: "sales", goal: "book a demo", transcript: "Customer: hi" });
    const text = H.calls[0].messages.map((m: any) => m.content).join("\n");
    expect(text).not.toMatch(/skill/i);
  });

  it("skills only → one call; config facts stay EMPTY; the verdict is whitelisted", async () => {
    H.reply = JSON.stringify({ skillId: "sk_exchange", fit: "disqualified" });
    const f = await evaluateWizardBinding({ tenantId: "T", conversationId: "c", role: "sales", transcript: "Customer: I want a bigger size", skills: sel });
    expect(H.calls).toHaveLength(1);
    expect(f).toMatchObject({ evaluated: false, fit: "neutral", matchedSkillId: "sk_exchange" });
    H.reply = JSON.stringify({ skillId: "made_up" });
    expect((await evaluateWizardBinding({ tenantId: "T", conversationId: "c", role: "sales", transcript: "Customer: x", skills: sel })).matchedSkillId).toBeNull();
  });

  it("the open run is marked so the judgement can keep it", async () => {
    await evaluateWizardBinding({ tenantId: "T", conversationId: "c", role: "sales", transcript: "Customer: ok", skills: sel, openSkillId: "sk_delivery" });
    expect(H.calls[0].messages[1].content).toContain('id "sk_delivery": Delivery status (OPEN in this conversation)');
  });
});


describe("★ found in the live check: the trace, not only request rows", () => {
  const surface = ["shopify.order_lookup", "shopify.track_shipment"];

  it("a result reused from the idempotency window (no request row) still completes its step", () => {
    const trace = [{ step: "s1", tool: "shopify.order_lookup", outcome: "completed", at: new Date(5).toISOString() }];
    expect(computeStepStates(skill().steps, traceAsRequests(trace), surface)[0].state).toBe("done");
  });

  it("an approval completed AFTER the turn that asked wins over that turn's 'approval requested'", () => {
    const trace = [{ step: "s2", tool: "shopify.track_shipment", outcome: "approval_requested", at: new Date(10).toISOString() }];
    const requestCompletedLater = [{ tool: "shopify.track_shipment", status: "completed", proposedAt: new Date(20) }];
    const st = computeStepStates(skill().steps, [...requestCompletedLater, ...traceAsRequests(trace)], surface);
    expect(st[1].state).toBe("done");
  });

  it("decisions map to outcomes; an escalation is logged as 'escalate', a refused call records nothing", () => {
    expect(outcomeOfCall({ tool: "escalate_to_human", decision: "escalate", ok: false })).toBe("escalated");
    expect(outcomeOfCall({ tool: "x", decision: "executed", ok: true })).toBe("completed");
    expect(outcomeOfCall({ tool: "x", decision: "executed_on_retry", ok: false })).toBe("failed");
    expect(outcomeOfCall({ tool: "x", decision: "awaiting_approval", ok: false })).toBe("approval_requested");
    expect(outcomeOfCall({ tool: "x", decision: "simulated", ok: true })).toBe("simulated");
    expect(outcomeOfCall({ tool: "x", decision: "missing_required_inputs", ok: false })).toBeNull();
  });
});


describe("★ found in the live check: a just-finished skill is not restarted", () => {
  it("a match on a skill that finished within the cooldown starts nothing", () => {
    expect(decideSkillTurn(ctx({ recentlyDoneSkillIds: ["sk_delivery"] }), "sk_delivery")).toEqual({ active: null, close: null, starts: false });
  });
  it("another skill still starts; an older finished one can start again", () => {
    expect(decideSkillTurn(ctx({ recentlyDoneSkillIds: ["sk_delivery"] }), "sk_exchange").starts).toBe(true);
    expect(decideSkillTurn(ctx({ doneSkillIds: ["sk_delivery"], recentlyDoneSkillIds: [] }), "sk_delivery").starts).toBe(true);
  });
});

describe("★ an automation's Run a skill", () => {
  it("names the skill for the turn when the employee has it, past the restart cooldown", () => {
    const c = ctx({ recentlyDoneSkillIds: ["sk_exchange"] } as any);
    const r = withStartSkill(c, null, "sk_exchange");
    expect(r.matched).toBe("sk_exchange");
    expect(decideSkillTurn(r.ctx, r.matched)).toMatchObject({ starts: true, active: { skill: { id: "sk_exchange" } } });
  });

  it("a skill the employee does not have changes nothing; no start keeps the judgement", () => {
    const c = ctx();
    expect(withStartSkill(c, "sk_delivery", "sk_other")).toEqual({ ctx: c, matched: "sk_delivery" });
    expect(withStartSkill(c, "sk_delivery", null)).toEqual({ ctx: c, matched: "sk_delivery" });
  });
});
