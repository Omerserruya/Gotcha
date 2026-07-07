/**
 * CALENDAR capability — the FIRST registered domain capability.
 *
 * It SELF-DESCRIBES its world (facts + summary + operations + observations) and
 * executes its own operations through the existing `executeCalendarOperation`
 * (frozen CALENDAR contracts + prod port + shared resolver) — no execution logic
 * duplicated. The kernel never knows calendar exists; it only carries this view.
 *
 * Tomorrow, CRM/Commerce/Knowledge register the same way; this is the template.
 */

import {
  type AvailableOperation,
  type CapabilityWorldView,
  type ExecutionRequest,
  type OperationContract,
} from "@chatcenter/shared";
import { CALENDAR_CONTRACTS } from "../capability-runtime/calendar.contracts";
import { executeCalendarOperation } from "../capability-runtime/calendar.runtime";
import { createProdCalendarPort } from "../capability-runtime/calendar.port.prod";
import type { CalendarOpContext } from "../capability-runtime/calendar.port";
import type { CapabilityContext, CapabilityRegistration } from "./registry";

const port = createProdCalendarPort();
const CONTRACTS: OperationContract[] = Object.values(CALENDAR_CONTRACTS);

function toAvailableOperation(c: OperationContract): AvailableOperation {
  return {
    name: c.id,
    meaning: c.meaning,
    params: c.params.map((p) => ({ name: p.key, meaning: p.meaning, required: !!p.required })),
    businessPreconditions: c.invariants
      .filter((i) => i.checkpoint === "PRE" && i.strength === "MUST")
      .map((i) => i.statement),
  };
}

function opContext(ctx: CapabilityContext): CalendarOpContext {
  return {
    tenantId: ctx.tenantId,
    conversationId: ctx.conversationId,
    aiAgentId: ctx.aiAgentId,
    customerExternalId: ctx.customerExternalId,
    customerEmail: ctx.customerEmail,
  };
}

export const CalendarCapability: CapabilityRegistration = {
  name: "CALENDAR",

  ownsOperation: (op) => op in CALENDAR_CONTRACTS,

  async describeWorld(ctx): Promise<CapabilityWorldView> {
    const c = opContext(ctx);
    // Meeting types configured ⇒ calendar is set up + bookable. Active bookings are
    // the mutated home the loop MUST re-read after BOOK/MOVE/CANCEL.
    const [bookings, kind, agentTimezone] = await Promise.all([
      port.listActiveBookings(c),
      port.resolveMeetingKind(c, undefined),
      port.agentTimezone ? port.agentTimezone(c) : Promise.resolve(null),
    ]);
    const connected = kind !== null; // null = no meeting types configured
    const first = bookings[0];
    const activeBooking = first ? { when: new Date(first.startMs).toISOString(), ref: first.eventId } : null;
    // The agent's timezone lets the Reasoner present slots in local time + map a
    // customer's local request to an instant, instead of asking which timezone.
    const tzNote = agentTimezone ? ` The agent's timezone is ${agentTimezone}; times are UTC ISO — interpret and present them in that timezone.` : "";

    return {
      capability: "CALENDAR",
      summary: !connected
        ? "No calendar is connected."
        : (activeBooking
          ? `A meeting is booked for ${activeBooking.when}.`
          : "Calendar is connected and bookable; no meeting booked yet.") + tzNote,
      facts: { calendarConnected: connected, bookable: connected, activeBooking, agentTimezone },
      // Operations are offered only when the calendar is genuinely usable.
      operations: connected ? CONTRACTS.map(toAvailableOperation) : [],
    };
  },

  async execute(req: ExecutionRequest) {
    return executeCalendarOperation(req, { port, strategyId: "calendar" });
  },

  // Calendar operations are external-facing writes (invites go out); keep the loop
  // slightly tighter than the platform default.
  loopPolicy: { maxIterations: 5 },
};
