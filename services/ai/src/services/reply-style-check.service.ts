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
  | "offer_to_check"
  | "foreign_script"
  | "repeated_question"
  | "push_after_ack";

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
  /** The employee's own last replies, newest last. */
  previousReplies?: string[];
}

const HE = "\\u0590-\\u05FF";
/** Whole Hebrew word: JS \b does not see Hebrew letters. */
// One attached prefix letter is allowed ("שנשמור", "בשחור", "ואחזור").
const w = (alts: string) => new RegExp(`(?<![${HE}])[ושכלבהמ]?(?:${alts})(?![${HE}])`, "u");

const GREETING_START = /^(?:היי+|הי|שלום|אהלן|הלו|בוקר טוב|ערב טוב|צהריים טובים|hi+|hey+|hello|good (?:morning|afternoon|evening))(?=[\s,.!?:;🙂😊]|$)/iu;
const SELF_INTRO = /(?:^|[\s,.!])(?:אני|כאן)\s+(?:נועה|נועא|מאיה|[A-Z][a-z]+)\s+(?:מ|מצוות|מהצוות|ה)|I(?:'m| am) [A-Z][a-z]+ (?:from|with|at)/u;

const BANNED_HE = ["אשמח לעזור", "אשמח לסייע", "בהחלט", "שאלה מצוינת", "עליי לבדוק", "הינו", "הינה", "על מנת", "במידה ו", "אנא", "מתנצלת על אי הנוחות", "מתנצל על אי הנוחות", "אל תהסס", "אל תהססי", "יש לך שאלות נוספות", "המוצר זמין במלאי", "תודה על פנייתך", "אני כאן אם", "במה אוכל לעזור", "איך אפשר לעזור", "מה אפשר לעזור", "עשה רושם", "עושה רושם", "השגנו", "חקרתי", "זיהיתי", "טוב שאלה", "לא משוחק", "ראו למטה", "ראו מטה", "ראוי למטה", "כרטיס המוצר למטה", "בכרטיס למטה", "רואים את כרטיס", "ראה למטה", "ראי למטה", "ראה את הכרטיס", "אותו מטה", "לשלוח שוב את כרטיס", "לשלוח שוב את הכרטיס", "שאעזור להוסיף", "לעזור להוסיף", "חיפוש ראשוני", "בחיפוש הראשוני", "ככרטיס", "להציג כרטיס", "להציג את הכרטיס", "לשלוח כרטיס", "לשלוח את כרטיס", "רואים למטה", "תראו אותו למטה", "יש לשלוח", "יש למלא", "יש לפנות", "נמצאו שתי אופציות", "אופציות רלוונטיות", "להציג את כרטיס", "כרטיס המוצר כדי", "אנחנו לא יכולים לעשות זאת", "לא ניתן לבצע את הבקשה", "נחפר", "כדי שבדיקה תתחיל"];
const BANNED_EN = ["happy to help", "great question", "i hope this helps", "don't hesitate", "do you have any other questions", "thank you for reaching out", "how can i help you today"];

/**
 * "תרצה/י", "אתה/את", "מעדיף/ה": a gender ending after a slash, 1-3 letters.
 * Two whole words ("אירופה/בריטניה", eval e6 F02) are a list, not a form.
 */
const SLASH = new RegExp(`[${HE}]{2,12}\\/(?:[${HE}]{1,3}|את|אתה)(?![${HE}])|(?<![${HE}])(?:אתה\\/את|את\\/ה)(?![${HE}])`, "u");
/** Second-person forms that choose a gender, addressed to the customer. */
const MASC_TO_CUSTOMER = w("שלח לי|תשלח|תבחר|תוכל|תרצה|תגיד|תן לי|כתוב|תכתוב|לחץ|תלחץ|תזמין|אתה מעוניין|אתה מחפש|מעוניין לשמוע|אם תרצה");
const FEM_TO_CUSTOMER = w("שלחי לי|תשלחי|בחרי|תבחרי|תוכלי|תרצי|תגידי|תני לי|כתבי|תכתבי|לחצי|תזמיני|את מעוניינת|את מחפשת|אם תרצי");
/** Short imperatives that ARE ordinary words with a prefix ("מראה", "מבחר"): only bare or with ו. */
const IMPERATIVE_MASC = new RegExp(`(?<![${HE}])ו?(?:ראה|שלח|תאר|הוסף|בחר|תראה|תוסיף|תבדוק|בדוק|כנס|היכנס|לך ל|ציין|תציין)(?![${HE}])`, "u");
const IMPERATIVE_FEM = new RegExp(`(?<![${HE}])ו?(?:ראי|שלחי|תארי|הוסיפי|בחרי|תראי|תוסיפי|תבדקי|בדקי|כנסי|היכנסי|לכי ל|צייני|תצייני)(?![${HE}])`, "u");
/** Collecting a phone number or a time for a callback (eval e9 W5, C02). */
const CALLBACK_ASK = /טלפון|מספר נייד|מתי נוח|באיזו שעה|שעה נוחה|phone number|what time/i;
const CALLBACK_WORD = /שיחה|שיחת טלפון|נתקשר|נחזור|יחזרו|לחזור אליך|יתקשר|call you|call back|callback/i;

/** The employee about itself, by gender. */
const SELF_MASC = w("אני (?:לא )?(?:בודק|יכול|מבין|שמח|מצטער|ממליץ|מציע|חושב|רואה|בטוח)|בודק רגע|שמח לעזור|שמח לשמוע|מצטער על|לא בטוח(?! לי)|אני מעביר|מעביר את השיחה|מעביר אותך");
const SELF_FEM = w("אני (?:לא )?(?:בודקת|יכולה|מבינה|שמחה|מצטערת|ממליצה|מציעה|חושבת|רואה|בטוחה)|בודקת רגע|שמחה לעזור|שמחה לשמוע|מצטערת על|לא בטוחה|אני מעבירה|מעבירה את השיחה|מעבירה אותך");

const COLOUR = /(?<![A-Za-z])(?:black|white|navy|beige|camel|oat|grey|gray|olive|cream|ivory|brown|red|blue|green|pink|ecru|sand|khaki|charcoal|burgundy)(?![A-Za-z])|(?<![\u0590-\u05FF])[ובה]?(?:שחור|שחורה|לבן|לבנה|נייבי|בז'|קאמל|אפור|אפורה|זית|שמנת|חום|חומה|אדום|אדומה|כחול|כחולה|ירוק|ירוקה|ורוד|ורודה)(?![֐-׿])/iu;
const SIZE = /(?:מידה|מידות|size|sizes)\s*(?:XXS|XS|S|M|L|XL|XXL|\d{2})(?![A-Za-z])/i;
const PRICE = /[₪$€]\s?\d|\d\s?(?:₪|ש["״']?ח|שקל|ILS)/i;
const STOCK = w("במלאי|אזל|אזלה|אזלו|נגמר|זמין|זמינה|זמינים") ;

/** Commitments with no tool behind them on a shop floor. */
const RESERVE = w("לקבוע תור|נקבע תור|אקבע תור|תור למדידה|שאשלח לאיסוף|אשלח לאיסוף|לסדר איסוף|נסדר איסוף|אסדר איסוף|שאעזור להשלים את ההזמנה|לעזור להשלים את ההזמנה|נשלים את ההזמנה|אשלים את ההזמנה|לשמור מקום|נשמור מקום|נשמור לך|אשמור לך|לשמור לך|לשמור עבורך|נשמור עבורך|אשמור עבורך|נשמור את המידה|לשריין|נשריין|אשריין|שמרנו|שמרתי|שריינו|שריינתי|רשמנו לך|רשמתי לך|רשמתי לנציג|רשמנו לנציג");
/** Adding to the cart: the card's button does it, never the employee (eval e6 A01, A02, A04). */
const ADD_TO_CART = w("אוסיף|נוסיף|שאוסיף|שנוסיף|להוסיף לך|להוסיף עבורך");
const CART = /לסל|לעגלה|לסלסלה|to (?:your |the )?cart/i;
const FOLLOW_UP = w("אחזור אליך|נחזור אליך|אחזור אלייך|אעדכן אותך|נעדכן אותך|אבדוק ואחזור|נבדוק ונחזור|אבדוק מול|נבדוק מול|אצור קשר|ניצור קשר|נתקשר|אתקשר");
const HANDOFF_PROMISE = w("נציג יחזור|נציגה תחזור|הצוות יחזור|מישהו מהצוות יחזור|יחזרו אליך|העברנו|העברתי|העברנו לצוות|להעביר לצוות|מעבירים לצוות");
/** Ending on an offer to go and check what a tool could check now: "לבדוק אם יש בחום?". */
const OFFER_TO_CHECK = new RegExp(`(?:^|[\\s,.])(?:רוצה ש|שאבדוק|שנבדוק|לבדוק|אפשר לבדוק|נבדוק|אבדוק|shall i check|want me to check|should i check)[^.!?؟\\n]*[?؟]\\s*\\S{0,3}\\s*$`, "iu");

/** A customer message that only acknowledges: "מגניב", "סבבה", "אוקיי", "אחלה". */
const ACK_ONLY = /^\s*(?:אוקיי?|אוקי|אוקיי סבבה|סבבה|מגניב|אחלה|יופי|מעולה|טוב|הבנתי|ok(?:ay)?|cool|great|got it|nice)[\s!.,👍🙂😊]*$/iu;

/** Saying the store lacks something, or has none in stock. */
const ABSENCE = w("אין (?:לנו |כרגע |במלאי )?(?:[^.!?\\n]{0,30})?במלאי|אין לנו|לא נמצאו|לא קיים|לא קיימים|אזל|אזלה|אזלו|לא מחזיקים|we don't (?:have|carry)|out of stock|not in stock");

/** The model writes its own Latin name in Hebrew, and gets it wrong. */
const NAME_MISSPELLINGS: Record<string, RegExp> = {
  noa: w("נועא|נואה|נוע'ה|נועע"),
};

/** The last question in a text, normalised, or null. */
function lastQuestion(text: string): string | null {
  const parts = String(text ?? "").split(/(?<=[?؟])/);
  const q = parts.filter((p) => /[?؟]\s*$/.test(p)).pop();
  if (!q) return null;
  const n = q.split(/[.!\n]/).pop()!.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  return n.length >= 6 ? n : null;
}

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
  // A one-line question gets a short answer (eval e8 U7: "כמה עולה משלוח?" got
  // every rate there is): two sentences, not three.
  const oneLine = ctx.incomingMessage.trim().length <= 60 && !/\n/.test(ctx.incomingMessage.trim());
  const maxSentences = oneLine ? 2 : 3;
  if (!detailAsked && (sentences(plain) > maxSentences || plain.length > (oneLine ? 240 : 360))) hit("too_long", `${sentences(plain)} sentences, ${plain.length} chars`);
  // After a plain acknowledgement ("מגניב", "סבבה", "אוקיי") no push and no
  // offer (eval L01 L-3: a cart nudge after every one).
  if (ACK_ONLY.test(ctx.incomingMessage) && /[?؟]/.test(plain)) hit("push_after_ack", "a question after an acknowledgement");

  if (!ctx.isFirstReply) hit("greeting_after_first", plain.match(GREETING_START));
  hit("self_intro", plain.match(SELF_INTRO));

  const lower = plain.toLowerCase();
  for (const b of ctx.locale === "he" ? BANNED_HE : BANNED_EN) {
    if (lower.includes(b.toLowerCase())) { hit("banned_phrase", b); break; }
  }

  hit("slash_form", plain.match(SLASH));
  const f = ctx.customerForm;
  const known = f && (f.confidence === "explicit" || f.confidence === "strong_context") ? f.form : null;
  if (known !== "masculine") hit("gendered_address", plain.match(MASC_TO_CUSTOMER) ?? plain.match(IMPERATIVE_MASC));
  if (known !== "feminine") hit("gendered_address", plain.match(FEM_TO_CUSTOMER) ?? plain.match(IMPERATIVE_FEM));

  if (ctx.employeeGender === "feminine") hit("self_gender", plain.match(SELF_MASC));
  else if (ctx.employeeGender === "masculine") hit("self_gender", plain.match(SELF_FEM));
  else hit("self_gender", plain.match(SELF_MASC) ?? plain.match(SELF_FEM));

  const name = (ctx.employeeName ?? "").trim().toLowerCase();
  if (NAME_MISSPELLINGS[name]) hit("own_name", plain.match(NAME_MISSPELLINGS[name]));

  if (ctx.shopFloor && !ctx.productFactsAvailable) {
    hit("ungrounded_attribute", plain.match(SIZE) ?? plain.match(PRICE) ?? plain.match(COLOUR) ?? plain.match(STOCK));
  }

  hit("promise", plain.match(RESERVE) ?? plain.match(FOLLOW_UP));
  if (CART.test(plain)) hit("promise", plain.match(ADD_TO_CART));
  if (!ctx.handedOff) hit("promise", plain.match(HANDOFF_PROMISE));
  // A time for a phone call is a promise even after a handoff: nobody here can
  // place that call (eval e10 X4: "מתי נוח לקבל שיחה" after a real handoff).
  if (CALLBACK_ASK.test(plain) && CALLBACK_WORD.test(plain)) hit("promise", "collecting details for a callback");
  if (ctx.shopFloor) hit("offer_to_check", plain.match(OFFER_TO_CHECK));

  // "We don't have it" on an empty TITLE search is false (eval e5 S1).
  if (ctx.searchesAllEmpty) hit("false_absence", plain.match(ABSENCE));

  // Another script inside a Hebrew reply: "אם تريد" (eval e5 H01).
  if (ctx.locale === "he") hit("foreign_script", plain.match(/[\u0600-\u06FF\u0400-\u04FF]+/u));

  // Asking again, word for word, what she already asked (eval e5 D02, D03).
  const ask = lastQuestion(plain);
  if (ask && (ctx.previousReplies ?? []).some((r) => lastQuestion(r) === ask)) hit("repeated_question", ask);

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
  foreign_script: { he: "A word in another script slipped in. Write the whole reply in Hebrew.", en: "A word in another script slipped in; keep one language." },
  push_after_ack: { he: "The customer only acknowledged. Reply with a short, warm acknowledgement and no question, no offer, no next step.", en: "The customer only acknowledged: a short acknowledgement, no question or offer." },
  repeated_question: { he: "You already asked exactly this. Do not repeat it: answer what they said, or move on.", en: "You already asked exactly this; do not repeat it." },
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
  // A semicolon reads as a document, not a chat (eval e5 S6): a comma.
  out = out.replace(/(?<!&#?[a-z0-9]{1,8})\s*;\s*/gi, ", ");
  // A word in another script inside a Hebrew reply ("ג'رسي", eval e10 X6) is
  // removed: a regenerated reply is not checked again.
  if (opts.locale === "he") out = out.replace(/\S*[\u0600-\u06FF\u0400-\u04FF]\S*/gu, "").replace(/[ \t]{2,}/g, " ");
  if (opts.locale === "he") out = out
    .replace(/(?<![A-Za-z])(black|white|navy|beige|camel|grey|gray|olive|cream|ivory|brown|red|blue|green|pink|ecru|sand|khaki|charcoal|burgundy)(?![A-Za-z])/gi, (m) => COLOUR_HE[m.toLowerCase()] ?? m)
    .replace(/(\d[\d,]*(?:\.\d+)?)\s?ILS\b/g, "₪$1")
    .replace(/\bILS\s?(\d[\d,]*(?:\.\d+)?)/g, "₪$1");
  // After the colours are Hebrew, so "אפור פחם (Charcoal)" is seen as a repeat
  // (eval e8 U6). A parenthetical that repeats what the sentence already says, or narrates
  // the card (eval e7 T4: "Heavyweight Hoodie במלאי (Heavyweight Hoodie)",
  // "בז' (בז')", "(ראו מטה: Chino Pants)"), is dropped.
  out = out.replace(/\s*\(([^()\n]{1,80})\)/g, (m, inner: string, at: number, whole: string) => {
    const raw = inner.replace(/\u0000(\d+)\u0000/g, (_x, i) => held[Number(i)]).trim();
    if (/(?:ראו|ראוי|רואים|ראי|see)\s*(?:ל?מטה|below)/i.test(raw)) return "";
    const before = whole.slice(0, at).replace(/\u0000(\d+)\u0000/g, (_x, i) => held[Number(i)]);
    return raw && before.toLowerCase().includes(raw.toLowerCase()) ? "" : m;
  });
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

/**
 * "בכיף 🙂" tacked onto a reply that was not answering a thank-you (eval e5
 * A05): removed. Only a trailing close, and only when something else precedes it.
 */
export function stripStrayClose(reply: string, incomingMessage: string): string {
  if (ONLY_CLOSING.test(incomingMessage ?? "") || /תודה|thanks|thank you/i.test(incomingMessage ?? "")) return reply;
  // A close that is its own sentence after the reply, with the brand's
  // endearment and emoji (voice run V02: "באיזו מידה לחפש? בכיף אהובה ❤️").
  const own = reply.replace(
    /([?!.؟\n])\s*(?:בכיף|בשמחה|anytime|my pleasure)(?:\s+(?:אהובה|אהוב|מותק|יקירה|יקרה|מאמי|נשמה|dear))?[\s!.,🙂😊❤️🥰✨🙏]*(?:יום (?:טוב|מצוין|נפלא)[!.]?)?[\s🙂😊❤️🥰✨]*$/iu,
    "$1",
  ).trim();
  if (own !== reply.trim() && own.length >= 3) return own;
  const out = reply.replace(/[\s,]*(?:בכיף|anytime)\s*[🙂😊❤️🙏]*\s*$/iu, "").trim();
  return out.length >= 3 ? out : reply;
}

/** Colour words a customer may use, to the English the store's options are written in. */
const COLOUR_ASK: Array<[RegExp, string[]]> = [
  [/שחור|שחורה|שחורים|שחורות|black/i, ["black"]],
  [/לבן|לבנה|לבנים|לבנות|white/i, ["white"]],
  [/אפור|אפורה|אפורים|grey|gray/i, ["grey", "gray", "charcoal"]],
  [/נייבי|navy/i, ["navy"]],
  [/כחול|כחולה|כחולים|blue/i, ["blue", "navy", "sky"]],
  [/תכלת|sky/i, ["sky"]],
  [/בז'|בז׳|beige/i, ["beige", "sand", "oat"]],
  [/חום|חומה|חומים|brown/i, ["brown", "camel", "chocolate"]],
  [/קאמל|camel/i, ["camel"]],
  [/ירוק|ירוקה|green/i, ["green", "olive", "sage"]],
  [/זית|olive/i, ["olive"]],
  [/אדום|אדומה|אדומים|red/i, ["red", "burgundy"]],
  [/בורדו|burgundy/i, ["burgundy"]],
  [/ורוד|ורודה|pink/i, ["pink", "rose"]],
  [/שמנת|קרם|cream|ecru|ivory/i, ["cream", "ecru", "ivory", "natural"]],
  [/חאקי|khaki/i, ["khaki"]],
];

/** The colours a customer message asks for, as option words to look for; empty when none. */
export function askedColours(text: string | null | undefined): string[] {
  const t = String(text ?? "");
  const out = new Set<string>();
  for (const [re, words] of COLOUR_ASK) if (re.test(t)) words.forEach((w) => out.add(w));
  return Array.from(out);
}

/** Does a variations result (raw REST list) offer one of these colours? */
export function variationsOfferColour(variations: any[], colours: string[]): boolean {
  return variations.some((v) =>
    (Array.isArray(v?.attributes) ? v.attributes : []).some((a: any) => {
      const opt = String(a?.option ?? "").toLowerCase();
      return colours.some((c) => opt.includes(c));
    }),
  );
}

/**
 * The last sentence, when it is only an offer to go and check (eval e8 U1, D02:
 * regenerating over it lost the price, or came back as nothing but "נבדוק?").
 * Removed in code; the rest of the reply stands. Unchanged when nothing remains.
 */
export function stripTrailingOffer(reply: string): string {
  const t = reply.trim();
  const parts = t.split(/(?<=[.!?؟\n])\s+/);
  if (parts.length < 2) return reply;
  const last = parts[parts.length - 1];
  if (!OFFER_TO_CHECK.test(" " + last)) return reply;
  const rest = parts.slice(0, -1).join(" ").trim();
  return rest.length >= 3 ? rest : reply;
}
