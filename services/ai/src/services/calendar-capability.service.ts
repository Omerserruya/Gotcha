/**
 * Calendar Capability — the SINGLE source of truth for an agent's booking state.
 *
 * Historically the runtime asked a boolean `hasConnectedCalendarFor()`, while
 * the UI exposed tenant-level calendar *tools* (create_event/check_availability)
 * as if enabling them made the agent bookable. They are unrelated: booking only
 * works through `schedule_meeting`, which needs a per-agent CONNECTED
 * CalendarAccount AND at least one active MeetingType. This module collapses
 * both signals into one explicit, three-valued capability so the AI never has
 * to infer it and the UI can warn accurately.
 *
 *   NO_CALENDAR                     → no usable connected calendar for this agent
 *   CALENDAR_CONNECTED              → calendar connected, but NOT bookable yet
 *                                     (no active meeting type configured)
 *   CALENDAR_CONNECTED_AND_BOOKABLE → connected + ≥1 active meeting type →
 *                                     `schedule_meeting` is surfaced
 *
 * Provider-agnostic by design: a connected account may be Google Calendar today
 * or Calendly tomorrow; the capability is the same. The concrete adapter is
 * resolved later in schedule-handler.service.ts.
 */

import { prisma } from "@chatcenter/shared";

export type CalendarCapability =
  | "NO_CALENDAR"
  | "CALENDAR_CONNECTED"
  | "CALENDAR_CONNECTED_AND_BOOKABLE";

export interface CalendarCapabilityDetail {
  capability: CalendarCapability;
  /** True iff `schedule_meeting` should be surfaced + the agent may commit to times. */
  bookable: boolean;
  /** Connected provider name(s) for display (e.g. ["GOOGLE_CALENDAR"]). */
  providers: string[];
  /** Count of active meeting types for the tenant. */
  activeMeetingTypes: number;
  /** Diagnostic for a BROKEN connection (token revoked etc.), for UX. */
  lastError?: string | null;
}

const NONE: CalendarCapabilityDetail = {
  capability: "NO_CALENDAR",
  bookable: false,
  providers: [],
  activeMeetingTypes: 0,
  lastError: null,
};

/**
 * Compute the calendar capability for one agent. Cheap (two indexed reads);
 * callers may still cache per turn. Never throws — on any DB error it degrades
 * to NO_CALENDAR so the bot fails safe (cannot book) rather than fabricating.
 */
export async function computeCalendarCapability(
  tenantId: string,
  aiAgentId: string | null | undefined,
): Promise<CalendarCapabilityDetail> {
  if (!aiAgentId) return NONE;
  try {
    const accounts: Array<{ provider: string; status: string; lastError: string | null }> =
      await (prisma as any).calendarAccount.findMany({
        where: { tenantId, aiAgentId },
        select: { provider: true, status: true, lastError: true },
      });

    const connected = accounts.filter((a) => a.status === "CONNECTED");
    if (connected.length === 0) {
      const broken = accounts.find((a) => a.status === "BROKEN");
      return { ...NONE, lastError: broken?.lastError ?? null };
    }

    const providers = connected.map((a) => a.provider);

    // Bookable requires an active meeting type — schedule_meeting rejects a
    // booking when no active meeting type exists for the tenant.
    const activeMeetingTypes: number = await (prisma as any).meetingType.count({
      where: { tenantId, isActive: true },
    });

    if (activeMeetingTypes === 0) {
      return { capability: "CALENDAR_CONNECTED", bookable: false, providers, activeMeetingTypes: 0, lastError: null };
    }

    return {
      capability: "CALENDAR_CONNECTED_AND_BOOKABLE",
      bookable: true,
      providers,
      activeMeetingTypes,
      lastError: null,
    };
  } catch (err: any) {
    console.warn("[calendar-capability] compute failed, defaulting NO_CALENDAR:", err?.message);
    return NONE;
  }
}
