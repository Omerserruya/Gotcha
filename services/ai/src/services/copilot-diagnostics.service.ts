/**
 * Copilot Diagnostics - deterministic, structured observability for every Copilot
 * turn, the advisory analog of the AI Employee's `[ai-bot]` diagnostics.
 *
 * The Copilot writes no per-tool audit row (it recommends, it doesn't act), so
 * before this module the only way to know WHY it said what it said was to guess.
 * These logs make any Copilot decision debuggable from stdout alone:
 *
 *   [copilot][plan]   - the planner's view BEFORE the model reasons: the goal, the
 *                       active objective, the best next action, confidence, and the
 *                       business-goal status. This is the EXACT CurrentPlan rendered
 *                       into the prompt (see `computeCurrentPlanForOpts`), so the
 *                       log can never disagree with what the model received.
 *
 *   [copilot][tool]   - one per decision the turn makes:
 *                         • READ  - a safe tool the Copilot auto-ran (with the
 *                                   facts it returned, summarized);
 *                         • ACTION- a customer-facing tool it RECOMMENDED, never ran
 *                                   (with the planner's reason);
 *                         • NO_TOOL- it answered with no tool (pure reply);
 *                         • MISSING_INFORMATION - it could not act because the
 *                                   planner still needs a required input (named).
 *
 * Pure formatting + a thin console emitter. Never throws; diagnostics must never
 * break a suggestion.
 */

import type { CurrentPlan } from "./planner.service";
import type { CopilotExecutionMode } from "./capabilities";

export type CopilotToolDecision = "NO_TOOL" | "READ" | "ACTION" | "MISSING_INFORMATION";

export interface CopilotDiagContext {
  tenantId?: string;
  conversationId: string;
  /** "suggest" (primary panel) | "chat" (agent asks the copilot). */
  entry: "suggest" | "chat";
}

export interface CopilotToolDiag {
  decision: CopilotToolDecision;
  /** WHY the planner did/didn't select this - for MISSING_INFORMATION, the blocker. */
  plannerReason: string;
  tool?: string;
  executed: boolean;
  executionMode: CopilotExecutionMode;
  /** Summarized tool result / facts returned (READ) or the recommendation note. */
  result?: string;
}

const tag = (ctx: CopilotDiagContext, kind: string) =>
  `[copilot][${kind}] entry=${ctx.entry} conv=${ctx.conversationId}` +
  (ctx.tenantId ? ` tenant=${ctx.tenantId}` : "");

/** Render the `[copilot][plan]` block from the EXACT plan the prompt rendered. */
export function formatCopilotPlan(plan: CurrentPlan | null, ctx: CopilotDiagContext): string {
  if (!plan) {
    return `${tag(ctx, "plan")}\n  Goal: -\n  Objective: -\n  BestAction: -\n  Confidence: -\n  GoalStatus: -`;
  }
  const best = plan.bestNextAction;
  const bestStr = best ? `[${best.kind.toUpperCase()}] ${best.tool ?? best.label}` : "-";
  return (
    `${tag(ctx, "plan")}\n` +
    `  Goal: ${plan.goal ?? "-"}\n` +
    `  Objective: ${plan.currentObjective ?? "-"}\n` +
    `  BestAction: ${bestStr}\n` +
    `  Confidence: ${plan.confidence.toFixed(2)}\n` +
    `  GoalStatus: ${plan.goalStatus?.kind ?? "-"}`
  );
}

/** Render one `[copilot][tool]` block. */
export function formatCopilotTool(e: CopilotToolDiag, ctx: CopilotDiagContext): string {
  return (
    `${tag(ctx, "tool")}\n` +
    `  Decision: ${e.decision}\n` +
    `  PlannerReason: ${e.plannerReason || "-"}\n` +
    `  Tool: ${e.tool ?? "-"}\n` +
    `  Executed: ${e.executed}\n` +
    `  ExecutionMode: ${e.executionMode}\n` +
    `  Result: ${e.result ?? "-"}`
  );
}

export function logCopilotPlan(plan: CurrentPlan | null, ctx: CopilotDiagContext): void {
  try {
    console.log(formatCopilotPlan(plan, ctx));
  } catch {
    /* diagnostics never break a turn */
  }
}

export function logCopilotTool(e: CopilotToolDiag, ctx: CopilotDiagContext): void {
  try {
    console.log(formatCopilotTool(e, ctx));
  } catch {
    /* diagnostics never break a turn */
  }
}

/**
 * Why did the planner select (or pass over) `toolName`? Matches the tool against
 * the plan's ranked candidates so a READ that auto-ran or an ACTION that was
 * recommended carries the planner's own rationale, not a guess.
 */
export function plannerReasonForTool(plan: CurrentPlan | null, toolName: string): string {
  if (!plan) return "no plan computed for this turn";
  if (toolName === plan.preferredTool && plan.why) {
    return `planner's best action - ${plan.why} (confidence ${plan.confidence.toFixed(2)})`;
  }
  const cand = plan.candidateActions.find((c) => c.tool === toolName);
  if (cand) {
    return `planner candidate [${cand.kind.toUpperCase()}] - ${cand.rationale} (score ${cand.score.toFixed(2)})`;
  }
  // Not an objective action the planner ranked - typically a READ the model ran to
  // enrich the recommendation, or a tool it chose off the customer's latest message.
  return "not the planner's ranked action - model-selected for this turn (e.g. a read to enrich the recommendation)";
}

/**
 * The turn-level decision when NO read/action tool ran. If the planner's best move
 * was an ASK blocked by missing required info → MISSING_INFORMATION, naming the
 * blocker; otherwise the Copilot simply replied → NO_TOOL.
 */
export function noToolDecision(plan: CurrentPlan | null): CopilotToolDiag {
  const best = plan?.bestNextAction;
  const missing = plan?.currentState?.missingRequired ?? [];
  if (best?.kind === "ask" && missing.length > 0) {
    return {
      decision: "MISSING_INFORMATION",
      plannerReason:
        `blocked: the planner needs ${missing.map((m) => m.label).join("; ")} before the goal's action can run ` +
        `(objective ${plan?.currentObjective ?? "-"})`,
      executed: false,
      executionMode: "none",
      result: "recommended asking for the missing detail (no tool run)",
    };
  }
  return {
    decision: "NO_TOOL",
    plannerReason: best
      ? `planner best move is [${best.kind.toUpperCase()}] ${best.label} - no tool needed to advance it this turn`
      : "no objective action this turn - reply only",
    executed: false,
    executionMode: "none",
    result: "reply-only suggestions",
  };
}

/**
 * Summarize a tool result for the `Result:` line - the FACTS a READ returned, so a
 * reader can confirm the Copilot wove real data into its recommendation. Parses the
 * dispatcher's JSON envelope when present; otherwise truncates. Never throws.
 */
export function summarizeToolResult(raw: unknown): string {
  if (raw === undefined || raw === null) return "-";
  let s = typeof raw === "string" ? raw : safeStringify(raw);
  try {
    const o = JSON.parse(s);
    if (o && typeof o === "object") {
      const bits: string[] = [];
      if ("ok" in o) bits.push(`ok=${(o as any).ok}`);
      if ((o as any).recommended) bits.push("recommended");
      if ("executed" in o) bits.push(`executed=${(o as any).executed}`);
      if ((o as any).reason) bits.push(`reason=${(o as any).reason}`);
      for (const k of ["slots", "availableSlots", "openSlots", "events", "results", "matches", "orders"]) {
        if (Array.isArray((o as any)[k])) bits.push(`${(o as any)[k].length} ${k}`);
      }
      if ((o as any).workingHours) bits.push("workingHours");
      if ((o as any).nearest || (o as any).nearestSlot) bits.push("nearest-slot");
      if ((o as any).available !== undefined) bits.push(`available=${(o as any).available}`);
      if ((o as any).note) bits.push(`note=${truncate(String((o as any).note), 80)}`);
      if (bits.length) s = bits.join(", ");
    }
  } catch {
    /* not JSON - fall through to truncation */
  }
  return truncate(s, 240);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
