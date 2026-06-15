/**
 * Unified tool policy for the AI Worker.
 *
 * Replaces three scattered filtering mechanisms:
 *   1. `buildAgentTools(opts)` in @chatcenter/shared/lib/agent-tools.ts
 *      - boolean flags per built-in tool (closure / followup / etc.)
 *   2. `BehaviorState.allowedActions[]` filter in behavior-engine.service.ts
 *      - ActionCategory allowlist computed per turn
 *   3. `LiveCallToolPolicy.evaluate()` in orchestrator/policy/
 *      - per-call gating decision
 *
 * The unified policy is a pure function of:
 *   - the worker's mode
 *   - the skill set's `toolsAdded[]` (each skill grants its own tools)
 *   - optional tenant `AgentToolPermission` overrides (loaded by caller)
 *
 * Output: the final allowlist of tool function names the worker may call.
 * The OpenAI client receives this as the `tools:` parameter.
 *
 * Behavioural rules baked into this policy (saved-memory invariants):
 *   - copilot mode MUST NOT include `close_conversation` or
 *     `schedule_followup` / `schedule_followup_template` / `create_task`.
 *     The LLM otherwise auto-closes live chats out from under the rep.
 *   - callpilot mode has ZERO mutating tools during the live call.
 *     Action triggers surface as structured cues; the post-call worker
 *     executes them.
 *   - autonomous mode gets the full surface, modulated by tenant
 *     `AgentToolPermission` (the tenant Settings → Tools page).
 */

import type { AIWorkerMode } from "@chatcenter/shared";

// ─── Tool name constants ────────────────────────────────────────
//
// Centralised here so the per-mode lists are unambiguous and grep-able.
// These mirror the names registered in services/ai/src/services/tool-registry.ts
// and the built-in helpers in @chatcenter/shared/lib/agent-tools.ts.

/**
 * Bot-surface action tools that the copilot path MUST NOT expose to the
 * LLM. If included, the model tends to call them unprompted (close the
 * conversation, schedule a follow-up the rep didn't authorise, etc.).
 */
export const COPILOT_FORBIDDEN_TOOLS = new Set<string>([
  "close_conversation",
  "schedule_followup",
  "schedule_followup_template",
  "create_task",
  "schedule_meeting",
]);

/**
 * Tools that mutate platform state. callpilot mode strips all of these
 * during the live call; the post-call worker re-evaluates and executes
 * them with the call transcript as evidence.
 */
export const MUTATING_TOOLS = new Set<string>([
  "send_message",
  "update_contact",
  "update_crm",
  "create_ticket",
  "tag_contact",
  "create_broadcast",
  "schedule_broadcast",
  "create_workflow",
  "merge_contacts",
  "link_customer_identifier",
  "schedule_followup",
  "schedule_followup_template",
  "schedule_meeting",
  "create_task",
  "close_conversation",
  "escalate_to_human",
]);

// ─── Policy input + output ──────────────────────────────────────

export interface ToolPolicyInput {
  mode: AIWorkerMode;
  /** Tools granted by the worker's skill set (composer aggregates these). */
  skillToolsAdded: string[];
  /**
   * Tenant-level overrides loaded from `AgentToolPermission`. Empty array
   * = no allowlist (every tool the policy would surface is kept).
   * Non-empty = intersect: only tools in this list pass through.
   */
  tenantAllowlist?: string[];
  /**
   * Tenant-level deny list. Always wins over allowlist + skills + mode.
   * Use for hard kill switches (e.g. tenant disabled SMS sending entirely).
   */
  tenantDenylist?: string[];
}

export interface ToolPolicyDecision {
  /** Final tool names the worker may call this session. */
  allowed: string[];
  /** Trace of what filtered each tool - keyed by tool name. */
  rejections: Record<string, string>;
  /** Trace summary suitable for log lines. */
  summary: string;
}

// ─── Core decision ──────────────────────────────────────────────

export function decideToolPolicy(input: ToolPolicyInput): ToolPolicyDecision {
  const rejections: Record<string, string> = {};
  // Dedup skill tools while preserving order (composer already dedups,
  // but be defensive - callers may invoke directly).
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const t of input.skillToolsAdded) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    candidates.push(t);
  }

  const allowed: string[] = [];
  for (const tool of candidates) {
    const verdict = filterTool(tool, input);
    if (verdict.allowed) {
      allowed.push(tool);
    } else {
      rejections[tool] = verdict.reason;
    }
  }

  const summary = `mode=${input.mode} allowed=${allowed.length}/${candidates.length}${
    Object.keys(rejections).length > 0
      ? ` rejections=[${Object.entries(rejections)
          .map(([t, r]) => `${t}:${r}`)
          .join(", ")}]`
      : ""
  }`;

  return { allowed, rejections, summary };
}

function filterTool(
  tool: string,
  input: ToolPolicyInput,
): { allowed: true } | { allowed: false; reason: string } {
  // 1. Tenant kill switch wins over everything.
  if (input.tenantDenylist?.includes(tool)) {
    return { allowed: false, reason: "tenant-deny" };
  }

  // 2. Mode-specific hard rules.
  if (input.mode === "copilot" && COPILOT_FORBIDDEN_TOOLS.has(tool)) {
    return { allowed: false, reason: "copilot-forbidden" };
  }
  if (input.mode === "callpilot" && MUTATING_TOOLS.has(tool)) {
    return { allowed: false, reason: "callpilot-no-mutating" };
  }

  // 3. Tenant allowlist (only when non-empty; empty = no allowlist).
  if (input.tenantAllowlist && input.tenantAllowlist.length > 0) {
    if (!input.tenantAllowlist.includes(tool)) {
      return { allowed: false, reason: "not-in-tenant-allowlist" };
    }
  }

  return { allowed: true };
}
