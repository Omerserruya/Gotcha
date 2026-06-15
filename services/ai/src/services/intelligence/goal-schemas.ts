/**
 * Goal-driven required-field schemas for the live call copilot.
 *
 * The CRM playbook stage tells us "what step in the sales script are we on";
 * a Goal tells us "what data does the SYSTEM need to progress this lead".
 * Goals are deterministic and owned here - the LLM's frame.stage is a hint,
 * not the authority. See GoalStateMachine for the transition rules.
 */

export type Goal = "lookup_lead" | "qualify" | "propose" | "close";

export const GOAL_ORDER: readonly Goal[] = [
  "lookup_lead",
  "qualify",
  "propose",
  "close",
] as const;

/**
 * Subset of lead/contact fields the copilot tracks for goal progression.
 * Keep keys aligned with the CRM canonical names so a future LeadStateProvider
 * pulling from prefetchCrmContext can map 1:1 without a translation layer.
 */
export interface LeadStateView {
  fullName?: string;
  email?: string;
  phone?: string;
  company?: string;
  companySize?: string;
  budget?: string;
  timeline?: string;
  decisionMaker?: string;
  decisionProcess?: string;
  painPoint?: string;
}

export type LeadField = keyof LeadStateView;

/**
 * Required fields per goal. A goal cannot advance until ALL of its required
 * fields are present in the LeadStateView. Empty list = terminal stage.
 */
export const goalSchemas: Record<Goal, readonly LeadField[]> = {
  lookup_lead: ["fullName", "email"],
  qualify: ["company", "companySize", "painPoint", "budget"],
  propose: ["decisionMaker", "decisionProcess", "timeline"],
  close: [],
};

/**
 * Cue text + rationale per field. Kept here (not inside the projector) so
 * adding a new field is one place to edit. Text is the 3-7 word micro-cue;
 * rationale is the ≤10 word hover/why.
 */
export const FIELD_PROMPTS: Record<LeadField, { text: string; rationale: string }> = {
  fullName:        { text: "ask their name",        rationale: "needed to lookup lead" },
  email:           { text: "get email",             rationale: "needed to lookup/create lead" },
  phone:           { text: "confirm phone",         rationale: "no number on file" },
  company:         { text: "ask company",           rationale: "qualification" },
  companySize:     { text: "ask team size",         rationale: "qualification" },
  budget:          { text: "explore budget range",  rationale: "qualification gate" },
  timeline:        { text: "ask timeline",          rationale: "deal sizing" },
  decisionMaker:   { text: "who else decides?",     rationale: "unblock close" },
  decisionProcess: { text: "clarify approval flow", rationale: "unblock close" },
  painPoint:       { text: "dig into pain",         rationale: "qualification" },
};

/** Fields the schema for `goal` says are required but `lead` does not have. */
export function missingForGoal(goal: Goal, lead: LeadStateView): LeadField[] {
  return goalSchemas[goal].filter((f) => !lead[f]);
}
