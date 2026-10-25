/**
 * The reply checker (2026-10-25, P3): deterministic checks on the model's
 * draft, before it is rendered and sent. The prompt states every one of these
 * rules and the model still breaks them (eval: slash forms in G02, masculine
 * imperatives, a greeting on every reply, "נועא", reserving stock it cannot
 * reserve). A violation earns ONE regeneration with the specific corrective;
 * the caller sends whatever comes back. Nothing here rewrites meaning.
 *
 * `polishReply` is the part that IS safe to do in code: a colour the store
 * wrote in English said in Hebrew (outside product titles), and "529 ILS"
 * written "₪529".
 */

export type StyleViolationKind =
  | "too_long"
  | "greeting_after_first"
  | "self_intro"
  | "banned_phrase"
  | "slash_form"
  | "gendered_address"
  | "self_gender"
  | "own_name"
  | "ungrounded_attribute"
  | "promise"
  | "two_questions"
  | "question_after_thanks"
  | "false_absence"
  | "offer_to_check";

export interface StyleViolation { kind: StyleViolationKind; match: string }

export interface StyleCheckContext {
  locale: "he" | "en";
  /** No earlier outbound message in this conversation. */
  isFirstReply: boolean;
  /** The customer's latest message. */
  incomingMessage: string;
  /** The customer's known form; anything but explicit masculine/feminine means neutral. */
  customerForm?: { form: string; confidence: string } | null;
  /** The employee's own configured grammatical gender, if any. */
  employeeGender?: "feminine" | "masculine" | null;
  employeeName?: string | null;
  /** A product tool returned a result this turn or earlier in the conversation. */
  productFactsAvailable: boolean;
  /** A shop's employee: only there are size, colour, price and stock product facts. */
  shopFloor: boolean;
  /** Tools offered this turn. */
  toolsOffered: string[];
  /** A handoff to a person actually happened this turn (only that licenses "a person will get back to you"). */
  handedOff?: boolean;
  /** The customer just said thanks or goodbye. */
  customerClosing: boolean;
  /** Every product search this turn came back empty (no title matched). */
  searchesAllEmpty?: boolean;
}

const HE = "\\u0590-\\u05FF";
/** Whole Hebrew word: JS \b does not see Hebrew letters. */
// One attached prefix letter is allowed ("שנשמור", "בשחור", "ואחזור").
const w = (alts: string) => new RegExp(`(?<![${HE}])[ושכלבהמ]?(?:${alts})(?![${HE}])`, "u");

const GREETING_START = /^(?:היי+|הי|שלום|אהלן|הלו|בוקר טוב|ערב טוב|צהריים טובים|hi+|hey+|hello|good (?:morning|afternoon|evening))(?=[\s,.!?:;🙂😊]|$)/iu;
const SELF_INTRO = /(?:^|[\s,.!])(?:אני|כאן)\s+(?:נועה|נועא|מאיה|[A-Z][a-z]+)\s+(?:מ|מצוות|מהצוות|ה)|I(?:'m| am) [A-Z][a-z]+ (?:from|with|at)/u;

const BANNED_HE = ["אשמח לעזור", "אשמח לסייע", "בהחלט", "שאלה מצוינת", "עליי לבדוק", "הינו", "הינה", "על מנת", "במידה ו", "אנא", "מתנצלת על אי הנוחות", "מתנצל על אי הנוחות", "אל תהסס", "אל תהססי", "יש לך שאלות נוספות", "המוצר זמין במלאי", "תודה על פנייתך", "אני כאן אם", "במה אוכל לעזור", "איך אפשר לעזור", "מה אפשר לעזור"];
const BANNED_EN = ["happy to help", "great question", "i hope this helps", "don't hesitate", "do you have any other questions", "thank you for reaching out", "how can i help you today"];

/** "תרצה/י", "אתה/את", "מעדיף/ה": a slash inside or between Hebrew words. */
const SLASH = new RegExp(`[${HE}]{1,12}\\/[${HE}]{1,6}`, "u");
/** Second-person forms that choose a gender, addressed to the customer. */
const MASC_TO_CUSTOMER = w("שלח לי|תשלח|תבחר|תוכל|תרצה|תגיד|תן לי|כתוב|תכתוב|לחץ|תלחץ|תזמין|אתה מעוניין|אתה מחפש|מעוניין לשמוע|אם תרצה");
const FEM_TO_CUSTOMER = w("שלחי לי|תשלחי|בחרי|תבחרי|תוכלי|תרצי|תגידי|תני לי|כתבי|תכתבי|לחצי|תזמיני|את מעוניינת|את מחפשת|אם תרצי");
/** The employee about itself, by gender. */
const SELF_MASC = w("אני (?:לא )?(?:בודק|יכול|מבין|שמח|מצטער|ממליץ|מציע|חושב|רואה)|בודק רגע|שמח לעזור|מצטער על");
const SELF_FEM = w("אני (?:לא )?(?:בודקת|יכולה|מבינה|שמחה|מצטערת|ממליצה|מציעה|חושבת|רואה)|בודקת רגע|שמחה לעזור|מצטערת על");

const COLOUR = /(?<![A-Za-z])(?:black|white|navy|beige|camel|oat|grey|gray|olive|cream|ivory|brown|red|blue|green|pink|ecru|sand|khaki|charcoal|burgundy)(?![A-Za-z])|(?<![\u0590-\u05FF])[ובה]?(?:שחור|שחורה|לבן|לבנה|נייבי|בז'|קאמל|אפור|אפורה|זית|שמנת|חום|חומה|אדום|אדומה|כחול|כחולה|ירוק|ירוקה|ורוד|ורודה)(?![֐-׿])/iu;
const SIZE = /(?:מידה|מידות|size|sizes)\s*(?:XXS|XS|S|M|L|XL|XXL|\d{2})(?![A-Za-z])/i;
const PRICE = /[₪$€]\s?\d|\d\s?(?:₪|ש["״']?ח|שקל|ILS)/i;
const STOCK = w("במלאי|אזל|אזלה|אזלו|נגמר|זמין|זמינה|זמינים") ;

/** Commitments with no tool behind them on a shop floor. */
const RESERVE = w("נשמור לך|אשמור לך|לשמור לך|לשמור עבורך|נשמור עבורך|אשמור עבורך|נשמור את המידה|לשריין|נשריין|אשריין|שמרנו|שמרתי|שריינו|שריינתי|רשמנו לך|רשמתי לך|רשמתי לנציג|רשמנו לנציג");
const FOLLOW_UP = w("אחזור אליך|נחזור אליך|אחזור אלייך|אעדכן אותך|נעדכן אותך|אבדוק ואחזור|נבדוק ונחזור|אבדוק מול|נבדוק מול|אצור קשר|ניצור קשר|נתקשר|אתקשר");
const HANDOFF_PROMISE = w("נציג יחזור|נציגה תחזור|הצוות יחזור|מישהו מהצוות יחזור|יחזרו אליך|העברנו|העברתי|העברנו לצוות|להעביר לצוות|מעבירים לצוות");
/** Ending on an offer to go and check what a tool could check now: "לבדוק אם יש בחום?". */
const OFFER_TO_CHECK = new RegExp(`(?:^|[\\s,.])(?:רוצה ש|שאבדוק|שנבדוק|לבדוק|אפשר לבדוק|נבדוק|אבדוק|shall i check|want me to check|should i check)[^.!?؟\\n]*[?؟]\\s*\\S{0,3}\\s*$`, "iu");

/** Saying the store lacks something, or has none in stock. */
const ABSENCE = w("אין (?:לנו |כרגע |במלאי )?(?:[^.!?\\n]{0,30})?במלאי|אין לנו|לא נמצאו|לא קיים|לא קיימים|אזל|אזלה|אזלו|לא מחזיקים|we don't (?:have|carry)|out of stock|not in stock");

/** The model writes its own Latin name in Hebrew, and gets it wrong. */
const NAME_MISSPELLINGS: Record<string, RegExp> = {
  noa: w("נועא|נואה|נוע'ה|נועע"),
};

function sentences(text: string): number {
  return text.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 1).length;
}

export function checkReplyStyle(draft: string, ctx: StyleCheckContext): StyleViolation[] {
  const text = String(draft ?? "").trim();
  if (!text) return [];
  // PRODUCT_n keys stand for titles; titles may hold colour words the store wrote.
  const plain = text.replace(/PRODUCT_\d+/gi, "המוצר");
  const out: StyleViolation[] = [];
  const hit = (kind: StyleViolationKind, m: RegExpMatchArray | null | string | undefined) => {
    if (m) out.push({ kind, match: typeof m === "string" ? m : m[0] });
  };

  const detailAsked = /פרט|תפרט|הסבר|תסביר|איך (?:עושים|מחזירים|מזמינים)|explain|details|step/i.test(ctx.incomingMessage);
  if (!detailAsked && (sentences(plain) > 3 || plain.length > 360)) hit("too_long", `${sentences(plain)} sentences, ${plain.length} chars`);

  if (!ctx.isFirstReply) hit("greeting_after_first", plain.match(GREETING_START));
  hit("self_intro", plain.match(SELF_INTRO));

  const lower = plain.toLowerCase();
  for (const b of ctx.locale === "he" ? BANNED_HE : BANNED_EN) {
    if (lower.includes(b.toLowerCase())) { hit("banned_phrase", b); break; }
  }

  hit("slash_form", plain.match(SLASH));
  const f = ctx.customerForm;
  const known = f && (f.confidence === "explicit" || f.confidence === "strong_context") ? f.form : null;
  if (known !== "masculine") hit("gendered_address", plain.match(MASC_TO_CUSTOMER));
  if (known !== "feminine") hit("gendered_address", plain.match(FEM_TO_CUSTOMER));

  if (ctx.employeeGender === "feminine") hit("self_gender", plain.match(SELF_MASC));
  else if (ctx.employeeGender === "masculine") hit("self_gender", plain.match(SELF_FEM));
  else hit("self_gender", plain.match(SELF_MASC) ?? plain.match(SELF_FEM));

  const name = (ctx.employeeName ?? "").trim().toLowerCase();
  if (NAME_MISSPELLINGS[name]) hit("own_name", plain.match(NAME_MISSPELLINGS[name]));

  if (ctx.shopFloor && !ctx.productFactsAvailable) {
    hit("ungrounded_attribute", plain.match(SIZE) ?? plain.match(PRICE) ?? plain.match(COLOUR) ?? plain.match(STOCK));
  }

  hit("promise", plain.match(RESERVE) ?? plain.match(FOLLOW_UP));
  if (!ctx.handedOff) hit("promise", plain.match(HANDOFF_PROMISE));
  if (ctx.shopFloor) hit("offer_to_check", plain.match(OFFER_TO_CHECK));

  // "We don't have it" on an empty TITLE search is false (eval e5 S1).
  if (ctx.searchesAllEmpty) hit("false_absence", plain.match(ABSENCE));

  const questions = (plain.match(/[?؟]/g) ?? []).length;
  if (questions > 1) hit("two_questions", `${questions} questions`);
  if (ctx.customerClosing && questions > 0) hit("question_after_thanks", "a question after a thank-you");

  return out;
}

const CORRECTIVE: Record<StyleViolationKind, { he: string; en: string }> = {
  too_long: { he: "Too long. One or two short sentences that answer exactly what was asked.", en: "Too long. One or two short sentences that answer exactly what was asked." },
  greeting_after_first: { he: "Do not greet: this conversation already started. Open with the substance.", en: "Do not greet: this conversation already started. Open with the substance." },
  self_intro: { he: "Do not introduce yourself; the chat already shows who you are.", en: "Do not introduce yourself; the chat already shows who you are." },
  banned_phrase: { he: "Remove the stock phrase and say it the way a person in a shop would.", en: "Remove the stock phrase and say it the way a person would." },
  slash_form: { he: "No slash forms. Rewrite neutrally: \"אפשר לבחור\", \"מה מחפשים?\", an infinitive or the plural.", en: "No slash forms." },
  gendered_address: { he: "The customer's gender is not known: no gendered verbs to them. Use \"אפשר\" + infinitive, the plural (\"מחפשים?\") or a noun.", en: "Address the customer neutrally." },
  self_gender: { he: "Your own grammatical form is wrong: follow the Persona's gender, or when it is not configured speak as the business in the plural (\"נבדוק\", \"יש לנו\").", en: "Keep your own grammatical form consistent." },
  own_name: { he: "Your name is misspelled. Leave it out unless asked; if needed write it exactly as configured.", en: "Your name is misspelled; leave it out." },
  ungrounded_attribute: { he: "You stated a size, colour, price or stock with no tool result behind it. Remove it, or say you cannot confirm it right now.", en: "Remove the size, colour, price or stock you cannot ground in a tool result." },
  promise: { he: "You promised something no tool does (reserving, holding, calling back, checking with someone, a person getting back). Remove it; say plainly what you CAN do, or quote the store's policy if one covers it.", en: "Remove the promise no tool backs; say what you can do." },
  two_questions: { he: "At most one question.", en: "At most one question." },
  offer_to_check: { he: "Do not end by offering to check: either you know it now (say it) or nothing needs asking. Remove the offer; end on the answer.", en: "Do not end by offering to check; end on the answer." },
  false_absence: { he: "The search found no product TITLE by that word; that does not mean the store lacks it. Never say it is out of stock or that we don't have it: say you could not find it by that name (\"לא מצאתי\") and offer another way to look.", en: "Never say it is out of stock or not carried: say you could not find it by that name." },
  question_after_thanks: { he: "The customer thanked you and is closing. Reply with ONLY a short warm close, 2 to 4 words (\"בכיף 🙂\", \"בשמחה, יום טוב!\"). No offer, no product, no next step.", en: "The customer thanked you and is closing. Reply with ONLY a short warm close, 2 to 4 words (\"Anytime 🙂\"). No offer, no product, no next step." },
};

/** The single corrective for the one regeneration, naming each violation. */
export function buildStyleCorrective(violations: StyleViolation[], locale: "he" | "en"): string {
  const kinds = Array.from(new Set(violations.map((v) => v.kind)));
  const lines = kinds.map((k) => {
    const v = violations.find((x) => x.kind === k)!;
    return `- ${CORRECTIVE[k][locale]} (found: "${v.match}")`;
  });
  return `**Rewrite your last draft once, fixing exactly these, and change nothing else (same facts, same products, same language):**\n${lines.join("\n")}\nReply with the rewritten message only.`;
}

const COLOUR_HE: Record<string, string> = {
  black: "שחור", white: "לבן", navy: "כחול נייבי", beige: "בז'", camel: "קאמל",
  grey: "אפור", gray: "אפור", olive: "ירוק זית", cream: "שמנת", ivory: "שנהב", brown: "חום",
  red: "אדום", blue: "כחול", green: "ירוק", pink: "ורוד", ecru: "אקרו", sand: "חול", khaki: "חאקי",
  charcoal: "אפור פחם", burgundy: "בורדו",
};

/**
 * Safe, deterministic touches on the final Hebrew text: a colour written in
 * English becomes Hebrew, except inside a product title the store wrote; and
 * "529 ILS" / "ILS 529" becomes "₪529".
 */
export function polishReply(text: string, opts: { locale: "he" | "en"; productTitles?: string[] }): string {
  if (!text) return text;
  const titles = (opts.productTitles ?? []).filter(Boolean).sort((a, b) => b.length - a.length);
  const held: string[] = [];
  let out = text;
  for (const t of titles) {
    out = out.split(t).join(`\u0000${held.length}\u0000`);
    held.push(t);
  }
  // A title said twice: "X (X)" or "X, X" (eval e5 S5), outside lookup turns too.
  for (let i = 0; i < held.length; i++) {
    const t = `\u0000${i}\u0000`;
    out = out.split(`${t} (${t})`).join(t).split(`${t}, ${t}`).join(t).split(`${t} ${t}`).join(t);
  }
  if (opts.locale !== "he") return out.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
  out = out
    .replace(/(?<![A-Za-z])(black|white|navy|beige|camel|grey|gray|olive|cream|ivory|brown|red|blue|green|pink|ecru|sand|khaki|charcoal|burgundy)(?![A-Za-z])/gi, (m) => COLOUR_HE[m.toLowerCase()] ?? m)
    .replace(/(\d[\d,]*(?:\.\d+)?)\s?ILS\b/g, "₪$1")
    .replace(/\bILS\s?(\d[\d,]*(?:\.\d+)?)/g, "₪$1");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
}

/** The customer's whole message is a thank-you or a goodbye, nothing asked. */
const CLOSING_PHRASE = "(?:(?:ממש |אחלה |מעולה,? |סבבה,? |סופר )?תודה(?: רבה| ענקית| לך| לכם)?|thanks?(?: a lot| so much)?|thank you(?: so much)?|ty|ביי|להתראות|יום טוב|bye|goodbye|شكرا|شكراً|شكرا جزيلا|شكرًا|مع السلامة|باي)";
const ONLY_CLOSING = new RegExp(`^\\s*${CLOSING_PHRASE}(?:[\\s,!.]+${CLOSING_PHRASE})*[\\s!.,🙏❤️🙂😊🌸]*$`, "iu");

/** A reply that is only a short warm close: a few words, no question, no link. */
function isShortClose(reply: string): boolean {
  const t = reply.trim();
  return t.length <= 40 && !/[?؟]/.test(t) && !/https?:\/\//.test(t) && t.split(/\s+/).length <= 6;
}

/**
 * After a bare thank-you or goodbye the reply is a short warm close and nothing
 * else (2026-10-25, eval E04: even the regenerated reply offered to resend a
 * product card). Deterministic: anything more is replaced by the close.
 */
export function closeAfterThanks(reply: string, incomingMessage: string, locale: "he" | "en"): string {
  if (!ONLY_CLOSING.test(incomingMessage ?? "") || (reply.trim() && isShortClose(reply))) return reply;
  return closingReplyFor(incomingMessage, locale) ?? reply;
}

/** The short close for a message that is only thanks or goodbye; null for anything else. */
export function closingReplyFor(incomingMessage: string, locale: "he" | "en"): string | null {
  if (!ONLY_CLOSING.test(incomingMessage ?? "")) return null;
  const bye = /ביי|להתראות|יום טוב|bye|مع السلامة|باي/i.test(incomingMessage);
  // The customer's own script decides: the turn's locale is only he or en.
  if (/[\u0600-\u06FF]/.test(incomingMessage)) return bye ? "مع السلامة!" : "العفو 🙂";
  if (locale === "he") return bye ? "בשמחה, יום טוב!" : "בכיף 🙂";
  return bye ? "Anytime, have a good one!" : "Anytime 🙂";
}
