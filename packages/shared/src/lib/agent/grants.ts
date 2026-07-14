/**
 * Agent - grants (permissions to PROPOSE, never to execute).
 *
 * "Many minds, one hand." The Runtime is the single execution authority. An
 * Agent never executes; it proposes Execution Intents, and the Runtime enforces
 * these grants regardless of what the Agent emits. `grants` is therefore a
 * permission Fact about the agent, not a power it holds.
 */

import type { ExecutionMode } from "../capability-runtime";

/** A spend ceiling the Runtime enforces on money-moving operations. */
export interface SpendLimits {
  /** Per-period currency ceiling (minor units or whole - runtime decides). */
  maxAmount?: number;
  currency?: string;
  /** Operations above this require approval regardless of mode. */
  approvalThreshold?: number;
}

export interface AgentGrants {
  /**
   * Operation names this agent MAY propose. `"*"` = all registered operations.
   * The Runtime intersects this with RBAC + capability availability; the grant
   * is a ceiling, never an override.
   */
  operations: string[];
  /** Default execution posture for this agent's operations. */
  mode: ExecutionMode;
  /** Optional money guardrails (the Runtime is the enforcer). */
  spendLimits?: SpendLimits;
  /** Optional data-scope tags (e.g. which CRM pipelines) the Runtime honours. */
  dataScopes?: string[];
}

/**
 * Pure check: is `operation` within this agent's grant ceiling? This is an
 * advisory pre-filter only - the Runtime re-checks grants + RBAC at execution.
 * Never throws.
 */
export function agentMayPropose(grants: AgentGrants | undefined, operation: string): boolean {
  if (!grants || !operation) return false;
  return grants.operations.includes("*") || grants.operations.includes(operation);
}
