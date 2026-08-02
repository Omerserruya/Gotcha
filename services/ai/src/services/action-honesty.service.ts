/**
 * Action-honesty: a reply may claim work is happening / done / coming only if
 * the turn produced execution evidence.
 *
 * Live incident (2026-07-21): with no product tool in its surface, the model
 * narrated "אני בודקת עכשיו", "הנה 3 אופציות", "שלחתי", "אחזור אליך תוך דקה"
 * across 14 turns while ZERO tools executed. These are the four harmful claim
 * shapes; the detector is deterministic (regex on both Hebrew and English) so
 * it can gate the reply and be measured, rather than trusting the persona
 * prompt to keep the model honest.
 */

export type UnsupportedClaimKind =
  | "in_progress"
  | "results"
  | "sent"
  | "followup"
  | "delegated"
  | "performed";

const CLAIM_PATTERNS: Array<{ kind: UnsupportedClaimKind; re: RegExp }> = [
  // "checking now / searching now"
  { kind: "in_progress", re: /(בודק(ת|ים)?\s*עכשיו|מחפש(ת|ים)?\s*עכשיו|אני\s*(בודק|מחפש)|רגע\s*אני\s*(בודק|מחפש)|checking\s*now|searching\s*now|let me\s*(check|search|look)\s*(now|that up))/i },
  // "here are N options / I found …"  (claims RESULTS exist)
  { kind: "results", re: /(הנה\s*\d*\s*(אופציות|דגמים|תוצאות|מוצרים)|מצאתי\s*(לך|עבורך)?\s*\d|here\s*are\s*\d*\s*(options|products|results)|i\s*found\s*(you|\d))/i },
  // "I sent / already sent"
  { kind: "sent", re: /(שלחתי|שלחנו|כבר\s*שלחתי|נשלח(ה|ו)?\s*(אליך|עכשיו)|i\s*(have\s*)?sent|i['’]ve\s*sent|already\s*sent)/i },
  // "I'll get back to you / returning in a minute"  (promises later autonomous work)
  // Promises LATER autonomous work. Includes "I'll let you know when X
  // happens", which is the shape a shipment-update request produces:
  // "אשמח לעדכן ברגע שייווצר שינוי במשלוח" was sent with ZERO scheduled
  // records behind it. The customer then waits for a message nobody will send.
  { kind: "followup", re: /(אחזור\s*אליך|מחזיר(ה)?\s*(לך)?\s*תוך|נחזור\s*אליך|חוזרת\s*אליך|(אעדכן|נעדכן|אשמח\s*לעדכן|אעדכן\s*אותך)[^\n]{0,30}?(כש|ברגע|כאשר|בהמשך|מאוחר)|i(['’]ll| will)?\s*(get|come)\s*back\s*to\s*you|i(['’]ll| will)?\s*return\s*in|i(['’]ll| will)?\s*(send|let you know|update you)\s*(you\s*)?(shortly|in a|when|as soon))/i },
  // "I'll pass this to the team / I've contacted the courier / support will
  // handle it" - claims ANOTHER PARTY has been engaged.
  //
  // Seen live three times while nothing was engaged at all: "אעביר את המצב
  // לצוות התמיכה כדי שיאשרו", "אעביר את הבקשה לצוות שיטפל בביטול", "להזמין
  // בדיקה אצל צוות המשלוחים". Each one hands the customer a person who does
  // not know they exist, and it is the single most damaging shape here
  // because it reads as resolution and ends the conversation.
  //
  // A note or a tag is not a team notification. Only a real handoff or task
  // counts as evidence.
  // "I've done it" - a completed WRITE, past tense.
  //
  // Live: asked to note a callback request on an order, the bot replied
  // "מעולה, ביצעתי את הבקשה שיחזרו אליך לפני המשלוח". Shopify showed
  // note: null and tags: "". Nothing was written and nothing was called; the
  // customer was told their request was on the order.
  //
  // The existing shapes miss this because they describe work STARTING
  // ("checking now") or a message SENT. This is the flat claim that a change
  // was made - the one a customer acts on and stops chasing.
  {
    kind: "performed",
    // No `\b` on the Hebrew alternation: Hebrew letters are not \w, so a word
    // boundary after them never matches and the whole group silently never
    // fired. The English side keeps its boundaries.
    // Active AND passive. Told that "ביצעתי" was being stripped, the model
    // simply switched to "בקשתך עודכנה בהזמנה" - same false claim, no first
    // person. A customer cannot tell the difference and should not have to.
    re: /((ביצעתי|ביצענו|עשיתי|עשינו|רשמתי|רשמנו|הוספתי|הוספנו|עדכנתי|עדכנו|סימנתי|שמרתי|הזנתי|צירפתי|הגדרתי)|(עודכן|עודכנה|נרשם|נרשמה|נוסף|נוספה|נשמר|נשמרה|הוזן|הוזנה|צורף|צורפה|סומן|סומנה)|\bi(['’]ve| have)?\s*(added|noted|recorded|updated|saved|tagged|set|applied|logged)\b|\b(has|have|was|were)( been)? (added|noted|recorded|updated|saved|tagged|applied)\b)/i,
  },
  {
    kind: "delegated",
    // The gap between the verb and the target is deliberately loose. A noun
    // allowlist kept losing: "אעביר את הבקשה לצוות" was caught, then "אעביר
    // את המצב לצוות", then "אעביר את הפרטים לצוות" - each a new word for the
    // same promise. What matters is the shape "I am handing this to <someone
    // else>", not which noun the model reached for.
    re: /((אעביר|מעביר(ה)?|העברתי|נעביר|אפנה|פניתי|פונה|מחבר(ת)?|מקשר(ת)?)[^\n]{0,40}?(אל\s*|ל)(צוות|נציג|מחלק|תמיכה|שירות|חברת\s*המשלוחים|שליח)|(צוות|נציג|מחלקה)\s*(יטפל|יחזור|יבדוק|ייצור\s*קשר)|(דיווחתי|יידעתי|עדכנתי)\s*(את\s*)?[להה]?\s*(צוות|מחלקה|חברת\s*המשלוחים|תמיכה)|i(['’]ve| have)?\s*(contacted|notified|informed|escalated|forwarded|passed)\s*(this\s*)?(to\s*)?(the\s*)?(team|support|department|courier|carrier|warehouse)|(the\s*)?(team|support|department)\s*will\s*(handle|contact|reach|get)\b)/i,
  },
];

export interface ActionClaim {
  kind: UnsupportedClaimKind;
  match: string;
}

/** All action-claim shapes present in the text (empty = none). */
export function detectActionClaims(text: string | null | undefined): ActionClaim[] {
  if (!text) return [];
  const out: ActionClaim[] = [];
  for (const { kind, re } of CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (m) out.push({ kind, match: m[0] });
  }
  return out;
}

/**
 * Did this turn actually DO something a claim could rest on? Any tool that
 * executed for real (not a gate/skip/denied/awaiting-approval side effect) is
 * evidence. `followup` claims additionally require a real async job, which the
 * bot loop does not create - so they are NEVER supported inline.
 */
export function turnHasExecutionEvidence(
  toolCallLog: Array<{ tool?: string; decision?: string; sideEffect?: string }> | undefined,
): boolean {
  if (!toolCallLog?.length) return false;
  return toolCallLog.some(
    (t) =>
      (t.decision === "executed" || t.decision === "executed_on_retry") &&
      !!t.tool &&
      !t.tool.startsWith("__") && // internal markers (__redundant_info__ etc.)
      t.sideEffect !== "awaiting_approval" &&
      t.sideEffect !== "denied",
  );
}

/**
 * Did this turn actually engage another party?
 *
 * Stricter than `turnHasExecutionEvidence` on purpose: reading an order is
 * evidence that the bot did something, but it is not evidence that a person
 * was told anything. Only a handoff, a task, an assignment or a notification
 * can support "I've passed this to the team" - and a note or a tag, which the
 * model likes to treat as equivalent, deliberately cannot.
 */
export function turnHasHandoffEvidence(
  toolCallLog: Array<{ tool?: string; decision?: string; sideEffect?: string }> | undefined,
): boolean {
  if (!toolCallLog?.length) return false;
  return toolCallLog.some((t) => {
    if (t.decision !== "executed" && t.decision !== "executed_on_retry") return false;
    const name = String(t.tool ?? "").toLowerCase();
    return /(escalate_to_human|handoff|create_task|assign|notify_|send_notification|transfer_conversation)/.test(name);
  });
}

/** Sentence boundaries, Hebrew and English, keeping the terminator. */
const SENTENCE_SPLIT = /(?<=[.!?׃])\s+|\n+/;

/**
 * Remove sentences that promise another party has been engaged.
 *
 * The honesty check has been observe-only: it logs, it audits, and the reply
 * ships anyway. That is defensible for the vaguer claim shapes, where a false
 * positive would mangle a good answer - but not for this one. "אעביר את המצב
 * לצוות התמיכה" reads as resolution, so the customer stops chasing, and nobody
 * is coming. It is the one claim where shipping it is worse than cutting it.
 *
 * Surgery is per SENTENCE so the grounded part of the reply survives; the
 * model usually states the real facts first and then over-promises at the end.
 * Returns null when nothing needed removing, so callers can tell "unchanged"
 * from "rewritten".
 */
export function stripUnsupportedDelegation(
  text: string | null | undefined,
  kinds: UnsupportedClaimKind[] = ["delegated", "performed", "followup"],
): string | null {
  if (!text) return null;
  const res = CLAIM_PATTERNS.filter((p) => kinds.includes(p.kind)).map((p) => p.re);
  const re = { test: (s: string) => res.some((r) => r.test(s)) };
  const sentences = String(text).split(SENTENCE_SPLIT);
  const kept = sentences.filter((s) => !re.test(s));
  if (kept.length === sentences.length) return null;
  const rebuilt = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  // Everything was a promise. Say the one true thing instead of nothing.
  if (rebuilt.length < 3) return null;
  return rebuilt;
}

export interface HonestyVerdict {
  ok: boolean;
  /** Claims that have no execution evidence to support them. */
  unsupported: ActionClaim[];
}

/**
 * A reply is action-honest when every claim it makes is backed by evidence.
 * `in_progress` / `results` / `sent` need a tool that executed this turn.
 * `followup` (promising later autonomous work) is unsupported unless a real
 * continuation job exists - the bot loop has none, so it is always flagged.
 */
export function validateActionHonesty(
  replyText: string | null | undefined,
  toolCallLog: Array<{ tool?: string; decision?: string; sideEffect?: string }> | undefined,
  opts?: { hasBackgroundJob?: boolean },
): HonestyVerdict {
  const claims = detectActionClaims(replyText);
  if (!claims.length) return { ok: true, unsupported: [] };
  const evidence = turnHasExecutionEvidence(toolCallLog);
  const handoff = turnHasHandoffEvidence(toolCallLog);
  const unsupported = claims.filter((c) => {
    if (c.kind === "followup") return !opts?.hasBackgroundJob;
    if (c.kind === "delegated") return !handoff;
    // "performed" is a completed WRITE. Any tool that really executed this
    // turn is evidence; nothing at all is not.
    return !evidence;
  });
  return { ok: unsupported.length === 0, unsupported };
}
