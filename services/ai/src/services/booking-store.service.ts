/**
 * Booking store - the source of truth for calendar events the bot has booked,
 * keyed by the CUSTOMER (not the conversation).
 *
 * Why this exists: the previous reschedule/cancel path recovered the event to
 * act on by scanning the `ai.bot_turn` audit trail (and, as a fallback, by
 * matching the customer's email against calendar attendees). That worked until a
 * duplicate event existed - then the scan locked onto the wrong one, so the bot
 * "moved" a phantom meeting while the real one stayed put, and kept creating
 * fresh duplicates whenever it couldn't find the original.
 *
 * This table makes the booked event explicit and customer-keyed:
 *   - schedule_meeting records the ACTIVE booking here (and reschedules an
 *     existing ACTIVE booking instead of creating a second one);
 *   - reschedule/cancel resolve the EXACT eventId from here;
 *   - lookups by customerExternalId work across conversations.
 *
 * All writes are best-effort: a persistence failure must never break the actual
 * calendar operation, only the bookkeeping. Reads fail-soft to null/[].
 */

import { prisma } from "@chatcenter/shared";

export type CalendarProviderName = "GOOGLE_CALENDAR" | "CALENDLY";

export interface StoredBooking {
  id: string;
  eventId: string;
  startMs: number;
  endMs: number;
  meetingTypeSlug?: string;
  customerEmail?: string;
  customerExternalId?: string;
  customerTimezone?: string;
  joinUrl?: string;
  provider: CalendarProviderName;
  conversationId: string;
}

function rowToStored(r: any): StoredBooking {
  return {
    id: r.id,
    eventId: r.eventId,
    startMs: new Date(r.startAt).getTime(),
    endMs: new Date(r.endAt).getTime(),
    meetingTypeSlug: r.meetingTypeSlug ?? undefined,
    customerEmail: r.customerEmail ?? undefined,
    customerExternalId: r.customerExternalId ?? undefined,
    customerTimezone: r.customerTimezone ?? undefined,
    joinUrl: r.joinUrl ?? undefined,
    provider: r.provider,
    conversationId: r.conversationId,
  };
}

/**
 * Record (or update) an ACTIVE booking after a successful create/reschedule.
 * Idempotent on (provider, eventId): a reschedule of the same event updates the
 * stored times in place rather than inserting a duplicate row.
 */
export async function recordBooking(input: {
  tenantId: string;
  aiAgentId: string;
  conversationId: string;
  provider: CalendarProviderName;
  calendarAccountId: string;
  eventId: string;
  startMs: number;
  endMs: number;
  customerExternalId?: string;
  customerEmail?: string;
  meetingTypeSlug?: string;
  customerTimezone?: string;
  joinUrl?: string;
}): Promise<void> {
  try {
    const data = {
      tenantId: input.tenantId,
      aiAgentId: input.aiAgentId,
      conversationId: input.conversationId,
      provider: input.provider,
      calendarAccountId: input.calendarAccountId,
      eventId: input.eventId,
      startAt: new Date(input.startMs),
      endAt: new Date(input.endMs),
      customerExternalId: input.customerExternalId ?? null,
      customerEmail: input.customerEmail ?? null,
      meetingTypeSlug: input.meetingTypeSlug ?? null,
      customerTimezone: input.customerTimezone ?? null,
      joinUrl: input.joinUrl ?? null,
      status: "ACTIVE" as const,
    };
    await (prisma as any).meetingBooking.upsert({
      where: { provider_eventId: { provider: input.provider, eventId: input.eventId } },
      create: data,
      update: {
        startAt: data.startAt,
        endAt: data.endAt,
        customerExternalId: data.customerExternalId,
        customerEmail: data.customerEmail,
        meetingTypeSlug: data.meetingTypeSlug,
        customerTimezone: data.customerTimezone,
        joinUrl: data.joinUrl,
        status: "ACTIVE",
      },
    });
    console.log(
      `[booking-store] recorded ACTIVE eventId=${input.eventId} ` +
        `customer=${input.customerExternalId || input.customerEmail || "-"} ` +
        `start=${new Date(input.startMs).toISOString()}`,
    );
  } catch (err: any) {
    console.warn("[booking-store] recordBooking failed (non-fatal):", err?.message);
  }
}

/** Mark a booking CANCELLED by eventId after a successful calendar cancel. */
export async function markBookingCancelled(
  provider: CalendarProviderName,
  eventId: string,
): Promise<void> {
  try {
    await (prisma as any).meetingBooking.updateMany({
      where: { provider, eventId },
      data: { status: "CANCELLED" },
    });
    console.log(`[booking-store] marked CANCELLED eventId=${eventId}`);
  } catch (err: any) {
    console.warn("[booking-store] markBookingCancelled failed (non-fatal):", err?.message);
  }
}

/**
 * Look up a stored booking by its calendar event id, regardless of status.
 * Used to stop the legacy audit/email fallback from RESURRECTING an event the
 * store already tracks (e.g. one that was just cancelled): once an event is in
 * the store, the store - not the stale audit trail - is authoritative for it.
 */
export async function findBookingByEvent(
  provider: CalendarProviderName,
  eventId: string,
): Promise<{ status: string } | null> {
  try {
    const row: any = await (prisma as any).meetingBooking.findUnique({
      where: { provider_eventId: { provider, eventId } },
      select: { status: true },
    });
    return row ?? null;
  } catch (err: any) {
    console.warn("[booking-store] findBookingByEvent failed (non-fatal):", err?.message);
    return null;
  }
}

/**
 * Find the customer's ACTIVE bookings, soonest-first. Prefers the stable
 * customer key (customerExternalId); falls back to the conversation when no key
 * is known. Only future-or-current events are returned (past events are stale).
 */
export async function findActiveBookings(opts: {
  tenantId: string;
  aiAgentId: string;
  customerExternalId?: string;
  conversationId?: string;
  nowMs?: number;
}): Promise<StoredBooking[]> {
  try {
    const where: any = { tenantId: opts.tenantId, aiAgentId: opts.aiAgentId, status: "ACTIVE" };
    if (opts.customerExternalId) {
      where.customerExternalId = opts.customerExternalId;
    } else if (opts.conversationId) {
      where.conversationId = opts.conversationId;
    } else {
      return [];
    }
    const rows: any[] = await (prisma as any).meetingBooking.findMany({
      where,
      orderBy: { startAt: "asc" },
      take: 20,
    });
    const nowMs = opts.nowMs ?? Date.now();
    // Keep events that haven't ended yet (small grace so an in-progress meeting
    // is still reschedulable/cancellable).
    return rows.map(rowToStored).filter((b) => b.endMs > nowMs - 60 * 60_000);
  } catch (err: any) {
    console.warn("[booking-store] findActiveBookings failed (non-fatal):", err?.message);
    return [];
  }
}
