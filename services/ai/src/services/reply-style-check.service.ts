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
  | "push_after_ack"
  | "repeated_reply"
  | "phantom_action";

export interface StyleViolation { kind: StyleViolationKind; match: string }

export interface StyleCheckContext {
  locale: "he" | "en";
  /** No earlier outbound message in this conversation. */
  isFirstReply: boolean;
  /** The customer's latest message. */
  incomingMessage: string;
  /** Kept for callers; the customer is always addressed neutrally (Omer, 2026-10-26), whatever form they use. */
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

const BANNED_HE = ["אשמח לעזור", "אשמח לסייע", "בהחלט", "שאלה מצוינת", "עליי לבדוק", "הינו", "הינה", "על מנת", "במידה ו", "אנא", "מתנצלת על אי הנוחות", "מתנצל על אי הנוחות", "אל תהסס", "אל תהססי", "יש לך שאלות נוספות", "המוצר זמין במלאי", "תודה על פנייתך", "אני כאן אם", "במה אוכל לעזור", "איך אפשר לעזור", "מה אפשר לעזור", "עשה רושם", "עושה רושם", "השגנו", "חקרתי", "זיהיתי", "טוב שאלה", "לא משוחק", "ראו למטה", "ראו מטה", "ראוי למטה", "כרטיס המוצר למטה", "בכרטיס למטה", "רואים את כרטיס", "ראה למטה", "ראי למטה", "ראה את הכרטיס", "אותו מטה", "לשלוח שוב את כרטיס", "לשלוח שוב את הכרטיס", "שאעזור להוסיף", "לעזור להוסיף", "חיפוש ראשוני", "בחיפוש הראשוני", "ככרטיס", "להציג כרטיס", "להציג את הכרטיס", "לשלוח כרטיס", "לשלוח את כרטיס", "רואים למטה", "תראו אותו למטה", "יש לשלוח", "יש למלא", "יש לפנות", "נמצאו שתי אופציות", "אופציות רלוונטיות", "להציג את כרטיס", "כרטיס המוצר כדי", "אנחנו לא יכולים לעשות זאת", "לא ניתן לבצע את הבקשה", "נחפר", "כדי שבדיקה תתחיל", "לרצונך"];
const BANNED_EN = ["happy to help", "great question", "i hope this helps", "don't hesitate", "do you have any other questions", "thank you for reaching out", "how can i help you today"];

/**
 * "תרצה/י", "אתה/את", "מעדיף/ה": a gender ending after a slash, 1-3 letters.
 * Two whole words ("אירופה/בריטניה", eval e6 F02) are a list, not a form.
 */
const SLASH = new RegExp(`[${HE}]{2,12}\\/(?:[${HE}]{1,3}|את|אתה)(?![${HE}])|(?<![${HE}])(?:אתה\\/את|את\\/ה)(?![${HE}])`, "u");
/** Second-person forms that choose a gender, addressed to the customer. */
const MASC_TO_CUSTOMER = w("שלח לי|תשלח|תבחר|תוכל|תרצה|תגיד|תן לי|כתוב|תכתוב|לחץ|תלחץ|תזמין|אתה מעוניין|אתה מחפש|מעוניין לשמוע|אם תרצה");
const FEM_TO_CUSTOMER = w("שלחי לי|תשלחי|בחרי|תבחרי|תוכלי|תרצי|תגידי|תני לי|כתבי|תכתבי|לחצי|תזמיני|את מעוניינת|את מחפשת|אם תרצי");
/** "את רוצה", "אתה מחפש": a pronoun and a present-tense verb to the customer (eval e11 E01, F01). */
const PRONOUN_TO_CUSTOMER = new RegExp(`(?<![${HE}])(?:אתה|את)\\s+(?:רוצה|מחפש|מחפשת|צריך|צריכה|מעדיף|מעדיפה|יכול|יכולה|מעוניין|מעוניינת|יודע|יודעת|חושב|חושבת|מתכוון|מתכוונת|אוהב|אוהבת|לובש|לובשת)(?![${HE}])`, "u");
/** A participle that opens a question to the customer: "מעדיפה לראות...?", "מחפש מתנה...?" (eval e11 B01, B03, B04, F01). */
const PARTICIPLE_TO_CUSTOMER = new RegExp(`(?:^|[.!?,:\\n]\\s*)(?:מחפש|מחפשת|מעדיף|מעדיפה|מעוניין|מעוניינת|צריך|צריכה|מתלבט|מתלבטת)(?![${HE}])[^.!?\\n]*[?؟]`, "u");
/** Short imperatives that ARE ordinary words with a prefix ("מראה", "מבחר"): only bare or with ו. */
const IMPERATIVE_MASC = new RegExp(`(?<![${HE}])ו?(?:ראה|שלח|תאר|הוסף|בחר|תראה|תוסיף|תבדוק|בדוק|כנס|היכנס|לך ל|ציין|תציין)(?![${HE}])`, "u");
const IMPERATIVE_FEM = new RegExp(`(?<![${HE}])ו?(?:ראי|שלחי|תארי|הוסיפי|בחרי|תראי|תוסיפי|תבדקי|בדקי|כנסי|היכנסי|לכי ל|צייני|תצייני)(?![${HE}])`, "u");
/** Collecting a phone number or a time for a callback (eval e9 W5, C02). */
const CALLBACK_ASK = /טלפון|מספר נייד|מתי נוח|באיזו שעה|שעה נוחה|phone number|what time/i;
const CALLBACK_WORD = /שיחה|שיחת טלפון|נתקשר|נחזור|יחזרו|יחזור|תחזור|לחזור אליך|יתקשר|call you|call back|callback/i;
/** Telling the customer we will let them know when it is back (eval e11 A05): no tool watches stock for them. */
const NOTIFY_RESTOCK = w("נודיע|שנודיע|אודיע|שאודיע|להודיע לך|להודיע לכם|נעדכן כש|אעדכן כש|לעדכן כש|נשלח עדכון|התראה כש|אימייל או טלפון|מייל או טלפון");
/** Asking for an order number: only with a tool that reads orders. */
const ORDER_NUMBER_ASK = /מספר (?:ה)?הזמנה|order (?:number|no\.?|#)/i;
/** Changing an order the customer already placed: no tool edits one (eval e11 C04). */
const ORDER_CHANGE = w("נשנה|אשנה|שנשנה|שאשנה|נעדכן את ההזמנה|אעדכן את ההזמנה|נחליף לך|אחליף לך|נבטל לך|אבטל לך|לשנות לך את|לבטל לך את");
/** Gathering measurements for work the store does not do (eval e11 C06). */
const CUSTOM_SPEC_ASK = /כמה ס["״']?מ|באיזה אורך|מה האורך|מידות מדויקות|how many (?:cm|centimet)/i;
const CUSTOM_WORK = /התאמה אישית|בהתאמה|להאריך|להארכה|לקצר|לקיצור|הזמנה אישית|בהזמנה מיוחדת|תפירה|custom|made to (?:order|measure)|alter/i;

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
/** Ending on a push to buy or continue: "להמשיך עם הצעיף?", "להוסיף לסל מהכרטיס?", "רוצה שאפתח את כרטיס המוצר?" (eval e11 L01, F01, H01). */
const PUSH_QUESTION = /(?:להמשיך|נמשיך|ממשיכים|להוסיף (?:ל|את|אותו|אותה)|לסל|לעגלה|בעגלה|כרטיס המוצר|כרטיס|להזמין|לרכישה|לקנות|להשלים (?:את )?ה?הזמנה|להגיע לסכום|לשריין|add (?:it )?to (?:your |the )?cart|checkout|place (?:the|an|your) order)[^.!?؟\n]*[?؟]\s*\S{0,3}\s*$/iu;
/** Asking whether to look, when the search tool is right there: "להראות עכשיו צעיפים באפור?" (eval e11 L01). */
const ASK_TO_SHOW = /(?:להראות|להציג|לבדוק|שאבדוק|שנבדוק|שאחפש|שנחפש|לחפש)[^.!?؟\n]*[?؟]\s*\S{0,3}\s*$/iu;
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

const ORDER_READ_TOOL = /get_order|list_orders|list_customer_orders|order_status|find_order/i;
const ORDER_EDIT_TOOL = /update_order|edit_order|cancel_order|change_order|order_edit/i;

/**
 * Details gathered for something no offered tool does (2026-10-26, Omer: "לא
 * מבטיחה מה שלא יכולה"; eval e11 C02 a phone for a callback, A05 a contact for
 * a restock alert, C04 an order change, C06 measurements for custom work). Each
 * match is a phrase to report; none means the reply asks only for what a tool uses.
 */
export function phantomActions(text: string, ctx: Pick<StyleCheckContext, "toolsOffered" | "incomingMessage">): string[] {
  const out: string[] = [];
  const tools = ctx.toolsOffered ?? [];
  const m = (re: RegExp) => text.match(re)?.[0];
  const restock = m(NOTIFY_RESTOCK);
  if (restock) out.push(restock);
  if (!tools.some((t) => ORDER_READ_TOOL.test(t))) { const o = m(ORDER_NUMBER_ASK); if (o) out.push(o); }
  if (!tools.some((t) => ORDER_EDIT_TOOL.test(t))) { const c = m(ORDER_CHANGE); if (c) out.push(c); }
  if (CUSTOM_WORK.test(`${ctx.incomingMessage ?? ""} ${text}`)) { const sp = m(CUSTOM_SPEC_ASK); if (sp) out.push(sp); }
  return out;
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
  // Always neutral, even when the customer wrote "אני מחפשת" or "אחי" (Omer,
  // 2026-10-26; eval e11 F03 "תוכל לבחור", B04 "מעדיפה"): following the
  // customer's form guessed wrong too often to be worth it.
  if (ctx.locale === "he") {
    hit("gendered_address", plain.match(MASC_TO_CUSTOMER) ?? plain.match(IMPERATIVE_MASC));
    hit("gendered_address", plain.match(FEM_TO_CUSTOMER) ?? plain.match(IMPERATIVE_FEM));
    hit("gendered_address", plain.match(PRONOUN_TO_CUSTOMER) ?? plain.match(PARTICIPLE_TO_CUSTOMER));
  }

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
  for (const m of phantomActions(plain, ctx)) hit("phantom_action", m);
  if (ctx.shopFloor) hit("offer_to_check", plain.match(OFFER_TO_CHECK));

  // "We don't have it" on an empty TITLE search is false (eval e5 S1).
  if (ctx.searchesAllEmpty) hit("false_absence", plain.match(ABSENCE));

  // Another script inside a Hebrew reply: "אם تريد" (eval e5 H01).
  if (ctx.locale === "he") hit("foreign_script", plain.match(/[\u0600-\u06FF\u0400-\u04FF]+/u));

  // Asking again, word for word, what she already asked (eval e5 D02, D03).
  const ask = lastQuestion(plain);
  if (ask && (ctx.previousReplies ?? []).some((r) => lastQuestion(r) === ask)) hit("repeated_question", ask);
  // The same reply, word for word, again (eval L01c: "מעולה, שמחים שזה מתאים." twice).
  const norm = (x: string) => x.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
  if (norm(plain).length >= 6 && (ctx.previousReplies ?? []).some((r) => norm(r) === norm(plain))) hit("repeated_reply", plain.slice(0, 60));

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
  gendered_address: { he: "Address the customer neutrally ALWAYS, even when they wrote about themselves as a man or a woman: no gendered verbs, participles or pronouns to them (not \"תוכל\", \"מעדיפה\", \"את רוצה\"). Use \"אפשר\" + infinitive, the plural (\"מחפשים?\", \"מעדיפים?\") or a noun.", en: "Address the customer neutrally." },
  self_gender: { he: "Your own grammatical form is wrong: follow the Persona's gender, or when it is not configured speak as the business in the plural (\"נבדוק\", \"יש לנו\").", en: "Keep your own grammatical form consistent." },
  own_name: { he: "Your name is misspelled. Leave it out unless asked; if needed write it exactly as configured.", en: "Your name is misspelled; leave it out." },
  ungrounded_attribute: { he: "You stated a size, colour, price or stock with no tool result behind it. Remove it, or say you cannot confirm it right now.", en: "Remove the size, colour, price or stock you cannot ground in a tool result." },
  promise: { he: "You promised something no tool does (reserving, holding, calling back, checking with someone, a person getting back). Remove it; say plainly what you CAN do, or quote the store's policy if one covers it.", en: "Remove the promise no tool backs; say what you can do." },
  two_questions: { he: "At most one question.", en: "At most one question." },
  foreign_script: { he: "A word in another script slipped in. Write the whole reply in Hebrew.", en: "A word in another script slipped in; keep one language." },
  repeated_reply: { he: "You already sent exactly this. Say it differently, or more briefly.", en: "You already sent exactly this; say it differently." },
  push_after_ack: { he: "The customer only acknowledged. Reply with a short, warm acknowledgement and no question, no offer, no next step.", en: "The customer only acknowledged: a short acknowledgement, no question or offer." },
  repeated_question: { he: "You already asked exactly this. Do not repeat it: answer what they said, or move on.", en: "You already asked exactly this; do not repeat it." },
  offer_to_check: { he: "Do not end by offering to check: either you know it now (say it) or nothing needs asking. Remove the offer; end on the answer.", en: "Do not end by offering to check; end on the answer." },
  phantom_action: { he: "You asked for details (a phone number, a time, an order number, measurements, a way to notify) for something none of your tools can do. Do not collect them and do not say they were noted. Say plainly, in one sentence, that this is not something we can arrange from here, and offer to pass the conversation to the team here in the chat.", en: "You asked for details for something none of your tools can do. Do not collect them; say plainly it can't be arranged from here and offer to pass the conversation to the team in this chat." },
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
export function polishReply(text: string, opts: { locale: "he" | "en"; productTitles?: string[]; incomingMessage?: string }): string {
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
  if (opts.locale === "he") out = hebrewTouches(out, opts.incomingMessage ?? "");
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
  // Narrating the cards (eval e11 E05: "יש, שמתי עבורך תוצאות חיות למטה. ראו: X",
  // a regenerated reply, so never checked again): the cards speak for themselves.
  if (opts.locale === "he") {
    const narrated = out
      .replace(/\s*שמתי (?:עבורך|לך|לכם)[^.!?\n]*?(?:ל?מטה|חיות)[^.!?\n]*[.!]?/g, "")
      .replace(/\s*ראו:\s*[^.!?\n]*$/g, "")
      .replace(/[,\s]+$/, "")
      .trim();
    if (narrated.length >= 2) out = narrated;
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
}

/** The customer asked how many are left: then a count is the answer. */
const ASKS_QUANTITY = /כמה (?:יחידות|נשאר|נשארו|יש במלאי|פריטים יש)|כמות|how many (?:are )?(?:left|in stock)|quantity/i;

/**
 * Deterministic Hebrew fixes the model keeps getting wrong (eval e11):
 * - "S/XL", "חולצות/סווטשירטים", "להזמנה/למוצר/למשלוח" read as a form: "S או XL",
 *   "להזמנה, למוצר או למשלוח". A gender ending ("תחליט/י") is the checker's, not this.
 * - Unit counts ("נשארו 13 יחידות", "(22 יח')") only when asked, or 3 or fewer.
 * - "ו‑Oat" keeps the no-break hyphen before Latin; before a Hebrew word ("ב‑חום") the prefix attaches.
 * - "Off-White" is one colour ("Off-לבן" came from translating half of it).
 * - "לא נשען" for unworn is "לא נלבש".
 */
function hebrewTouches(text: string, incoming: string): string {
  let out = text
    .replace(/(?<![A-Za-z])off[- ]white(?![A-Za-z])/gi, "אוף וייט")
    .replace(/(?<![\u0590-\u05FF])([ובלהמש])[\u2011\u2010-](?=[\u0590-\u05FF])/gu, "$1")
    .replace(/לא נשען/g, "לא נלבש");
  // Slash lists. URLs and dates are left alone; ו/או is a word.
  out = out.replace(/(?<![\w/:.\u0590-\u05FF])((?:[A-Za-z0-9]{1,4}|[\u0590-\u05FF]{3,})(?:\/(?:[A-Za-z0-9]{1,4}|[\u0590-\u05FF]{3,})){1,5})(?![\w/\u0590-\u05FF])/gu, (whole: string) => {
    const parts = whole.split("/");
    if (parts.every((x) => /^\d+$/.test(x))) return whole;
    return parts.length === 2 ? `${parts[0]} או ${parts[1]}` : `${parts.slice(0, -1).join(", ")} או ${parts[parts.length - 1]}`;
  });
  if (!ASKS_QUANTITY.test(incoming)) {
    const few = (n: string) => Number(n) > 0 && Number(n) <= 3;
    out = out
      .replace(/\s*\((\d+)\s*(?:יח['׳]?|יחידות(?: במלאי)?|במלאי)\)/g, (_m, n) => (few(n) ? " (נשארו אחרונות)" : ""))
      .replace(/,?\s*(?:ו)?נשאר(?:ו|ה)?\s+(?:רק\s+)?(\d+)\s+יחידות?(?:\s+במלאי)?/g, (_m, n) => (few(n) ? ", נשארו אחרונות" : ""))
      .replace(/(\d+)\s+יחידות\s+במלאי/g, (_m, n) => (few(n) ? "נשארו אחרונות" : "במלאי"))
      .replace(/\s+([.,!?])/g, "$1");
  }
  return out;
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
/**
 * A trailing push to buy or continue ("להמשיך עם הצעיף האפור?", eval e11): at
 * most one gentle push per conversation, and never right after a factual answer.
 * Removed in code; unchanged when nothing would remain.
 */
export function stripTrailingPush(reply: string, opts: { incomingMessage: string; earlierReplies: string[] }): string {
  const t = reply.trim();
  const parts = t.split(/(?<=[.!?؟\n])\s+/);
  if (parts.length < 2) return reply;
  const last = parts[parts.length - 1];
  if (!PUSH_QUESTION.test(last)) return reply;
  const askedSomething = /[?؟]/.test(opts.incomingMessage) || /^\s*(?:כמה|מה|איך|יש|האם|מתי|איפה|באיזה|באיזו|למה|אפשר|ו?יש|how|what|is|are|do|does|can)(?=[\s?,.!]|$)/iu.test(opts.incomingMessage);
  const pushedBefore = opts.earlierReplies.some((r) => PUSH_QUESTION.test(r.trim()));
  if (!askedSomething && !pushedBefore) return reply;
  const rest = parts.slice(0, -1).join(" ").trim();
  return rest.length >= 3 ? rest : reply;
}

/** The draft asks whether to look something up instead of looking (eval e11 L01: "להראות עכשיו צעיפים באפור?"). */
export function asksToShowInstead(text: string | null | undefined): boolean {
  return ASK_TO_SHOW.test(String(text ?? "").trim());
}

export function stripTrailingOffer(reply: string): string {
  const t = reply.trim();
  const parts = t.split(/(?<=[.!?؟\n])\s+/);
  if (parts.length < 2) return reply;
  const last = parts[parts.length - 1];
  if (!OFFER_TO_CHECK.test(" " + last)) return reply;
  const rest = parts.slice(0, -1).join(" ").trim();
  return rest.length >= 3 ? rest : reply;
}
