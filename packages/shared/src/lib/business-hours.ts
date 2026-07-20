/**
 * Tenant business hours - the single evaluator for "is the business open now,
 * and when does it open next?".
 *
 * The configuration is the admin-edited blob stored by services/auth at the
 * Redis key `tenant:{tenantId}:businessHours` (see BUSINESS_HOURS_KEY). This
 * module owns its SHAPE and its evaluation so every consumer - the settings
 * UI (via the auth routes), the incoming-worker's pre-model gate, and the AI
 * service's outside-hours prompt context - agrees on one meaning of "open".
 *
 * Timezone math uses only Intl (no dependencies): wall-clock parts in the
 * tenant's timezone come from Intl.DateTimeFormat, and instants are recovered
 * with the standard offset-probe (UTC time minus the same instant rendered in
 * the target zone). DST transitions are handled to minute precision, which is
 * ample for "we open tomorrow at 09:00".
 */

export type DayKey =
  | "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";

export const DAY_KEYS: DayKey[] = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];

export interface DaySchedule {
  enabled: boolean;
  /** "HH:MM" 24h, in the tenant's timezone. */
  open?: string;
  close?: string;
}

export interface BusinessHoursConfig {
  enabled: boolean;
  timezone: string;
  /** Auto-reply body for closed hours (used when the AI is silenced). */
  autoResponse?: string;
  /**
   * What the AI employee does outside opening hours:
   *  - "active" (default): keeps answering; human handoff copy must state the
   *    team is unavailable and when it returns.
   *  - "silent": does not answer; the closed-hours auto-response (or a
   *    generated default) is sent instead.
   */
  aiOutsideHours?: "active" | "silent";
  /** Optional owner-written line appended to handoffs while closed. */
  outsideHoursHandoffMessage?: string;
  schedule: Record<DayKey, DaySchedule>;
}

export const BUSINESS_HOURS_KEY = (tenantId: string) => `tenant:${tenantId}:businessHours`;

export function parseBusinessHours(raw: string | null | undefined): BusinessHoursConfig | null {
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as BusinessHoursConfig;
    if (!cfg || typeof cfg !== "object" || !cfg.schedule) return null;
    return cfg;
  } catch {
    return null;
  }
}

export interface BusinessOpenState {
  /** False when the tenant never configured/enabled business hours - callers
   *  must treat that as "always open" (no behavior change). */
  configured: boolean;
  open: boolean;
  /** The next instant the business opens (UTC Date), null when open now,
   *  when unconfigured, or when no enabled day exists in the coming week. */
  nextOpening: Date | null;
  timezone: string;
}

/** Wall-clock parts of `date` in `timeZone`. */
function zonedParts(date: Date, timeZone: string): { day: DayKey; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const day = String(parts.weekday || "").toLowerCase() as DayKey;
  // Intl renders midnight as "24" in some environments with hour12:false.
  const hour = Number(parts.hour) % 24;
  return { day, minutes: hour * 60 + Number(parts.minute) };
}

function hmToMinutes(hm: string | undefined, fallback: number): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hm || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

/** Offset (ms) of `timeZone` relative to UTC at `date` - the standard probe. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const inZone = new Date(date.toLocaleString("en-US", { timeZone }));
  const inUtc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  return inZone.getTime() - inUtc.getTime();
}

/** The UTC instant of "HH:MM, `daysAhead` days from now" in the tenant zone. */
function zonedFutureInstant(now: Date, timeZone: string, daysAhead: number, minutes: number): Date {
  // Anchor at the zone's wall-clock for that day, then convert back to UTC.
  const base = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const ymd = fmt.format(base); // YYYY-MM-DD in the tenant zone
  const naive = new Date(`${ymd}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00Z`);
  return new Date(naive.getTime() - tzOffsetMs(naive, timeZone));
}

/**
 * Evaluate "open now?" and the next opening instant.
 * Unconfigured/disabled config → { configured: false, open: true }.
 */
export function evaluateBusinessHours(
  cfg: BusinessHoursConfig | null | undefined,
  now: Date = new Date(),
): BusinessOpenState {
  const timezone = cfg?.timezone || "UTC";
  if (!cfg || !cfg.enabled || !cfg.schedule) {
    return { configured: false, open: true, nextOpening: null, timezone };
  }

  let parts: { day: DayKey; minutes: number };
  try {
    parts = zonedParts(now, timezone);
  } catch {
    // Bad timezone string must never take the bot down - treat as always open.
    return { configured: false, open: true, nextOpening: null, timezone };
  }

  const today = cfg.schedule[parts.day];
  const openNow = !!today?.enabled &&
    parts.minutes >= hmToMinutes(today.open, 0) &&
    parts.minutes < hmToMinutes(today.close, 24 * 60);
  if (openNow) return { configured: true, open: true, nextOpening: null, timezone };

  // Walk up to 8 days ahead (covers "later today" through a full week wrap).
  const todayIdx = DAY_KEYS.indexOf(parts.day);
  for (let d = 0; d <= 7; d++) {
    const key = DAY_KEYS[(todayIdx + d) % 7];
    const sched = cfg.schedule[key];
    if (!sched?.enabled) continue;
    const openMin = hmToMinutes(sched.open, 0);
    if (d === 0 && parts.minutes >= openMin) continue; // today's opening already passed
    return { configured: true, open: false, nextOpening: zonedFutureInstant(now, timezone, d, openMin), timezone };
  }
  return { configured: true, open: false, nextOpening: null, timezone };
}

/**
 * Human wording for the next opening - NEVER hardcode "tomorrow morning":
 * says "today at HH:MM", "tomorrow at HH:MM", or "on <weekday> at HH:MM"
 * relative to the tenant's timezone, in the conversation language.
 */
export function describeNextOpening(
  state: BusinessOpenState,
  locale: "en" | "he",
  now: Date = new Date(),
): string {
  const he = locale === "he";
  if (!state.nextOpening) return he ? "בשעות הפעילות הבאות" : "during our next business hours";
  const tz = state.timezone;
  const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat(he ? "he-IL" : "en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(state.nextOpening);
  const nowYmd = dayOf(now);
  const openYmd = dayOf(state.nextOpening);
  if (openYmd === nowYmd) return he ? `היום בשעה ${time}` : `today at ${time}`;
  const tomorrowYmd = dayOf(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  if (openYmd === tomorrowYmd) return he ? `מחר בשעה ${time}` : `tomorrow at ${time}`;
  const weekday = new Intl.DateTimeFormat(he ? "he-IL" : "en-US", { timeZone: tz, weekday: "long" }).format(state.nextOpening);
  return he ? `ביום ${weekday} בשעה ${time}` : `on ${weekday} at ${time}`;
}
