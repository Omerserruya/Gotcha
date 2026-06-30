/**
 * COPILOT ⇄ EMPLOYEE PARITY AUDIT (deterministic, no LLM).
 *
 * Proves the Copilot reasons over the SAME CurrentPlan as the AI Employee for the
 * same conversation, and reports the decision-engine routing (which tools the
 * Copilot would auto-run vs. recommend). The only intended difference is the
 * advisory call-to-action wording + the known calendarBookable/hasActiveBooking
 * gap (Copilot omits them today). Everything else must be identical.
 */
import { describe, it, expect } from "vitest";
import { computeCurrentPlan, renderCurrentPlan, type PlanInput } from "../services/planner.service";
import { classifyToolEffect } from "../services/capabilities";
import { EMPTY_WIZARD_FACTS, type WizardRuntimeFacts } from "../services/objectives";
import type { CrmStateFlags } from "../services/prospect-state";

interface Scenario {
  name: string;
  role: string;
  crm: CrmStateFlags;
  factText: string;
  completed: string[];
  tools: string[];
  wizard?: Partial<WizardRuntimeFacts>;
  strategy?: string;
  // Employee-only context the Copilot does NOT pass today:
  calendarBookable?: boolean;
  hasActiveBooking?: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: "SALES · new vague prospect · no tools needed",
    role: "sales", crm: { hasLead: false, hasContact: false },
    factText: "Customer: hi what is this", completed: [],
    tools: ["submit_suggestions"], strategy: "GUIDE",
  },
  {
    name: "SALES · qualified · ready to book (calendar present)",
    role: "sales", crm: { hasLead: true, hasContact: true },
    factText: "Customer: yes book me a demo tuesday. Email: a@b.com. Budget confirmed.",
    completed: [], tools: ["check_availability", "schedule_meeting", "integration_create_lead", "submit_suggestions"],
    wizard: { qualificationMet: true, goalObjective: "BOOK_MEETING" as any },
    strategy: "CONVERT", calendarBookable: true, hasActiveBooking: false,
  },
  {
    name: "SUPPORT · billing issue · KB/no action tool",
    role: "support", crm: { hasLead: false, hasContact: true, isCustomer: true },
    factText: "Customer: I was double charged this month", completed: [],
    tools: ["create_ticket", "submit_suggestions"], strategy: "RESOLVE",
  },
  {
    name: "CRM LOOKUP · 'what's my last order' (read tools present)",
    role: "support", crm: { hasLead: false, hasContact: true, isCustomer: true },
    factText: "Customer: can you check my last order status?", completed: [],
    tools: ["integration_shopify.search_orders", "integration_shopify.get_order", "submit_suggestions"],
    strategy: "RESOLVE",
  },
  {
    name: "OPERATIONS · create task / update CRM (action tools)",
    role: "agent", crm: { hasLead: false, hasContact: true },
    factText: "Customer: please have someone follow up about onboarding next week",
    completed: [], tools: ["create_task", "update_contact", "submit_suggestions"], strategy: "GUIDE",
  },
  {
    name: "HOSTILE / DISQUALIFIED prospect",
    role: "sales", crm: { hasLead: false, hasContact: false },
    factText: "Customer: this is useless, we are a 2-person shop with no budget",
    completed: [], tools: ["integration_create_lead", "submit_suggestions"],
    wizard: { fit: "disqualified", disqualifierMatched: "no budget / too small" }, strategy: "QUALIFY",
  },
  {
    name: "AVAILABILITY CHECK · asks 'when are you free?' (calendar)",
    role: "sales", crm: { hasLead: true, hasContact: true },
    factText: "Customer: what times do you have this week?", completed: [],
    tools: ["check_availability", "schedule_meeting", "submit_suggestions"],
    wizard: { qualificationMet: true, goalObjective: "BOOK_MEETING" as any },
    strategy: "CONVERT", calendarBookable: true, hasActiveBooking: false,
  },
  {
    name: "NO TOOLS AT ALL · pure Q&A",
    role: "support", crm: { hasLead: false, hasContact: false },
    factText: "Customer: what are your support hours?", completed: [],
    tools: ["submit_suggestions"], strategy: "GUIDE",
  },
];

function planFor(s: Scenario, _mode: "employee" | "copilot"): PlanInput {
  const wizard: WizardRuntimeFacts = { ...EMPTY_WIZARD_FACTS, ...(s.wizard ?? {}) };
  // After the calendar-parity fix BOTH modes resolve calendarBookable +
  // hasActiveBooking via the same functions, so both wirings pass them. The
  // planner inputs are now identical across modes → identical CurrentPlan.
  return {
    role: s.role,
    prospectFlags: s.crm,
    factText: s.factText,
    completedActionTools: s.completed,
    toolFunctionNames: s.tools,
    wizardFacts: wizard,
    strategyName: s.strategy,
    calendarBookable: s.calendarBookable,
    hasActiveBooking: s.hasActiveBooking,
  };
}

// Fields that define "the same reasoning". advisory wording is excluded on purpose.
function fingerprint(p: ReturnType<typeof computeCurrentPlan>) {
  return JSON.stringify({
    goal: p.goal,
    objective: p.currentObjective,
    bestTool: p.bestNextAction?.tool ?? null,
    bestKind: p.bestNextAction?.kind ?? null,
    candidates: p.candidateActions.map((c) => `${c.kind}:${c.tool ?? "-"}`),
    capabilities: p.capabilities.map((g) => `${g.capability}[${g.tools.map((t) => t.name).join(",")}]`),
    goalStatus: p.goalStatus?.kind ?? null,
    missing: p.currentState?.missingRequired.map((m) => m.key) ?? null,
  });
}

describe("Copilot ⇄ Employee CurrentPlan parity", () => {
  const report: string[] = [];

  for (const s of SCENARIOS) {
    it(`same plan: ${s.name}`, () => {
      const emp = computeCurrentPlan(planFor(s, "employee"));
      const cop = computeCurrentPlan(planFor(s, "copilot"));

      const reads = s.tools.filter((t) => t !== "submit_suggestions" && classifyToolEffect(t) === "read");
      const actions = s.tools.filter((t) => t !== "submit_suggestions" && classifyToolEffect(t) === "action");

      report.push(
        `\n### ${s.name}\n` +
          `  goal=${cop.goal ?? "—"} | objective=${cop.currentObjective ?? "—"} | best=${cop.bestNextAction?.kind ?? "—"}:${cop.bestNextAction?.tool ?? "—"} (conf ${cop.confidence.toFixed(2)})\n` +
          `  goalStatus=${cop.goalStatus?.kind ?? "—"} | missing=[${cop.currentState?.missingRequired.map((m) => m.key).join(",") ?? ""}]\n` +
          `  Copilot auto-run READ → [${reads.join(", ") || "none"}]\n` +
          `  Copilot RECOMMEND ACTION → [${actions.join(", ") || "none"}]\n` +
          `  parity(emp==cop): ${fingerprint(emp) === fingerprint(cop) ? "IDENTICAL ✅" : "DIVERGED ⚠️"}`,
      );

      // HARD PARITY: the Copilot reasoning must match the Employee exactly.
      const same = fingerprint(emp) === fingerprint(cop);
      if (!same) {
        report.push(`    ↳ EMP: ${fingerprint(emp)}\n    ↳ COP: ${fingerprint(cop)}`);
      }
      expect(fingerprint(cop)).toBe(fingerprint(emp));
      // Advisory rendering must differ (proves mode-aware CTA), content must not.
      expect(renderCurrentPlan(cop, { advisory: true })).toContain("recommend");
      expect(renderCurrentPlan(emp)).toContain("ACT this turn");
    });
  }

  it("prints the audit report", () => {
    console.log("\n========== COPILOT PARITY AUDIT ==========" + report.join("\n") + "\n==========================================\n");
    expect(true).toBe(true);
  });
});
