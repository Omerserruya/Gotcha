/**
 * Scheduling Constraints Layer (Task 3).
 *
 * Pure, deterministic availability resolver. Given:
 *   - tenant SchedulingPolicy (working hours, buffers, min notice, max horizon)
 *   - assigned agent(s) and their busy slots (fetched by adapter)
 *   - a meeting type (duration + optional stricter window)
 *   - either a customer-suggested time OR a request for proposed slots
 *
 * Returns a verdict the `schedule_meeting` tool dispatcher can act on:
 *   - VALID  → proceed to create the calendar event via adapter
 *   - INVALID → return reason + 2–3 alternatives
 *   - PROPOSE → no time was requested; return 2–3 valid slots
 *
 * NEVER hallucinates availability. The resolver only reports times that
 * pass every constraint, anchored to the agent's calendar busy list.
 *
 * Calendar adapters (Google / Calendly) implement `CalendarAdapter` and
 * own OAuth + concrete CRUD. The resolver does NOT touch the network.
 *
 * OAuth flow (high level):
 *   1. Operator clicks "Connect Calendar" in the dashboard.
 *   2. UI redirects to /integrations/google/connect (or /calendly/connect)
 *      → 302 to the provider authorize URL with state=tenantId.userId.nonce.
 *   3. Provider posts back to /integrations/<provider>/callback.
 *   4. Server exchanges code → access+refresh tokens, stores in
 *      IntegrationConnection (encrypted at rest), and creates one
 *      CalendarAccount row per primary calendar.
 *   5. From now on, dispatchToolCall("schedule_meeting") loads the
 *      CalendarAdapter for the assigned agent's CalendarAccount and calls
 *      `findBusy()` / `createEvent()`.
 *   6. A nightly job refreshes access tokens; on persistent failure the
 *      connection moves to status=BROKEN and the tool surface drops
 *      schedule_meeting until the operator reconnects.
 */

// ─── Schemas ────────────────────────────────────────────────

/** ISO weekday: 0=Sun, 1=Mon, ..., 6=Sat (matches JS Date.getDay()). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface DayWindow {
  weekday: Weekday;
  /** "HH:MM" 24h, in agent timezone. */
  start: string;
  /** "HH:MM" 24h, in agent timezone. End is exclusive. */
  end: string;
}

export interface SchedulingPolicy {
  /** IANA timezone of the agent / team owning these working hours. */
  agentTimezone: string;
  /** Working hours. Empty array on a weekday = closed that day. */
  workingHours: DayWindow[];
  /** Minutes of buffer required BEFORE every meeting. */
  bufferBeforeMinutes: number;
  /** Minutes of buffer required AFTER every meeting. */
  bufferAfterMinutes: number;
  /** Minimum notice in hours - cannot book sooner than this. */
  minNoticeHours: number;
  /** Maximum horizon in days - cannot book further than this. */
  maxHorizonDays: number;
  /** Slot grid resolution in minutes (e.g. 15 → :00, :15, :30, :45). */
  slotResolutionMinutes: number;
  /** Optional stricter window per meeting type id. Falls back to workingHours. */
  meetingTypeWindows?: Record<string, DayWindow[]>;
}

export interface MeetingType {
  id: string;
  durationMinutes: 15 | 30 | 45 | 60;
}

export interface BusyInterval {
  /** Unix ms. */
  startMs: number;
  /** Unix ms (exclusive). */
  endMs: number;
  /** Optional source label for audit. */
  source?: "google" | "calendly" | "manual";
}

export interface ResolveAvailabilityOpts {
  policy: SchedulingPolicy;
  meetingType: MeetingType;
  /** Busy intervals from the agent's calendar(s). */
  busy: BusyInterval[];
  /** "Now" - injected for determinism (tests). */
  nowMs: number;
  /** Customer-suggested time, ISO 8601. Omit to request proposed slots. */
  requestedAtIso?: string;
  /** Customer timezone (IANA). For invite display only - math is in UTC. */
  customerTimezone?: string;
  /** How many alternatives to propose when requested is invalid OR omitted. */
  proposeCount?: number;
  /**
   * Optional lower bound (Unix ms) for slot enumeration. Used by
   * check_availability to answer windowed questions ("what's free TOMORROW",
   * "anything SATURDAY", "next WEEK"). Clamped against now+minNotice - never
   * proposes a slot earlier than the policy allows. Ignored for a requested-time
   * point check. Omit for "soonest available".
   */
  windowStartMs?: number;
  /**
   * Optional upper bound (Unix ms) for slot enumeration. Clamped against
   * now+maxHorizon. When the window yields no valid slot (e.g. the customer
   * asked about a closed Saturday) the resolver returns an empty `proposed`;
   * check_availability layers a `nextAvailableIso` fallback on top.
   */
  windowEndMs?: number;
}

export type ResolveAvailabilityResult =
  | {
      verdict: "VALID";
      slot: { startMs: number; endMs: number };
    }
  | {
      verdict: "INVALID";
      reason: InvalidReason;
      proposed: Array<{ startMs: number; endMs: number }>;
    }
  | {
      verdict: "PROPOSE";
      proposed: Array<{ startMs: number; endMs: number }>;
    };

export type InvalidReason =
  | "outside_working_hours"
  | "outside_meeting_type_window"
  | "min_notice_violated"
  | "max_horizon_exceeded"
  | "agent_busy"
  | "buffer_violated"
  | "bad_iso_input";

// ─── Adapter contract (Google Calendar / Calendly) ──────────

export interface CalendarAdapter {
  /** Provider id for telemetry. */
  provider: "google" | "calendly";
  /** Read busy intervals for the assigned agent across [fromMs, toMs). */
  findBusy(opts: { agentId: string; fromMs: number; toMs: number }): Promise<BusyInterval[]>;
  /** Create a meeting once availability has been resolved as VALID. */
  createEvent(opts: {
    agentId: string;
    startMs: number;
    endMs: number;
    customerEmail: string;
    customerTimezone?: string;
    title: string;
    notes?: string;
    /** Extra attendee emails (the customer's teammates/manager). */
    additionalGuests?: string[];
  }): Promise<{ eventId: string; joinUrl?: string }>;
  /**
   * Move an existing event to a new time (keeps the same attendees + meet link).
   * Optional: providers that don't support direct edits (e.g. Calendly, whose
   * reschedule is the customer's own link flow) simply omit it.
   */
  updateEvent?(opts: {
    agentId: string;
    eventId: string;
    startMs: number;
    endMs: number;
    customerTimezone?: string;
  }): Promise<{ eventId: string; joinUrl?: string }>;
  /** Cancel an existing event. Optional for the same reason as updateEvent. */
  cancelEvent?(opts: { agentId: string; eventId: string }): Promise<void>;
  /**
   * List upcoming events in a window. Optional - used to find a customer's
   * existing meeting (by attendee email) when it was booked outside the current
   * conversation. Providers without it simply can't do cross-conversation lookup.
   */
  listEvents?(opts: { fromMs: number; toMs: number; max?: number }): Promise<
    Array<{ id: string; summary: string | null; start: string | null; end: string | null; attendees: string[] }>
  >;
}

// ─── Resolver (pure, deterministic) ─────────────────────────

const DEFAULT_PROPOSE_COUNT = 3;

/**
 * Strip an RFC-9557 IANA zone-name suffix (e.g. `2026-07-02T09:00:00+03:00[Asia/Jerusalem]`)
 * that `Date.parse` cannot handle. The numeric offset (`+03:00`) is preserved, so the
 * instant is unchanged - only the trailing `[…]` bracket is removed. LLM reasoners emit
 * this format; without normalization it was rejected as `bad_iso_input`.
 */
function normalizeRequestedIso(iso: string): string {
  return iso.replace(/\[[^\]]+\]\s*$/, "").trim();
}

// Failures where the requested time is a meaningful anchor (right ballpark, wrong
// exact slot) → propose the nearest free slots around it. The rest (past time,
// beyond horizon, unparseable) carry no usable anchor → earliest-first instead.
const NEAREST_ANCHOR_REASONS: Set<InvalidReason> = new Set([
  "outside_working_hours",
  "outside_meeting_type_window",
  "agent_busy",
  "buffer_violated",
]);

export function resolveAvailability(opts: ResolveAvailabilityOpts): ResolveAvailabilityResult {
  const proposeCount = opts.proposeCount ?? DEFAULT_PROPOSE_COUNT;

  // 1) If a specific time was requested, validate it.
  if (opts.requestedAtIso) {
    const t = Date.parse(normalizeRequestedIso(opts.requestedAtIso));
    if (Number.isNaN(t)) {
      return {
        verdict: "INVALID",
        reason: "bad_iso_input",
        proposed: enumerateValidSlots(opts, proposeCount),
      };
    }
    const reason = validateSlot(t, opts);
    if (!reason) {
      return {
        verdict: "VALID",
        slot: { startMs: t, endMs: t + opts.meetingType.durationMinutes * 60_000 },
      };
    }
    // For "ballpark" failures (the requested time is well-formed and in range but
    // just unavailable), propose the slots CLOSEST to what they asked for - e.g.
    // 14:00 / 15:00 around a taken 14:30 - not the day's first free slots. For
    // out-of-range failures (past, beyond horizon, unparseable) the requested
    // time is no anchor at all, so fall back to earliest-first.
    const proposed = NEAREST_ANCHOR_REASONS.has(reason)
      ? enumerateNearestSlots(opts, proposeCount, t)
      : enumerateValidSlots(opts, proposeCount);
    return { verdict: "INVALID", reason, proposed };
  }

  // 2) No request → propose slots.
  const proposed = enumerateValidSlots(opts, proposeCount);
  return { verdict: "PROPOSE", proposed };
}

// ─── Validation primitives ──────────────────────────────────

function validateSlot(startMs: number, opts: ResolveAvailabilityOpts): InvalidReason | null {
  const { policy, meetingType, busy, nowMs } = opts;
  const endMs = startMs + meetingType.durationMinutes * 60_000;

  // Min-notice / max-horizon are absolute time checks - not timezone-dependent.
  const minNoticeMs = policy.minNoticeHours * 3600_000;
  if (startMs < nowMs + minNoticeMs) return "min_notice_violated";
  const maxHorizonMs = policy.maxHorizonDays * 24 * 3600_000;
  if (startMs > nowMs + maxHorizonMs) return "max_horizon_exceeded";

  // Working hours / meeting-type windows operate in the agent timezone.
  const window = policy.meetingTypeWindows?.[meetingType.id] ?? policy.workingHours;
  if (!withinAnyWindow(startMs, endMs, window, policy.agentTimezone)) {
    return policy.meetingTypeWindows?.[meetingType.id] ? "outside_meeting_type_window" : "outside_working_hours";
  }

  // Buffer-aware busy check.
  const before = policy.bufferBeforeMinutes * 60_000;
  const after = policy.bufferAfterMinutes * 60_000;
  for (const b of busy) {
    const conflictStart = b.startMs - after;
    const conflictEnd = b.endMs + before;
    if (overlaps(startMs, endMs, conflictStart, conflictEnd)) {
      // Distinguish exact-overlap (busy) from buffer-only collision.
      if (overlaps(startMs, endMs, b.startMs, b.endMs)) return "agent_busy";
      return "buffer_violated";
    }
  }

  return null;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Walk the slot grid from now+minNotice forward up to maxHorizon, returning
 * the first N slots that pass `validateSlot`. Bounded to one slot per
 * (day × meeting-type duration × resolution) combination so we don't churn
 * for tens of thousands of grid points on long horizons.
 */
function enumerateValidSlots(opts: ResolveAvailabilityOpts, count: number): Array<{ startMs: number; endMs: number }> {
  const { policy, meetingType, nowMs } = opts;
  const stepMs = policy.slotResolutionMinutes * 60_000;
  const dur = meetingType.durationMinutes * 60_000;
  // Optional caller window ("tomorrow", "Saturday", "next week") clamps the
  // enumeration range but can NEVER widen it past the policy: the earliest is
  // always >= now+minNotice and the latest <= now+maxHorizon.
  const policyStartMs = nowMs + policy.minNoticeHours * 3600_000;
  const policyEndMs = nowMs + policy.maxHorizonDays * 24 * 3600_000;
  const startFromMs = Math.max(policyStartMs, opts.windowStartMs ?? policyStartMs);
  const endByMs = Math.min(policyEndMs, opts.windowEndMs ?? policyEndMs);

  // Round up to next grid step to keep slots tidy (e.g. :00, :15).
  let cursor = ceilToStep(startFromMs, stepMs);
  const out: Array<{ startMs: number; endMs: number }> = [];

  // Hard cap on iteration count - guards against pathological inputs.
  const HARD_CAP = 5000;
  let iterations = 0;
  while (cursor < endByMs && out.length < count && iterations < HARD_CAP) {
    iterations++;
    if (!validateSlot(cursor, opts)) {
      out.push({ startMs: cursor, endMs: cursor + dur });
      // Skip past the proposed slot + after-buffer to avoid stacking
      // adjacent proposals that visually look identical to the customer.
      cursor += dur + policy.bufferAfterMinutes * 60_000;
      cursor = ceilToStep(cursor, stepMs);
      continue;
    }
    cursor += stepMs;
  }
  return out;
}

/**
 * Return up to `count` valid slots CLOSEST to `anchorMs` (the time the customer
 * actually asked for), searching both later and earlier and ordered for a tidy
 * read-out. Used when a requested time is well-formed but unavailable, so we
 * offer "14:00 or 15:00" around a taken 14:30 instead of the day's first slots.
 * Every returned slot passes the same `validateSlot` gate as a direct booking.
 */
function enumerateNearestSlots(
  opts: ResolveAvailabilityOpts,
  count: number,
  anchorMs: number,
): Array<{ startMs: number; endMs: number }> {
  const { policy, meetingType, nowMs } = opts;
  const stepMs = policy.slotResolutionMinutes * 60_000;
  const dur = meetingType.durationMinutes * 60_000;
  const startFromMs = nowMs + policy.minNoticeHours * 3600_000;
  const endByMs = nowMs + policy.maxHorizonDays * 24 * 3600_000;

  const anchor = ceilToStep(anchorMs, stepMs);
  const found: Array<{ startMs: number; endMs: number }> = [];
  const seen = new Set<number>();

  const HARD_CAP = 5000;
  for (let k = 0; k <= HARD_CAP && found.length < count; k++) {
    // Probe later before earlier at the same distance: a customer who asked for
    // 14:30 usually means "around then or a bit after", so ties prefer the later slot.
    const candidates = k === 0 ? [anchor] : [anchor + k * stepMs, anchor - k * stepMs];
    for (const c of candidates) {
      if (found.length >= count) break;
      if (c < startFromMs || c >= endByMs || seen.has(c)) continue;
      seen.add(c);
      if (!validateSlot(c, opts)) found.push({ startMs: c, endMs: c + dur });
    }
    // Both directions have left the bookable window → nothing more to find.
    if (anchor + k * stepMs >= endByMs && anchor - k * stepMs < startFromMs) break;
  }

  // Present chronologically so the customer reads "14:00, 15:00", not "15:00, 14:00".
  found.sort((a, b) => a.startMs - b.startMs);
  return found;
}

function ceilToStep(t: number, stepMs: number): number {
  const r = t % stepMs;
  return r === 0 ? t : t + (stepMs - r);
}

// ─── Timezone-aware window check ────────────────────────────

/**
 * Returns true iff [startMs, endMs) sits entirely within at least one of the
 * `windows` in the given IANA timezone.
 *
 * We use Intl.DateTimeFormat with the target timezone to read off the
 * weekday + minute-of-day for the slot's start and end. This avoids a heavy
 * tz library and stays correct across DST boundaries (the formatter handles
 * the wall-clock conversion).
 */
function withinAnyWindow(startMs: number, endMs: number, windows: DayWindow[], timezone: string): boolean {
  if (!windows.length) return false;
  const startParts = wallClockParts(startMs, timezone);
  const endParts = wallClockParts(endMs - 1, timezone); // -1ms → inclusive end day

  // A meeting that crosses midnight is not allowed; require same-day in tz.
  if (startParts.weekday !== endParts.weekday) return false;

  for (const w of windows) {
    if (w.weekday !== startParts.weekday) continue;
    const winStart = parseHM(w.start);
    const winEnd = parseHM(w.end);
    if (startParts.minutesOfDay >= winStart && endParts.minutesOfDay + 1 <= winEnd) {
      return true;
    }
  }
  return false;
}

function parseHM(hm: string): number {
  const [h, m] = hm.split(":").map((s) => Number(s));
  return h * 60 + m;
}

interface WallClockParts {
  weekday: Weekday;
  minutesOfDay: number;
}

function wallClockParts(ms: number, timezone: string): WallClockParts {
  // Intl returns the formatted parts in the given timezone deterministically.
  // We use 'en-US' just to fix the locale - values are extracted by `type`.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  let weekday: Weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "weekday") weekday = WEEKDAY_MAP[p.value] ?? 0;
    else if (p.type === "hour") hour = Number(p.value === "24" ? "00" : p.value);
    else if (p.type === "minute") minute = Number(p.value);
  }
  return { weekday, minutesOfDay: hour * 60 + minute };
}

const WEEKDAY_MAP: Record<string, Weekday> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};
