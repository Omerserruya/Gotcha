/**
 * Acceptance 6 (plan §5): a step that needs a person's approval, the approval
 * decided later, and the skill run picks up AT THAT STEP - it does not
 * restart, and nothing before it runs again.
 *
 * Shown at the runtime level (settleSkillRun + decideSkillTurn over an
 * in-memory SkillRun / ToolExecutionRequest store) because a live run needs
 * a skill in mode "on", which waits on Omer's approval, and a real approval
 * item. The orchestrator half - ALLOW + a skill's amount limit turns into an
 * approval instead of an execution - is skill-prompt-and-approval.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DB = vi.hoisted(() => ({ run: null as any, requests: [] as any[], audits: [] as string[] }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    writeAudit: async (e: any) => { DB.audits.push(e.action); },
    prisma: {
      skillRun: {
        findFirst: async (a: any) => (DB.run && DB.run.id === a.where.id && DB.run.tenantId === a.where.tenantId ? { ...DB.run, trace: [...DB.run.trace] } : null),
        updateMany: async (a: any) => {
          if (!DB.run || DB.run.id !== a.where.id || DB.run.status !== a.where.status) return { count: 0 };
          Object.assign(DB.run, a.data);
          return { count: 1 };
        },
      },
      toolExecutionRequest: {
        findMany: async (a: any) => DB.requests.filter((r) => r.tenantId === a.where.tenantId && r.conversationId === a.where.conversationId && r.proposedAt >= a.where.proposedAt.gte),
      },
    },
  };
});

import { settleSkillRun, decideSkillTurn, skillApprovalReason, type SkillCandidate } from "../services/skill-runtime.service";

const T = "T", CONV = "c1", AGENT = "maya";
const exchange: SkillCandidate = {
  id: "sk_exchange", name: "Exchange a product", situation: null, whenToUse: null, examples: [], exclusions: [],
  steps: [
    { id: "e1", kind: "find", title: "Find the order", tools: ["shopify.order_lookup"] },
    { id: "e2", kind: "change", title: "Exchange the item", tools: ["shopify.exchange_order_item"], approvalOverAmount: 200 },
  ],
  rules: [], requiredInfo: [], version: 1, mode: "on", order: 0,
};
const surface = ["shopify.order_lookup", "shopify.exchange_order_item"];
// The run started 10 minutes ago; turns are stamped with the real clock, so
// an approval decided "later" is later than now.
const t0 = new Date(Date.now() - 10 * 60_000);
const later = (ms: number) => new Date(Date.now() + ms);
const settle = (turnCalls: any[] = []) => settleSkillRun({ tenantId: T, conversationId: CONV, aiAgentId: AGENT, runId: "run1", skill: exchange, surface, escalatedThisTurn: false, turnCalls });
const ctxWithOpen = () => ({
  candidates: [exchange], noSkillPolicy: "answer_from_knowledge",
  openRun: { id: "run1", skillId: "sk_exchange", skillVersion: 1, mode: "on" as const, currentStepId: DB.run.currentStepId, missedTurns: 0, startedAt: t0 },
});

beforeEach(() => {
  DB.run = { id: "run1", tenantId: T, startedAt: t0, trace: [], currentStepId: "e1", status: "active" };
  DB.requests = [];
  DB.audits = [];
});

describe("★ approval → resume at the same step", () => {
  it("over the step's amount the call needs a person (the orchestrator then proposes, not executes)", () => {
    expect(skillApprovalReason(exchange, "shopify.exchange_order_item", { amount: 250 })).toMatch(/asks a person over 200/);
  });

  it("asks, waits, is approved, and finishes at that step without redoing the first", async () => {
    // Turn 1: the order is found; the exchange goes to a person.
    DB.requests.push({ tenantId: T, conversationId: CONV, tool: "shopify.order_lookup", status: "completed", proposedAt: new Date(+t0 + 1000), completedAt: new Date(+t0 + 1500) });
    DB.requests.push({ tenantId: T, conversationId: CONV, tool: "shopify.exchange_order_item", status: "proposed", proposedAt: new Date(+t0 + 2000) });
    let r = await settle([
      { tool: "shopify.order_lookup", decision: "executed", ok: true },
      { tool: "shopify.exchange_order_item", decision: "awaiting_approval", ok: false },
    ]);
    expect(r).toEqual({ status: "active", currentStepId: "e2" });
    expect(DB.run.trace.map((x: any) => [x.step, x.outcome])).toEqual([["e1", "completed"], ["e2", "approval_requested"]]);

    // Turn 2: "any news?" - still pending. The run stays on e2; the next
    // turn keeps the SAME run (no restart, no new run).
    r = await settle([]);
    expect(r).toEqual({ status: "active", currentStepId: "e2" });
    expect(decideSkillTurn(ctxWithOpen() as any, "sk_exchange")).toMatchObject({ starts: false, close: null, active: { runId: "run1" } });

    // A person approves; the approved dispatch completes the request.
    Object.assign(DB.requests[1], { status: "completed", decidedAt: later(60_000), completedAt: later(61_000) });
    r = await settle([]);
    expect(r).toEqual({ status: "completed", currentStepId: null });
    expect(DB.run.status).toBe("completed");
    // Nothing before the approved step ran again.
    expect(DB.run.trace.filter((x: any) => x.step === "e1")).toHaveLength(1);
    expect(DB.audits).toEqual(expect.arrayContaining(["ai.skill_step", "ai.skill_completed"]));
  });

  it("a rejected approval leaves the run at that step, not done (the employee says so or hands over)", async () => {
    DB.requests.push({ tenantId: T, conversationId: CONV, tool: "shopify.order_lookup", status: "completed", proposedAt: new Date(+t0 + 1000) });
    DB.requests.push({ tenantId: T, conversationId: CONV, tool: "shopify.exchange_order_item", status: "proposed", proposedAt: new Date(+t0 + 2000) });
    await settle([{ tool: "shopify.exchange_order_item", decision: "awaiting_approval", ok: false }]);
    Object.assign(DB.requests[1], { status: "denied", decidedAt: later(60_000) });
    const r = await settle([]);
    expect(r).toEqual({ status: "active", currentStepId: "e2" });
    expect(DB.run.status).toBe("active");
  });

  it("an approval decided BEFORE the run started does not count for it", async () => {
    DB.requests.push({ tenantId: T, conversationId: CONV, tool: "shopify.exchange_order_item", status: "completed", proposedAt: new Date(+t0 - 5000) });
    const r = await settle([]);
    expect(r.currentStepId).toBe("e1");
  });
});
