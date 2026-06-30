/**
 * Slice 3C — calendar execution through the Capability Runtime.
 *
 * Returns an AgentToolDispatchResult (the SAME shape `dispatchToolCall` returns),
 * so it drops straight into the existing orchestrator.submit(...) wrapper at the
 * dispatch site. That means idempotency, HITL approval, the Turn Outcome Ledger,
 * and auditing are all still owned by the orchestrator — the cutover swaps ONLY
 * who computes the tool result (new runtime vs legacy handler).
 *
 * The model still emits tool calls (check_availability / schedule_meeting / …);
 * here we map tool→operation+params, run the runtime in AUTONOMOUS mode (writes
 * execute), then map the semantic ExecutionResult back to the legacy result JSON
 * the reply/ledger logic already understands.
 */

import type { AgentToolDispatchResult, ExecutionRequest, ExecutionResult, ExecutionTrace } from "@chatcenter/shared";
import { executeCalendarOperation } from "./calendar.runtime";
import type { CalendarPort } from "./calendar.port";

const OP_FOR_TOOL: Record<string, string> = {
  check_availability: "CHECK_AVAILABILITY",
  schedule_meeting: "BOOK_MEETING",
  reschedule_meeting: "MOVE_MEETING",
  cancel_meeting: "CANCEL_MEETING",
};

function paramsForTool(tool: string, a: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case "check_availability":
      return { meeting_type: a.meeting_type, from_iso: a.from_iso, to_iso: a.to_iso, desired_time: a.requested_at_iso };
    case "schedule_meeting":
      return { desired_time: a.requested_at_iso, meeting_type: a.meeting_type, email: a.customer_email };
    case "reschedule_meeting":
      return { desired_time: a.requested_at_iso };
    default:
      return {};
  }
}

/** Map the semantic result to the legacy tool-result JSON the loop already parses. */
function toLegacyContent(op: string, result: ExecutionResult): string {
  switch (result.status) {
    case "EXECUTED": {
      const data = (result.data ?? {}) as Record<string, unknown>;
      if (op === "CHECK_AVAILABILITY") {
        return JSON.stringify({ ok: true, proposedSlotsIso: data.proposedSlotsIso ?? [], outcome: result.outcome });
      }
      return JSON.stringify({ ok: true, verdict: "VALID", ...data, outcome: result.outcome });
    }
    case "NEEDS_INPUT":
      return JSON.stringify({
        ok: false,
        error: "missing_required_inputs",
        missing_inputs: [result.field],
        instruction: `Do not proceed yet. Ask the customer for: ${result.field}, then call the tool again.`,
      });
    case "FAILED": {
      const needsAvail = /no_slot|needs_availability|slot_taken|time_taken|none_open|conflict/i.test(result.reason);
      return JSON.stringify({ ok: false, reason: result.reason, ...(needsAvail ? { needsAvailabilityCheck: true } : {}) });
    }
    case "BLOCKED":
      return JSON.stringify({ ok: false, reason: result.reason });
    case "AWAITING_APPROVAL":
      return JSON.stringify({ ok: false, reason: "awaiting_approval", ref: result.ref });
    case "RECOMMENDED":
      return JSON.stringify({ ok: false, reason: "recommend_only_mode" });
    default:
      return JSON.stringify({ ok: false, reason: "unknown" });
  }
}

/** True for the calendar tools the Capability Runtime owns. */
export function isCalendarTool(name: string): boolean {
  return !!OP_FOR_TOOL[name];
}

export interface AdvisoryCalendarResult {
  /** Tool-message content for the model (real facts for a READ; a recommend note for a WRITE). */
  content: string;
  /** Present for a WRITE: the recommended action to surface to the human (never executed). */
  quickAction?: { tool: string; args: Record<string, unknown>; reason: string };
  trace: ExecutionTrace;
}

/**
 * Copilot (ADVISORY) calendar execution — the SAME `executeCalendarOperation`
 * pipeline as the employee, only `mode: "advisory"`. READs auto-run and return
 * their real facts; WRITEs short-circuit to a RECOMMENDATION (never executed).
 * This is what lets the Copilot drop ALL of its own calendar execution logic:
 * dependency resolution, invariants, READ execution, WRITE recommendation,
 * approval, recovery, and tracing are owned by the runtime, parameterized only
 * by execution mode.
 */
export async function executeCalendarToolAdvisory(input: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  context: ExecutionRequest["context"];
  port: CalendarPort;
  plannerGoal?: string;
  logger?: (t: ExecutionTrace) => void;
}): Promise<AdvisoryCalendarResult> {
  const op = OP_FOR_TOOL[input.toolName];
  const req: ExecutionRequest = {
    operation: op,
    params: paramsForTool(input.toolName, input.toolArgs ?? {}),
    context: input.context,
    mode: "advisory",
  };
  const { result, trace } = await executeCalendarOperation(req, { port: input.port, logger: input.logger, strategyId: "calendar.copilot" });
  switch (result.status) {
    case "EXECUTED": {
      const data = (result.data ?? {}) as Record<string, unknown>;
      return {
        content: JSON.stringify({ ok: true, ...data, outcome: result.outcome, note: "Read auto-ran — weave these REAL facts into your reply suggestions; do NOT promise to check later." }),
        trace,
      };
    }
    case "RECOMMENDED":
      return {
        content: JSON.stringify({ ok: true, recommended: true, executed: false, note: "Surfaced to the human agent as a recommended action — NOT executed by the Co-Pilot. Continue and draft the suggested reply." }),
        quickAction: { tool: input.toolName, args: input.toolArgs ?? {}, reason: `Recommended by Co-Pilot (${op})` },
        trace,
      };
    case "NEEDS_INPUT":
      return { content: JSON.stringify({ ok: false, error: "missing_required_inputs", missing_inputs: [result.field], instruction: `Ask the customer for: ${result.field}.` }), trace };
    case "FAILED":
    case "BLOCKED":
      return { content: JSON.stringify({ ok: false, reason: (result as { reason?: string }).reason }), trace };
    default:
      return { content: JSON.stringify({ ok: false, reason: "unknown" }), trace };
  }
}

export interface RuntimeExecInput {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
  context: ExecutionRequest["context"];
  port: CalendarPort;
  plannerGoal?: string;
  /** Trace sink (defaults to the runtime's JSON logger). */
  logger?: (t: ExecutionTrace) => void;
}

/**
 * Execute one calendar tool via the Capability Runtime. Returns a dispatch-shaped
 * result; never throws (a runtime error becomes a structured ok:false result so
 * the loop continues exactly as a legacy handler error would).
 */
export async function executeCalendarToolViaRuntime(input: RuntimeExecInput): Promise<AgentToolDispatchResult> {
  const op = OP_FOR_TOOL[input.toolName];
  if (!op) {
    return { toolCallId: input.toolCallId, content: JSON.stringify({ ok: false, reason: `no_operation_for_tool:${input.toolName}` }) };
  }
  try {
    const req: ExecutionRequest = {
      operation: op,
      params: paramsForTool(input.toolName, input.toolArgs ?? {}),
      context: input.context,
      mode: "autonomous",
    };
    const { result } = await executeCalendarOperation(req, { port: input.port, logger: input.logger, strategyId: "calendar.runtime" });
    return { toolCallId: input.toolCallId, content: toLegacyContent(op, result) };
  } catch (err: any) {
    return { toolCallId: input.toolCallId, content: JSON.stringify({ ok: false, reason: `capability_runtime_error:${String(err?.message || err)}` }) };
  }
}
