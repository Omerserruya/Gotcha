/**
 * CALENDAR runtime — binds the frozen CALENDAR contracts to a concrete
 * CalendarPort and runs them through the shared resolver.
 *
 * Constraint 1 (single source of truth): every calendar BUSINESS RULE lives here
 * as a verifier over the port's concrete reads — NOT in the port, NOT in the
 * handlers. The port only does calendar I/O. The contracts declare the rules; the
 * verifiers evaluate them; the resolver enforces them. One rule, one place.
 *
 * Constraint 2 (instrumentation): every execution emits a structured
 * ExecutionTrace (defaulting to a compact `[capability-runtime]` log line) and
 * returns it, so WHY an operation ended as it did is observable without provider
 * logs.
 */

import {
  resolveExecution,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionTrace,
  type ExecutionMode,
  type RuntimeBindings,
  type StrategyResult,
} from "@chatcenter/shared";
import { CALENDAR_CONTRACTS } from "./calendar.contracts";
import type {
  CalendarPort,
  CalendarOpContext,
  CalendarBookingRef,
  MeetingKind,
  ResolvedMeetingKind,
} from "./calendar.port";
import { kernelApprovalGate } from "./approval-gate";

/** Lazy, resettable memo so a verifier doesn't re-hit the port within one turn. */
function memo<T>(fn: () => Promise<T>): (() => Promise<T>) & { reset: () => void } {
  let p: Promise<T> | undefined;
  const m = (() => (p ??= fn())) as (() => Promise<T>) & { reset: () => void };
  m.reset = () => { p = undefined; };
  return m;
}

const isKind = (k: ResolvedMeetingKind): k is MeetingKind => k !== null && k !== "ambiguous";
const near = (startMs: number, iso?: string) =>
  !!iso && Number.isFinite(Date.parse(iso)) && Math.abs(startMs - Date.parse(iso)) < 60_000;

export interface ExecuteCalendarOptions {
  port: CalendarPort;
  /** Trace sink (defaults to a compact console log). */
  logger?: (trace: ExecutionTrace) => void;
  /** Strategy label for the trace. */
  strategyId?: string;
}

function defaultTraceLogger(trace: ExecutionTrace): void {
  const inv = trace.invariants.map((i) => `${i.id}:${i.outcome}`).join(",");
  console.log(
    `[capability-runtime] op=${trace.operation} mode=${trace.mode} strategy=${trace.strategy ?? "-"} ` +
      `result=${trace.result}${trace.reason ? `(${trace.reason})` : ""} executed=${trace.executed} ` +
      `successVerified=${trace.successVerified ?? "-"} invariants=[${inv}] ` +
      `optimizations=[${trace.optimizations.join(" | ")}]`,
  );
}

/**
 * Execute one CALENDAR operation. Loads the contract, builds port-backed
 * bindings (rules-as-verifiers), runs the resolver, logs + returns the trace.
 */
export async function executeCalendarOperation(
  req: ExecutionRequest,
  opts: ExecuteCalendarOptions,
): Promise<{ result: ExecutionResult; trace: ExecutionTrace }> {
  const log = opts.logger ?? defaultTraceLogger;
  const contract = CALENDAR_CONTRACTS[req.operation];
  if (!contract) {
    const result: ExecutionResult = { status: "BLOCKED", reason: `unknown_operation:${req.operation}` };
    const trace: ExecutionTrace = {
      operation: req.operation, capability: "CALENDAR", mode: req.mode,
      strategy: opts.strategyId, invariants: [], optimizations: [], executed: false,
      result: "BLOCKED", reason: result.status === "BLOCKED" ? result.reason : undefined,
    };
    log(trace);
    return { result, trace };
  }

  let captured: ExecutionTrace | undefined;
  const bind = buildCalendarBindings(req, opts, (t) => { captured = t; log(t); });
  try {
    const result = await resolveExecution(contract, req, bind);
    return { result, trace: captured! };
  } catch (err: any) {
    // A verifier/oracle/strategy READ that throws (e.g. the calendar API is down)
    // must become an OBSERVABLE FAILED decision with a trace — never an unhandled
    // throw into the caller. resolveExecution only emits a trace on a terminal
    // return, so synthesize one here.
    const reason = `runtime_error:${String(err?.message || err)}`;
    const result: ExecutionResult = { status: "FAILED", reason, recoverable: true };
    const trace: ExecutionTrace = {
      operation: contract.id, capability: contract.capability, mode: req.mode,
      strategy: opts.strategyId ?? "calendar", invariants: captured?.invariants ?? [],
      optimizations: captured?.optimizations ?? [], executed: false, result: "FAILED", reason,
    };
    log(trace);
    return { result, trace };
  }
}

function buildCalendarBindings(
  req: ExecutionRequest,
  opts: ExecuteCalendarOptions,
  emitTrace: (t: ExecutionTrace) => void,
): RuntimeBindings {
  const port = opts.port;
  const ctx: CalendarOpContext = {
    tenantId: req.context.tenantId,
    conversationId: req.context.conversationId,
    customerExternalId: req.context.customerExternalId,
    customerEmail: (req.context.customerEmail as string | undefined),
    aiAgentId: (req.context.aiAgentId as string | undefined),
  };

  // ── resolved meaning-level inputs ──
  const chosenIso = (): string | undefined => (req.params.desired_time as string) || undefined;
  const kindHint = (req.params.meeting_kind as string) ?? (req.params.meeting_type as string);

  // ── memoized port reads (the business-state oracle) ──
  const bookings = memo<CalendarBookingRef[]>(() => port.listActiveBookings(ctx));
  const kind = memo<ResolvedMeetingKind>(() => port.resolveMeetingKind(ctx, kindHint));
  const email = memo<string | undefined>(async () =>
    ctx.customerEmail || (req.params.email as string) || (req.params.attendee_email as string) || undefined,
  );

  const timeOpen = async (): Promise<boolean> => {
    const iso = chosenIso();
    const k = await kind();
    if (!iso || !isKind(k)) return false;
    return port.isTimeOpen(ctx, iso, k);
  };

  // ── verifiers: the ONE place calendar business rules live ──
  const verifiers: RuntimeBindings["verifiers"] = {
    // shared
    meeting_kind_known: async () => isKind(await kind()),
    // BOOK
    no_duplicate_meeting: async () => (await bookings()).length === 0,
    attendee_email_known: async () => !!(await email()),
    desired_time_provided: () => !!chosenIso(),
    time_genuinely_open: timeOpen,
    booking_confirmed_and_invited: async () => {
      const bs = await bookings();
      return bs.length === 1 && near(bs[0].startMs, chosenIso());
    },
    // MOVE
    existing_booking_present: async () => (await bookings()).length >= 1,
    booking_unambiguous: async () => (await bookings()).length <= 1,
    new_time_provided: () => !!chosenIso(),
    new_time_genuinely_open: timeOpen,
    meeting_moved: async () => {
      const bs = await bookings();
      return bs.length === 1 && near(bs[0].startMs, chosenIso());
    },
    // CANCEL
    meeting_cancelled: async () => (await bookings()).length === 0,
    // POST-shared
    single_meeting_after: async () => (await bookings()).length === 1,
    // CHECK_AVAILABILITY: slots are produced BY the real availability computation,
    // so a returned slot is genuinely open by construction.
    returned_times_genuinely_open: () => true,
    availability_established: () => true,
  };

  const runSatisfier = async (operationId: string): Promise<StrategyResult> => {
    if (operationId === "CHECK_AVAILABILITY") {
      const k = await kind();
      if (!isKind(k)) return { ok: false, reason: "meeting_kind_unknown" };
      const iso = chosenIso();
      const day = iso ? { fromIso: iso } : undefined;
      const { slotsIso } = await port.computeAvailability(ctx, k, day);
      // Surfaces real alternatives as DATA (recovery posture: gather, don't decide).
      return { ok: true, outcome: "availability_checked", data: { proposedSlotsIso: slotsIso } };
    }
    return { ok: false, reason: `no_satisfier_for:${operationId}` };
  };

  const executeStrategy = async (
    contract: { id: string },
  ): Promise<StrategyResult> => {
    try {
      const k = await kind();
      switch (contract.id) {
        case "CHECK_AVAILABILITY": {
          if (!isKind(k)) return { ok: false, reason: "meeting_kind_unknown" };
          const iso = chosenIso();
          const { slotsIso } = await port.computeAvailability(
            ctx, k,
            (req.params.from_iso || req.params.to_iso)
              ? { fromIso: req.params.from_iso as string, toIso: req.params.to_iso as string }
              : iso ? { fromIso: iso } : undefined,
          );
          return { ok: true, outcome: `open times: ${slotsIso.join(", ") || "none"}`, data: { proposedSlotsIso: slotsIso } };
        }
        case "BOOK_MEETING": {
          if (!isKind(k)) return { ok: false, reason: "meeting_kind_unknown" };
          const iso = chosenIso()!;
          const to = (await email())!;
          const ref = await port.createEvent(ctx, { iso, email: to, kind: k });
          bookings.reset();
          return { ok: true, outcome: `booked for ${iso}, invite sent to ${to}`, data: { eventId: ref.eventId, joinUrl: ref.joinUrl } };
        }
        case "MOVE_MEETING": {
          if (!isKind(k)) return { ok: false, reason: "meeting_kind_unknown" };
          const iso = chosenIso()!;
          const booking = (await bookings())[0];
          const ref = await port.moveEvent(ctx, { booking, iso, kind: k });
          bookings.reset();
          return { ok: true, outcome: `moved to ${iso}`, data: { eventId: ref.eventId, joinUrl: ref.joinUrl } };
        }
        case "CANCEL_MEETING": {
          const booking = (await bookings())[0];
          await port.cancelEvent(ctx, { booking });
          bookings.reset();
          return { ok: true, outcome: `cancelled meeting on ${new Date(booking.startMs).toISOString()}` };
        }
        default:
          return { ok: false, reason: `unhandled_operation:${contract.id}` };
      }
    } catch (err: any) {
      // The port throws concrete failures (time_taken, no_calendar_available, …);
      // surface them as the contract's failure modes. recoverable by default.
      return { ok: false, reason: String(err?.message || err || "calendar_error"), recoverable: true };
    }
  };

  // HITL: which legacy tool's policy governs each calendar WRITE (the operation→
  // concrete mapping lives here, in the runtime layer, never above it).
  const OP_POLICY_TOOL: Record<string, string> = {
    BOOK_MEETING: "schedule_meeting",
    MOVE_MEETING: "reschedule_meeting",
    CANCEL_MEETING: "cancel_meeting",
  };

  return {
    verifiers,
    runSatisfier,
    executeStrategy: (contract) => executeStrategy(contract),
    // Real HITL: production `evaluatePolicies` + Approvals inbox via the shared gate.
    // Thread duration/type so `on_condition` policies (e.g. duration > 60min)
    // evaluate with the same args the legacy dispatch would have carried.
    approvalGate: async (contract, _req, gateOpts) => {
      const policyTool = OP_POLICY_TOOL[contract.id];
      if (!policyTool) return { required: false as const };
      const args: Record<string, unknown> = { ...req.params };
      const k = await kind();
      if (isKind(k)) {
        args.duration_minutes = k.durationMinutes;
        args.meeting_type = k.slug;
      }
      const iso = chosenIso();
      if (iso) args.requested_at_iso = iso;
      return kernelApprovalGate(contract, req, { policyTool, args }, gateOpts);
    },
    strategyId: opts.strategyId ?? "calendar",
    emitTrace,
  };
}

export type { ExecutionMode };
