/**
 * Agent — memory (the Reasoner's notes to its future self).
 *
 * Trust hierarchy: FACTS (authoritative, Oracle) > fresh JUDGMENT (this turn) >
 * MEMORY (advisory, prior judgments). Memory is literally last turn's Reasoner
 * output fed back in. It provides cross-turn continuity WITHOUT a state machine
 * — it is never authoritative and Facts always override it. Bounded on purpose
 * so it can't grow unbounded or poison context.
 */

export type BusinessOutcome =
  | "booking"
  | "crm_lead"
  | "crm_contact"
  | "crm_deal"
  // open for extension without losing autocomplete on the known set.
  | (string & {});

/** The agent's carried-forward conclusions. Advisory, revisable every turn. */
export interface AgentMemory {
  /** The outcome we've been driving — prevents goal thrash. */
  committedGoal?: BusinessOutcome;
  /** Working beliefs that are NOT Facts, e.g. "seems price-sensitive". */
  workingHypotheses: string[];
  /** Things we've already asked the customer — so we don't re-ask. */
  alreadyAsked: string[];
  /** Brief, bounded prior situation reads (rolling window). */
  priorReads: { turn: number; situation: string }[];
  /** Promises we made, e.g. "said we'd follow up Tuesday". */
  openCommitments: string[];
}

/** Empty starting memory for a fresh agent×customer binding. */
export const EMPTY_AGENT_MEMORY: AgentMemory = {
  workingHypotheses: [],
  alreadyAsked: [],
  priorReads: [],
  openCommitments: [],
};

/**
 * Persistence boundary for agent memory, scoped per agent × customer. Phase 1
 * defines the interface only; an implementation (DB-backed) arrives with the
 * Reasoner phases. Kept narrow so the store can live anywhere.
 */
export interface MemoryStore {
  load(key: MemoryKey): Promise<AgentMemory>;
  save(key: MemoryKey, memory: AgentMemory): Promise<void>;
}

export interface MemoryKey {
  agentId: string;
  tenantId: string;
  /** Customer continuity key (memory follows the customer across conversations). */
  customerExternalId: string;
}
