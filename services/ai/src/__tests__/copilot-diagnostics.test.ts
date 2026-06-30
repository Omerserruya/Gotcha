/**
 * Copilot diagnostics — deterministic formatting + decision derivation.
 * Proves the [copilot][plan] / [copilot][tool] logs accurately reflect the plan.
 */
import { describe, it, expect } from "vitest";
import {
  formatCopilotPlan,
  formatCopilotTool,
  plannerReasonForTool,
  noToolDecision,
  summarizeToolResult,
  type CopilotDiagContext,
} from "../services/copilot-diagnostics.service";
import { computeCurrentPlan, type CurrentPlan } from "../services/planner.service";
import { EMPTY_WIZARD_FACTS } from "../services/objectives";

const CTX: CopilotDiagContext = { tenantId: "t1", conversationId: "c1", entry: "suggest" };

// A ready-to-book qualified lead → planner's best action is an ACT (schedule_meeting).
function bookingPlan(): CurrentPlan {
  return computeCurrentPlan({
    role: "sales",
    prospectFlags: { hasLead: true, hasContact: true },
    factText: "Customer: yes book me tuesday. Email a@b.com. Budget confirmed.",
    completedActionTools: [],
    toolFunctionNames: ["check_availability", "schedule_meeting", "submit_suggestions"],
    wizardFacts: { ...EMPTY_WIZARD_FACTS, qualificationMet: true, goalObjective: "BOOK_MEETING" as any },
    calendarBookable: true,
    hasActiveBooking: false,
    strategyName: "CONVERT",
  });
}

// A new prospect missing required info → planner's best action is an ASK.
function askPlan(): CurrentPlan {
  return computeCurrentPlan({
    role: "sales",
    prospectFlags: { hasLead: false, hasContact: false },
    factText: "Customer: hi I might be interested",
    completedActionTools: [],
    toolFunctionNames: ["integration_create_lead", "submit_suggestions"],
    wizardFacts: EMPTY_WIZARD_FACTS,
    strategyName: "QUALIFY",
  });
}

describe("copilot-diagnostics - formatCopilotPlan", () => {
  it("renders the five plan fields from the real plan", () => {
    const out = formatCopilotPlan(bookingPlan(), CTX);
    expect(out).toContain("[copilot][plan]");
    expect(out).toContain("entry=suggest");
    expect(out).toMatch(/Goal:/);
    expect(out).toMatch(/Objective:/);
    expect(out).toMatch(/BestAction:/);
    expect(out).toMatch(/Confidence: \d\.\d\d/);
    expect(out).toMatch(/GoalStatus:/);
  });

  it("degrades to placeholders for a null plan", () => {
    const out = formatCopilotPlan(null, CTX);
    expect(out).toContain("Goal: —");
    expect(out).toContain("BestAction: —");
  });
});

describe("copilot-diagnostics - formatCopilotTool", () => {
  it("renders every required tool-decision line", () => {
    const out = formatCopilotTool(
      { decision: "READ", plannerReason: "why", tool: "check_availability", executed: true, executionMode: "background", result: "3 slots" },
      CTX,
    );
    expect(out).toContain("Decision: READ");
    expect(out).toContain("PlannerReason: why");
    expect(out).toContain("Tool: check_availability");
    expect(out).toContain("Executed: true");
    expect(out).toContain("ExecutionMode: background");
    expect(out).toContain("Result: 3 slots");
  });
});

describe("copilot-diagnostics - noToolDecision", () => {
  it("MISSING_INFORMATION names the blocking requirement when best move is ASK", () => {
    const plan = askPlan();
    // sanity: the planner really wants to ask here
    expect(plan.bestNextAction?.kind).toBe("ask");
    const d = noToolDecision(plan);
    expect(d.decision).toBe("MISSING_INFORMATION");
    expect(d.plannerReason.length).toBeGreaterThan(0);
    expect(d.executed).toBe(false);
    expect(d.executionMode).toBe("none");
  });

  it("NO_TOOL when there is no missing-info block", () => {
    const plan: CurrentPlan = {
      ...bookingPlan(),
      bestNextAction: { kind: "act", tool: "schedule_meeting", label: "book it", score: 0.9, rationale: "ready" },
      currentState: { ...(bookingPlan().currentState as any), missingRequired: [] },
    };
    const d = noToolDecision(plan);
    expect(d.decision).toBe("NO_TOOL");
  });

  it("NO_TOOL for a null plan", () => {
    expect(noToolDecision(null).decision).toBe("NO_TOOL");
  });
});

describe("copilot-diagnostics - plannerReasonForTool", () => {
  it("returns the planner's own rationale for its best tool", () => {
    const plan = bookingPlan();
    const tool = plan.preferredTool!;
    const reason = plannerReasonForTool(plan, tool);
    expect(reason).toMatch(/planner's best action|planner candidate/);
  });

  it("flags a non-ranked tool as model-selected (e.g. an enrichment read)", () => {
    const plan = bookingPlan();
    const reason = plannerReasonForTool(plan, "hubspot.search_contacts");
    expect(reason).toMatch(/model-selected|not the planner/i);
  });

  it("handles a null plan without throwing", () => {
    expect(plannerReasonForTool(null, "anything")).toMatch(/no plan/i);
  });
});

describe("copilot-diagnostics - summarizeToolResult", () => {
  it("summarizes a READ envelope into facts (counts, ok)", () => {
    const raw = JSON.stringify({ ok: true, slots: [1, 2, 3], workingHours: { mon: "9-5" } });
    const s = summarizeToolResult(raw);
    expect(s).toContain("ok=true");
    expect(s).toContain("3 slots");
    expect(s).toContain("workingHours");
  });

  it("surfaces the recommend/executed flags of an ACTION envelope", () => {
    const raw = JSON.stringify({ ok: true, recommended: true, executed: false });
    const s = summarizeToolResult(raw);
    expect(s).toContain("recommended");
    expect(s).toContain("executed=false");
  });

  it("truncates long non-JSON results and never throws", () => {
    expect(summarizeToolResult(undefined)).toBe("—");
    const long = "x".repeat(500);
    expect(summarizeToolResult(long).length).toBeLessThanOrEqual(240);
  });
});
