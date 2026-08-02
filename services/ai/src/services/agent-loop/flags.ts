/**
 * Agent Loop feature flag - per-tenant, env-driven, INSTANT rollback (flip env,
 * recreate, no deploy). The legacy Planner is the production path; the loop only
 * runs when explicitly enabled for a tenant.
 *
 * Capability lifecycle ladder (AGENT_LOOP_MODE) - the STANDARD migration path for
 * every capability (Calendar, CRM, Knowledge, Commerce, Voice, …):
 *   off        - Planner drives (default). The loop code is never entered.
 *   shadow     - EVALUATION mode. The complete loop + Runtime run on real traffic:
 *                every observation, iteration, metric and safety check is collected
 *                and persisted - but the customer NEVER sees the loop's output; the
 *                legacy brain remains the customer-facing source of truth. Writes are
 *                dry-run (RECOMMENDED, no real mutation). Sole purpose: prove the new
 *                kernel behaves correctly under production traffic. Runs off the live
 *                turn's critical path (fire-and-forget), so it can neither slow nor
 *                break the turn.
 *   autonomous - the loop drives the customer turn and executes real operations
 *                (only after shadow evidence reaches confidence). Never the first
 *                production execution path for a capability.
 *
 * A capability only ever graduates off → shadow → autonomous; the migration process
 * itself is the validation framework.
 */

export type AgentLoopMode = "off" | "shadow" | "autonomous";

function tenantAllowed(allowRaw: string | undefined, tenantId: string): boolean {
  const allow = (allowRaw || "").trim();
  if (allow === "" || allow === "*") return true;
  return allow.split(",").map((s) => s.trim()).filter(Boolean).includes(tenantId);
}

export function agentLoopMode(tenantId: string): AgentLoopMode {
  const raw = (process.env.AGENT_LOOP_MODE || "off").toLowerCase();
  if (raw !== "shadow" && raw !== "autonomous") return "off";
  if (!tenantAllowed(process.env.AGENT_LOOP_TENANTS, tenantId)) return "off";
  return raw;
}

export function isAgentLoopEnabled(tenantId: string): boolean {
  return agentLoopMode(tenantId) !== "off";
}
