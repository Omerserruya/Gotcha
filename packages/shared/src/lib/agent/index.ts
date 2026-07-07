/**
 * Agent Contract — public surface (FROZEN architecture, Phase 1: envelope only).
 *
 * GOTCHA as an OS for AI Employees:
 *   - Capability Runtime = the kernel (single execution authority).
 *   - Agent             = a process (identity + grants + memory + cognition).
 *   - Operations        = syscalls (Calendar/CRM/Billing capability domains).
 *   - Oracle Facts      = the one shared truth agents coordinate through.
 *
 * Phase 1 ships pure contract types + a pure binder + a master flag. No
 * behaviour, nothing wired into the live path, fully reversible (delete this
 * dir + the one barrel line in ../../index.ts).
 */

export type { AgentIdentity, AgentPersona } from "./identity";


export type { AgentMemory, MemoryStore, MemoryKey, BusinessOutcome } from "./memory";
export { EMPTY_AGENT_MEMORY } from "./memory";
export type { WorkingMemory, IterationTrace, RuledOutOperation } from "./working-memory";
export { emptyWorkingMemory, mergeWorkingMemory } from "./working-memory";
export type { LoopPolicy, CapabilityLoopPolicy, TerminationReason } from "./loop-policy";
export { DEFAULT_LOOP_POLICY, resolveLoopPolicy } from "./loop-policy";
export type { AuthorizationVerdict } from "./guardrails";
export { authorizeOperation } from "./guardrails";
export type { LoopControl } from "./loop";
export {
  decisionToControl,
  preReasonTermination,
  runtimeResultToTermination,
} from "./loop";
export type { Facts, AvailableOperation, OperationParamHint, BillingStatus, CapabilityWorldView } from "./facts";
export type {
  Context,
  ReasonerInput,
  ReasonerDecision,
  ReasonerRead,
  ReplyIntent,
  ReasonerOutput,
  Cognition,
  Writer,
} from "./cognition";

export { isAgentArchitectureEnabled } from "./agent";
export type { KernelSignals } from "./oracle";
export { assembleFacts } from "./oracle";
export type {
  PlannerMove,
  DivergenceAxis,
  DecisionDivergence,
  ShadowEvalRecord,
} from "./shadow-eval";
export { plannerMoveToDecision, compareDecisions, summarizeShadowBatch, SHADOW_EVAL_SCHEMA_VERSION } from "./shadow-eval";
export type {
  ReasonerProvider,
  ReasonerProviderResult,
  ReasonerUsage,
  ReasonerCallOptions,
  ParseResult,
} from "./reasoner-provider";
export { parseReasonerOutput } from "./reasoner-provider";
