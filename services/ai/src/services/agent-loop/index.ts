/**
 * Agent Loop - public surface. The one entry the live turn calls is `runAgentLoop`
 * (gated by `isAgentLoopEnabled` / `agentLoopMode`). Everything else is internal.
 */

export { runAgentLoop, LOOP_PROMPT_VERSION } from "./agent-loop";
export type { AgentLoopInputs, AgentLoopResult } from "./agent-loop";
export { isAgentLoopEnabled, agentLoopMode, type AgentLoopMode } from "./flags";
export { assembleOracleFacts } from "./oracle-assembler";
