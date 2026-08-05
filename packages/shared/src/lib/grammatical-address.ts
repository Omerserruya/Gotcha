/**
 * Grammatical address: which FORM to write in, not who the customer is.
 *
 * Hebrew (like Arabic, Spanish, French and most of the world's languages)
 * makes the speaker choose a grammatical gender for almost every verb and
 * adjective aimed at the listener. An assistant that guesses wrong writes
 * "מה אתה מחפש?" at a woman on every turn; one that refuses to choose
 * writes "מעוניין/ת", which is the single clearest sign a machine wrote
 * the message.
 *
 * ─── What this module is NOT ─────────────────────────────────
 *
 * It does not classify, infer or store anyone's sex or gender identity.
 * It records which grammatical form the customer used about THEMSELVES in
 * THIS conversation, so replies can agree with it. The distinction is not
 * a formality:
 *
 *   • Evidence is first-person agreement morphology only. A name, a phone
 *     number, an email address, an avatar, a voice, an address, a
 *     purchased product and a product category are NEVER evidence, and
 *     there is deliberately no code path that could make them evidence.
 *   • Another person's description is never evidence. "הבת שלי מחפשת
 *     שמלה" contains a feminine verb and proves nothing about the person
 *     typing it. Third-person guards below exist for exactly this.
 *   • The state is conversation-scoped, never promoted to a customer
 *     attribute, never written to Shopify, never an input to
 *     authorization, segmentation, pricing or tool behaviour.
 *
 * ─── Why only some words count ───────────────────────────────
 *
 * Unvocalized Hebrew hides most gender distinctions. "רוצה" is both
 * masculine and feminine singular; so are "מנסה", "קונה" and "מחכה".
 * Past tense in the first person ("הזמנתי", "קניתי") carries no gender at
 * all, and neither does the future. Only the present participle and a
 * handful of adjectives distinguish the two in writing - so those are the
 * only things this module reads. Everything else is silence, and silence
 * keeps the form "unknown", which is a perfectly good answer: the neutral
 * register exists and reads fine.
 */

export type GrammaticalForm = "masculine" | "feminine" | "neutral" | "unknown";
export type GrammaticalConfidence = "explicit" | "strong_context" | "unknown";

export interface GrammaticalAddress {
  form: GrammaticalForm;
  confidence: GrammaticalConfidence;
  /** The message the current form was learned from. Never prompted with. */
  sourceMessageId?: string;
  /** Language this form applies to. A form learned in Hebrew means nothing in English. */
  language?: string;
  /** When it was last updated. Diagnostics only. */
  updatedAt?: string;
}

export const UNKNOWN_ADDRESS: GrammaticalAddress = { form: "unknown", confidence: "unknown" };

/** Languages where a reply has to choose a form at all. */
export const GENDERED_LANGUAGES: ReadonlyArray<string> = ["he", "iw", "ar", "es", "fr", "pt", "it", "ru", "he-il"];

export function isGenderedLanguage(locale: string | null | undefined): boolean {
  if (typeof locale !== "string") return false;
  const tag = locale.trim().toLowerCase().replace(/_/g, "-");
  if (!tag) return false;
  return GENDERED_LANGUAGES.includes(tag) || GENDERED_LANGUAGES.includes(tag.split("-")[0]);
}

// ─── Hebrew evidence ─────────────────────────────────────────

/**
 * Hebrew word boundary. `\b` is defined over [A-Za-z0-9_], so it fires in
 * the MIDDLE of every Hebrew word and never at its edges. These
 * lookarounds are the real thing.
 */
const HB = "(?<![\\u0590-\\u05FF])";
const HE = "(?![\\u0590-\\u05FF])";

/**
 * First-person present participles and adjectives whose masculine and
 * feminine forms differ in UNVOCALIZED Hebrew.
 *
 * Curated, never derived. Deriving the feminine by appending ת/ה would
 * generate forms that are real words with other meanings, and one false
 * match here addresses a customer wrongly for the rest of a conversation.
 *
 * Pairs whose two forms are spelled identically without vowels - רוצה,
 * מנסה, קונה, מחכה, מרוצה, בוחר?/בוחרת (no, that one differs) - are
 * deliberately absent. They are not weak evidence, they are NO evidence.
 */
export const HEBREW_FORM_PAIRS: ReadonlyArray<readonly [masculine: string, feminine: string]> = [
  ["מחפש", "מחפשת"],
  ["מתלבט", "מתלבטת"],
  ["צריך", "צריכה"],
  ["יכול", "יכולה"],
  ["מעוניין", "מעוניינת"],
  ["מתעניין", "מתעניינת"],
  ["מבין", "מבינה"],
  ["חושב", "חושבת"],
  ["אוהב", "אוהבת"],
  ["יודע", "יודעת"],
  ["מרגיש", "מרגישה"],
  ["מעדיף", "מעדיפה"],
  ["מתכוון", "מתכוונת"],
  ["מבקש", "מבקשת"],
  ["מזמין", "מזמינה"],
  ["משלם", "משלמת"],
  ["מחזיר", "מחזירה"],
  ["הולך", "הולכת"],
  ["לוקח", "לוקחת"],
  ["מחליט", "מחליטה"],
  ["שוקל", "שוקלת"],
  ["בטוח", "בטוחה"],
  ["מוכן", "מוכנה"],
  ["שמח", "שמחה"],
  ["מודאג", "מודאגת"],
  ["מאוכזב", "מאוכזבת"],
  ["מרוגז", "מרוגזת"],
  ["חייב", "חייבת"],
  ["זקוק", "זקוקה"],
  ["עייף", "עייפה"],
  ["מחובר", "מחוברת"],
  ["מרוויח", "מרוויחה"],
  ["גר", "גרה"],
  ["עובד", "עובדת"],
];

const MASCULINE_WORDS = HEBREW_FORM_PAIRS.map(([m]) => m);
const FEMININE_WORDS = HEBREW_FORM_PAIRS.map(([, f]) => f);

/** Adverbs and negations that may sit between "אני" and the marker. */
const INTERVENING =
  "(?:לא|כבר|עדיין|ממש|רק|בעצם|פשוט|גם|כרגע|מאוד|די|קצת|באמת|בכלל|אולי|תמיד|עכשיו)";

/** "אני", optionally with a ו/ש prefix. */
const FIRST_PERSON = "[וש]?אני";

function alternation(words: ReadonlyArray<string>): string {
  // Longest first so "מתעניין" is not shadowed by "מעוניין"-style prefixes.
  return [...words].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** אני [adverb]{0,2} MARKER - the strongest signal there is in writing. */
function adjacencyRe(words: ReadonlyArray<string>): RegExp {
  return new RegExp(
    `${HB}${FIRST_PERSON}${HE}\\s+(?:${INTERVENING}\\s+){0,2}${HB}[וש]?(?:${alternation(words)})${HE}`,
    "g",
  );
}

/** The marker anywhere, for the weaker clause-level rule. */
function anywhereRe(words: ReadonlyArray<string>): RegExp {
  return new RegExp(`${HB}[וש]?(?:${alternation(words)})${HE}`, "g");
}

const MASC_ADJACENT = adjacencyRe(MASCULINE_WORDS);
const FEM_ADJACENT = adjacencyRe(FEMININE_WORDS);
const MASC_ANYWHERE = anywhereRe(MASCULINE_WORDS);
const FEM_ANYWHERE = anywhereRe(FEMININE_WORDS);

/**
 * Somebody else is the subject of this clause.
 *
 * "הבת שלי מחפשת שמלה" is the canonical case: a feminine verb that says
 * nothing about the person typing. Possessives are included because "X
 * שלי" is how a third party is almost always introduced in Hebrew chat.
 */
const THIRD_PARTY_RE = new RegExp(
  `${HB}[והשבלמכ]?(?:` +
    "הוא|היא|הם|הן|אתה|אתם|אתן|" +
    "בת|בן|בתי|בני|ילד|ילדה|ילדי|אישה|אשתי|אשת|בעל|בעלי|" +
    "חבר|חברה|חברי|חברתי|אמא|אבא|אמי|אבי|הורים|" +
    "אח|אחות|אחי|אחותי|סבא|סבתא|נכד|נכדה|דוד|דודה|" +
    "לקוח|לקוחה|מישהו|מישהי|בחור|בחורה|" +
    "שלה|שלו|שלהם|שלהן" +
    `)${HE}`,
  "",
);

/** "X שלי" - a possessed noun, i.e. somebody or something that is not the speaker. */
const POSSESSED_RE = new RegExp(`${HB}שלי${HE}`, "");

/**
 * The customer stating the form outright. Rare, and unambiguous when it
 * happens - a correction like "תכתבו אליי בלשון נקבה" must land instantly.
 */
const EXPLICIT_REQUEST: ReadonlyArray<readonly [RegExp, GrammaticalForm]> = [
  [new RegExp(`${HB}(?:ב|ה)?לשון${HE}\\s+${HB}נקבה${HE}`), "feminine"],
  [new RegExp(`${HB}(?:ב|ה)?לשון${HE}\\s+${HB}זכר${HE}`), "masculine"],
  [new RegExp(`${HB}בנקבה${HE}`), "feminine"],
  [new RegExp(`${HB}בזכר${HE}`), "masculine"],
];

/**
 * Quoted spans are somebody else's words. "היא כתבה לי 'אני מחפשת'" must
 * not make the speaker feminine.
 */
const QUOTED_RE = /["'“”״‘’׳]([^"'“”״‘’׳]{0,200})["'“”״‘’׳]/g;

function stripQuoted(text: string): string {
  return text.replace(QUOTED_RE, " ");
}

/** Clause boundaries. Hebrew chat punctuates lightly, so newlines count. */
function clauses(text: string): string[] {
  return text.split(/[.!?;\n\r,]+/).map((c) => c.trim()).filter(Boolean);
}

export interface GrammaticalEvidence {
  form: GrammaticalForm;
  confidence: GrammaticalConfidence;
  /**
   * Why. Held for tests and for a support engineer looking at one
   * conversation; NEVER placed in a prompt and never persisted.
   */
  rule?: "explicit_request" | "first_person_adjacent" | "clause_subjectless";
}

const NO_EVIDENCE: GrammaticalEvidence = { form: "unknown", confidence: "unknown" };

/**
 * Read one customer message for first-person grammatical evidence.
 *
 * Returns "unknown" far more often than not, and that is the intended
 * behaviour: a wrong form every turn is worse than a neutral one.
 */
export function detectGrammaticalEvidence(
  text: string | null | undefined,
  locale?: string | null,
): GrammaticalEvidence {
  if (locale && !/^(he|iw)/i.test(locale.trim())) return NO_EVIDENCE;
  const raw = String(text ?? "");
  if (!raw.trim()) return NO_EVIDENCE;

  const cleaned = stripQuoted(raw);

  // 1. The customer said which form to use. Nothing outranks that.
  for (const [re, form] of EXPLICIT_REQUEST) {
    if (re.test(cleaned)) return { form, confidence: "explicit", rule: "explicit_request" };
  }

  // 2. "אני" governing an agreement form, within two adverbs.
  const mascAdjacent = countMatches(cleaned, MASC_ADJACENT);
  const femAdjacent = countMatches(cleaned, FEM_ADJACENT);
  if (mascAdjacent > 0 || femAdjacent > 0) {
    // Both in one message: the customer is quoting, listing, or writing
    // about two people. Refuse rather than pick.
    if (mascAdjacent > 0 && femAdjacent > 0) return NO_EVIDENCE;
    return {
      form: mascAdjacent > 0 ? "masculine" : "feminine",
      confidence: "explicit",
      rule: "first_person_adjacent",
    };
  }

  // 3. A clause with an agreement form and NO other subject in it. Hebrew
  //    chat drops "אני" constantly ("מחפשת נעליים בבקשה"), and refusing to
  //    read those would make the feature almost never fire. The guard is
  //    that any third party or second-person pronoun in the same clause
  //    disqualifies it entirely.
  let masc = 0;
  let fem = 0;
  for (const clause of clauses(cleaned)) {
    if (THIRD_PARTY_RE.test(clause) || POSSESSED_RE.test(clause)) continue;
    masc += countMatches(clause, MASC_ANYWHERE);
    fem += countMatches(clause, FEM_ANYWHERE);
  }
  if (masc > 0 && fem > 0) return NO_EVIDENCE;
  if (masc > 0) return { form: "masculine", confidence: "strong_context", rule: "clause_subjectless" };
  if (fem > 0) return { form: "feminine", confidence: "strong_context", rule: "clause_subjectless" };

  return NO_EVIDENCE;
}

function countMatches(text: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  return (text.match(global) ?? []).length;
}

// ─── State transitions ───────────────────────────────────────

const CONFIDENCE_RANK: Record<GrammaticalConfidence, number> = {
  unknown: 0,
  strong_context: 1,
  explicit: 2,
};

export interface AddressUpdateInput {
  current?: GrammaticalAddress | null;
  text: string | null | undefined;
  messageId?: string;
  locale?: string | null;
  now?: Date;
}

export interface AddressUpdateResult {
  next: GrammaticalAddress;
  changed: boolean;
  /** True when new evidence CONTRADICTED the stored form - a correction. */
  corrected: boolean;
}

/**
 * Fold one inbound message into the conversation's address state.
 *
 * Rules, in the order they matter:
 *
 *   • No evidence changes nothing. Ambiguous words produce no evidence, so
 *     they cannot make the form oscillate.
 *   • Evidence that AGREES with the stored form may only raise confidence,
 *     never lower it.
 *   • Evidence that CONTRADICTS the stored form must be at least as strong
 *     as what is stored. A clause-level guess never overturns an explicit
 *     one; an explicit correction always lands, immediately.
 */
export function updateGrammaticalAddress(input: AddressUpdateInput): AddressUpdateResult {
  const current: GrammaticalAddress = input.current ?? UNKNOWN_ADDRESS;
  const evidence = detectGrammaticalEvidence(input.text, input.locale);

  if (evidence.form === "unknown" || evidence.confidence === "unknown") {
    return { next: current, changed: false, corrected: false };
  }

  const language = normalizeLanguage(input.locale) ?? current.language;
  const stamp = (input.now ?? new Date()).toISOString();

  // A form learned in a different language is not evidence about this one.
  const knownHere =
    current.form !== "unknown" && (!current.language || !language || current.language === language);

  if (!knownHere) {
    return {
      next: {
        form: evidence.form,
        confidence: evidence.confidence,
        sourceMessageId: input.messageId,
        language,
        updatedAt: stamp,
      },
      changed: true,
      corrected: false,
    };
  }

  if (current.form === evidence.form) {
    if (CONFIDENCE_RANK[evidence.confidence] <= CONFIDENCE_RANK[current.confidence]) {
      return { next: current, changed: false, corrected: false };
    }
    return {
      next: { ...current, confidence: evidence.confidence, sourceMessageId: input.messageId, language, updatedAt: stamp },
      changed: true,
      corrected: false,
    };
  }

  // Contradiction. Only an equally strong signal may overturn the stored
  // one; otherwise a single loose clause could flip a form the customer
  // stated outright.
  if (CONFIDENCE_RANK[evidence.confidence] < CONFIDENCE_RANK[current.confidence]) {
    return { next: current, changed: false, corrected: false };
  }
  return {
    next: {
      form: evidence.form,
      confidence: evidence.confidence,
      sourceMessageId: input.messageId,
      language,
      updatedAt: stamp,
    },
    changed: true,
    corrected: true,
  };
}

function normalizeLanguage(locale: string | null | undefined): string | undefined {
  if (typeof locale !== "string") return undefined;
  const tag = locale.trim().toLowerCase().split(/[-_]/)[0];
  return tag || undefined;
}

/**
 * Read whatever is stored on the conversation row back into a usable
 * state. Anything malformed collapses to "unknown" rather than throwing:
 * a bad blob must never be able to stop a reply going out.
 */
export function readGrammaticalAddress(raw: unknown): GrammaticalAddress {
  if (!raw || typeof raw !== "object") return UNKNOWN_ADDRESS;
  const src = raw as Record<string, unknown>;
  const form = src.form;
  const confidence = src.confidence;
  const validForm =
    form === "masculine" || form === "feminine" || form === "neutral" || form === "unknown";
  const validConfidence =
    confidence === "explicit" || confidence === "strong_context" || confidence === "unknown";
  if (!validForm || !validConfidence) return UNKNOWN_ADDRESS;
  return {
    form,
    confidence,
    sourceMessageId: typeof src.sourceMessageId === "string" ? src.sourceMessageId : undefined,
    language: typeof src.language === "string" ? src.language : undefined,
    updatedAt: typeof src.updatedAt === "string" ? src.updatedAt : undefined,
  };
}

// ─── Prompt integration ──────────────────────────────────────

/**
 * The instruction the model gets. Three facts and a rule.
 *
 * Deliberately does NOT carry the evidence: not the message it came from,
 * not the words that matched, not a history. Handing the model a
 * transcript of how we decided invites it to reason about the customer's
 * gender out loud, which is precisely the thing that must never reach a
 * customer.
 */
export function grammaticalAddressPromptBlock(
  address: GrammaticalAddress | null | undefined,
  locale: string | null | undefined,
): string | null {
  // Hebrew only, because Hebrew is the only language this module can
  // actually READ evidence for. Emitting the block for Spanish would put
  // Hebrew examples in front of the model and claim a state nothing
  // produces. Adding a language means adding its evidence table first.
  if (!/^(he|iw)/i.test(String(locale ?? "").trim())) return null;
  const state = address ?? UNKNOWN_ADDRESS;

  const header = "# Addressing the customer (grammatical form)";
  const common =
    "This is about grammar, not about the person. Never mention it, never ask about it, " +
    "and never use slash forms (מעוניין/ת, אתה/את) - they read as a form, not a person.";

  if (state.form === "masculine" || state.form === "feminine") {
    const hebrew = state.form === "masculine" ? "masculine (זכר)" : "feminine (נקבה)";
    return [
      header,
      `The customer has used **${hebrew}** forms about themselves in this conversation ` +
        `(confidence: ${state.confidence}).`,
      `Address them in ${state.form} throughout: verbs, adjectives and pronouns all agree. ` +
        "Be consistent within the reply; do not switch mid-message, and do not over-gender - " +
        "one natural agreement is enough, you are not demonstrating it.",
      common,
    ].join("\n\n");
  }

  return [
    header,
    "The customer has not used any form about themselves that distinguishes gender in writing, " +
      "so there is nothing to agree with.",
    "Write NEUTRALLY by RESTRUCTURING the sentence - infinitives, nouns and impersonal phrasing - " +
      "not by hedging. ❌ \"באיזה מוצר אתה מעוניין?\" ✅ \"איזה מוצר מעניין אותך?\" · " +
      "❌ \"האם תרצה שאבדוק?\" ✅ \"אפשר לבדוק עבורך, להמשיך?\" · " +
      "❌ \"מתלבט/ת?\" ✅ \"אפשר לעזור לבחור?\"",
    common,
  ].join("\n\n");
}

// ─── Reply validation ────────────────────────────────────────

/** "מעוניין/ת", "אתה/את", "רוצה/ה" - a form, not a person. */
export const SLASH_FORM_RE = new RegExp(
  `${HB}[\\u0590-\\u05FF]{2,}\\s?/\\s?[\\u0590-\\u05FF]{1,4}${HE}`,
);

/**
 * Second-person address forms whose gender is unambiguous in writing.
 *
 * Two absences are deliberate and both are load-bearing:
 *
 *   • "את" - unvocalized it is ALSO the accusative particle, and "אני
 *     רוצה את זה" appears in a large share of Hebrew sentences. Counting
 *     it as a feminine pronoun would report a conflict on almost every
 *     masculine reply.
 *   • Bare present participles ("מחפש", "צריך", "יכול") - they are the
 *     assistant's own self-reference at least as often as they are an
 *     address to the customer. "אני בודק את זה" is the assistant talking
 *     about itself in its OWN configured gender, and flagging that as an
 *     address conflict would reject correct replies all day.
 *
 * What is left is the second-person future and imperative, where the
 * ת-prefix plus a י-suffix marks the feminine unambiguously, plus the
 * masculine pronoun.
 */
const SECOND_PERSON_MASC = [
  "אתה", "אתכם",
  "תרצה", "תוכל", "תבחר", "תשלח", "תגיד", "תכתוב", "תבדוק", "תעדכן",
  "תמצא", "תקבל", "תראה", "תיתן", "תתקשר", "תצטרך", "תלחץ", "תמלא",
  "בחר", "שלח", "בדוק", "כתוב", "לחץ", "מלא", "תן",
];
const SECOND_PERSON_FEM = [
  "אתן",
  "תרצי", "תוכלי", "תבחרי", "תשלחי", "תגידי", "תכתבי", "תבדקי", "תעדכני",
  "תמצאי", "תקבלי", "תראי", "תתני", "תתקשרי", "תצטרכי", "תלחצי", "תמלאי",
  "בחרי", "שלחי", "בדקי", "כתבי", "לחצי", "מלאי", "תני",
];

const MASC_ADDRESS_RE = new RegExp(
  `${HB}[והש]?(?:${alternation(SECOND_PERSON_MASC)})${HE}`,
  "g",
);
const FEM_ADDRESS_RE = new RegExp(
  `${HB}[והש]?(?:${alternation(SECOND_PERSON_FEM)})${HE}`,
  "g",
);

export interface AddressAgreementVerdict {
  ok: boolean;
  problems: Array<
    | "slash_form_used"
    | "address_form_conflict"
    | "mixed_address_forms"
    | "gendered_address_without_evidence"
  >;
  /** The form the REPLY actually addressed the customer in, if any. */
  replyForm: GrammaticalForm;
}

/**
 * Does this reply agree with what we know?
 *
 * Advisory by design at the "no evidence" end (a gendered guess with no
 * evidence is a style problem, not a falsehood) and hard at the
 * contradiction end: replying in feminine to a customer who has written
 * about themselves in masculine, this conversation, is the failure the
 * whole feature exists to prevent.
 */
export function validateGrammaticalAgreement(
  reply: string | null | undefined,
  address: GrammaticalAddress | null | undefined,
  locale?: string | null,
): AddressAgreementVerdict {
  const problems: AddressAgreementVerdict["problems"] = [];
  const text = String(reply ?? "");
  if (!text.trim() || !isGenderedLanguage(locale ?? "he")) {
    return { ok: true, problems: [], replyForm: "unknown" };
  }

  if (SLASH_FORM_RE.test(text)) problems.push("slash_form_used");

  const masc = countMatches(text, MASC_ADDRESS_RE);
  const fem = countMatches(text, FEM_ADDRESS_RE);

  let replyForm: GrammaticalForm = "unknown";
  if (masc > 0 && fem > 0) {
    problems.push("mixed_address_forms");
  } else if (masc > 0) {
    replyForm = "masculine";
  } else if (fem > 0) {
    replyForm = "feminine";
  } else {
    replyForm = "neutral";
  }

  const known = address?.form === "masculine" || address?.form === "feminine";
  if (known && (replyForm === "masculine" || replyForm === "feminine") && replyForm !== address!.form) {
    problems.push("address_form_conflict");
  }
  if (!known && (replyForm === "masculine" || replyForm === "feminine")) {
    problems.push("gendered_address_without_evidence");
  }

  return { ok: problems.length === 0, problems, replyForm };
}

/**
 * Is this verdict bad enough to reject the draft and regenerate?
 *
 * A gendered guess with no evidence is not: the neutral register is a
 * preference, and rejecting every reply that picks a form would leave the
 * assistant unable to write natural Hebrew at all. Contradicting evidence
 * the customer gave us this conversation IS.
 */
export function shouldRegenerateForAddress(verdict: AddressAgreementVerdict): boolean {
  return (
    verdict.problems.includes("address_form_conflict") ||
    verdict.problems.includes("mixed_address_forms") ||
    verdict.problems.includes("slash_form_used")
  );
}
