/**
 * The last thing between a drafted reply and a customer.
 *
 * The prompt already told the model to run tools silently and never promise
 * what it cannot do. On 2026-07-31 it did both anyway, to a real customer:
 *
 *   "בדקתי גם עבור ETA"                      - narrated a tool by its own name
 *   "עשיתי עכשיו שתי בדיקות"                  - counted its tool calls out loud
 *   "ניסיתי להוסיף הערה/תג לשורת המילוי"       - described an internal write
 *   "נתקלה שגיאת מערכת"                       - surfaced a provider error
 *   "אני פונה לצוות המשלוחים"                  - promised contact with a team
 *                                              it has no way to reach
 *   "אעדכן אותך כאן בוואטסאפ"                  - promised a proactive message
 *                                              that was never scheduled
 *
 * A prompt sentence is a request. This is a check. Both layers are wanted: the
 * prompt shapes the good case, this catches the bad one.
 *
 * ── Design constraint ───────────────────────────────────────────────────────
 * A blacklist of suspicious words would maim ordinary conversation - a customer
 * service reply is allowed to contain "check", "team" or "update". So the two
 * halves are deliberately narrow:
 *
 *   Leakage is keyed on what ACTUALLY RAN this turn. If a reply contains the
 *   literal name of a tool that was just invoked, that is not a coincidence,
 *   and no legitimate reply needs it. Provider error signatures
 *   (`shopify_400`, `no_eta`) are matched literally because no customer-facing
 *   sentence contains them either.
 *
 *   Promises are matched by pattern but only ever REMOVED when the turn lacks
 *   evidence for them. A promise backed by a successful schedule_followup is
 *   left completely alone.
 */

export interface TurnEvidence {
  /** A follow-up message was actually scheduled and persisted. */
  followUpScheduled?: boolean;
  /** A task/ticket was created for a human. */
  taskCreated?: boolean;
  /** A notification actually went to a person or channel. */
  notificationSent?: boolean;
  /** The conversation was assigned to a department or queue. */
  assignedToDepartment?: boolean;
  /** A human handoff/escalation was created. */
  handoffCreated?: boolean;
  /** An outbound message was queued for delivery. */
  messageQueued?: boolean;
}

export type ReplyFindingKind =
  | "untranslated_acronym"
  | "slash_form"
  | "tool_name_leak"
  | "provider_error_leak"
  | "internal_term_leak"
  | "tool_count_narration"
  | "unsupported_promise";

export interface ReplyFinding {
  kind: ReplyFindingKind;
  /** What matched. Safe to log - never contains customer PII. */
  match: string;
  /** Whether the guard rewrote the text or only flagged it. */
  action: "removed" | "flagged";
}

export interface GuardOptions {
  locale?: string;
  /** Names of tools invoked this turn, e.g. ["shopify.check_delivery_eta"]. */
  invokedTools?: string[];
  evidence?: TurnEvidence;
  /** Replacement for a sentence that had to go. Locale-aware default. */
  fallbackSentence?: string;
}

export interface GuardResult {
  text: string;
  changed: boolean;
  findings: ReplyFinding[];
  /** True when nothing survived and the caller must substitute a safe reply. */
  emptied: boolean;
}

/**
 * Provider and transport signatures. These are matched literally because they
 * cannot occur in a legitimate customer sentence in any language.
 */
const PROVIDER_ERROR_PATTERNS: RegExp[] = [
  /\bshopify[_ ]?\d{3}\b/gi,          // shopify_400, "Shopify 404"
  /\b(?:no_eta|no_tracking|not_fulfilled|order_not_found|order_ambiguous)\b/gi,
  /\border_identifier_invalid\b/gi,
  /\bunknown_shopify_tool\b/gi,
  /\bHTTP\s?[45]\d{2}\b/g,
  /\b[45]\d{2}\s+(?:Bad Request|Not Found|Unauthorized|Forbidden)\b/gi,
];

/**
 * Internal vocabulary that has no customer-facing meaning.
 *
 * Kept SHORT on purpose. "note" and "tag" are ordinary words in both languages
 * and are not listed; what is listed is the internal compound the model
 * actually produced ("שורת המילוי" - the fulfillment line) and the words that
 * only ever describe machinery.
 */
const INTERNAL_TERM_PATTERNS: RegExp[] = [
  /(?<![֐-׿])שורת המילוי/g,
  /(?<![֐-׿])שגיאת מערכת/g,
  /(?<![֐-׿])תקלה טכנית אצלנו/g,
  /\b(?:endpoint|payload|schema|adapter|webhook|API call)\b/gi,
  /\bfulfillment line\b/gi,
];

/** "I ran two checks" - the model counting its own tool calls. */
const TOOL_COUNT_PATTERNS: RegExp[] = [
  /עשיתי (?:עכשיו )?(?:שתי|שלוש|ארבע|שני|מספר) בדיקות/g,
  /ביצעתי (?:שתי|שלוש|מספר) בדיקות/g,
  /\bI (?:ran|performed|did) (?:two|three|several|a couple of) checks\b/gi,
];

/**
 * Future-action claims, and the evidence each one requires.
 *
 * Every pattern is anchored on the AI committing to something, not on the
 * customer asking for it - "רוצה שאעדכן אותך?" is an offer and stays; "אעדכן
 * אותך" is a commitment and needs a scheduled follow-up behind it.
 */
interface PromiseRule {
  patterns: RegExp[];
  /** Any ONE of these makes the promise honest. */
  satisfiedBy: (keyof TurnEvidence)[];
  label: string;
}

const PROMISE_RULES: PromiseRule[] = [
  {
    label: "proactive_update",
    satisfiedBy: ["followUpScheduled", "messageQueued"],
    patterns: [
      /אעדכן אותך[^.!?\n]*/g,
      /אדאג לעדכן אותך[^.!?\n]*/g,
      /נדווח לך[^.!?\n]*/g,
      /אחזור אליך[^.!?\n]*/g,
      /\bI(?:'ll| will) (?:update|get back to|follow up with) you\b[^.!?\n]*/gi,
    ],
  },
  {
    label: "team_contacted",
    satisfiedBy: ["taskCreated", "notificationSent", "assignedToDepartment", "handoffCreated"],
    patterns: [
      /(?:אני )?פונה ל(?:צוות|מחלקת)[^.!?\n]*/g,
      /אפנה (?:עכשיו )?ל(?:צוות|מחלקת)[^.!?\n]*/g,
      /פניתי ל(?:צוות|מחלקת)[^.!?\n]*/g,
      /העברתי (?:את הפרטים )?ל(?:צוות|מחלקת)[^.!?\n]*/g,
      /סימנתי (?:את זה )?ל(?:צוות|מחלקה)[^.!?\n]*/g,
      /\bI(?:'ve| have)? ?(?:contacted|reached out to|flagged (?:this )?(?:to|for)) the (?:team|ops|operations|shipping)\b[^.!?\n]*/gi,
    ],
  },
  {
    label: "carrier_contacted",
    // No carrier-contact integration exists at all, so nothing can satisfy
    // this. Listed with an empty set so the intent is explicit rather than
    // implied by omission.
    satisfiedBy: [],
    patterns: [
      /(?:אני )?(?:פונה|אפנה|פניתי) ל(?:חברת השליחויות|חברת המשלוחים|שליח)[^.!?\n]*/g,
      /\bI(?:'ve| have)? ?(?:contacted|will contact) the (?:carrier|courier|shipping company)\b[^.!?\n]*/gi,
    ],
  },
];

/**
 * An all-caps English acronym of 2-5 letters, as a standalone word.
 *
 * Deliberately not matching inside URLs or longer mixed-case words, so
 * "WhatsApp" and "Urban Supply" are untouched.
 */
const ACRONYM_RE = /(?<![A-Za-z/])[A-Z]{2,5}(?![A-Za-z/])/g;

/**
 * Acronyms a Hebrew-speaking customer genuinely reads as words. Kept tiny:
 * everything else should be said in Hebrew.
 */
const ACRONYM_ALLOWLIST = new Set(["SMS", "PDF", "OK", "USB", "TV"]);

/**
 * Hebrew slash forms: "מאשר/ת", "יכול/ה", "אתה/את".
 *
 * A Hebrew letter, then "/", then one or two Hebrew letters ending the word.
 * Anchored tightly so a date ("7/8"), a URL, or "ו/או" - a real Hebrew
 * conjunction - do not trip it.
 */
const SLASH_FORM_RE = /[֐-׿]{2,}\/[֐-׿]{1,2}(?![֐-׿])/g;

function hasEvidence(ev: TurnEvidence | undefined, keys: (keyof TurnEvidence)[]): boolean {
  if (!ev || keys.length === 0) return false;
  return keys.some((k) => ev[k] === true);
}

const FALLBACK_HE = "לא הצלחתי להשלים את הפעולה כרגע. אפשר להעביר את הטיפול לנציג אנושי.";
const FALLBACK_EN = "I could not complete that just now. I can pass this to a colleague who can help.";

/** Collapse the whitespace/punctuation left behind by a removal. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,!?])/g, "$1")
    .replace(/([.!?])\s*\1+/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.replace(/^[\s,.;:]+/, "").trimEnd())
    .join("\n")
    .trim();
}

/**
 * Check a drafted customer reply, removing what must not reach them.
 *
 * Returns the text to send. When `emptied` is true the guard removed
 * everything and the caller must send `fallbackSentence` instead - which is
 * the honest outcome for a reply that was nothing but leakage and promises.
 */
export function guardCustomerReply(draft: string, opts: GuardOptions = {}): GuardResult {
  const findings: ReplyFinding[] = [];
  let text = String(draft ?? "");
  const original = text;
  const isHebrew = (opts.locale ?? "").toLowerCase().startsWith("he") || /[֐-׿]/.test(text);

  // 1. Tool names that actually ran this turn. The most reliable signal there
  //    is: no legitimate reply contains `shopify.check_delivery_eta`.
  for (const full of opts.invokedTools ?? []) {
    const bare = full.includes(".") ? full.slice(full.indexOf(".") + 1) : full;
    for (const needle of [full, bare]) {
      if (!needle || needle.length < 4) continue;
      const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      if (re.test(text)) {
        text = text.replace(re, "");
        findings.push({ kind: "tool_name_leak", match: needle, action: "removed" });
      }
    }
  }

  // 2. Raw provider errors.
  for (const re of PROVIDER_ERROR_PATTERNS) {
    const m = text.match(re);
    if (m) {
      text = text.replace(re, "");
      findings.push({ kind: "provider_error_leak", match: m[0], action: "removed" });
    }
  }

  // 3. Internal vocabulary. Removed by SENTENCE, because "I tried to add a
  //    note to the fulfillment line but hit a system error" is not salvageable
  //    by deleting two words.
  for (const re of INTERNAL_TERM_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    findings.push({ kind: "internal_term_leak", match: m[0], action: "removed" });
    text = removeSentencesMatching(text, re);
  }

  // 4. Tool-call counting.
  for (const re of TOOL_COUNT_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    findings.push({ kind: "tool_count_narration", match: m[0], action: "removed" });
    text = removeSentencesMatching(text, re);
  }

  // 4a. English acronyms inside a Hebrew message.
  //
  // FLAGGED, not removed: "ETA" carries the sentence's meaning, and deleting
  // it would leave a reply that says nothing. What a regex CAN do is make the
  // leak visible - the customer in the original conversation had to ask "מה זה
  // ETA?" twice, and nothing anywhere noticed.
  //
  // Only fires on a message that is actually Hebrew, so an English
  // conversation using "ETA" normally is untouched.
  if (/[֐-׿]/.test(text)) {
    const acronyms = text.match(ACRONYM_RE) ?? [];
    for (const a of [...new Set(acronyms)]) {
      if (ACRONYM_ALLOWLIST.has(a.toUpperCase())) continue;
      findings.push({ kind: "untranslated_acronym", match: a, action: "flagged" });
    }
  }

  // 4b. Hebrew slash forms.
  //
  // FLAGGED, not removed. "מאשר/ת" carries real meaning and deleting the
  // sentence would cost the customer the question; rewriting it correctly
  // needs the grammar the model has and this guard does not. So it is surfaced
  // for the prompt to fix and for anyone watching the logs to see, which is
  // honest about what a regex can and cannot do here.
  const slashHits = text.match(SLASH_FORM_RE);
  if (slashHits) {
    for (const hit of [...new Set(slashHits)]) {
      findings.push({ kind: "slash_form", match: hit, action: "flagged" });
    }
  }

  // 5. Promises without evidence.
  //
  // Only COMMITMENTS are removed. "רוצה שאעדכן אותך?" - would you like me to
  // update you? - contains the same words as the promise but commits to
  // nothing, and stripping it would delete the very question that lets the
  // customer ask for a follow-up. Offers are recognised by being questions or
  // by an explicit offer marker.
  for (const rule of PROMISE_RULES) {
    if (hasEvidence(opts.evidence, rule.satisfiedBy)) continue;
    for (const re of rule.patterns) {
      const m = text.match(re);
      if (!m) continue;
      const before = text;
      text = removeSentencesMatching(text, re, isOffer);
      if (text !== before) {
        findings.push({
          kind: "unsupported_promise",
          match: `${rule.label}: ${m[0].slice(0, 60)}`,
          action: "removed",
        });
      }
    }
  }

  text = tidy(text);
  const emptied = text.length === 0 && original.trim().length > 0;
  if (emptied) text = opts.fallbackSentence ?? (isHebrew ? FALLBACK_HE : FALLBACK_EN);

  return { text, changed: text !== original, findings, emptied };
}

/**
 * Drop whole sentences containing a match.
 *
 * Sentence-level rather than token-level because a half-deleted sentence reads
 * worse than a missing one, and because the offending clause usually IS the
 * sentence.
 */
function removeSentencesMatching(
  text: string,
  re: RegExp,
  keepIf?: (sentence: string) => boolean,
): string {
  return text
    .split("\n")
    .map((line) => {
      // Keep the separators so the surviving sentences still read naturally.
      const parts = line.split(/(?<=[.!?])\s+/);
      const kept = parts.filter((s) => {
        const probe = new RegExp(re.source, re.flags.replace("g", ""));
        if (!probe.test(s)) return true;
        return keepIf ? keepIf(s) : false;
      });
      return kept.join(" ");
    })
    .join("\n");
}

/**
 * Is this sentence an offer rather than a commitment?
 *
 * A question commits to nothing, and the offer markers below introduce a
 * subordinate clause ("would you like me to...") that turns the verb into a
 * proposal. Getting this wrong in the removing direction is expensive: it
 * would delete the question that lets a customer opt into a follow-up.
 */
function isOffer(sentence: string): boolean {
  const s = sentence.trim();
  if (s.endsWith("?")) return true;
  return /(?:רוצה ש|תרצה ש|תרצי ש|האם|רוצים ש|Would you like|Shall I|Do you want me to)/i.test(s);
}

/**
 * What this turn actually accomplished, derived from the turn's own record.
 *
 * Deliberately driven by COMMITTED ledger entries rather than by "a tool
 * returned ok". A tool can succeed at its own job without the customer-facing
 * claim becoming true - `update_order_fulfillment` writing a note is the exact
 * case that started this: it succeeds, and nobody has been contacted.
 *
 * So the mapping is by what the tool DOES, not by whether it worked. A tool
 * that is not listed here contributes no evidence, which is the safe default:
 * an unrecognised tool cannot license a promise.
 */
export function turnEvidenceFrom(
  committedTools: string[],
  opts: { escalated?: boolean } = {},
): TurnEvidence {
  const has = (...names: string[]) =>
    committedTools.some((t) => names.some((n) => t === n || t.endsWith(`.${n}`)));

  return {
    followUpScheduled: has("schedule_followup", "schedule_message"),
    taskCreated: has("create_task", "integration_create_task", "create_ticket"),
    notificationSent: has("notify_team", "send_internal_notification", "notify_department"),
    assignedToDepartment: has("transfer_to_department", "assign_conversation", "route_to_department"),
    handoffCreated: !!opts.escalated || has("escalate_to_human", "handoff_to_human"),
    messageQueued: has("send_message"),
  };
}
