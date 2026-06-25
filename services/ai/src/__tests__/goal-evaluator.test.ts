import { describe, it, expect } from "vitest";
import {
  evaluateGoalStatus,
  presentBusinessOutcomes,
  businessOutcomesFromLedger,
  type GoalEvalInput,
} from "../services/goal-evaluator";
import type { BusinessOutcome } from "../services/objectives";

function input(over: Partial<GoalEvalInput> = {}): GoalEvalInput {
  return {
    goalObjective: "BOOK_MEETING",
    presentOutcomes: new Set<BusinessOutcome>(),
    capabilities: ["CALENDAR", "CRM", "CONVERSATION"],
    ...over,
  };
}

describe("goal-evaluator - scope (only real business outcomes)", () => {
  it("returns null when there is no goal objective", () => {
    expect(evaluateGoalStatus(input({ goalObjective: null }))).toBeNull();
  });

  it("returns null for a navigation objective with no outcome signature (QUALIFY_LEAD)", () => {
    // QUALIFY_LEAD is a step, not an outcome → GoalStatus N/A, BEL owns 'done'.
    expect(evaluateGoalStatus(input({ goalObjective: "QUALIFY_LEAD" }))).toBeNull();
    expect(evaluateGoalStatus(input({ goalObjective: "RESOLVE_ISSUE" }))).toBeNull();
  });
});

describe("goal-evaluator - the four states", () => {
  it("ACHIEVED when the business outcome exists in a runtime home", () => {
    const r = evaluateGoalStatus(input({ presentOutcomes: new Set<BusinessOutcome>(["booking"]) }))!;
    expect(r.kind).toBe("ACHIEVED");
    expect(r.goal).toBe("BOOK_MEETING");
    expect(r.outcome).toBe("booking");
  });

  it("FAILED(missing_capability) when the goal needs a capability the agent lacks", () => {
    const r = evaluateGoalStatus(input({ capabilities: ["CRM", "CONVERSATION"] }))!; // no CALENDAR
    expect(r.kind).toBe("FAILED");
    expect(r.reason).toBe("missing_capability");
    expect(r.detail).toMatch(/CALENDAR/);
  });

  it("FAILED(disqualified) when wizard fit is disqualified", () => {
    const r = evaluateGoalStatus(input({ fit: "disqualified" }))!;
    expect(r.kind).toBe("FAILED");
    expect(r.reason).toBe("disqualified");
  });

  it("FAILED(recovery_exhausted) when recovery gave up", () => {
    const r = evaluateGoalStatus(input({ recovery: { exhausted: true } }))!;
    expect(r.kind).toBe("FAILED");
    expect(r.reason).toBe("recovery_exhausted");
  });

  it("BLOCKED(awaiting_approval) when an approval is pending on the goal action", () => {
    const r = evaluateGoalStatus(input({ approvalPending: true }))!;
    expect(r.kind).toBe("BLOCKED");
    expect(r.reason).toBe("awaiting_approval");
  });

  it("BLOCKED(external_failure) when recovery is mid-retry", () => {
    const r = evaluateGoalStatus(input({ recovery: { active: true } }))!;
    expect(r.kind).toBe("BLOCKED");
    expect(r.reason).toBe("external_failure");
  });

  it("ACTIVE by default — outcome not yet present, capability there, nothing blocking", () => {
    const r = evaluateGoalStatus(input())!;
    expect(r.kind).toBe("ACTIVE");
    expect(r.reason).toBeUndefined();
  });
});

describe("goal-evaluator - precedence", () => {
  it("ACHIEVED wins even if a block/fail condition is also present", () => {
    const r = evaluateGoalStatus(
      input({ presentOutcomes: new Set<BusinessOutcome>(["booking"]), approvalPending: true, fit: "disqualified" }),
    )!;
    expect(r.kind).toBe("ACHIEVED");
  });

  it("FAILED outranks BLOCKED", () => {
    const r = evaluateGoalStatus(input({ fit: "disqualified", approvalPending: true }))!;
    expect(r.kind).toBe("FAILED");
  });
});

describe("goal-evaluator - presentBusinessOutcomes (runtime homes, no audit)", () => {
  it("derives from CRM flags + active-booking flag", () => {
    const s = presentBusinessOutcomes({
      crmFlags: { hasLead: true, hasContact: true, hasOpportunity: true },
      hasActiveBooking: true,
    });
    expect(s).toEqual(new Set(["crm_lead", "crm_contact", "crm_deal", "booking"]));
  });

  it("folds in this-turn live outcomes", () => {
    const s = presentBusinessOutcomes({ crmFlags: { hasLead: false, hasContact: false }, liveOutcomes: ["booking"] });
    expect(s.has("booking")).toBe(true);
  });

  it("empty when nothing exists", () => {
    expect(presentBusinessOutcomes({}).size).toBe(0);
  });
});

describe("goal-evaluator - businessOutcomesFromLedger (live this-turn projection)", () => {
  it("maps committed booking + crm_lead ledger entries, ignores failed/pending", () => {
    const entries: any[] = [
      { status: "committed", kind: "booking", externalRef: { type: "gcal_event", id: "e1" } },
      { status: "succeeded_unverified", kind: "create", externalRef: { type: "crm_lead", id: "l1" } },
      { status: "failed", kind: "create", externalRef: { type: "crm_contact", id: "c1" } },
      { status: "pending_approval", kind: "create", externalRef: { type: "crm_deal", id: "d1" } },
    ];
    expect(businessOutcomesFromLedger(entries)).toEqual(["booking", "crm_lead"]);
  });
});
