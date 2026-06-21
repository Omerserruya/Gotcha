import { describe, it, expect } from "vitest";
import {
  detectBookingClaim,
  detectBookingCommitment,
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
