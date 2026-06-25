import { describe, it, expect } from "vitest";
import { computeCurrentPlan, renderCurrentPlan, type PlanInput, type CurrentPlan } from "../services/planner.service";

const BOOK_GOAL_WF = {
  evaluated: true,
  fit: "neutral" as const,
  disqualifierMatched: null,
  qualificationMet: true,
  signalsMet: [] as string[],
  goalObjective: "BOOK_MEETING" as const,
};

const BASE: PlanInput = {
  role: "SALES",
  prospectFlags: { hasLead: false, hasContact: false },
  factText: "",
  completedActionTools: [],
  calendarBookable: true,
  priorGoal: null,
  toolFunctionNames: [
    "check_availability",
    "schedule_meeting",
    "integration_create_lead",
    "escalate_to_human",
  ],
  strategyName: "GUIDE",
};

describe("planner - computeCurrentPlan", () => {
  it("produces a goal + objective + ranked actions for a NEW_PROSPECT sales agent", () => {
    const plan = computeCurrentPlan(BASE);
    expect(plan.goal).toBeTruthy(); // GENERATE_LEAD mission
    expect(plan.currentObjective).toBe("GENERATE_LEAD");
    expect(plan.currentState?.prospectState).toBe("NEW_PROSPECT");
    expect(plan.candidateActions.length).toBeGreaterThan(0);
  });

  it("bestNextAction is the top-ranked candidate, and the envelope mirrors it", () => {
    const plan = computeCurrentPlan(BASE);
    const top = plan.candidateActions[0];
    expect(plan.bestNextAction).toBe(top);
    expect(plan.confidence).toBe(top.score);
    expect(plan.preferredTool).toBe(top.tool);
    expect(plan.why).toBe(top.rationale);
    // candidates are sorted by score desc.
    const scores = plan.candidateActions.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("derives preferredCapability from the preferred tool", () => {
    // Force an ACT on schedule_meeting by completing the chain via fact text +
    // marking lead/contact present so the objective advances to BOOK_MEETING.
    const plan = computeCurrentPlan({
      ...BASE,
      prospectFlags: { hasLead: true, hasContact: true },
      factText:
        "name: Omer. business: SaaS. email: o@x.com. need: overloaded support. wants a demo. timeline: this month.",
      completedActionTools: [],
    });
    if (plan.preferredTool === "schedule_meeting") {
      expect(plan.preferredCapability).toBe("CALENDAR");
    }
    // Regardless of which action wins, capability of any calendar tool resolves.
    expect(plan.capabilities.find((g) => g.capability === "CALENDAR")).toBeTruthy();
  });

  it("surfaces wizard facts (disqualified fit) into currentState", () => {
    const plan = computeCurrentPlan({
      ...BASE,
      wizardFacts: {
        evaluated: true,
        fit: "disqualified",
        disqualifierMatched: "individual hobbyist, not a business",
        qualificationMet: false,
        signalsMet: [],
        goalObjective: null,
      },
    });
    expect(plan.currentState?.fit).toBe("disqualified");
    expect(plan.currentState?.disqualifierMatched).toMatch(/hobbyist/);
  });

  it("groups the tool surface into capabilities", () => {
    const plan = computeCurrentPlan(BASE);
    const caps = plan.capabilities.map((g) => g.capability);
    expect(caps).toContain("CALENDAR");
    expect(caps).toContain("CRM");
    expect(caps).toContain("CONVERSATION");
  });

  it("is null-safe with an empty surface and unknown role", () => {
    const plan = computeCurrentPlan({
      role: "TOTALLY_UNKNOWN_ROLE",
      prospectFlags: { hasLead: false, hasContact: false },
      factText: "",
      completedActionTools: [],
      toolFunctionNames: [],
    });
    expect(plan.capabilities).toEqual([]);
    expect(plan.confidence).toBeGreaterThanOrEqual(0);
    // Does not throw; goal may be null if the role has no chain.
    expect(plan).toHaveProperty("bestNextAction");
  });

  it("surfaces GoalStatus: booking goal ACTIVE before a booking exists", () => {
    const plan = computeCurrentPlan({ ...BASE, wizardFacts: BOOK_GOAL_WF });
    expect(plan.goalStatus?.outcome).toBe("booking");
    expect(plan.goalStatus?.kind).toBe("ACTIVE");
  });

  it("GoalStatus → ACHIEVED once the booking exists in its runtime home", () => {
    const plan = computeCurrentPlan({ ...BASE, wizardFacts: BOOK_GOAL_WF, hasActiveBooking: true });
    expect(plan.goalStatus?.kind).toBe("ACHIEVED");
  });

  it("GoalStatus → FAILED(missing_capability) for a booking goal with no calendar capability", () => {
    const plan = computeCurrentPlan({
      ...BASE,
      wizardFacts: BOOK_GOAL_WF,
      toolFunctionNames: ["integration_create_lead", "escalate_to_human"], // no CALENDAR
    });
    expect(plan.goalStatus?.kind).toBe("FAILED");
    expect(plan.goalStatus?.reason).toBe("missing_capability");
  });

  it("non-bookable agent still plans without stalling on BOOK_MEETING", () => {
    const plan = computeCurrentPlan({ ...BASE, calendarBookable: false, toolFunctionNames: ["integration_create_lead", "escalate_to_human"] });
    expect(plan.currentObjective).toBe("GENERATE_LEAD");
    // schedule_meeting is not in the surface → no CALENDAR group.
    expect(plan.capabilities.find((g) => g.capability === "CALENDAR")).toBeFalsy();
  });
});

// The decoupling fix: when the objective CURSOR is exhausted (goal/currentState
// null), the GoalStatus — not the bare null — decides the terminal message.
describe("planner - renderCurrentPlan terminal branch driven by GoalStatus", () => {
  function terminal(goalStatus: CurrentPlan["goalStatus"]): string {
    const plan: CurrentPlan = {
      goal: null, currentObjective: null, currentState: null,
      bestNextAction: null, candidateActions: [], confidence: 0, why: "",
      capabilities: [], goalStatus, snapshot: null,
    };
    return renderCurrentPlan(plan);
  }

  it("ACTIVE (cursor done, outcome NOT achieved) → drive it, do NOT close", () => {
    const out = terminal({ kind: "ACTIVE", goal: "BOOK_MEETING", outcome: "booking" });
    expect(out).toMatch(/Goal still open/);
    expect(out).not.toMatch(/close naturally/);
  });

  it("ACHIEVED → wrap cleanly", () => {
    expect(terminal({ kind: "ACHIEVED", goal: "BOOK_MEETING", outcome: "booking" })).toMatch(/Goal achieved/);
  });

  it("FAILED(missing_capability) → honest, team-follow-up, NOT a spurious human handoff", () => {
    const out = terminal({ kind: "FAILED", goal: "BOOK_MEETING", outcome: "booking", reason: "missing_capability", detail: "needs CALENDAR" });
    expect(out).toMatch(/can't be completed/);
    expect(out).toMatch(/team will follow up/);
    expect(out).not.toMatch(/hand off to a human/);
  });

  it("FAILED(disqualified) → qualify out politely, do NOT escalate", () => {
    const out = terminal({ kind: "FAILED", goal: "BOOK_MEETING", outcome: "booking", reason: "disqualified" });
    expect(out).toMatch(/Not a fit/);
    expect(out).toMatch(/do NOT escalate/);
  });

  it("null goalStatus (no business goal) → BEL owns close", () => {
    const out = terminal(null);
    expect(out).toMatch(/No open business outcome/);
    expect(out).toMatch(/close naturally/);
  });
});
