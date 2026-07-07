/**
 * Cognition — the Reasoner & Writer contracts (the Agent's mind & voice).
 *
 * Reasoning is ONE capability of the Agent. The Reasoner owns judgment and emits
 * STRUCTURED INTENT — never probabilities, never a ranked score list. Uncertainty
 * is expressed as a MOVE (REQUEST_INPUT / CONVERSE), not a confidence number.
 * The Writer owns expression only and has no tools — it cannot take an unsafe
 * action by construction.
 *
 * Phase 1 freezes these I/O types (the contract). Phase 3 implements a Reasoner
 * that satisfies `Cognition` and runs in shadow against the Planner first.
 */

import type { Facts } from "./facts";
import type { AgentMemory, BusinessOutcome } from "./memory";
import type { AgentPersona } from "./identity";
import type { WorkingMemory } from "./working-memory";

/** Deterministic, non-authoritative reference material the Reasoner interprets. */
export interface Context {
  transcript: { role: "customer" | "agent" | "system"; text: string; ts?: string }[];
  mission: {
    goalOutcome?: BusinessOutcome;
    businessDescription?: string;
    disqualifiers?: string[];
  };
  /** Tenant playbook TEXT — advice the Reasoner MAY override, never a hard rule. */
  guidance?: string;
  /** Semantic descriptions of the operation vocabulary (no tool names). */
  operationCatalog: { name: string; meaning: string; whenItApplies?: string }[];
  brandVoice?: AgentPersona;

  // ── Agent Loop context (optional; absent in single-shot Planner use) ──────
  /** Evolving intra-loop scratchpad — established facts, ruled-out ops, questions. */
  workingMemory?: WorkingMemory;
  /** 1-based iteration counter, so the Reasoner knows how deep the loop is. */
  iteration?: number;
  /** Loop budget headroom (AI units) remaining — pressure to converge. */
  budgetRemaining?: number;
}

export interface ReasonerInput {
  facts: Facts; // authoritative
  context: Context; // interpretive material
  memory: AgentMemory; // advisory continuity
}

/**
 * The committed next move — a discriminated union, no scores.
 *
 * Loop semantics (single-shot Planner ignores these and treats EXECUTE as "act"):
 *   EXECUTE       → PROPOSE an operation to the Runtime; its observation re-enters
 *                   the loop (the ONE continuing move — everything else terminates).
 *   REQUEST_INPUT → NEED_INPUT: stop, ask the customer the one blocking thing.
 *   FINISH        → the goal is reached / nothing left to do: stop, hand to Writer.
 *   ESCALATE      → the Reasoner JUDGES it is stuck (missing capability, contradiction,
 *                   unrecoverable failure): stop, hand to a human. Reason-driven,
 *                   independent of runtime guards.
 *   CONVERSE/WAIT → non-executing turns; the loop treats them as FINISH.
 */
export type ReasonerDecision =
  | { type: "EXECUTE"; operation: string; params: Record<string, unknown> }
  | { type: "REQUEST_INPUT"; needed: string }
  | { type: "FINISH"; reason: string }
  | { type: "CONVERSE" }
  | { type: "ESCALATE"; reason: string }
  | { type: "WAIT" };

/** Free-form JUDGMENT — for audit/analytics. It must NEVER gate control flow. */
export interface ReasonerRead {
  situation: string;
  /** Natural language ("hesitant"/"ready") — deliberately not an enum. */
  customerState: string;
  goal: BusinessOutcome | null;
  missingInformation: { what: string; why: string; source: "customer" | "system" }[];
  /** Why this decision — UNTRUSTED; audit/eval only, never executed. */
  rationale: string;
}

/** WHAT to communicate; the Writer decides HOW. */
export interface ReplyIntent {
  purpose: string;
  keyPoints: string[];
}

export interface ReasonerOutput {
  read: ReasonerRead;
  decision: ReasonerDecision;
  replyIntent: ReplyIntent;
  /** Becomes next turn's `memory` input (advisory continuity). */
  memoryUpdate: AgentMemory;
}

/** The Agent's reasoning capability. */
export interface Cognition {
  reason(input: ReasonerInput): Promise<ReasonerOutput>;
}

/** The Agent's expression capability — language only, no tools, no decisions. */
export interface Writer {
  write(
    replyIntent: ReplyIntent,
    opts: { persona?: AgentPersona; language?: string },
  ): Promise<string>;
}
