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
  RescheduleMeetingArgs,
  RescheduleMeetingResult,
  CancelMeetingResult,
  CheckAvailabilityArgs,
  CheckAvailabilityResult,
} from "@chatcenter/shared";
import {
  resolveAvailability,
  type SchedulingPolicy,
  type MeetingType,
  type CalendarAdapter,
  type BusyInterval,
} from "./scheduling.service";
import { GoogleCalendarAdapter } from "./connectors/google-calendar.adapter";
import { CalendlyAdapter } from "./connectors/calendly.adapter";
import {
  recordBooking,
  markBookingCancelled,
  findActiveBookings,
  findBookingByEvent,
  type CalendarProviderName,
} from "./booking-store.service";

export interface ScheduleHandlerOpts {
  tenantId: string;
  /** AIAgent for whom we look up the connected calendar. */
  aiAgentId: string;
  /** Conversation the booking is made in (persisted with the booking). */
  conversationId: string;
  /**
   * Stable customer key (channel external id / phone). Lets bookings be keyed
   * to the customer so reschedule/cancel resolve the exact event across
   * conversations, and so a second schedule_meeting reschedules rather than
   * creating a duplicate.
   */
  customerExternalId?: string;
  /**
   * Customer's email, when known (from CRM/identity). Used as the Google invite
   * target and as a legacy fallback key (match against calendar attendees) for
   * meetings booked before the booking store existed.
   */
  customerEmail?: string;
}

// Reschedule/cancel share the same opts now that the base carries conversation
// + customer identity. Kept as an alias so existing call sites stay readable.
export type RescheduleHandlerOpts = ScheduleHandlerOpts;

/**
 * Map a meeting_type the model invented (from the customer's wording, e.g.
 * "demo", "intro call", "דמו") to the most appropriate CONFIGURED meeting type.
 * Returns null only when there's no reasonable match AND more than one type
 * exists (so the model is asked to pick explicitly).
 *
 * Strategy, most→least confident:
 *   1. exactly one configured type  → use it (it's the only thing bookable);
 *   2. case-insensitive exact slug/name match;
 *   3. substring overlap either direction (slug/name ⊂ requested or vice-versa);
 *   4. an intro/discovery/demo synonym in the request → a configured type whose
 *      slug/name reads as an intro/discovery/demo/consult call.
 */
export function snapMeetingType(
  requested: string | undefined,
  rows: Array<{ slug: string; name: string; durationMinutes: number }>,
): { slug: string; name: string; durationMinutes: number } | null {
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];
  const q = String(requested ?? "").toLowerCase().trim();
  if (!q) return null;
  const norm = (s: string) => s.toLowerCase().trim();

  let m = rows.find((r) => norm(r.slug) === q || norm(r.name) === q);
  if (m) return m;

  m = rows.find(
    (r) => q.includes(norm(r.slug)) || norm(r.slug).includes(q) || q.includes(norm(r.name)),
  );
  if (m) return m;

  const INTRO_REQUEST = /(demo|intro|discovery|kickoff|call|meeting|chat|consult|sync|דמו|היכרות|הכרות|שיחה|פגיש|ייעוץ)/i;
  const INTRO_TYPE = /(demo|intro|discovery|kickoff|call|consult|sync|דמו|היכרות|הכרות|שיחה|ייעוץ)/i;
  if (INTRO_REQUEST.test(q)) {
    m = rows.find((r) => INTRO_TYPE.test(`${r.slug} ${r.name}`));
    if (m) return m;
  }
  return null;
}

/**
 * Shared scheduling environment, loaded once and reused by BOTH the read
 * (check_availability) and write (schedule_meeting) paths - so availability math
 * lives in exactly ONE place (resolveAvailability) and the meeting-type/policy/
 * adapter plumbing is never duplicated. Loads + snaps the meeting type, resolves
 * the connected calendar, and builds the constraints policy + adapter.
 */
interface SchedulingEnv {
  mt: any;
  account: any;
  adapter: CalendarAdapter;
  policy: SchedulingPolicy;
  meetingType: MeetingType;
}

async function loadSchedulingEnv(
  opts: ScheduleHandlerOpts,
  meetingTypeArg: string | undefined,
): Promise<{ ok: true; env: SchedulingEnv } | { ok: false; reason: string }> {
  // 1) Load the meeting type, snapping the model's wording to a configured slug.
  // Guard the compound-key lookup: check_availability may omit meeting_type, and
  // Prisma THROWS on a findUnique with an undefined key field - so only do the
  // direct lookup when a slug was actually given; otherwise fall through to the
  // snap path (which picks the only type for single-type tenants).
  let mt = meetingTypeArg
    ? await (prisma as any).meetingType.findUnique({
        where: { tenantId_slug: { tenantId: opts.tenantId, slug: meetingTypeArg } } as any,
      })
    : null;
  if (!mt || !mt.isActive) {
    // The model often invents a slug from the customer's wording (observed live:
    // "demo" when the only configured type is `discovery_call`). Rather than
    // reject, SNAP to the most appropriate configured type.
    const validRows: Array<{ slug: string; name: string; durationMinutes: number }> =
      await (prisma as any).meetingType.findMany({
        where: { tenantId: opts.tenantId, isActive: true },
        select: { slug: true, name: true, durationMinutes: true },
      });
    const snapped = snapMeetingType(meetingTypeArg, validRows);
    if (snapped) {
      console.warn(
        `[schedule_handler] meeting_type "${meetingTypeArg}" not found → snapped to "${snapped.slug}" (${snapped.name})`,
      );
      mt = await (prisma as any).meetingType.findUnique({
        where: { tenantId_slug: { tenantId: opts.tenantId, slug: snapped.slug } } as any,
      });
    }
  }
  if (!mt || !mt.isActive) {
    const validRows: Array<{ slug: string; name: string; durationMinutes: number }> =
      await (prisma as any).meetingType.findMany({
        where: { tenantId: opts.tenantId, isActive: true },
        select: { slug: true, name: true, durationMinutes: true },
      });
    const validSlugs = validRows.map((r) => `${r.slug} (${r.name}, ${r.durationMinutes}min)`);
    console.warn(
      `[schedule_handler] unknown_meeting_type slug=${meetingTypeArg} valid=[${validSlugs.join(",")}]`,
    );
    return {
      ok: false,
      reason: `unknown_meeting_type:${meetingTypeArg ?? "none"}. Valid options: ${validSlugs.join(" | ") || "none configured"}.`,
    };
  }

  // 2) Resolve the connected calendar (Google preferred over Calendly).
  const account = await loadConnectedCalendarAccount(opts.tenantId, opts.aiAgentId);
  if (!account) {
    console.warn(`[schedule_handler] no_calendar_connected agent=${opts.aiAgentId}`);
    return { ok: false, reason: "no_calendar_connected" };
  }

  // 3) Build the constraints policy + meeting type + adapter from the DB row.
  const policy = policyFromMeetingType(mt);
  const meetingType: MeetingType = {
    id: mt.slug,
    durationMinutes: mt.durationMinutes as 15 | 30 | 45 | 60,
  };
  const adapter = buildAdapter(account);
  return { ok: true, env: { mt, account, adapter, policy, meetingType } };
}

/**
 * check_availability handler - READ-ONLY. The single source of truth for every
 * availability + working-hours question. Inspects the agent's REAL calendar and
 * scheduling policy via the shared `resolveAvailability` resolver and returns
 * structured info (working hours, real open slots, point-check verdict, nearest
 * fallback). NEVER creates an event.
 */
export function makeCheckAvailabilityHandler(opts: ScheduleHandlerOpts) {
  return async function checkAvailability(args: CheckAvailabilityArgs): Promise<CheckAvailabilityResult> {
    const t0 = Date.now();
    console.log(
      `[check_availability] tenant=${opts.tenantId} agent=${opts.aiAgentId} mt=${args.meeting_type || "-"} ` +
        `requested=${args.requested_at_iso || "-"} window=${args.from_iso || "-"}..${args.to_iso || "-"}`,
    );
    const loaded = await loadSchedulingEnv(opts, args.meeting_type);
    if (!loaded.ok) {
      console.warn(`[check_availability] load_failed reason=${loaded.reason}`);
      return { ok: false, reason: loaded.reason };
    }
    const { policy, meetingType, adapter } = loaded.env;
    const nowMs = Date.now();
    const fromMs = nowMs;
    const toMs = nowMs + policy.maxHorizonDays * 24 * 3600_000;
    let busy: BusyInterval[] = [];
    try {
      busy = await adapter.findBusy({ agentId: opts.aiAgentId, fromMs, toMs });
    } catch (err: any) {
      console.error(`[check_availability] freebusy.fail ${err?.message || "unknown"}`);
      return { ok: false, reason: `calendar_unavailable:${err?.message || "unknown"}` };
    }

    // The hours that actually apply to THIS meeting type (its own window if set,
    // else the tenant working hours) - returned structurally so the model can
    // answer "what are your hours?" / "do you work Saturday?" precisely.
    const windowSource = policy.meetingTypeWindows?.[meetingType.id] ?? policy.workingHours;
    const base = {
      ok: true as const,
      timezone: policy.agentTimezone,
      workingHours: windowSource.map((w) => ({ weekday: w.weekday, start: w.start, end: w.end })),
      minNoticeHours: policy.minNoticeHours,
      maxHorizonDays: policy.maxHorizonDays,
      durationMinutes: meetingType.durationMinutes,
      meetingTypeSlug: meetingType.id,
    };

    // Soonest open slot overall (ignoring any window) - fallback for a "closed
    // Saturday" style answer where the asked-about window has nothing.
    const soonest = resolveAvailability({ policy, meetingType, busy, nowMs, proposeCount: 1 });
    const soonestIso =
      soonest.verdict === "PROPOSE" && soonest.proposed[0]
        ? new Date(soonest.proposed[0].startMs).toISOString()
        : undefined;

    // ── Point check: "are you free tomorrow at 12:00?" ──
    if (args.requested_at_iso) {
      const verdict = resolveAvailability({
        policy,
        meetingType,
        busy,
        nowMs,
        requestedAtIso: args.requested_at_iso,
        customerTimezone: args.customer_timezone,
      });
      const available = verdict.verdict === "VALID";
      const proposedSlotsIso =
        verdict.verdict === "INVALID" ? verdict.proposed.map((s) => new Date(s.startMs).toISOString()) : [];
      console.log(
        `[check_availability] point requested=${args.requested_at_iso} available=${available} ` +
          `reason=${verdict.verdict === "INVALID" ? verdict.reason : "-"} dt_ms=${Date.now() - t0}`,
      );
      return {
        ...base,
        requestedIso: args.requested_at_iso,
        requestedAvailable: available,
        requestedReason: verdict.verdict === "INVALID" ? verdict.reason : undefined,
        proposedSlotsIso,
        nextAvailableIso: available ? undefined : soonestIso,
      };
    }

    // ── Window / general "what's free?" ──
    const wStart = args.from_iso ? Date.parse(args.from_iso) : NaN;
    const wEnd = args.to_iso ? Date.parse(args.to_iso) : NaN;
    const windowed = resolveAvailability({
      policy,
      meetingType,
      busy,
      nowMs,
      customerTimezone: args.customer_timezone,
      windowStartMs: Number.isFinite(wStart) ? wStart : undefined,
      windowEndMs: Number.isFinite(wEnd) ? wEnd : undefined,
    });
    const proposedSlotsIso =
      windowed.verdict === "PROPOSE" ? windowed.proposed.map((s) => new Date(s.startMs).toISOString()) : [];
    console.log(
      `[check_availability] window slots=${proposedSlotsIso.length} next=${soonestIso || "-"} dt_ms=${Date.now() - t0}`,
    );
    return {
      ...base,
      proposedSlotsIso,
      // When the asked-about window came back empty (e.g. a closed Saturday),
      // hand the model the soonest real slot so it can offer the nearest option.
      nextAvailableIso: proposedSlotsIso.length === 0 ? soonestIso : undefined,
    };
  };
}

/**
 * schedule_meeting handler - pure WRITE. Books an ALREADY-CHOSEN slot; it does
 * NOT search for times or decide availability (that is check_availability's job).
 * It still does a final point-validation of the chosen slot for write safety
 * (working hours / busy / min-notice + the create-time race re-check), but on any
 * unavailability it returns `needsAvailabilityCheck` and defers slot discovery to
 * check_availability instead of proposing alternatives itself.
 */
export function makeScheduleMeetingHandler(opts: ScheduleHandlerOpts) {
  return async function scheduleMeeting(args: ScheduleMeetingArgs): Promise<ScheduleMeetingResult> {
    const t0 = Date.now();
    console.log(
      `[schedule_handler] invoked tenant=${opts.tenantId} agent=${opts.aiAgentId} ` +
        `mt=${args.meeting_type} duration=${args.duration_minutes}min ` +
        `requested=${args.requested_at_iso || "none"} email=${args.customer_email || "-"}`,
    );

    // WRITE-ONLY precondition: a concrete chosen time is required. Without one
    // there's nothing to book - bounce the model to the read/discovery tool.
    if (!args.requested_at_iso) {
      console.warn(`[schedule_handler] no_time_selected → defer to check_availability`);
      return { ok: false, reason: "no_time_selected", needsAvailabilityCheck: true };
    }

    // 1) Load meeting-type policy + connected calendar + adapter (shared env).
    const loaded = await loadSchedulingEnv(opts, args.meeting_type);
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    const { mt, account, adapter, policy, meetingType } = loaded.env;
    // Duration is OWNED by the meeting type server-side; the model's
    // `duration_minutes` is advisory only. Log divergence, then use the
    // authoritative value (rejecting on mismatch used to block every booking).
    if (Number(mt.durationMinutes) !== Number(args.duration_minutes)) {
      console.warn(
        `[schedule_handler] duration override: model said ${args.duration_minutes}min, ` +
          `using meeting_type ${mt.durationMinutes}min (authoritative)`,
      );
    }
    console.log(
      `[schedule_handler] mt_loaded id=${mt.id} tz=${mt.agentTimezone} adapter=${account.provider}`,
    );

    // 2) DEDUPE: if this customer already has an ACTIVE booking, NEVER create a
    //    second event - MOVE the existing one to the chosen time instead. This
    //    enforces the one-active-meeting-per-customer invariant.
    const existing = await findActiveBookings({
      tenantId: opts.tenantId,
      aiAgentId: opts.aiAgentId,
      customerExternalId: opts.customerExternalId,
      conversationId: opts.conversationId,
    });
    if (existing.length >= 1) {
      const target = existing[0]; // soonest upcoming
      if (existing.length > 1) {
        console.warn(
          `[schedule_handler] dedupe: ${existing.length} active bookings for customer ` +
            `${opts.customerExternalId || "-"} - rescheduling the soonest (${target.eventId})`,
        );
      }
      console.log(
        `[schedule_handler] dedupe: existing booking eventId=${target.eventId} → rescheduling instead of creating`,
      );
      return performReschedule(opts, target, {
        requested_at_iso: args.requested_at_iso,
        customer_timezone: args.customer_timezone,
      });
    }

    // 3) Read busy slots in [now, now+horizon].
    const nowMs = Date.now();
    const fromMs = nowMs;
    const toMs = nowMs + policy.maxHorizonDays * 24 * 3600_000;
    let busy: Awaited<ReturnType<CalendarAdapter["findBusy"]>> = [];
    try {
      busy = await adapter.findBusy({ agentId: opts.aiAgentId, fromMs, toMs });
      console.log(`[schedule_handler] freebusy.ok busy_intervals=${busy.length}`);
    } catch (err: any) {
      console.error(`[schedule_handler] freebusy.fail ${err?.message || "unknown"}`);
      // Fail-closed: if we can't read availability, don't book.
      return { ok: false, reason: `calendar_unavailable:${err?.message || "unknown"}` };
    }

    // 4) Validate the EXACT chosen slot (a point check for write safety - NOT a
    //    search). If it isn't bookable we do NOT propose alternatives here; the
    //    model calls check_availability for that.
    const verdict = resolveAvailability({
      policy,
      meetingType,
      busy,
      nowMs,
      requestedAtIso: args.requested_at_iso,
      customerTimezone: args.customer_timezone,
    });
    if (verdict.verdict !== "VALID") {
      const reason = verdict.verdict === "INVALID" ? verdict.reason : "no_time_selected";
      console.log(
        `[schedule_handler] verdict=${verdict.verdict} reason=${reason} → defer to check_availability ` +
          `dt_ms=${Date.now() - t0}`,
      );
      return {
        ok: false,
        verdict: "INVALID",
        reason,
        needsAvailabilityCheck: true,
        requestedSlotIso: args.requested_at_iso,
      };
    }
    console.log(
      `[schedule_handler] verdict=VALID slot=${new Date(verdict.slot.startMs).toISOString()}`,
    );

    // 6) VALID → create the event. Customer email is required for Google
    //    invites; Calendly returns a scheduling link the customer follows.
    //    Fall back to the email we ALREADY hold for this customer (CRM/contact,
    //    resolved into opts.customerEmail) so a booking never fails just because
    //    the model forgot to echo an email it can see in the prompt.
    const inviteEmail = args.customer_email || opts.customerEmail || "";
    if (account.provider === "GOOGLE_CALENDAR" && !inviteEmail) {
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
        customerEmail: inviteEmail,
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
      await recordBooking({
        tenantId: opts.tenantId,
        aiAgentId: opts.aiAgentId,
        conversationId: opts.conversationId,
        provider: account.provider as CalendarProviderName,
        calendarAccountId: account.id,
        eventId: event.eventId,
        startMs: verdict.slot.startMs,
        endMs: verdict.slot.endMs,
        customerExternalId: opts.customerExternalId,
        customerEmail: args.customer_email || opts.customerEmail,
        meetingTypeSlug: mt.slug,
        customerTimezone: args.customer_timezone,
        joinUrl: event.joinUrl,
      });
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
        return failSlotTaken(verdict.slot, firstErr?.message);
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
        return failSlotTaken(verdict.slot, firstErr?.message);
      }

      // Re-validated - try once more.
      try {
        const event = await tryCreate(recheck.slot);
        await recordBooking({
          tenantId: opts.tenantId,
          aiAgentId: opts.aiAgentId,
          conversationId: opts.conversationId,
          provider: account.provider as CalendarProviderName,
          calendarAccountId: account.id,
          eventId: event.eventId,
          startMs: recheck.slot.startMs,
          endMs: recheck.slot.endMs,
          customerExternalId: opts.customerExternalId,
          customerEmail: args.customer_email || opts.customerEmail,
          meetingTypeSlug: mt.slug,
          customerTimezone: args.customer_timezone,
          joinUrl: event.joinUrl,
        });
        return {
          ok: true,
          verdict: "VALID",
          eventId: event.eventId,
          joinUrl: event.joinUrl,
          startMs: recheck.slot.startMs,
          endMs: recheck.slot.endMs,
        };
      } catch (secondErr: any) {
        return failSlotTaken(recheck.slot, secondErr?.message);
      }
    }
  };
}

// ─── Reschedule / cancel (booking-store lookup of the existing event) ────────

export interface ActiveBooking {
  eventId: string;
  startMs: number;
  endMs: number;
  meetingTypeSlug?: string;
  customerEmail?: string;
  customerExternalId?: string;
  customerTimezone?: string;
  provider?: CalendarProviderName;
}

function bookingFromStored(s: import("./booking-store.service").StoredBooking): ActiveBooking {
  return {
    eventId: s.eventId,
    startMs: s.startMs,
    endMs: s.endMs,
    meetingTypeSlug: s.meetingTypeSlug,
    customerEmail: s.customerEmail,
    customerExternalId: s.customerExternalId,
    customerTimezone: s.customerTimezone,
    provider: s.provider,
  };
}

/**
 * Recover the meeting currently booked in THIS conversation from the
 * `ai.bot_turn` audit trail. LEGACY fallback only: used to backfill the booking
 * store for meetings booked before it existed. Walks the audit chronologically:
 * a successful schedule_meeting/reschedule_meeting sets/updates the active
 * booking; a successful cancel_meeting clears it. Returns the final live
 * booking, or null. Fail-soft → null.
 */
export async function loadLastBooking(
  tenantId: string,
  conversationId: string,
): Promise<ActiveBooking | null> {
  try {
    const rows = await prisma.auditLog.findMany({
      where: { tenantId, targetId: conversationId, action: "ai.bot_turn" },
      select: { metadata: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    let active: ActiveBooking | null = null;
    // Carried across turns so a reschedule (which has no meeting_type/email args
    // of its own) inherits them from the original schedule_meeting call.
    let carrySlug: string | undefined;
    let carryEmail: string | undefined;
    let carryTz: string | undefined;
    // Oldest → newest so later turns win.
    for (const r of [...rows].reverse()) {
      const calls = (r.metadata as any)?.toolCalls;
      if (!Array.isArray(calls)) continue;
      for (const c of calls) {
        const tool = String(c?.tool ?? "");
        const decision = String(c?.decision ?? "");
        if (decision !== "executed" && decision !== "executed_on_retry") continue;
        let parsed: any = null;
        try {
          parsed = JSON.parse(String(c?.result ?? ""));
        } catch {
          parsed = null;
        }
        if (!parsed) continue;
        const args = (c?.args ?? {}) as Record<string, unknown>;
        if (tool === "schedule_meeting" || tool === "reschedule_meeting") {
          if (parsed.ok === true && parsed.verdict === "VALID" && parsed.eventId) {
            if (typeof args.meeting_type === "string") carrySlug = args.meeting_type;
            if (typeof args.customer_email === "string") carryEmail = args.customer_email;
            if (typeof args.customer_timezone === "string") carryTz = args.customer_timezone;
            active = {
              eventId: String(parsed.eventId),
              startMs: Number(parsed.startMs),
              endMs: Number(parsed.endMs),
              meetingTypeSlug: carrySlug,
              customerEmail: carryEmail,
              customerTimezone: carryTz,
            };
          }
        } else if (tool === "cancel_meeting") {
          if (parsed.ok === true) active = null;
        }
      }
    }
    return active;
  } catch (err: any) {
    console.warn("[schedule_handler] loadLastBooking failed (non-fatal):", err?.message);
    return null;
  }
}

async function loadConnectedCalendarAccount(tenantId: string, aiAgentId: string): Promise<any | null> {
  const accounts: any[] = await (prisma as any).calendarAccount.findMany({
    where: { tenantId, aiAgentId, status: "CONNECTED" },
    orderBy: { provider: "asc" },
  });
  return (
    accounts.find((a) => a.provider === "GOOGLE_CALENDAR") ||
    accounts.find((a) => a.provider === "CALENDLY") ||
    null
  );
}

/**
 * Find the customer's soonest UPCOMING meeting by matching their email against
 * calendar attendees - the fallback when the booking wasn't made in this
 * conversation (so the audit trail has nothing). Google-only (needs listEvents).
 */
async function findUpcomingEventForCustomer(
  tenantId: string,
  aiAgentId: string,
  customerEmail: string,
): Promise<ActiveBooking | null> {
  const account = await loadConnectedCalendarAccount(tenantId, aiAgentId);
  if (!account) return null;
  const adapter = buildAdapter(account);
  if (!adapter.listEvents) return null;
  const nowMs = Date.now();
  const toMs = nowMs + 60 * 24 * 3600_000; // look ~60 days ahead
  let events: Awaited<ReturnType<NonNullable<CalendarAdapter["listEvents"]>>> = [];
  try {
    events = await adapter.listEvents({ fromMs: nowMs, toMs, max: 50 });
  } catch (err: any) {
    console.warn("[schedule_handler] findUpcomingEventForCustomer listEvents failed:", err?.message);
    return null;
  }
  const wanted = customerEmail.trim().toLowerCase();
  const matches = events
    .filter((e) => e.start && Date.parse(e.start) > nowMs)
    .filter((e) => (e.attendees || []).some((a) => String(a).trim().toLowerCase() === wanted))
    .map((e) => ({ e, startMs: Date.parse(e.start as string) }))
    .filter((x) => Number.isFinite(x.startMs))
    .sort((a, b) => a.startMs - b.startMs);
  if (!matches.length) return null;
  const { e, startMs } = matches[0];
  const endMs = e.end ? Date.parse(e.end) : startMs + 30 * 60_000;
  console.log(`[schedule_handler] found cross-conversation booking by email eventId=${e.id}`);
  return {
    eventId: e.id,
    startMs,
    endMs: Number.isFinite(endMs) ? endMs : startMs + 30 * 60_000,
    customerEmail,
  };
}

export interface ResolveBookingOpts {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  customerExternalId?: string;
  customerEmail?: string;
}

/**
 * Resolve ALL of the customer's ACTIVE bookings (soonest-first) - the source of
 * truth shared by ai-bot (surfacing + prompt fact) and the handlers so they all
 * agree on which event(s) reschedule/cancel will touch.
 *
 * Order:
 *   1. The booking store (customer-keyed; survives across conversations).
 *   2. LEGACY fallback for meetings booked before the store existed - the audit
 *      trail, then a calendar-attendee match by email. When the fallback finds
 *      one, it's backfilled into the store so subsequent turns are table-driven
 *      and duplicate-proof.
 */
export async function resolveActiveBookings(opts: ResolveBookingOpts): Promise<ActiveBooking[]> {
  const stored = await findActiveBookings({
    tenantId: opts.tenantId,
    aiAgentId: opts.aiAgentId,
    customerExternalId: opts.customerExternalId,
    conversationId: opts.conversationId,
  });
  if (stored.length) return stored.map(bookingFromStored);

  // ── Legacy fallback (pre-store bookings) ──
  let legacy: ActiveBooking | null = await loadLastBooking(opts.tenantId, opts.conversationId);
  if (!legacy && opts.customerEmail) {
    legacy = await findUpcomingEventForCustomer(opts.tenantId, opts.aiAgentId, opts.customerEmail);
  }
  if (!legacy) return [];

  const account = await loadConnectedCalendarAccount(opts.tenantId, opts.aiAgentId);
  // CRITICAL: never resurrect an event the store already tracks. The legacy
  // audit/email scan can surface a stale ACTIVE-looking entry for an event that
  // was since CANCELLED (or COMPLETED) - if we backfilled it we'd flip it back
  // to ACTIVE. Once an event is in the store, the store is authoritative; the
  // fallback is ONLY for events the store has never seen.
  if (account) {
    const known = await findBookingByEvent(account.provider as CalendarProviderName, legacy.eventId);
    if (known) {
      console.log(
        `[schedule_handler] legacy fallback ignored: event ${legacy.eventId} already in store (status=${known.status})`,
      );
      return [];
    }
  }

  // Backfill so the next turn is table-driven.
  if (account) {
    await recordBooking({
      tenantId: opts.tenantId,
      aiAgentId: opts.aiAgentId,
      conversationId: opts.conversationId,
      provider: account.provider as CalendarProviderName,
      calendarAccountId: account.id,
      eventId: legacy.eventId,
      startMs: legacy.startMs,
      endMs: legacy.endMs,
      customerExternalId: opts.customerExternalId,
      customerEmail: legacy.customerEmail || opts.customerEmail,
      meetingTypeSlug: legacy.meetingTypeSlug,
      customerTimezone: legacy.customerTimezone,
    });
    legacy.provider = account.provider as CalendarProviderName;
  }
  return [legacy];
}

/**
 * Single soonest ACTIVE booking, for ai-bot's surfacing + prompt fact.
 */
export async function resolveActiveBooking(opts: ResolveBookingOpts): Promise<ActiveBooking | null> {
  const all = await resolveActiveBookings(opts);
  return all[0] ?? null;
}

async function loadMeetingTypeForPolicy(tenantId: string, slug?: string): Promise<any | null> {
  if (slug) {
    const mt = await (prisma as any).meetingType.findUnique({
      where: { tenantId_slug: { tenantId, slug } } as any,
    });
    if (mt && mt.isActive) return mt;
  }
  const rows: any[] = await (prisma as any).meetingType.findMany({
    where: { tenantId, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  return rows[0] ?? null;
}

function policyFromMeetingType(mt: any): SchedulingPolicy {
  return {
    agentTimezone: mt.agentTimezone,
    workingHours: (mt.workingHours as any[]) ?? [],
    bufferBeforeMinutes: mt.bufferBeforeMinutes,
    bufferAfterMinutes: mt.bufferAfterMinutes,
    minNoticeHours: mt.minNoticeHours,
    maxHorizonDays: mt.maxHorizonDays,
    slotResolutionMinutes: mt.slotResolutionMinutes,
    meetingTypeWindows: mt.meetingTypeWindows ? { [mt.slug]: mt.meetingTypeWindows } : undefined,
  };
}

/**
 * When the customer has more than one ACTIVE meeting we must NOT guess which one
 * to move/cancel. Build a reason carrying the candidate times so the model asks
 * the customer which meeting they mean.
 */
function ambiguousMeetingsReason(bookings: ActiveBooking[]): string {
  const list = bookings
    .map((b) => new Date(b.startMs).toISOString())
    .join(", ");
  return `multiple_active_meetings:${bookings.length}:[${list}]`;
}

/**
 * Shared reschedule core - MOVE a known booking to a new time. Validates the new
 * time like a fresh booking, PATCHes the calendar event in place (same Meet link
 * / attendees), then updates the booking store. NEVER creates a new event.
 * Used by both reschedule_meeting AND schedule_meeting's dedupe path.
 */
async function performReschedule(
  opts: ScheduleHandlerOpts,
  booking: ActiveBooking,
  args: RescheduleMeetingArgs,
): Promise<RescheduleMeetingResult> {
  const t0 = Date.now();
  if (!args.requested_at_iso) return { ok: false, reason: "missing_new_time" };
  const account = await loadConnectedCalendarAccount(opts.tenantId, opts.aiAgentId);
  if (!account) return { ok: false, reason: "no_calendar_connected" };
  const adapter = buildAdapter(account);
  if (!adapter.updateEvent) return { ok: false, reason: "reschedule_not_supported_for_provider" };
  const mt = await loadMeetingTypeForPolicy(opts.tenantId, booking.meetingTypeSlug);
  if (!mt) return { ok: false, reason: "no_meeting_type_configured" };

  const policy = policyFromMeetingType(mt);
  // Preserve the original meeting length when moving it.
  const durMin = Math.max(15, Math.round((booking.endMs - booking.startMs) / 60_000)) as 15 | 30 | 45 | 60;
  const meetingType: MeetingType = { id: mt.slug, durationMinutes: durMin };

  const nowMs = Date.now();
  const toMs = nowMs + policy.maxHorizonDays * 24 * 3600_000;
  let busy: BusyInterval[] = [];
  try {
    busy = await adapter.findBusy({ agentId: opts.aiAgentId, fromMs: nowMs, toMs });
  } catch (err: any) {
    return { ok: false, reason: `calendar_unavailable:${err?.message || "unknown"}` };
  }
  // Exclude the meeting being moved from its own busy list, or it conflicts with itself.
  busy = busy.filter((b) => !(b.startMs < booking.endMs && booking.startMs < b.endMs));

  const verdict = resolveAvailability({
    policy,
    meetingType,
    busy,
    nowMs,
    requestedAtIso: args.requested_at_iso,
    customerTimezone: args.customer_timezone || booking.customerTimezone,
  });
  // Pure-write move: if the chosen new time isn't bookable, defer slot discovery
  // to check_availability rather than proposing alternatives from the write path.
  if (verdict.verdict !== "VALID") {
    const reason = verdict.verdict === "INVALID" ? verdict.reason : "no_time_selected";
    return {
      ok: false,
      verdict: "INVALID",
      reason,
      needsAvailabilityCheck: true,
      requestedSlotIso: args.requested_at_iso,
    };
  }
  try {
    const ev = await adapter.updateEvent({
      agentId: opts.aiAgentId,
      eventId: booking.eventId,
      startMs: verdict.slot.startMs,
      endMs: verdict.slot.endMs,
      customerTimezone: args.customer_timezone || booking.customerTimezone,
    });
    console.log(
      `[schedule_handler] reschedule.OK eventId=${ev.eventId} ` +
        `new=${new Date(verdict.slot.startMs).toISOString()} dt_ms=${Date.now() - t0}`,
    );
    // Keep the store in sync: same eventId, new times (upsert updates in place).
    await recordBooking({
      tenantId: opts.tenantId,
      aiAgentId: opts.aiAgentId,
      conversationId: opts.conversationId,
      provider: account.provider as CalendarProviderName,
      calendarAccountId: account.id,
      eventId: ev.eventId,
      startMs: verdict.slot.startMs,
      endMs: verdict.slot.endMs,
      customerExternalId: opts.customerExternalId ?? booking.customerExternalId,
      customerEmail: opts.customerEmail ?? booking.customerEmail,
      meetingTypeSlug: booking.meetingTypeSlug ?? mt.slug,
      customerTimezone: args.customer_timezone || booking.customerTimezone,
      joinUrl: ev.joinUrl,
    });
    return {
      ok: true,
      verdict: "VALID",
      eventId: ev.eventId,
      joinUrl: ev.joinUrl,
      startMs: verdict.slot.startMs,
      endMs: verdict.slot.endMs,
    };
  } catch (err: any) {
    console.error(`[schedule_handler] reschedule.fail ${err?.message || "unknown"}`);
    return { ok: false, reason: `reschedule_failed:${err?.message || "unknown"}` };
  }
}

/**
 * reschedule_meeting handler - MOVE the customer's existing booking to a new
 * time. The eventId is resolved from the booking store (customer-keyed), so it
 * targets the EXACT event even across conversations. If the customer has more
 * than one active meeting, asks which instead of guessing. Never creates a new
 * event.
 */
export function makeRescheduleMeetingHandler(opts: RescheduleHandlerOpts) {
  return async function rescheduleMeeting(args: RescheduleMeetingArgs): Promise<RescheduleMeetingResult> {
    if (!args.requested_at_iso) return { ok: false, reason: "missing_new_time" };
    const bookings = await resolveActiveBookings({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      aiAgentId: opts.aiAgentId,
      customerExternalId: opts.customerExternalId,
      customerEmail: opts.customerEmail,
    });
    if (!bookings.length) {
      console.warn(`[schedule_handler] reschedule: no_existing_meeting conv=${opts.conversationId}`);
      return { ok: false, reason: "no_existing_meeting" };
    }
    if (bookings.length > 1) {
      console.warn(`[schedule_handler] reschedule: ${bookings.length} active meetings - asking which`);
      return { ok: false, reason: ambiguousMeetingsReason(bookings) };
    }
    return performReschedule(opts, bookings[0], args);
  };
}

/**
 * cancel_meeting handler - cancel the customer's existing booking. eventId
 * resolved from the booking store; guests are notified by the adapter
 * (sendUpdates=all). Asks which when more than one meeting exists.
 */
export function makeCancelMeetingHandler(opts: RescheduleHandlerOpts) {
  return async function cancelMeeting(): Promise<CancelMeetingResult> {
    const bookings = await resolveActiveBookings({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      aiAgentId: opts.aiAgentId,
      customerExternalId: opts.customerExternalId,
      customerEmail: opts.customerEmail,
    });
    if (!bookings.length) return { ok: false, reason: "no_existing_meeting" };
    if (bookings.length > 1) {
      console.warn(`[schedule_handler] cancel: ${bookings.length} active meetings - asking which`);
      return { ok: false, reason: ambiguousMeetingsReason(bookings) };
    }
    const booking = bookings[0];
    const account = await loadConnectedCalendarAccount(opts.tenantId, opts.aiAgentId);
    if (!account) return { ok: false, reason: "no_calendar_connected" };
    const adapter = buildAdapter(account);
    if (!adapter.cancelEvent) return { ok: false, reason: "cancel_not_supported_for_provider" };
    try {
      await adapter.cancelEvent({ agentId: opts.aiAgentId, eventId: booking.eventId });
      console.log(`[schedule_handler] cancel.OK eventId=${booking.eventId}`);
      await markBookingCancelled(
        (booking.provider ?? (account.provider as CalendarProviderName)),
        booking.eventId,
      );
      return { ok: true, cancelled: true, startMs: booking.startMs, endMs: booking.endMs };
    } catch (err: any) {
      console.error(`[schedule_handler] cancel.fail ${err?.message || "unknown"}`);
      return { ok: false, reason: `cancel_failed:${err?.message || "unknown"}` };
    }
  };
}

/**
 * Build the "slot was taken between validate and create" failure result. The
 * write path does NOT search for alternatives - it sets `needsAvailabilityCheck`
 * and defers slot discovery to check_availability. Carries pre-localized copy in
 * `userMessage` so the model can relay the exact wording verbatim.
 */
function failSlotTaken(
  slot: { startMs: number; endMs: number },
  diagnostic?: string,
): import("@chatcenter/shared").ScheduleMeetingResult {
  return {
    ok: false,
    verdict: "INVALID",
    reason: "slot_taken" + (diagnostic ? `:${diagnostic.slice(0, 120)}` : ""),
    needsAvailabilityCheck: true,
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
