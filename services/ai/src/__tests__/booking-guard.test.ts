import { describe, it, expect } from "vitest";
import {
  detectBookingClaim,
  detectBookingCommitment,
  detectAvailabilityAssertion,
  detectBookingAssertion,
  isBookingAssertionUngrounded,
} from "../services/booking-guard.service";

// Regression protection for the bookable-agent fabricated-booking guard.
//
// Context: the guard fires when a BOOKABLE agent's reply CLAIMS a booking is
// done but no schedule_meeting succeeded that turn. Hebrew detection was found
// silently broken because JS `\b` is ASCII-only and never matches at a
// Hebrew-letter boundary (`/\bקבעתי\b/.test("קבעתי לך") === false`). These
// tests pin the `\b`-free Hebrew patterns so we never regress on detection.

describe("detectBookingClaim — Hebrew completion claims (must MATCH)", () => {
  // Phrases the team actually observed (or explicitly requested coverage for).
  const positives = [
    "קבעתי לך פגישה למחר",            // "I booked you a meeting for tomorrow"
    "הפגישה סגורה",                    // "the meeting is locked"
    "קבענו ליום שני",                  // "we booked for Monday"
    "הכל סגור",                        // "all set"
    "הפגישה מחר ב-16:00 סגורה!",       // the real live fabrication that slipped past every gate
    "הכל סגור! קבענו שיחת הכרות מחר בשעה 15:00", // real-booking phrasing (Roni)
    // E2E amorphous run: model fabricated a booking while BOOK_MEETING was still
    // locked — these phrasings matched NO claim pattern and slipped to the customer.
    "הצלחתי לקבוע, הקישור לפגישה: https://gotcha.demo/meet/abc123",
    "שלחתי הזמנה ל‑20 דקות למחר ב‑16:30",
    "קבעתי לנו את הדמו למחר ב-16:30",
  ];
  for (const phrase of positives) {
    it(`matches: "${phrase}"`, () => {
      expect(detectBookingClaim(phrase).matched).toBe(true);
    });
  }
});

describe("detectBookingClaim — English completion claims (must MATCH)", () => {
  const positives = [
    "You're all set for tomorrow at 3pm!",
    "I've booked you in for tomorrow.",
    "Confirmed for Monday at 11.",
    "Booked!",
  ];
  for (const phrase of positives) {
    it(`matches: "${phrase}"`, () => {
      expect(detectBookingClaim(phrase).matched).toBe(true);
    });
  }
});

describe("detectBookingClaim — proposals / questions (must NOT match)", () => {
  // These are legitimate forward-moving replies, NOT false "it's booked" claims.
  // Firing the guard here would cause needless regenerations.
  const negatives = [
    "איזה יום מתאים לך?",              // "which day works for you?"
    "אפשר לקבוע שיחה?",               // "can we schedule a call?"
    "יש לי מקום פנוי מחר",            // "I have an opening tomorrow"
    "מעולה! איזה סוג מכירה אתה עוסק בה?", // discovery question
    "אני אעביר את הפרטים לצוות ונחזור אליך עם אישור", // honest deferral
    "What day works for you?",
    "I can offer tomorrow at 9, 10 or 11 — which suits you?",
  ];
  for (const phrase of negatives) {
    it(`does NOT match: "${phrase}"`, () => {
      expect(detectBookingClaim(phrase).matched).toBe(false);
    });
  }

  it("empty / null input does not match", () => {
    expect(detectBookingClaim("").matched).toBe(false);
    expect(detectBookingClaim(null).matched).toBe(false);
    expect(detectBookingClaim(undefined).matched).toBe(false);
  });
});

describe("detectBookingClaim — returns the matched phrase", () => {
  it("exposes the offending substring for audit/logging", () => {
    const res = detectBookingClaim("הפגישה מחר ב-16:00 סגורה!");
    expect(res.matched).toBe(true);
    expect(res.phrase && res.phrase.length).toBeGreaterThan(0);
  });
});

describe("detectBookingCommitment — Hebrew \\b regression", () => {
  // The broader commitment detector (used by the non-bookable booking-failsafe)
  // also had dead `\b` Hebrew patterns. Pin that it now detects a Hebrew
  // commitment so the failsafe actually engages.
  it("detects a Hebrew scheduling commitment (was dead under \\b)", () => {
    expect(detectBookingCommitment("קבעתי לך פגישה למחר").matched).toBe(true);
  });
  it("ignores a plain Hebrew question", () => {
    expect(detectBookingCommitment("איזה יום מתאים לך?").matched).toBe(false);
  });
});

// ── Booking-grounding gate detectors (the omer regression) ──────────────
// Live bug: a BOOKABLE agent invented Saturday availability, accepted a past
// time, and claimed a booking — all with ZERO schedule_meeting calls. The
// grounding gate fires on any of: claim / commitment / availability assertion.

describe("detectAvailabilityAssertion — invented availability (must MATCH)", () => {
  const positives = [
    "יש לי זמן פנוי ביום שבת לשיחה של 30 דקות. באיזה שעה נוח לך?", // omer: invented free Saturday
    "אני פנוי מחר בבוקר",
    "יש לי שעה פנויה ביום ראשון",
    "I have free time on Saturday",
    "I'm available tomorrow",
    "I have a slot at 10:00",
  ];
  for (const p of positives) {
    it(`matches: ${p.slice(0, 36)}`, () => {
      expect(detectAvailabilityAssertion(p).matched).toBe(true);
    });
  }
});

describe("detectAvailabilityAssertion — must NOT match neutral replies", () => {
  const negatives = [
    "איזה יום ושעה נוחים לך?",            // asking for preference — no asserted availability
    "What day and time works for you?",
    "תודה רבה, אעדכן אותך בהקדם",
  ];
  for (const n of negatives) {
    it(`ignores: ${n.slice(0, 36)}`, () => {
      expect(detectAvailabilityAssertion(n).matched).toBe(false);
    });
  }
});

describe("detectBookingAssertion — unified, returns the kind", () => {
  it("classifies a done-claim as 'claim'", () => {
    const r = detectBookingAssertion("היי עומר, קבעתי שיחה ל-14:00 היום, אבל אני צריך את האימייל שלך");
    expect(r.matched).toBe(true);
    expect(r.kind).toBe("claim");
  });
  it("classifies invented availability as 'availability'", () => {
    const r = detectBookingAssertion("יש לי זמן פנוי ביום שבת לשיחה של 30 דקות");
    expect(r.matched).toBe(true);
    expect(r.kind).toBe("availability");
  });
  it("classifies agreeing to a concrete time as 'commitment'", () => {
    const r = detectBookingAssertion("מעולה, נתראה ביום שני בשעה 10:00");
    expect(r.matched).toBe(true);
    expect(["commitment", "availability"]).toContain(r.kind);
  });
  it("does NOT fire on a neutral ask for preference (so a grounded flow isn't disturbed)", () => {
    expect(detectBookingAssertion("איזה יום ושעה נוחים לך? אבדוק זמינות ואחזור אליך").matched).toBe(false);
  });
});

describe("isBookingAssertionUngrounded — the gate decision (deterministic)", () => {
  const none = { committedBooking: false, proposedSlots: false };
  const proposed = { committedBooking: false, proposedSlots: true };
  const committed = { committedBooking: true, proposedSlots: false };

  it("omer bug 2: 'I booked 14:00' with NO committed event → ungrounded (gate fires)", () => {
    const a = detectBookingAssertion("היי עומר, קבעתי שיחה ל-14:00 היום");
    expect(isBookingAssertionUngrounded(a, none)).toBe(true);
    expect(isBookingAssertionUngrounded(a, proposed)).toBe(true); // a DONE claim needs a real event, not just proposed slots
    expect(isBookingAssertionUngrounded(a, committed)).toBe(false); // grounded by a real event
  });

  it("omer bug 1: invented Saturday availability with no schedule_meeting → ungrounded", () => {
    const a = detectBookingAssertion("יש לי זמן פנוי ביום שבת לשיחה של 30 דקות");
    expect(isBookingAssertionUngrounded(a, none)).toBe(true);
    expect(isBookingAssertionUngrounded(a, proposed)).toBe(false); // real proposed slots ground an availability statement
  });

  it("relaying REAL proposed slots is grounded (gate must NOT disturb it)", () => {
    const a = detectBookingAssertion("יש לי 09:00, 10:00, 11:00 פנויים מחר");
    expect(isBookingAssertionUngrounded(a, proposed)).toBe(false);
  });

  it("a confirmed booking reply is grounded", () => {
    const a = detectBookingAssertion("קבעתי לך שיחה מחר ב-10:00");
    expect(isBookingAssertionUngrounded(a, committed)).toBe(false);
  });

  it("a neutral reply is never ungrounded", () => {
    const a = detectBookingAssertion("איזה יום מתאים לך?");
    expect(isBookingAssertionUngrounded(a, none)).toBe(false);
  });
});
