/**
 * Booking fail-safe — runtime enforcement that an agent which CANNOT book a
 * meeting never commits to a date/time (or implies a booking is possible/done).
 *
 * The validated booking path is `schedule_meeting`, surfaced only when calendar
 * capability is CALENDAR_CONNECTED_AND_BOOKABLE. When it is NOT, prompt text
 * alone is insufficient (the model still free-texts "Saturday works") — so the
 * bot detects a booking commitment in the draft reply and regenerates ONCE with
 * a corrective, mirroring the passive-closer gate.
 *
 * Allowed when not bookable: collect availability/contact, create a lead,
 * escalate to a human, offer a follow-up. Forbidden: agreeing to a date/time,
 * implying a booking is possible, or implying one was made.
 */

/** Phrases where the assistant commits to / proposes a concrete meeting time or
 * day, or implies a booking happened. Heuristic but intentionally eager — it
 * only gates the NOT-bookable state, where committing to a time is always wrong,
 * so a rewrite-to-follow-up is a safe outcome even on a loose match. */
const BOOKING_COMMITMENT_PATTERNS: RegExp[] = [
  // English — agreeing to / proposing a time or day
  /\b(sounds good|great|perfect|works for me|that works|works for you)\b[^.!?\n]*\b(book|schedul|meet|call|slot|time|appointment)\b/i,
  /\b(i'?ll|i will|we'?ll|let'?s)\s+(book|schedule|set\s*up|arrange|lock\s*in|pencil\s+you\s+in|put\s+you\s+(down|in)|go\s+with|do)\b/i,
  /\b(see|meet|talk to)\s+you\s+(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next\s+week)\b/i,
  /\b(booked|scheduled|confirmed|locked\s+in|all\s+set)\b[^.!?\n]*\b(for|at|on)\b[^.!?\n]*(\d{1,2}(:\d{2})?\s*(am|pm)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)\b/i,
  /\b\d{1,2}(:\d{2})?\s*(am|pm)\b[^.!?\n]*\b(works|is\s+good|is\s+fine|confirmed|booked|see\s+you|let'?s)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.!?\n]*\b(works|is\s+good|is\s+fine|perfect|confirmed|see\s+you|let'?s\s+(meet|do|book))\b/i,
  // English — "all set" / "you're set" / "booked!" / "confirmed for"
  /\b(you'?re|you\s+are|we'?re|we\s+are)\s+all\s+set\b/i,
  /\b(booked|confirmed|locked\s+in|all\s+set)\s*!/i,
  /\b(confirmed|booked|scheduled)\s+(?:you\s+)?for\b/i,
  // Hebrew — IMPORTANT: JS `\b` is ASCII-only and never matches at a
  // Hebrew-letter boundary, so `\b`-wrapped Hebrew patterns silently NEVER
  // fire (verified: /\bקבעתי\b/.test("קבעתי לך") === false). All Hebrew
  // patterns here are therefore `\b`-free; they are specific multi-token
  // phrases so substring false-positives are negligible.
  /קבעתי/, // "I scheduled"
  /אקבע\s+(לך|לנו)?/, // "I'll schedule"
  /נקבע\s+ל/, // "let's set for"
  /נתראה\s+ביום/, // "see you on <day>"
  /נתראה\s+מחר/, // "see you tomorrow"
  /ביום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)[^.!?\n]*(מתאים|בסדר|מעולה|ניפגש|נקבע|נדבר)/,
  /(מצוין|מעולה|נהדר|סבבה|מתאים\s+לי)[^.!?\n]*(ניפגש|נקבע|בשעה\s+\d|נסגר|סגרנו)/,
  /בשעה\s+\d{1,2}[^.!?\n]*(ניפגש|נקבע|מתאים|בסדר|נתראה)/,
  // "the meeting is locked/closed/set" — the fabricated-booking phrasing that
  // slipped past every gate live: "הפגישה מחר ב-16:00 סגורה"
  /(הפגישה|השיחה|המפגש)[^.!?\n]*(סגור[הת]?|נסגר[ה]?|סגרנו|קבוע[ה]?|נקבע[הת]?|מאושר[ת]?|נתאמ[הת]?)/,
  /(סגרנו|סגור[הת]|נסגר[ה])[^.!?\n]*(פגישה|שיחה|מחר|בשעה|ביום)/,
  /קבענו[^.!?\n]*(פגישה|שיחה|מחר|בשעה|ביום|הכרות)/, // "we booked ... <meeting/day/time>"
  /הכל\s+סגור/, // "all set" (Hebrew)
];

// CLAIM patterns: the assistant asserts a booking is DONE (past/completed),
// as opposed to merely proposing a time. Used by the bookable-agent
// fabricated-booking guard so it fires ONLY on a false "it's booked" claim,
// never on a legitimate "let's schedule — what day?" proposal. `\b`-free for
// Hebrew (see note above).
const BOOKING_CLAIM_PATTERNS: RegExp[] = [
  // English — claims a booking already happened
  /\b(i'?ve|i\s+have|we'?ve|we\s+have)\s+(booked|scheduled|confirmed|set\s+up)\b/i,
  /\b(you'?re|we'?re|you\s+are|we\s+are)\s+all\s+set\b/i,
  /\b(booked|confirmed|all\s+set|locked\s+in)\s*!/i,
  /\b(booked|confirmed|scheduled|locked\s+in)\b[^.!?\n]*\b(for|at|on|tomorrow)\b/i,
  // Hebrew — claims DONE
  /(הפגישה|השיחה|המפגש)[^.!?\n]*(סגור[הת]?|נסגר[ה]?|סגרנו|קבוע[ה]?|נקבע[הת]?|מאושר[ת]?|נתאמ[הת]?)/,
  /(סגרנו|נסגר[ה])[^.!?\n]*(פגישה|שיחה|מחר|בשעה|ביום)/,
  /קבעתי[^.!?\n]*(פגישה|שיחה|מחר|בשעה|יום|הכרות|לך)/, // "יום" also covers ליום/ביום
  /קבענו[^.!?\n]*(פגישה|שיחה|מחר|בשעה|יום|הכרות)/, // "יום" also covers ליום/ביום
  /הכל\s+סגור/,
  // Hebrew — "I managed to schedule", "I scheduled the demo/meeting for ..."
  /הצלחתי\s+לקבוע/, // "I managed to schedule" (the live fabrication that slipped past)
  /קבעתי\s+(לנו\s+)?(את\s+)?(הדמו|הפגישה|הפגישה|השיחה|המפגש)/, // "I scheduled the demo/meeting"
  // Hebrew — "I sent (you) an invite / invitation"
  /(שלחתי|נשלח[ה]?|שולח[ת]?)\s+(לך\s+)?(הזמנה|זימון|הזמנת\s+יומן)/,
  // Hebrew — handing over a meeting/join link ("the link to the meeting is ...")
  /(הקישור|הלינק|קישור|לינק)\s+(ל?פגישה|ל?שיחה|ל?מפגש|להצטרפות|לזום|לדמו)/,
  // English — "I('ve) sent the invite", "here's the meeting link", "join link/url"
  /\b(i'?ve|i\s+have|we'?ve|we\s+have)\s+sent\b[^.!?\n]*\b(invite|invitation|calendar\s+invite)\b/i,
  /\b(here'?s|here\s+is)\b[^.!?\n]*\b(meeting\s+|join\s+|calendar\s+)?link\b/i,
  /\bjoin\s+(url|link)\b/i,
];

/** True when the reply CLAIMS a booking is already done (completed), not merely
 * proposing a time. Drives the bookable-agent fabricated-booking guard. */
export function detectBookingClaim(
  reply: string | null | undefined,
): BookingCommitmentMatch {
  if (!reply || !reply.trim()) return { matched: false };
  for (const re of BOOKING_CLAIM_PATTERNS) {
    const m = reply.match(re);
    if (m) return { matched: true, phrase: m[0].trim() };
  }
  return { matched: false };
}

// AVAILABILITY-assertion patterns: the assistant states (positively) that a
// time/day is FREE/AVAILABLE, or offers a concrete slot. A bookable agent must
// never invent this — availability is only known via a schedule_meeting call.
// Observed live (omer): "יש לי זמן פנוי ביום שבת" with zero schedule_meeting
// calls, then flip-flopping. `\b`-free for Hebrew (see note above).
const AVAILABILITY_ASSERTION_PATTERNS: RegExp[] = [
  // English — "I have free/available/a slot/an opening"
  /\b(i|we)\s+(have|have\s+got|'?ve\s+got|got)\b[^.!?\n]*\b(free|available|availabilit\w*|open\b|a\s+slot|an?\s+opening|time\s+(slot|available))\b/i,
  /\b(i'?m|we'?re|i\s+am|we\s+are)\s+(free|available|open)\b/i,
  /\b(free|available|open)\b[^.!?\n]{0,30}\b(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)\b/i,
  /\bi\s+(have|can\s+offer|can\s+do|could\s+do)\b[^.!?\n]{0,20}\b\d{1,2}(:\d{2})?\s*(am|pm)?\b/i,
  // Hebrew — "I have free/available time", "I'm free on <day/time>"
  /יש\s+לי\s+(זמן\s+)?(פנוי|זמין)/,
  /אני\s+(פנוי|זמין)/,
  /(פנוי|זמין)\s+(ביום|בשעה|מחר|היום|ב-?\d)/,
  /יש\s+לי\s+(שעה|שעות|זמן|חלון)\s+(פנוי|פנויה|פנויות|זמין)/,
  /(זמינות|פנוי(ות)?)\s+(ביום|מחר|היום|הקרוב|בשעה)/,
];

/** True when the reply ASSERTS availability (states a free time/day or offers a
 * concrete slot). Combined with claim/commitment to drive the booking-grounding
 * gate — a bookable agent may only state availability that came from a
 * schedule_meeting result this turn. */
export function detectAvailabilityAssertion(
  reply: string | null | undefined,
): BookingCommitmentMatch {
  if (!reply || !reply.trim()) return { matched: false };
  for (const re of AVAILABILITY_ASSERTION_PATTERNS) {
    const m = reply.match(re);
    if (m) return { matched: true, phrase: m[0].trim() };
  }
  return { matched: false };
}

export type BookingAssertionKind = "claim" | "commitment" | "availability";
export interface BookingAssertionMatch {
  matched: boolean;
  kind?: BookingAssertionKind;
  phrase?: string;
}

/**
 * Any statement that must be grounded in a schedule_meeting call: a booking
 * CLAIM (asserts done), a COMMITMENT (agrees to / proposes a concrete time), or
 * an AVAILABILITY assertion (states a free slot). Returned `kind` lets the
 * caller require the right grounding: a "claim" needs a committed event; a
 * "commitment"/"availability" is satisfied by real proposed slots too.
 */
export function detectBookingAssertion(
  reply: string | null | undefined,
): BookingAssertionMatch {
  const claim = detectBookingClaim(reply);
  if (claim.matched) return { matched: true, kind: "claim", phrase: claim.phrase };
  const commit = detectBookingCommitment(reply);
  if (commit.matched) return { matched: true, kind: "commitment", phrase: commit.phrase };
  const avail = detectAvailabilityAssertion(reply);
  if (avail.matched) return { matched: true, kind: "availability", phrase: avail.phrase };
  return { matched: false };
}

/**
 * Decision for the booking-grounding gate: is this asserted reply UNGROUNDED
 * given what `schedule_meeting` produced this turn? Pure so it can be unit-tested
 * deterministically (the live LLM can't be forced to fabricate on demand).
 *   - a "done" claim is grounded ONLY by a committed booking (a real event);
 *   - proposing a time / stating availability is ALSO grounded by real proposed
 *     slots a schedule_meeting result returned this turn.
 */
export function isBookingAssertionUngrounded(
  assertion: BookingAssertionMatch,
  ctx: { committedBooking: boolean; proposedSlots: boolean },
): boolean {
  if (!assertion.matched) return false;
  if (assertion.kind === "claim") return !ctx.committedBooking;
  return !(ctx.committedBooking || ctx.proposedSlots);
}

export interface BookingCommitmentMatch {
  matched: boolean;
  phrase?: string;
}

// ─── Redundant contact-request guard ─────────────────────────────────────
// The model often robotically asks for an email/phone the customer JUST gave
// (real GOTCHA regression: customer sends "omer@example.com, free Tuesday" and
// the bot replies "what's your email so I can pass it on?"). Prompt rules don't
// reliably stop it; this detects it for a single corrective regen.

const CUSTOMER_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// 7+ digits total → a phone, not an order id / quantity / price.
const CUSTOMER_PHONE_RE = /\+?\d(?:[\d\s-]{5,})\d/;
// Customer stated a day / time / availability.
const CUSTOMER_TIME_RE = /(יום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|מחר|מחרתיים|אחרי\s*הצהריים|לפני\s*הצהריים|בבוקר|בערב|בצהריים|בשעה\s*\d|\b\d{1,2}:\d{2}\b|\bmonday\b|\btuesday\b|\bwednesday\b|\bthursday\b|\bfriday\b|\bsaturday\b|\bsunday\b|\btomorrow\b|\bmorning\b|\bafternoon\b|\bevening\b|\d{1,2}\s*(am|pm)\b)/i;

const CONTACT_WORD_RE = /(אימייל|מייל|דוא"?ל|טלפון|נייד|אי-?מייל|\bemail\b|\be-mail\b|\bphone\b|\bmobile\b)/i;
const TIME_WORD_RE = /(מתי|איזה\s*(זמן|שעה|יום)|מה\s*ה?(זמן|שעה|יום)|הזמן\s*הנוח|מועד\s*(נוח|מתאים)|זמינות|\bwhen\b|\bwhat time\b|\bwhich (day|time)\b|\bavailab)/i;
const ASK_INDICATOR_RE = /(אפשר|תוכל[יו]?|אשמח|אני צריך|נצטרך|תן ל|מה ה|מהו|שלח ל|להשאיר|ליצור איתך קשר|ליצור קשר|נוח לך|מתאים לך|\bcan you\b|\bcould you\b|\bplease\b|\bprovide\b|\bshare\b|\bwhat'?s your\b|\bmay i have\b|\bneed your\b|\bwhat\b|\bwhich\b|\bwhen\b|\?|؟)/i;

export type RedundantInfoItem = "email" | "phone" | "time";
export interface RedundantInfoMatch {
  matched: boolean;
  items: RedundantInfoItem[];
}

/** True when the customer's latest message already supplied an email/phone/time
 * AND the draft reply asks for that same thing — re-asking for what was just
 * given. Returns every redundantly re-asked item. */
export function detectRedundantInfoRequest(
  incomingMessage: string | null | undefined,
  reply: string | null | undefined,
): RedundantInfoMatch {
  if (!incomingMessage || !reply) return { matched: false, items: [] };
  const hasEmail = CUSTOMER_EMAIL_RE.test(incomingMessage);
  const hasPhone = CUSTOMER_PHONE_RE.test(incomingMessage);
  const hasTime = CUSTOMER_TIME_RE.test(incomingMessage);
  if (!hasEmail && !hasPhone && !hasTime) return { matched: false, items: [] };

  const asks = ASK_INDICATOR_RE.test(reply);
  if (!asks) return { matched: false, items: [] };

  const items: RedundantInfoItem[] = [];
  if ((hasEmail || hasPhone) && CONTACT_WORD_RE.test(reply)) items.push(hasEmail ? "email" : "phone");
  if (hasTime && TIME_WORD_RE.test(reply)) items.push("time");
  return { matched: items.length > 0, items };
}

/** Corrective for the single regeneration when the bot re-asked for info the
 * customer just provided. */
export function buildRedundantInfoCorrective(items: RedundantInfoItem[]): string {
  const label: Record<RedundantInfoItem, string> = {
    email: "email address",
    phone: "phone number",
    time: "preferred day/time",
  };
  const list = items.map((i) => label[i]).join(" and ");
  return (
    `**STOP — you just asked for something the customer ALREADY gave you in their last message: their ${list}.** ` +
    `Read their last message carefully. Do NOT ask for the ${list} again. ` +
    `Rewrite your reply: confirm back exactly what they gave (use the right label — an address with "@" is an EMAIL, not a phone number), ` +
    `then move forward — collect ONLY what is genuinely still missing, or state the concrete next step. ` +
    `Reply in the customer's language. One move only.`
  );
}

/** True when the reply commits to / proposes a concrete meeting time or day,
 * or implies a booking. */
export function detectBookingCommitment(
  reply: string | null | undefined,
): BookingCommitmentMatch {
  if (!reply || !reply.trim()) return { matched: false };
  for (const re of BOOKING_COMMITMENT_PATTERNS) {
    const m = reply.match(re);
    if (m) return { matched: true, phrase: m[0].trim() };
  }
  return { matched: false };
}

/**
 * Corrective injected before the single regeneration when a non-bookable agent
 * committed to a time. Language-agnostic (the model replies in the customer's
 * language). `reason` explains why booking is unavailable for clearer copy.
 */
export function buildBookingFailsafeCorrective(reason: "no_calendar" | "not_bookable"): string {
  const why =
    reason === "no_calendar"
      ? "no calendar is connected to you"
      : "your calendar is connected but has no bookable meeting types configured";
  return (
    `**YOU CANNOT BOOK MEETINGS — do not commit to a time.** ` +
    `Your draft reply agreed to or proposed a specific day/time (or implied a booking), but ${why}, ` +
    `so you have NO way to actually book it. Rewrite your reply: do NOT agree to any date or time and do NOT imply a meeting is or will be booked. ` +
    `Instead make ONE genuine forward move that you CAN deliver — ask for the best email/phone and their general availability so a team member can follow up to confirm, offer to connect them with a person, or continue qualifying their need. ` +
    `Reply in the customer's language. One move only.`
  );
}

/**
 * Corrective for the single regeneration when a BOOKABLE agent's draft claims a
 * meeting is booked/locked/confirmed, but no schedule_meeting actually succeeded
 * this turn (observed live: "הפגישה מחר ב-16:00 סגורה!" with zero schedule_meeting
 * calls and no calendar event). Telling a customer they're booked when nothing
 * was booked is a direct Action Outcome Contract violation. The regen runs WITH
 * tools so the model can ACTUALLY book this time; if it still doesn't, it must
 * drop the false claim and ask the customer to confirm the exact day/time.
 */
export function buildFabricatedBookingCorrective(): string {
  return (
    `**YOU HAVE NOT BOOKED ANYTHING — your draft claims the meeting is booked/locked/confirmed, but no booking tool succeeded this turn.** ` +
    `Stating a meeting is set when it is not is a serious failure (no calendar event exists). ` +
    `If you have the meeting type + an explicit day/time + the customer's email, CALL \`schedule_meeting\` NOW and only confirm AFTER it returns success this turn. ` +
    `If the server proposes alternatives, relay them and ask the customer to pick. ` +
    `If you are missing the day/time, do NOT claim it's booked — ask for the exact day/time to lock it. ` +
    `Reply in the customer's language. Never imply a booking that did not actually happen.`
  );
}

/**
 * Corrective for the booking-grounding gate: the draft asserted a specific time,
 * stated availability, or claimed a booking, but NO `schedule_meeting` call this
 * turn justifies it. Availability and validity (working hours, minimum notice,
 * past times, busy slots) are known ONLY through `schedule_meeting` — the model
 * must never invent them. Forces the tool so the REAL result drives the reply.
 */
export function buildBookingGroundingCorrective(): string {
  return (
    `**STOP — you stated a time, availability, or booking that no tool verified this turn.** ` +
    `You do NOT know the calendar yourself: whether a day/time is free, allowed, in the past, or on a non-working day is known ONLY through your calendar tools. ` +
    `Never say a slot is available/booked, agree to a time, or say a day "doesn't work" from your own guessing. ` +
    `Do this now: to state ANY availability, open time, or working hours — or to propose times — CALL \`check_availability\` and answer ONLY from its result (offer the exact slots it returns, or answer hours from its \`workingHours\`). ` +
    `Only once the customer has CHOSEN a concrete slot, CALL \`schedule_meeting\` with that exact time to book it, then confirm the real outcome; if it returns \`needsAvailabilityCheck\`, call \`check_availability\` and offer real slots instead. ` +
    `If you are missing the day/time or email, do NOT invent availability — ask for what's missing. ` +
    `Reply in the customer's language. One move only.`
  );
}

/**
 * Deterministic, last-resort safe reply when the model STILL asserts an
 * ungrounded time/availability/booking after the grounding regen (it refused to
 * call the tool and kept free-texting). Invents nothing: acknowledges and asks
 * for the customer's preferred day/time so the next turn can ground it.
 */
export function buildBookingGroundingFallback(isHebrew: boolean): string {
  return isHebrew
    ? "אשמח לתאם לך פגישה. מה היום והשעה שנוחים לך? אבדוק את הזמינות בפועל ואחזור אליך עם אישור."
    : "I'd be glad to set up a meeting. What day and time generally work for you? I'll check real availability and come back to confirm.";
}

/**
 * Prompt block injected into the system prompt when the agent is NOT bookable,
 * so the model knows its boundary up front. Static per (agent, capability) →
 * cache-safe. Returns null when the agent IS bookable.
 */
export function buildBookingCapabilityBlock(bookable: boolean): string | null {
  if (bookable) return null;
  return [
    "# Booking Capability",
    "You currently CANNOT book meetings — no working calendar/booking tool is available to you this conversation.",
    "",
    "You MAY:",
    "- collect the customer's contact details (email / phone)",
    "- ask for their general availability / preferred times",
    "- create or enrich a lead",
    "- offer that a team member will follow up to confirm a time",
    "- escalate to a human",
    "",
    "You MUST NOT:",
    "- agree to a specific date or time (e.g. \"Saturday works\", \"let's do 14:00\")",
    "- say or imply that you scheduled, booked, or confirmed a meeting",
    "- imply booking is possible right now",
    "",
    "**When the customer wants to meet / asks for a demo (REQUIRED handoff flow):** acknowledge enthusiastically, then before handing off make sure you have collected BOTH (1) a way to reach them (email or phone) AND (2) their preferred days/times or general availability — ask for whichever is still missing, one at a time. Only once you have contact + availability, tell them a team member will reach out to lock in a time that works. Never invent or confirm a slot, and never hand off having asked for contact but not their availability.",
  ].join("\n");
}
