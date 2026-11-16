/**
 * Reply engine v2 switch, on the agent-loop ladder (off -> shadow -> autonomous),
 * per tenant, env-driven: flip REPLY_ENGINE_MODE and recreate ai for an instant
 * rollback. Off is the default; an unknown value is off.
 */
import { tenantAllowed } from "../agent-loop/flags";
import type { ReplyEngineMode } from "./contract";

export function replyEngineMode(tenantId: string): ReplyEngineMode {
  const raw = (process.env.REPLY_ENGINE_MODE || "off").trim().toLowerCase();
  if (raw !== "shadow" && raw !== "autonomous") return "off";
  if (!tenantAllowed(process.env.REPLY_ENGINE_TENANTS, tenantId)) return "off";
  return raw;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

export function engineConfig() {
  return {
    /** Per-tool timeout. */
    toolTimeoutMs: intEnv("REPLY_ENGINE_TOOL_TIMEOUT_MS", 8000, 500, 60000),
    /** Tools still running after this many ms add a short "checking" interim message. */
    interimAfterMs: intEnv("REPLY_ENGINE_INTERIM_AFTER_MS", 3000, 0, 60000),
    /** Model rounds per turn (tool rounds plus the respond round). */
    maxRounds: intEnv("REPLY_ENGINE_MAX_ROUNDS", 5, 2, 10),
    /** Messages in the turn window; older ones live in the rolling summary. */
    windowMessages: intEnv("REPLY_ENGINE_WINDOW", 16, 4, 60),
  };
}
