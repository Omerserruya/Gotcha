/**
 * Business-hours evaluator (packages/shared/src/lib/business-hours.ts).
 *
 * The evaluator feeds three behaviors: the incoming-worker's outside-hours
 * gate ("silent" = auto-reply instead of AI), the closed-context passed to
 * the AI service ("active" policy), and the availability line appended to
 * every human handoff while closed. Wrong open/closed or a wrong "next
 * opening" wording lies to customers - hence exhaustive cases here.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateBusinessHours,
  describeNextOpening,
  parseBusinessHours,
  BUSINESS_HOURS_KEY,
  type BusinessHoursConfig,
} from "@chatcenter/shared";

// A UTC-timezone config so test instants are unambiguous.
const weekdays9to18 = (overrides: Partial<BusinessHoursConfig> = {}): BusinessHoursConfig => ({
  enabled: true,
  timezone: "UTC",
  schedule: {
    sunday: { enabled: false },
    monday: { enabled: true, open: "09:00", close: "18:00" },
    tuesday: { enabled: true, open: "09:00", close: "18:00" },
    wednesday: { enabled: true, open: "09:00", close: "18:00" },
    thursday: { enabled: true, open: "09:00", close: "18:00" },
    friday: { enabled: true, open: "09:00", close: "14:00" },
    saturday: { enabled: false },
  },
  ...overrides,
});

// 2026-07-20 is a Monday.
const MON_NOON = new Date("2026-07-20T12:00:00Z");
const MON_EARLY = new Date("2026-07-20T06:30:00Z");
const MON_NIGHT = new Date("2026-07-20T20:00:00Z");
const FRI_LATE = new Date("2026-07-24T15:00:00Z"); // Friday closes 14:00
const SAT_NOON = new Date("2026-07-25T12:00:00Z");

describe("evaluateBusinessHours", () => {
  it("unconfigured/disabled → treated as always open (no behavior change)", () => {
    expect(evaluateBusinessHours(null).open).toBe(true);
    expect(evaluateBusinessHours(null).configured).toBe(false);
    expect(evaluateBusinessHours(weekdays9to18({ enabled: false }), SAT_NOON)).toMatchObject({
      configured: false,
      open: true,
    });
  });

  it("open during scheduled hours", () => {
    const s = evaluateBusinessHours(weekdays9to18(), MON_NOON);
    expect(s).toMatchObject({ configured: true, open: true, nextOpening: null });
  });

  it("closed before opening → next opening is TODAY at open time", () => {
    const s = evaluateBusinessHours(weekdays9to18(), MON_EARLY);
    expect(s.open).toBe(false);
    expect(s.nextOpening?.toISOString()).toBe("2026-07-20T09:00:00.000Z");
    expect(describeNextOpening(s, "en", MON_EARLY)).toBe("today at 09:00");
  });

  it("closed after closing → next opening is TOMORROW", () => {
    const s = evaluateBusinessHours(weekdays9to18(), MON_NIGHT);
    expect(s.open).toBe(false);
    expect(s.nextOpening?.toISOString()).toBe("2026-07-21T09:00:00.000Z");
    expect(describeNextOpening(s, "en", MON_NIGHT)).toBe("tomorrow at 09:00");
  });

  it("weekend gap → next opening is a NAMED WEEKDAY, never 'tomorrow'", () => {
    const s = evaluateBusinessHours(weekdays9to18(), FRI_LATE);
    expect(s.open).toBe(false);
    // Friday 15:00 → closed (Friday closes 14:00); Sat+Sun disabled → Monday.
    expect(s.nextOpening?.toISOString()).toBe("2026-07-27T09:00:00.000Z");
    expect(describeNextOpening(s, "en", FRI_LATE)).toBe("on Monday at 09:00");
    expect(describeNextOpening(s, "he", FRI_LATE)).toContain("ביום");
  });

  it("fully disabled week → closed with no next opening, generic wording", () => {
    const cfg = weekdays9to18();
    for (const d of Object.keys(cfg.schedule)) (cfg.schedule as any)[d] = { enabled: false };
    const s = evaluateBusinessHours(cfg, MON_NOON);
    expect(s.open).toBe(false);
    expect(s.nextOpening).toBeNull();
    expect(describeNextOpening(s, "en", MON_NOON)).toBe("during our next business hours");
  });

  it("respects the tenant timezone (open in Jerusalem while UTC says otherwise)", () => {
    const cfg = weekdays9to18({ timezone: "Asia/Jerusalem" });
    // 06:30 UTC on Monday = 09:30 in Jerusalem (UTC+3 in July) → OPEN.
    expect(evaluateBusinessHours(cfg, MON_EARLY).open).toBe(true);
    // 16:00 UTC on Monday = 19:00 Jerusalem → CLOSED.
    const s = evaluateBusinessHours(cfg, new Date("2026-07-20T16:00:00Z"));
    expect(s.open).toBe(false);
    // Next opening: Tuesday 09:00 Jerusalem = 06:00 UTC.
    expect(s.nextOpening?.toISOString()).toBe("2026-07-21T06:00:00.000Z");
  });

  it("an invalid timezone fails open (never mutes the bot)", () => {
    const s = evaluateBusinessHours(weekdays9to18({ timezone: "Not/AZone" }), MON_NOON);
    expect(s).toMatchObject({ configured: false, open: true });
  });
});

describe("parseBusinessHours / key", () => {
  it("parses the stored blob and rejects garbage", () => {
    expect(parseBusinessHours(JSON.stringify(weekdays9to18()))?.timezone).toBe("UTC");
    expect(parseBusinessHours("not json")).toBeNull();
    expect(parseBusinessHours(null)).toBeNull();
    expect(parseBusinessHours(JSON.stringify({ enabled: true }))).toBeNull(); // no schedule
  });

  it("key shape matches the auth routes' storage key", () => {
    expect(BUSINESS_HOURS_KEY("t1")).toBe("tenant:t1:businessHours");
  });
});
