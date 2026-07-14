/**
 * Copilot Tool-Surface Assembly - the single source of truth for the per-turn
 * TOOL SURFACE both Copilot entry points reason and act over. This is the surface
 * analog of `assemblePlanContext` (which owns the per-turn PLANNER inputs).
 *
 * The AI Employee (executes) and the AI Copilot (recommends) are ONE brain with
 * two execution modes. For the reasoning to be identical, the *surface* the model
 * sees - which capabilities exist, which tools are dispatchable, how the calendar
 * is gated - must be derived IDENTICALLY for both Copilot paths. Before this
 * module, `suggestResponse` built a full calendar-gated per-agent surface while
 * `chatWithAgent` built a generic built-in-only surface with NO calendar tools and
 * NO `check_availability` handler - so the CHAT Copilot could neither check real
 * availability nor recommend a real booking, and silently diverged from the
 * primary path. This builder removes that mirror: both callers now consume ONE
 * surface.
 *
 * What it owns (one place, no duplication):
 *   1. calendar capability + active booking - resolved via the SAME functions the
 *      Employee uses, so the Copilot's tool surface carries the SAME calendar tools.
 *   2. the surfaced tool set - the agent's allowed integration tools + the
 *      calendar built-ins, gated identically, under the advisory ("ASSIST") policy
 *      (never close / follow-up / escalate - those are the human agent's call).
 *   3. the `check_availability` READ handler - wired so the decision-gate can
 *      auto-run it (the Employee's same read path); ACTION calendar tools are
 *      surfaced for recommend-only and need no handler.
 *
 * The terminator (`submit_suggestions`, primary path only) and the free-text CHAT
 * surface differ ONLY in whether the caller prepends that terminator - every
 * dispatchable tool is identical. Fully fail-soft: a calendar / catalog hiccup
 * degrades to a smaller surface, never blocks the Copilot.
 */

import { buildAgentTools, buildAgentToolsForAIAgent } from "@chatcenter/shared";
import { computeCalendarCapability } from "./calendar-capability.service";
import { resolveActiveBooking, makeCheckAvailabilityHandler } from "./schedule-handler.service";
import type { CheckAvailabilityArgs, CheckAvailabilityResult } from "@chatcenter/shared";

export interface CopilotToolSurfaceInput {
  tenantId: string;
  conversationId: string;
  /** The AI agent whose allowed tools + calendar back this conversation. */
  aiAgentId: string | null | undefined;
  /** Resolved contact id → enables `link_customer_identifier`. */
  contactId?: string;
  /** Customer external id → active-booking lookup + check_availability scoping. */
  customerExternalId?: string | null;
}

export interface CopilotToolSurface {
  /**
   * The dispatchable agent tool surface (calendar-gated, advisory). Does NOT
   * include the `submit_suggestions` terminator - the primary path prepends it,
   * the CHAT path returns free text and omits it. Everything ELSE is identical.
   */
  tools: any[];
  /** Function names of `tools` (for the planner's capability surface). */
  toolFunctionNames: string[];
  /** Whether a meeting can actually be booked this conversation. */
  calendarBookable: boolean;
  /** Whether the customer has an ACTIVE booking right now (reschedule/cancel gate). */
  hasActiveBooking: boolean;
  /**
   * The `check_availability` READ handler, present only when the calendar is
   * bookable. Wire it into `AgentToolContext.checkAvailability` so the decision-
   * gate can auto-run availability checks (the SAME read path the Employee uses).
   */
  checkAvailabilityHandler?: (args: CheckAvailabilityArgs) => Promise<CheckAvailabilityResult>;
}

/**
 * Assemble the per-turn Copilot tool surface ONCE for BOTH entry points. Faithful
 * aggregation of the three derivations above - no business decisions, no mode
 * branching beyond the advisory gating that is common to all Copilot surfaces.
 */
export async function assembleCopilotToolSurface(
  input: CopilotToolSurfaceInput,
): Promise<CopilotToolSurface> {
  const { tenantId, conversationId, aiAgentId } = input;
  const extId = input.customerExternalId ?? undefined;

  // 1) Calendar capability + active booking - via the SAME functions the Employee
  //    uses, so the surface carries the SAME calendar tools, gated identically.
  let calendarBookable = false;
  let hasActiveBooking = false;
  try {
    if (tenantId && aiAgentId) {
      const cal = await computeCalendarCapability(tenantId, aiAgentId);
      calendarBookable = cal.bookable;
      if (cal.bookable) {
        hasActiveBooking = !!(await resolveActiveBooking({
          tenantId,
          conversationId,
          aiAgentId,
          customerExternalId: extId,
        }));
      }
    }
  } catch (err: any) {
    console.warn("[copilot-surface] calendar capability resolve failed (non-fatal):", err?.message);
  }

  // 2) The surfaced tool set. Advisory gating is common to EVERY Copilot surface:
  //    the human agent owns closure / follow-up / escalation, so the Copilot never
  //    surfaces those. Calendar tools are gated by real capability; schedule /
  //    reschedule / cancel are surfaced for recommend-only (the decision-gate makes
  //    them non-executing), check_availability is the auto-run READ.
  const surfaceOpts = {
    identityLinking: !!input.contactId,
    escalation: false,
    closure: false,
    followup: false,
    allowedMode: "ASSIST" as const,
    checkAvailability: calendarBookable,
    scheduleMeeting: calendarBookable,
    rescheduleMeeting: hasActiveBooking,
    cancelMeeting: hasActiveBooking,
  };

  let tools: any[] = [];
  try {
    // With an aiAgentId → the agent's ALLOWED integration tools + built-ins (the
    // same per-agent surface the Employee gets). Without one (stub / tests / dev)
    // → the generic built-in surface, still calendar-gated. Both go through the
    // identical advisory options, so neither path can drift.
    tools = aiAgentId
      ? await buildAgentToolsForAIAgent(tenantId, aiAgentId, surfaceOpts)
      : buildAgentTools(surfaceOpts);
  } catch (err: any) {
    console.warn("[copilot-surface] tool surface load failed (non-fatal):", err?.message);
    tools = buildAgentTools(surfaceOpts);
  }

  const toolFunctionNames: string[] = tools
    .map((t: any) => t?.function?.name)
    .filter((n: any): n is string => typeof n === "string");

  // 3) The check_availability READ handler - only when bookable AND we know the
  //    agent (the handler needs the agent's calendar + scheduling policy).
  const checkAvailabilityHandler =
    calendarBookable && tenantId && aiAgentId
      ? makeCheckAvailabilityHandler({
          tenantId,
          aiAgentId,
          conversationId,
          customerExternalId: extId,
        })
      : undefined;

  return { tools, toolFunctionNames, calendarBookable, hasActiveBooking, checkAvailabilityHandler };
}
