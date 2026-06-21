/**
 * schedule_meeting handler - wires the constraints layer + adapters to the
 * shared dispatcher (Task 3).
 *
 * Why this lives in ai-service (not shared): the adapters import Prisma
 * models from @chatcenter/shared and contain Google/Calendly REST logic.
 * Keeping the wiring in services/ai means shared stays decoupled and
 * doesn't grow a calendar dependency.
 *
 * Wiring contract:
 *   - ai-bot.service builds an `AgentToolContext` and assigns
 *     `ctx.scheduleMeeting = makeScheduleMeetingHandler({ tenantId, aiAgentId })`.
 *   - When the LLM emits `schedule_meeting(...)`, the shared dispatcher
 *     forwards it here, and the model gets a structured result back:
 *       VALID → meeting created, eventId/joinUrl returned
 *       INVALID → reason + 2–3 alternative ISO slots
 *       PROPOSE → 2–3 alternative ISO slots
 */

import { prisma } from "@chatcenter/shared";
import type {
  ScheduleMeetingArgs,
  ScheduleMeetingResult,
} from "@chatcenter/shared";
import {
  resolveAvailability,
  type SchedulingPolicy,
  type MeetingType,
  type CalendarAdapter,
} from "./scheduling.service";
import { GoogleCalendarAdapter } from "./connectors/google-calendar.adapter";
import { CalendlyAdapter } from "./connectors/calendly.adapter";

export interface ScheduleHandlerOpts {
  tenantId: string;
  /** AIAgent for whom we look up the connected calendar. */
  aiAgentId: string;
}

export function makeScheduleMeetingHandler(opts: ScheduleHandlerOpts) {
  return async function scheduleMeeting(args: ScheduleMeetingArgs): Promise<ScheduleMeetingResult> {
    const t0 = Date.now();
    console.log(
      `[schedule_handler] invoked tenant=${opts.tenantId} agent=${opts.aiAgentId} ` +
        `mt=${args.meeting_type} duration=${args.duration_minutes}min ` +
        `requested=${args.requested_at_iso || "none"} email=${args.customer_email || "-"}`,
    );

    // 1) Load the meeting type - drives policy + duration sanity check.
    const mt = await (prisma as any).meetingType.findUnique({
      where: { tenantId_slug: { tenantId: opts.tenantId, slug: args.meeting_type } } as any,
    });
    if (!mt || !mt.isActive) {
      // Hydrate the valid set so the model can recover instead of giving up.
      const validRows: Array<{ slug: string; name: string; durationMinutes: number }> =
        await (prisma as any).meetingType.findMany({
          where: { tenantId: opts.tenantId, isActive: true },
          select: { slug: true, name: true, durationMinutes: true },
        });
      const validSlugs = validRows.map((r) => `${r.slug} (${r.name}, ${r.durationMinutes}min)`);
      console.warn(
        `[schedule_handler] unknown_meeting_type slug=${args.meeting_type} valid=[${validSlugs.join(",")}]`,
      );
      return {
        ok: false,
        reason: `unknown_meeting_type:${args.meeting_type}. Valid options: ${validSlugs.join(" | ") || "none configured"}.`,
      };
    }
    // Duration is OWNED by the meeting type server-side (used as
    // mt.durationMinutes everywhere below); the model's `duration_minutes` arg
    // is advisory only and impossible for it to reliably guess. Rejecting the
    // whole booking when the model's guess differs blocked every booking where
    // it picked a different number (observed live: model sent 15 for a 30-min
    // discovery_call → duration_mismatch → no booking ever completed). Log the
    // divergence for observability, then proceed with the authoritative value.
    if (Number(mt.durationMinutes) !== Number(args.duration_minutes)) {
      console.warn(
        `[schedule_handler] duration override: model said ${args.duration_minutes}min, ` +
          `using meeting_type ${mt.durationMinutes}min (authoritative)`,
      );
    }
    console.log(
      `[schedule_handler] mt_loaded id=${mt.id} tz=${mt.agentTimezone} ` +
        `buf=${mt.bufferBeforeMinutes}/${mt.bufferAfterMinutes} ` +
        `notice=${mt.minNoticeHours}h horizon=${mt.maxHorizonDays}d`,
    );

    // 2) Find a connected calendar for this AI agent. Prefer Google when
    //    both providers are linked (Google supports direct booking;
    //    Calendly returns a link).
    const accounts: any[] = await (prisma as any).calendarAccount.findMany({
      where: { tenantId: opts.tenantId, aiAgentId: opts.aiAgentId, status: "CONNECTED" },
      orderBy: { provider: "asc" },
    });
    const account =
      accounts.find((a) => a.provider === "GOOGLE_CALENDAR") ||
      accounts.find((a) => a.provider === "CALENDLY");
    if (!account) {
      console.warn(`[schedule_handler] no_calendar_connected agent=${opts.aiAgentId}`);
      return { ok: false, reason: "no_calendar_connected" };
    }
    console.log(
      `[schedule_handler] adapter=${account.provider} account_id=${account.id} ` +
        `email=${account.accountEmail || "-"}`,
    );

    // 3) Build the constraints policy + meeting type from the DB row.
    const policy: SchedulingPolicy = {
      agentTimezone: mt.agentTimezone,
      workingHours: (mt.workingHours as any[]) ?? [],
      bufferBeforeMinutes: mt.bufferBeforeMinutes,
      bufferAfterMinutes: mt.bufferAfterMinutes,
      minNoticeHours: mt.minNoticeHours,
      maxHorizonDays: mt.maxHorizonDays,
      slotResolutionMinutes: mt.slotResolutionMinutes,
      meetingTypeWindows: mt.meetingTypeWindows ? { [mt.slug]: mt.meetingTypeWindows } : undefined,
    };
    const meetingType: MeetingType = {
      id: mt.slug,
      durationMinutes: mt.durationMinutes as 15 | 30 | 45 | 60,
    };

    // 4) Pick adapter + read busy slots in [now, now+horizon].
    const adapter = buildAdapter(account);
    const nowMs = Date.now();
    const fromMs = nowMs;
    const toMs = nowMs + policy.maxHorizonDays * 24 * 3600_000;
    let busy: Awaited<ReturnType<CalendarAdapter["findBusy"]>> = [];
    try {
      busy = await adapter.findBusy({ agentId: opts.aiAgentId, fromMs, toMs });
      console.log(
        `[schedule_handler] freebusy.ok busy_intervals=${busy.length} ` +
          `window=${new Date(fromMs).toISOString()}..${new Date(toMs).toISOString()}`,
      );
    } catch (err: any) {
      console.error(`[schedule_handler] freebusy.fail ${err?.message || "unknown"}`);
      // Fail-closed: if we can't read availability, don't propose times.
      return { ok: false, reason: `calendar_unavailable:${err?.message || "unknown"}` };
    }

    // 5) Validate / propose via the constraints layer.
    const verdict = resolveAvailability({
      policy,
      meetingType,
      busy,
      nowMs,
      requestedAtIso: args.requested_at_iso,
      customerTimezone: args.customer_timezone,
    });

    if (verdict.verdict === "PROPOSE") {
      console.log(
        `[schedule_handler] verdict=PROPOSE alternatives=${verdict.proposed.length} ` +
          `dt_ms=${Date.now() - t0}`,
      );
      return {
        ok: false,
        verdict: "PROPOSE",
        proposedSlotsIso: verdict.proposed.map((s) => new Date(s.startMs).toISOString()),
      };
    }
    if (verdict.verdict === "INVALID") {
      console.log(
        `[schedule_handler] verdict=INVALID reason=${verdict.reason} ` +
          `alternatives=${verdict.proposed.length} dt_ms=${Date.now() - t0}`,
      );
      return {
        ok: false,
        verdict: "INVALID",
        reason: verdict.reason,
        proposedSlotsIso: verdict.proposed.map((s) => new Date(s.startMs).toISOString()),
      };
    }
    console.log(
      `[schedule_handler] verdict=VALID slot=${new Date(verdict.slot.startMs).toISOString()}`,
    );

    // 6) VALID → create the event. Customer email is required for Google
    //    invites; Calendly returns a scheduling link the customer follows.
    if (account.provider === "GOOGLE_CALENDAR" && !args.customer_email) {
      return { ok: false, reason: "customer_email_required_for_google_invite" };
    }

    const autoGuests: string[] = Array.isArray(mt.autoGuests)
      ? (mt.autoGuests as unknown[]).filter((e): e is string => typeof e === "string" && e.length > 0)
      : [];
    const aiGuests: string[] = Array.isArray(args.additional_guests)
      ? args.additional_guests.filter((e): e is string => typeof e === "string" && e.length > 0)
      : [];
    const mergedGuests = [...autoGuests, ...aiGuests];
    if (autoGuests.length) {
      console.log(`[schedule_handler] auto_guests=[${autoGuests.join(",")}] merged with bot-collected=[${aiGuests.join(",")}]`);
    }

    const tryCreate = async (slot: { startMs: number; endMs: number }) => {
      return adapter.createEvent({
        agentId: opts.aiAgentId,
        startMs: slot.startMs,
        endMs: slot.endMs,
        customerEmail: args.customer_email || "",
        customerTimezone: args.customer_timezone,
        title: `${mt.name}`,
        notes: args.notes,
        additionalGuests: mergedGuests,
      });
    };

    // First attempt.
    try {
      const event = await tryCreate(verdict.slot);
      console.log(
        `[schedule_handler] result=VALID eventId=${event.eventId} ` +
          `joinUrl=${event.joinUrl ? "yes" : "no"} dt_ms=${Date.now() - t0}`,
      );
      return {
        ok: true,
        verdict: "VALID",
        eventId: event.eventId,
        joinUrl: event.joinUrl,
        startMs: verdict.slot.startMs,
        endMs: verdict.slot.endMs,
      };
    } catch (firstErr: any) {
      console.warn(
        `[schedule_handler] create.fail attempt=1 err=${firstErr?.message || "unknown"} - re-validating`,
      );
      // ── Race-condition path ──
      // The slot passed validation a moment ago, but createEvent failed.
      // The most likely cause is another booking landed in the same window
      // between findBusy() and createEvent(). Re-pull busy + re-validate
      // the SAME slot once. If it's still valid, retry create. Otherwise
      // (or if the retry create also fails) we MUST NOT confirm - return
      // INVALID with `slot_taken` + alternatives, and a ready-to-send
      // Hebrew/English message the model can relay verbatim.
      let freshBusy: typeof busy = busy;
      try {
        freshBusy = await adapter.findBusy({ agentId: opts.aiAgentId, fromMs, toMs });
      } catch {
        // If we can't even read availability now, fail closed.
        return failSlotTaken(verdict.slot, busy, policy, meetingType, nowMs, firstErr?.message);
      }
      const recheck = resolveAvailability({
        policy,
        meetingType,
        busy: freshBusy,
        nowMs: Date.now(),
        requestedAtIso: new Date(verdict.slot.startMs).toISOString(),
        customerTimezone: args.customer_timezone,
      });

      if (recheck.verdict !== "VALID") {
        return failSlotTaken(verdict.slot, freshBusy, policy, meetingType, Date.now(), firstErr?.message);
      }

      // Re-validated - try once more.
      try {
        const event = await tryCreate(recheck.slot);
        return {
          ok: true,
          verdict: "VALID",
          eventId: event.eventId,
          joinUrl: event.joinUrl,
          startMs: recheck.slot.startMs,
          endMs: recheck.slot.endMs,
        };
      } catch (secondErr: any) {
        return failSlotTaken(recheck.slot, freshBusy, policy, meetingType, Date.now(), secondErr?.message);
      }
    }
  };
}

/**
 * Build the "slot was taken between validate and create" failure result.
 * Returns 3 fresh alternatives so the model can offer them in the same turn.
 * Includes pre-localized customer-facing copy in `userMessage` so the model
 * can relay verbatim - the spec requires the exact Hebrew wording.
 */
function failSlotTaken(
  slot: { startMs: number; endMs: number },
  busy: Awaited<ReturnType<CalendarAdapter["findBusy"]>>,
  policy: SchedulingPolicy,
  meetingType: MeetingType,
  nowMs: number,
  diagnostic?: string,
): import("@chatcenter/shared").ScheduleMeetingResult {
  const alts = resolveAvailability({
    policy,
    meetingType,
    busy,
    nowMs,
    proposeCount: 3,
  });
  const proposedSlotsIso = alts.verdict === "PROPOSE" || alts.verdict === "INVALID"
    ? alts.proposed.map((s) => new Date(s.startMs).toISOString())
    : [];
  return {
    ok: false,
    verdict: "INVALID",
    reason: "slot_taken" + (diagnostic ? `:${diagnostic.slice(0, 120)}` : ""),
    proposedSlotsIso,
    // The model is instructed in the tool description to relay this string
    // when present. Hebrew + English so it matches the customer's language.
    userMessage: {
      he: "נראה שהזמן נתפס הרגע - בוא נבחר חלופה",
      en: "Looks like that slot was just booked - let's pick another time.",
    },
    requestedSlotIso: new Date(slot.startMs).toISOString(),
  };
}

function buildAdapter(account: any): CalendarAdapter {
  if (account.provider === "GOOGLE_CALENDAR") {
    return new GoogleCalendarAdapter({ calendarAccountId: account.id });
  }
  if (account.provider === "CALENDLY") {
    return new CalendlyAdapter({
      calendarAccountId: account.id,
      eventTypeUri: account.defaultCalendarId || undefined,
    });
  }
  throw new Error(`Unknown calendar provider: ${account.provider}`);
}
