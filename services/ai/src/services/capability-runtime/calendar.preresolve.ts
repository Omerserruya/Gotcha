/**
 * Planner-owned calendar execution — the Runtime runs BEFORE the LLM.
 *
 * Pipeline: Message → Planner → Execution Intent → Capability Runtime →
 * Execution Result → Prompt Enrichment → LLM → Final Response.
 *
 * Once the planner's CurrentPlan says scheduling is the active goal, the runtime
 * invokes the calendar READ (CHECK_AVAILABILITY) itself — AUTONOMOUS or ADVISORY
 * per mode — and returns an authoritative facts block to inject into the prompt.
 * The LLM never decides whether to invoke this; it only phrases the result. This
 * is what makes "I'll check availability" structurally impossible: the real open
 * times are already in the prompt before the model generates a word.
 *
 * READ-only and identical in both modes (a read is safe to execute in ADVISORY),
 * so Employee and Copilot get the SAME facts from the SAME runtime call.
 */

import {
  type ExecutionMode,
  type ExecutionRequest,
  type ExecutionTrace,
} from "@chatcenter/shared";
import { executeCalendarOperation } from "./calendar.runtime";
import type { CalendarPort } from "./calendar.port";

export interface PreResolveInput {
  /** CurrentPlan.currentObjective. */
  objective: string | null;
  calendarBookable: boolean;
  /** When a meeting already exists, the move/cancel (write) path owns the turn. */
  hasActiveBooking: boolean;
  mode: ExecutionMode;
  context: ExecutionRequest["context"];
  port: CalendarPort;
  logger?: (t: ExecutionTrace) => void;
}

export interface PreResolveResult {
  /** Authoritative facts block to inject into the prompt (absent when N/A). */
  block?: string;
  trace?: ExecutionTrace;
}

/**
 * Run the planner's calendar READ ahead of the LLM. Fail-soft: any problem
 * returns no block (the turn proceeds; the model just lacks pre-fetched slots).
 */
export async function preResolveCalendarRead(input: PreResolveInput): Promise<PreResolveResult> {
  // Planner gate: only when booking a meeting is the active goal, the calendar is
  // bookable, and none is booked yet. (Reschedule/cancel are writes, owned by the
  // dispatch path, not pre-resolved here.)
  if (input.objective !== "BOOK_MEETING" || !input.calendarBookable || input.hasActiveBooking) {
    return {};
  }
  try {
    const { result, trace } = await executeCalendarOperation(
      { operation: "CHECK_AVAILABILITY", params: {}, context: input.context, mode: input.mode },
      { port: input.port, logger: input.logger, strategyId: input.mode === "advisory" ? "calendar.copilot" : "calendar.runtime" },
    );
    if (result.status !== "EXECUTED") return { trace };
    const slots = ((result.data?.proposedSlotsIso as string[]) ?? []).slice(0, 6);
    const block = slots.length
      ? "# Calendar availability — retrieved by the Capability Runtime (AUTHORITATIVE, already executed)\n" +
        `Real open times: ${slots.join(", ")}.\n` +
        "Offer the customer ONLY from these real times. These came from the live calendar — do NOT invent " +
        'others and NEVER say you will "check availability" or "get back to you": it is already done.'
      : "# Calendar availability — retrieved by the Capability Runtime\n" +
        "No open slots were found in the booking horizon. Be honest about that; do not invent times.";
    return { block, trace };
  } catch {
    return {};
  }
}
