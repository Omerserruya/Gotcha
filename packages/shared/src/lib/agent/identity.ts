/**
 * Agent - identity & persona.
 *
 * Part of the FROZEN Agent Contract (see docs/architecture/agent-contract.md and
 * reasoner-architecture.md). Phase 1: the envelope only - pure types, zero
 * behaviour, not wired into the live path. The deterministic Planner keeps
 * driving the system; the Agent merely *exists* as the new abstraction.
 *
 * Principle: GOTCHA is a kernel (Capability Runtime) running employee PROCESSES
 * (Agents). An Agent reasons toward a goal on behalf of a principal. A capability
 * domain (Calendar/CRM/Billing) is NOT an agent - it's a syscall family in the
 * Runtime.
 */

/** Who the agent is and whom it acts for. */
export interface AgentIdentity {
  /** Stable id for this agent instance (the AI Employee). */
  agentId: string;
  /** Coarse role, e.g. "sales" | "support" | "research". Vocabulary, not an FSM. */
  role: string;
  /**
   * The principal this agent acts for - the billable/ownership entity. Kept
   * abstract on purpose (never hardcode Tenant == payer); see the billing model.
   */
  principal: {
    tenantId: string;
    /** Optional billable-entity id when it differs from the tenant. */
    billableEntityId?: string;
  };
}

/** How the agent presents - informs the Writer, never the decision. */
export interface AgentPersona {
  displayName?: string;
  /** Free-form voice description (e.g. "warm, concise, never pushy"). */
  voice?: string;
  /** Default language tag (e.g. "he", "en"); the Writer may still match the customer. */
  language?: string;
  /** Hard "never say/do" list surfaced to the Writer. */
  doNots?: string[];
}
