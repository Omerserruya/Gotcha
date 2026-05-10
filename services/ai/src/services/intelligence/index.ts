/**
 * Conversation Intelligence Engine — Layer 2.
 *
 * Owns every analysis primitive, prompt assembler, memory write/read, and
 * structured-output schema. Does NOT own WS connections, STT, or tool
 * execution. Pure analysis: consumes TranscriptUtterance, emits
 * ConversationStateFrame.
 *
 * Phase 3 lights up the live path: LivePromptAssembler + LiveAnalysisRunner
 * + ConversationMemory. Concrete QA / async paths land in Phase 5/6.
 */

export * from "./sources";
export * from "./analyzers";
export * from "./events";
export * from "./prompts";
export * from "./memory";
export { LiveCadence, type AnalysisCadence } from "./cadence";
export { LiveAnalysisRunner, type LiveRunnerOptions } from "./live-analysis-runner";
export { CallAnalysisStore } from "./persistence/call-analysis-store";
export {
  QAScoreStore,
  type QAScoreFinding,
  type QAScoreInput,
} from "./persistence/qa-score-store";
export * from "./queues";
export { runAnalysis } from "./run-analysis";
export { startLiveRunnerSupervisor } from "./live-runner-supervisor";
