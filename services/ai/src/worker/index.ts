/**
 * Public worker API. Call sites import from here, not the internals.
 *
 * Side effect: importing this module registers every system skill so
 * the registry is ready by the time a call site composes its first
 * worker.
 */

import "./skills";

export { AIWorker } from "./worker";
export type {
  OpenWorkerArgs,
  GenerateArgs,
  WorkerGenerationResult,
} from "./worker";
export {
  workerConfigFromAgent,
  workerConfigFromLegacy,
  sessionProfileFromContext,
  type LegacyAgentRecord,
  type LegacyVoiceChannelConfig,
  type ShimContext,
} from "./cutover-shim";
export { isUnifiedWorkerEnabled, isUnifiedWorkerEnabledFor, type CutoverSite } from "./cutover-flag";
export {
  decideToolPolicy,
  COPILOT_FORBIDDEN_TOOLS,
  MUTATING_TOOLS,
  type ToolPolicyInput,
  type ToolPolicyDecision,
} from "./tools/policy";
export {
  resolvePipelineContext,
  snapshotFromResolved,
  describePipelineSource,
  type PipelineSnapshot,
  type ResolvePipelineArgs,
} from "./pipeline/context";
export {
  advancePipeline,
  type AdvancePipelineArgs,
} from "./pipeline/transition";
export {
  composeSkills,
  defineSkill,
  listSkillMetadata,
} from "./skills/registry";
export {
  releaseSession,
  getSession,
  type WorkerSession,
} from "./session-registry";
