/**
 * Production CalendarPort (Slice 3A) — the existing calendar handlers BECOME the
 * adapter. Each port method delegates to one concrete handler / store call and
 * maps its result to the abstract port shape. NO business rules live here (those
 * are the contracts + verifiers in calendar.runtime.ts) — this file only
 * translates between the abstract port and the concrete scheduling primitives.
 *
 * Slice 3A is wiring only: NOTHING calls this port yet (the live tool path is
 * unchanged). Shadow mode (3B) is the first place it runs, side-by-side with the
 * legacy path, comparing outcomes without affecting the customer.
 */

import { prisma } from "@chatcenter/shared";
import {
  makeCheckAvailabilityHandler,
  makeScheduleMeetingHandler,
  makeRescheduleMeetingHandler,
  makeCancelMeetingHandler,
  snapMeetingType,
  type ScheduleHandlerOpts,
} from "../schedule-handler.service";
import { findActiveBookings } from "../booking-store.service";
import type { CalendarPort, CalendarOpContext } from "./calendar.port";

function toHandlerOpts(ctx: CalendarOpContext, emailOverride?: string): ScheduleHandlerOpts {
  return {
    tenantId: ctx.tenantId,
    aiAgentId: ctx.aiAgentId ?? "",
    conversationId: ctx.conversationId,
    customerExternalId: ctx.customerExternalId,
    customerEmail: emailOverride ?? ctx.customerEmail,
  };
}

export function createProdCalendarPort(): CalendarPort {
  return {
    async listActiveBookings(ctx) {
      if (!ctx.aiAgentId) return [];
      const rows = await findActiveBookings({
        tenantId: ctx.tenantId,
        aiAgentId: ctx.aiAgentId,
        customerExternalId: ctx.customerExternalId,
        conversationId: ctx.conversationId,
      });
      return rows.map((b) => ({
        eventId: b.eventId,
        startMs: b.startMs,
        endMs: b.endMs,
        meetingKind: b.meetingTypeSlug,
        joinUrl: b.joinUrl,
      }));
    },

    async agentTimezone(ctx) {
      // The agent's timezone lives on its meeting types; take the first active one.
      const mt = await (prisma as any).meetingType.findFirst({
        where: { tenantId: ctx.tenantId, isActive: true },
        select: { agentTimezone: true },
        orderBy: { createdAt: "asc" },
      });
      return mt?.agentTimezone ?? null;
    },

    async resolveMeetingKind(ctx, hint) {
      const rows: Array<{ slug: string; name: string; durationMinutes: number }> =
        await (prisma as any).meetingType.findMany({
          where: { tenantId: ctx.tenantId, isActive: true },
          select: { slug: true, name: true, durationMinutes: true },
        });
      if (!rows.length) return null;
      const snapped = snapMeetingType(hint, rows);
      if (snapped) return { slug: snapped.slug, durationMinutes: snapped.durationMinutes };
      // More than one configured kind and the hint didn't snap to one.
      return "ambiguous";
    },

    async isTimeOpen(ctx, iso, kind) {
      const res = await makeCheckAvailabilityHandler(toHandlerOpts(ctx))({
        requested_at_iso: iso,
        meeting_type: kind.slug,
      });
      return res.ok === true && res.requestedAvailable === true;
    },

    async computeAvailability(ctx, kind, window) {
      const res = await makeCheckAvailabilityHandler(toHandlerOpts(ctx))({
        meeting_type: kind.slug,
        from_iso: window?.fromIso,
        to_iso: window?.toIso,
      });
      return { slotsIso: res.ok ? res.proposedSlotsIso ?? [] : [] };
    },

    async createEvent(ctx, { iso, email, kind }) {
      const res = await makeScheduleMeetingHandler(toHandlerOpts(ctx, email))({
        requested_at_iso: iso,
        duration_minutes: kind.durationMinutes,
        meeting_type: kind.slug,
        customer_email: email,
      });
      if (res.ok) {
        return { eventId: res.eventId, startMs: res.startMs, endMs: res.endMs, joinUrl: res.joinUrl, meetingKind: kind.slug };
      }
      // Concrete failure (needsAvailabilityCheck / no_calendar_connected / …) →
      // surfaced to the resolver as a strategy failure (a contract failure mode).
      throw new Error((res as { reason?: string }).reason || "schedule_failed");
    },

    async moveEvent(ctx, { iso, kind }) {
      const res = await makeRescheduleMeetingHandler(toHandlerOpts(ctx))({ requested_at_iso: iso });
      if (res.ok) {
        return { eventId: res.eventId, startMs: res.startMs, endMs: res.endMs, joinUrl: res.joinUrl, meetingKind: kind.slug };
      }
      throw new Error((res as { reason?: string }).reason || "reschedule_failed");
    },

    async cancelEvent(ctx) {
      const res = await makeCancelMeetingHandler(toHandlerOpts(ctx))();
      if (!res.ok) throw new Error(res.reason || "cancel_failed");
    },
  };
}
