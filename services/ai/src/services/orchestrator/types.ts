/**
 * Action Orchestrator types.
 *
 * The orchestrator is the single tool-execution boundary for Chat, Live,
 * and Post-Call. Every system funnels through `submit()`. Direct calls
 * to the underlying tool registry from outside this package are forbidden
 * (anti-duplication rule #3).
 */

export type RuntimeMode = "chat" | "live" | "post-call";

export interface ProposedAction {
  /** ULID-shaped executionId. Stable across propose/approve/run. */
  id: string;
  conversationId: string;
  tenantId: string;
  proposedBy: { mode: RuntimeMode; system: string };
  actor: { agentId: string };
  tool: string;
  args: Record<string, unknown>;
  rationale: string;
  urgency: "low" | "medium" | "high";
}

export interface ToolDescriptor {
  name: string;
  /** Does the tool mutate external state? */
  mutating: boolean;
  /** Whether the chat-mode flow requires explicit human approval. */
  requiresApproval: boolean;
  /** Per-mode allowlist for auto-execute. Live is never on the list for mutating tools. */
  autoExecuteAllowlist: RuntimeMode[];
}

export type PolicyOutcome =
  | "auto-execute"
  | "propose-and-await-approval"
  | "deny";

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
}

export type ExecutionStatus =
  | "proposed"
  | "approved"
  | "running"
  | "completed"
  | "denied"
  | "failed";

export interface ExecutionResult {
  status: ExecutionStatus;
  result?: unknown;
  error?: string;
  attempts: number;
  durationMs?: number;
}
