/**
 * Agent architecture flag.
 *
 * (The dormant Phase-1 `Agent` envelope — `assembleAgent`/`AgentRuntime`/grants —
 * was deleted per the 2026-07-03 architecture audit's wire-or-delete rule: it had
 * zero consumers, and the LIVE composition is the Agent Loop (`runAgentLoop`) +
 * capability registry + `MemoryStore` (implemented in agent-loop/memory-store.ts).
 * Unused abstractions are how second architectures start.)
 */

/**
 * Master feature flag for the Agent architecture. Gates the reasoner-shadow and
 * related evidence machinery in the legacy path.
 */
export function isAgentArchitectureEnabled(): boolean {
  return (process.env.AGENT_ARCHITECTURE_ENABLED || "false").toLowerCase() === "true";
}
