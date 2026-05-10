/**
 * Action Orchestrator — Layer 3.
 *
 * Single tool-execution boundary. Every system (Chat, Live, Post-Call)
 * funnels actions through `submit()`. Direct imports of the tool registry
 * or `dispatchToolCall` from outside this package are rejected at code
 * review (anti-duplication rule #3).
 */

export {
  ActionOrchestrator,
  getActionOrchestrator,
  assertRuntimeMode,
} from "./action-orchestrator";
export { LiveCallToolPolicy } from "./policy";
export { getToolDescriptor } from "./tool-registry";
export {
  withRetry,
  CircuitBreakers,
  pushToDlq,
  DEFAULT_BACKOFF_SCHEDULE_MS,
  type RetryOptions,
  type RetryOutcome,
  type RetryFailure,
  type CircuitBreakerOptions,
  type DlqEntry,
} from "./runner";
export type {
  ProposedAction,
  ToolDescriptor,
  PolicyDecision,
  PolicyOutcome,
  ExecutionStatus,
  ExecutionResult,
  RuntimeMode,
} from "./types";
