/**
 * Copilot (ADVISORY) calendar execution through the Capability Runtime.
 *
 * The Copilot has NO calendar execution logic of its own: whenever its model emits
 * a calendar tool (check_availability / schedule_meeting / …) we map tool→operation
 * +params and run the SAME `executeCalendarOperation` pipeline in ADVISORY mode -
 * READs auto-run and return real facts; WRITEs short-circuit to a RECOMMENDATION
 * (never executed). Dependency resolution, invariants, approval, recovery, and
 * tracing are all owned by the runtime, parameterized only by execution mode.
 *
 * (The employee-side AUTONOMOUS variant `executeCalendarToolViaRuntime` was the
 * dead Slice-3C cutover path and has been removed; the employee books through the
 * Agent Loop's CalendarCapability.)
 */

import type { ExecutionRequest, ExecutionResult, ExecutionTrace } from "@chatcenter/shared";
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
 * Copilot (ADVISORY) calendar execution - the SAME `executeCalendarOperation`
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
        content: JSON.stringify({ ok: true, ...data, outcome: result.outcome, note: "Read auto-ran - weave these REAL facts into your reply suggestions; do NOT promise to check later." }),
        trace,
      };
    }
    case "RECOMMENDED":
      return {
        content: JSON.stringify({ ok: true, recommended: true, executed: false, note: "Surfaced to the human agent as a recommended action - NOT executed by the Co-Pilot. Continue and draft the suggested reply." }),
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

