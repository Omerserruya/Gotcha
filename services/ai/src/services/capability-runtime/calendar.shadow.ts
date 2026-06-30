/**
 * Slice 3B — shadow comparator.
 *
 * Runs the new Capability Runtime in ADVISORY mode (writes never execute — they
 * short-circuit to RECOMMENDED) alongside the legacy calendar tool result,
 * captures the full reasoning path, and classifies the comparison into four
 * categories. It NEVER throws into the live turn and NEVER mutates the calendar.
 *
 * Reasoning path captured per comparison (user requirement):
 *   plannerGoal, selectedOperation, invariants (preconditions), satisfiedAlready,
 *   satisfiedByRead, runtimeDecision, verdict.
 *
 * Verdicts:
 *   IDENTICAL            — new runtime would do exactly what legacy did.
 *   EXPECTED_DIFFERENCE  — a known, accepted divergence (e.g. book→move split).
 *   REGRESSION           — new runtime would act where legacy didn't, or block
 *                          what legacy completed (material, NOT on the allow-list).
 *   UNKNOWN              — could not be mapped / the shadow errored.
 */

import {
  type ExecutionResult,
  type ExecutionTrace,
  type InvariantTrace,
  type ExecutionRequest,
} from "@chatcenter/shared";
import { executeCalendarOperation } from "./calendar.runtime";
import type { CalendarPort } from "./calendar.port";

export type ShadowVerdict = "IDENTICAL" | "EXPECTED_DIFFERENCE" | "REGRESSION" | "UNKNOWN";

/**
 * Stable join key: Conversation → Turn → Tool Call → Shadow Comparison. The same
 * ids appear on the legacy execution's audit, so shadow records join to the live
 * run without matching by timestamp.
 */
export interface ShadowCorrelation {
  tenantId: string;
  conversationId: string;
  turnId?: string;
  /** The legacy tool-call id (shared with the legacy execution). */
  toolCallId: string;
  /** `conversationId:turnId:toolCallId` — one field for easy joins. */
  correlationId: string;
}

export interface ShadowComparison {
  correlation: ShadowCorrelation;
  // ── reasoning path ──
  plannerGoal?: string;
  selectedOperation: string;
  /** Preconditions/invariants evaluated this run. */
  invariants: InvariantTrace[];
  /** Invariant ids that were already satisfied (no work needed). */
  satisfiedAlready: string[];
  /** Invariant ids satisfied by running a read. */
  satisfiedByRead: string[];
  /** The new runtime's final decision (advisory). */
  runtimeDecision: ExecutionResult["status"];
  runtimeReason?: string;
  // ── comparison ──
  legacyDecision: string;
  verdict: ShadowVerdict;
  detail: string;
  trace?: ExecutionTrace;
}

export interface ShadowInput {
  legacyTool: string;
  legacyArgs: Record<string, unknown>;
  /** The legacy handler result (object or JSON string). */
  legacyResult: unknown;
  context: ExecutionRequest["context"];
  correlation: ShadowCorrelation;
  plannerGoal?: string;
  port: CalendarPort;
  logger?: (rec: ShadowComparison) => void;
}

const OP_FOR_TOOL: Record<string, string> = {
  check_availability: "CHECK_AVAILABILITY",
  schedule_meeting: "BOOK_MEETING",
  reschedule_meeting: "MOVE_MEETING",
  cancel_meeting: "CANCEL_MEETING",
};

type Decision =
  | { kind: "READ"; slots: string[] }
  | { kind: "READY" }
  | { kind: "NEEDS"; field: string }
  | { kind: "NOOP_FAIL"; reason: string };

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

function normalizeLegacy(tool: string, raw: unknown): Decision {
  let res: any = raw;
  if (typeof raw === "string") { try { res = JSON.parse(raw); } catch { res = {}; } }
  const ok = res?.ok === true;
  const reason = String(res?.reason ?? "");
  switch (tool) {
    case "check_availability":
      return ok ? { kind: "READ", slots: Array.isArray(res.proposedSlotsIso) ? res.proposedSlotsIso : [] } : { kind: "NOOP_FAIL", reason: reason || "check_failed" };
    case "schedule_meeting":
      if (ok && res.verdict === "VALID") return { kind: "READY" };
      if (/customer_email_required/i.test(reason)) return { kind: "NEEDS", field: "email" };
      return { kind: "NOOP_FAIL", reason: reason || (res?.needsAvailabilityCheck ? "needs_availability" : "schedule_failed") };
    case "reschedule_meeting":
      if (ok && res.verdict === "VALID") return { kind: "READY" };
      if (/which|ambiguous|more than one|choose/i.test(reason)) return { kind: "NEEDS", field: "which_booking" };
      return { kind: "NOOP_FAIL", reason: reason || "reschedule_failed" };
    case "cancel_meeting":
      if (ok) return { kind: "READY" };
      if (/which|ambiguous|more than one|choose/i.test(reason)) return { kind: "NEEDS", field: "which_booking" };
      return { kind: "NOOP_FAIL", reason: reason || "cancel_failed" };
    default:
      return { kind: "NOOP_FAIL", reason: `unknown_tool:${tool}` };
  }
}

function shadowDecision(result: ExecutionResult): Decision {
  switch (result.status) {
    case "EXECUTED": // only reads execute in advisory mode
      return { kind: "READ", slots: Array.isArray((result as any).data?.proposedSlotsIso) ? (result as any).data.proposedSlotsIso : [] };
    case "RECOMMENDED":
      return { kind: "READY" };
    case "NEEDS_INPUT":
      return { kind: "NEEDS", field: result.field };
    case "FAILED":
    case "BLOCKED":
      return { kind: "NOOP_FAIL", reason: (result as any).reason };
    default:
      return { kind: "NOOP_FAIL", reason: "unknown" };
  }
}

function reasonClass(r: string): string {
  if (/no_existing_meeting|nothing_to_move|nothing_to_cancel/i.test(r)) return "no_booking";
  if (/no_calendar|calendar_unavailable/i.test(r)) return "no_calendar";
  if (/active_booking_exists/i.test(r)) return "duplicate";
  if (/needs_availability|slot_taken|no_time_selected|invalid|none_open/i.test(r)) return "no_slot";
  return r;
}
const setEq = (a: string[], b: string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length;

/** Known, accepted divergences. Returns null when not on the allow-list. */
function expectedDifference(shadow: Decision, legacy: Decision, op: string): string | null {
  if (op === "BOOK_MEETING" && shadow.kind === "NOOP_FAIL" && reasonClass(shadow.reason) === "duplicate" && legacy.kind === "READY") {
    return "book→move split: legacy rescheduled an existing booking; the new model routes this to MOVE_MEETING";
  }
  if (shadow.kind === "READY" && legacy.kind === "NOOP_FAIL" && reasonClass(legacy.reason) === "no_slot") {
    return "shadow advisory stops before the write, so it cannot observe the legacy create-time availability re-check";
  }
  return null;
}

function classify(shadow: Decision, legacy: Decision, op: string): { verdict: ShadowVerdict; detail: string } {
  const exp = expectedDifference(shadow, legacy, op);
  if (exp) return { verdict: "EXPECTED_DIFFERENCE", detail: exp };

  if (shadow.kind === legacy.kind) {
    switch (shadow.kind) {
      case "READ": {
        const ls = (legacy as { slots: string[] }).slots;
        if (setEq(shadow.slots, ls)) return { verdict: "IDENTICAL", detail: "same open slots" };
        if (shadow.slots.length === 0 && ls.length > 0) return { verdict: "REGRESSION", detail: "shadow returned no slots where legacy had availability" };
        return { verdict: "EXPECTED_DIFFERENCE", detail: "slot sets differ (window/ordering)" };
      }
      case "READY":
        return { verdict: "IDENTICAL", detail: "both ready to act" };
      case "NEEDS": {
        const lf = (legacy as { field: string }).field;
        return shadow.field === lf
          ? { verdict: "IDENTICAL", detail: `both need ${shadow.field}` }
          : { verdict: "EXPECTED_DIFFERENCE", detail: `both ask, different field (legacy:${lf} vs new:${shadow.field})` };
      }
      case "NOOP_FAIL": {
        const lr = (legacy as { reason: string }).reason;
        return reasonClass(shadow.reason) === reasonClass(lr)
          ? { verdict: "IDENTICAL", detail: `both fail: ${reasonClass(shadow.reason)}` }
          : { verdict: "EXPECTED_DIFFERENCE", detail: `both fail, different reason (legacy:${lr} vs new:${shadow.reason})` };
      }
    }
  }

  // Kinds differ and it's not an accepted difference → material.
  if (shadow.kind === "READY" && (legacy.kind === "NEEDS" || legacy.kind === "NOOP_FAIL")) {
    return { verdict: "REGRESSION", detail: `new runtime would ACT (READY) where legacy did not (${legacy.kind})` };
  }
  if ((shadow.kind === "NEEDS" || shadow.kind === "NOOP_FAIL") && legacy.kind === "READY") {
    const what = shadow.kind === "NEEDS" ? `NEEDS:${shadow.field}` : `FAIL:${shadow.reason}`;
    return { verdict: "REGRESSION", detail: `new runtime would NOT act (${what}) where legacy completed` };
  }
  return { verdict: "UNKNOWN", detail: `unmapped: new=${shadow.kind} legacy=${legacy.kind}` };
}

// Emit the FULL record as one-line JSON: every shadow record is self-contained
// and serializable, so it can be shipped to a log pipeline and replayed offline
// for dashboards, planner-quality comparison across model versions, and eval data.
function defaultLogger(rec: ShadowComparison): void {
  console.log(`[capability-runtime][shadow] ${JSON.stringify(rec)}`);
}

/**
 * Compare the new runtime (advisory) against the legacy calendar result. Pure
 * observability: returns + logs a ShadowComparison, never throws, never writes.
 */
export async function shadowCompareCalendar(input: ShadowInput): Promise<ShadowComparison> {
  const log = input.logger ?? defaultLogger;
  const op = OP_FOR_TOOL[input.legacyTool];
  try {
    if (!op) {
      const rec: ShadowComparison = {
        correlation: input.correlation,
        plannerGoal: input.plannerGoal, selectedOperation: input.legacyTool, invariants: [],
        satisfiedAlready: [], satisfiedByRead: [], runtimeDecision: "BLOCKED",
        legacyDecision: "n/a", verdict: "UNKNOWN", detail: `no_operation_for_tool:${input.legacyTool}`,
      };
      log(rec);
      return rec;
    }

    const req: ExecutionRequest = {
      operation: op,
      params: paramsForTool(input.legacyTool, input.legacyArgs ?? {}),
      context: input.context,
      mode: "advisory",
    };
    const { result, trace } = await executeCalendarOperation(req, { port: input.port, logger: () => {}, strategyId: "calendar.shadow" });

    const legacy = normalizeLegacy(input.legacyTool, input.legacyResult);
    const shadow = shadowDecision(result);
    const { verdict, detail } = classify(shadow, legacy, op);

    const rec: ShadowComparison = {
      correlation: input.correlation,
      plannerGoal: input.plannerGoal,
      selectedOperation: op,
      invariants: trace.invariants,
      satisfiedAlready: trace.invariants.filter((i) => i.outcome === "held").map((i) => i.id),
      satisfiedByRead: trace.invariants.filter((i) => i.outcome === "satisfied_by_read").map((i) => i.id),
      runtimeDecision: result.status,
      runtimeReason: (result as any).reason ?? (result as any).field,
      legacyDecision: legacy.kind === "NEEDS" ? `NEEDS:${legacy.field}` : legacy.kind === "NOOP_FAIL" ? `FAIL:${legacy.reason}` : legacy.kind,
      verdict,
      detail,
      trace,
    };
    log(rec);
    return rec;
  } catch (err: any) {
    const rec: ShadowComparison = {
      correlation: input.correlation,
      plannerGoal: input.plannerGoal, selectedOperation: op ?? input.legacyTool, invariants: [],
      satisfiedAlready: [], satisfiedByRead: [], runtimeDecision: "BLOCKED",
      legacyDecision: "n/a", verdict: "UNKNOWN", detail: `shadow_error:${String(err?.message || err)}`,
    };
    log(rec);
    return rec;
  }
}
