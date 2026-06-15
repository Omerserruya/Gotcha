import { GOAL_ORDER, type Goal, type LeadStateView, missingForGoal } from "./goal-schemas";

/**
 * Deterministic goal state machine, one logical instance per conversation.
 *
 * The LLM's frame.stage answers "what playbook stage are we on" (UX) - this
 * machine answers "what data does the deal need next" (business gate).
 * Advances only when every required field for the current goal is present
 * in the lead view. Never regresses; a partial backslide in CRM state does
 * NOT drop the deal back a stage (avoids cue-flapping).
 *
 * State is held in-process. The supervisor is single-instance per call so
 * this is safe; if multi-instance routing is added later, persist via
 * CallAnalysisStore meta (one row already exists per call).
 */
export class GoalStateMachine {
  private readonly state = new Map<string, Goal>();

  current(conversationId: string): Goal {
    return this.state.get(conversationId) ?? "lookup_lead";
  }

  /**
   * Advance as many stages as the lead now satisfies. Idempotent - calling
   * twice with the same lead is a no-op. Returns the goal after advance.
   */
  advance(conversationId: string, lead: LeadStateView): Goal {
    let goal = this.current(conversationId);
    while (true) {
      const idx = GOAL_ORDER.indexOf(goal);
      if (idx === GOAL_ORDER.length - 1) break;
      if (missingForGoal(goal, lead).length > 0) break;
      goal = GOAL_ORDER[idx + 1];
    }
    this.state.set(conversationId, goal);
    return goal;
  }

  reset(conversationId: string): void {
    this.state.delete(conversationId);
  }
}

export const goalStateMachine = new GoalStateMachine();
