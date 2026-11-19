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
  | "ungrounded_price"
  | "promise"
  | "two_questions"
  | "question_after_thanks"
  | "false_absence"
  | "offer_to_check"
  | "foreign_script"
  | "repeated_question"
  | "push_after_ack"
  | "repeated_reply"
  | "phantom_action"
  | "mixed_address"
  | "recap_opener"
  | "long_menu"
  | "latin_titles"
  | "menu_greeting"
  | "echo_opener"
  | "card_narration"
  | "source_leak";

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
  /** The customer asked a colour or a size and no search this turn ran with it (urban-e29). */
  attributeUnsearched?: boolean;
  /** The employee's own last replies, newest last. */
  previousReplies?: string[];
  /** Our last text reply asked something the customer has not answered yet. */
  openQuestion?: boolean;
  /** The store titles this turn's search returned (to spot them in the text). */
  productTitles?: string[];
  /** Tools that actually ran this turn. */
  toolsCalled?: string[];
  /**
   * Everything the reply may take a price from: the prompt (knowledge, policy),
   * this turn's tool results, the conversation and its cards. A price in the
   * reply that is in none of it was made up.
   */
  groundingText?: string;
}

const HE = "\\u0590-\\u05FF";
/** Whole Hebrew word: JS \b does not see Hebrew letters. */
// One attached prefix letter is allowed ("שנשמור", "בשחור", "ואחזור").
const w = (alts: string) => new RegExp(`(?<![${HE}])[ושכלבהמ]?(?:${alts})(?![${HE}])`, "u");

const GREETING_START = /^(?:היי+|הי|שלום|אהלן|הלו|בוקר טוב|ערב טוב|צהריים טובים|hi+|hey+|hello|good (?:morning|afternoon|evening))(?=[\s,.!?:;🙂😊]|$)/iu;
const SELF_INTRO = /(?:^|[\s,.!])(?:אני|כאן)\s+(?:נועה|נועא|מאיה|[A-Z][a-z]+)\s+(?:מ|מצוות|מהצוות|ה)|I(?:'m| am) [A-Z][a-z]+ (?:from|with|at)/u;

export const BANNED_HE = ["אשמח לעזור", "אשמח לסייע", "בהחלט", "שאלה מצוינת", "עליי לבדוק", "הינו", "הינה", "על מנת", "במידה ו", "אנא", "מתנצלת על אי הנוחות", "מתנצל על אי הנוחות", "אל תהסס", "אל תהססי", "יש לך שאלות נוספות", "המוצר זמין במלאי", "תודה על פנייתך", "אני כאן אם", "במה אוכל לעזור", "איך אפשר לעזור", "מה אפשר לעזור", "עשה רושם", "עושה רושם", "השגנו", "חקרתי", "זיהיתי", "טוב שאלה", "לא משוחק", "ראו למטה", "ראו מטה", "ראוי למטה", "כרטיס המוצר למטה", "בכרטיס למטה", "רואים את כרטיס", "ראה למטה", "ראי למטה", "ראה את הכרטיס", "אותו מטה", "לשלוח שוב את כרטיס", "לשלוח שוב את הכרטיס", "שאעזור להוסיף", "לעזור להוסיף", "חיפוש ראשוני", "בחיפוש הראשוני", "ככרטיס", "להציג כרטיס", "להציג את הכרטיס", "לשלוח כרטיס", "לשלוח את כרטיס", "רואים למטה", "תראו אותו למטה", "יש לשלוח", "יש למלא", "יש לפנות", "נמצאו שתי אופציות", "אופציות רלוונטיות", "להציג את כרטיס", "כרטיס המוצר כדי", "אנחנו לא יכולים לעשות זאת", "לא ניתן לבצע את הבקשה", "נחפר", "כדי שבדיקה תתחיל", "לרצונך", "נקודת התחלה", "הראינו", "נמצא שני", "נמצא שתי", "נמצא שלוש", "נמצא כמה", "קיבלתי את התקציב", "להלן", "עצם שמתאים", "עצם שיתאים", "להקפאה"];
export const BANNED_EN = ["happy to help", "great question", "i hope this helps", "don't hesitate", "do you have any other questions", "thank you for reaching out", "how can i help you today"];

/**
 * "תרצה/י", "אתה/את", "מעדיף/ה": a gender ending after a slash, 1-3 letters.
 * Two whole words ("אירופה/בריטניה", eval e6 F02) are a list, not a form.
 */
const SLASH = new RegExp(`[${HE}]{2,12}\\/(?:[${HE}]{1,3}|את|אתה)(?![${HE}])|(?<![${HE}])(?:אתה\\/את|את\\/ה)(?![${HE}])`, "u");
/** Second-person forms that choose a gender, addressed to the customer. A bare imperative is in the lists below. */
const MASC_TO_CUSTOMER = w("אם מחפש|אם אתה|כשאתה|תשלח|תבחר|תוכל|תרצה|תגיד|תכתוב|תלחץ|תזמין|אתה מעוניין|אתה מחפש|מעוניין לשמוע|אם תרצה");
const FEM_TO_CUSTOMER = w("אם מחפשת|אם את מחפשת|כשאת|תשלחי|תבחרי|תוכלי|תרצי|תגידי|תכתבי|תזמיני|את מעוניינת|את מחפשת|אם תרצי");
/** "את רוצה", "אתה מחפש": a pronoun and a present-tense verb to the customer (eval e11 E01, F01). */
const PRONOUN_TO_CUSTOMER = new RegExp(`(?<![${HE}])(?:אתה|את)\\s+(?:רוצה|מחפש|מחפשת|צריך|צריכה|מעדיף|מעדיפה|יכול|יכולה|מעוניין|מעוניינת|יודע|יודעת|חושב|חושבת|מתכוון|מתכוונת|אוהב|אוהבת|לובש|לובשת)(?![${HE}])`, "u");
// About someone else, "איזה צבע היא מעדיפה?" (urban-e33), is not to the customer.
/** A participle that opens a question to the customer: "מעדיפה לראות...?", "מחפש מתנה...?" (eval e11 B01, B03, B04, F01). */
// After a dash too: "הי — מחפש מעיל?" (dev 2026-10-27, urban-e22).
const PARTICIPLE_TO_CUSTOMER = new RegExp(`(?:^|[.!?,:;\\n\u2013\u2014-]\\s*)(?:מחפש|מחפשת|מעדיף|מעדיפה|מעוניין|מעוניינת|צריך|צריכה|מתלבט|מתלבטת)(?![${HE}])[^.!?\\n]*[?؟]|(?<![${HE}])(?:איזה|איזו|מה|באיזה|באיזו)\\s[^.!?\\n]{0,30}?(?<![${HE}])(?<!(?:היא|הוא|הם|הן|הזוג|זוג|הבת|הבן|שלך|שלו|שלה)\\s)(?:מחפש|מחפשת|מעדיף|מעדיפה|מעוניין|מעוניינת|צריך|צריכה)(?![${HE}])[^.!?\\n]*[?؟]`, "u");
/** A participle to the customer opening a clause inside a question, after "או" or a comma: "יותר מתאים לשכבות או מעדיף משהו חם?" (urban-e30). "הבת שלך מחפשת" has its subject. */
const PARTICIPLE_IN_QUESTION = /(?:(?<![\u0590-\u05FF])או\s+|,\s*)(?:מעדיף|מעדיפה|מחפש|מחפשת|מעוניין|מעוניינת|מתלבט|מתלבטת)(?![\u0590-\u05FF])(?=[^.!?؟\n]*[?؟])/u;
/**
 * Short imperatives that ARE ordinary words with a prefix ("מראה", "מבחר"): only bare or with ו.
 * "כתוב" and "לחץ" too (prod replay of 18aedcf2, NE'A: "אפשר לכתוב איזה מוצר" was read as "write!" to a man, and
 * the answer was lost to the product fallback): "לכתוב" is an infinitive, "הכתוב" and "שכתוב" are "written".
 * "לחץ" / "לחצי" only before what is pressed ("לחץ על", "לחצי כאן"): "לחצי שעה" is half an hour, "לחץ המים" is pressure.
 */
const PRESSED = "(?=\\s+(?:על|כאן|פה)(?![\\u0590-\\u05FF]))";
const IMPERATIVE_MASC = new RegExp(`(?<![${HE}])ו?(?:הסתכל|תסתכל|שים לב|ראה|שלח|תאר|הוסף|בחר|תראה|תוסיף|תבדוק|בדוק|כנס|היכנס|לך ל|ציין|תציין|תן לי|כתוב|לחץ${PRESSED})(?![${HE}])`, "u");
const IMPERATIVE_FEM = new RegExp(`(?<![${HE}])ו?(?:הסתכלי|תסתכלי|שימי לב|ראי|שלחי|תארי|הוסיפי|בחרי|תראי|תוסיפי|תבדקי|בדקי|כנסי|היכנסי|לכי ל|צייני|תצייני|תני לי|כתבי|לחצי${PRESSED})(?![${HE}])`, "u");
const FEM_MARK = new RegExp(`(?<![${HE}])(?:את|מחפשת|צריכה|מעדיפה|יכולה|מעוניינת|יודעת|חושבת|מתכוונת|אוהבת|לובשת|מתלבטת)(?![${HE}])`, "u");
const MASC_MARK = new RegExp(`(?<![${HE}])(?:אתה|מחפש|צריך|מעדיף|יכול|מעוניין|יודע|חושב|מתכוון|אוהב|לובש|מתלבט)(?![${HE}])`, "u");
/**
 * The gendered second-person forms a reply uses towards the customer, each with its first match (null: none).
 * The same patterns the gendered_address check reads; a pronoun or a participle is told apart by its first
 * gendered word ("את רוצה" is feminine, "מחפש את המעיל?" is masculine).
 */
export function addressFormsUsed(draft: string): { masculine: string | null; feminine: string | null } {
  const plain = String(draft ?? "").replace(/PRODUCT_\d+/gi, "המוצר");
  let masculine = (plain.match(MASC_TO_CUSTOMER) ?? plain.match(IMPERATIVE_MASC))?.[0] ?? null;
  let feminine = (plain.match(FEM_TO_CUSTOMER) ?? plain.match(IMPERATIVE_FEM))?.[0] ?? null;
  for (const re of [PRONOUN_TO_CUSTOMER, PARTICIPLE_TO_CUSTOMER, PARTICIPLE_IN_QUESTION]) {
    for (const m of plain.matchAll(new RegExp(re.source, `${re.flags.replace("g", "")}g`))) {
      const f = m[0].search(FEM_MARK);
      const k = m[0].search(MASC_MARK);
      if (f >= 0 && (k < 0 || f < k)) feminine ??= m[0].trim();
      else if (k >= 0) masculine ??= m[0].trim();
    }
  }
  return { masculine, feminine };
}

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
/** Saying a detail was recorded ("רשמנו את המספר", eval e11/e14 C02). */
const RECORDED = w("רשמנו|רשמתי|שמרנו את|שמרתי את|קיבלנו את המספר|קיבלתי את המספר|העברנו את המספר|העברתי את המספר");
/** The tools that really record a customer's detail. */
const RECORD_TOOL = /create_lead|create_contact|update_contact|link_customer_identifier|crm|hubspot|monday|airtable|fireberry/i;
const CUSTOM_SPEC_ASK = /כמה ס["״']?מ|באיזה אורך|מה האורך|מידות מדויקות|how many (?:cm|centimet)/i;
const CUSTOM_WORK = /התאמה אישית|בהתאמה|להאריך|להארכה|לקצר|לקיצור|הזמנה אישית|בהזמנה מיוחדת|תפירה|custom|made to (?:order|measure)|alter/i;

/** The employee about itself, by gender. */
/** "מציג/מציגה" opening a sentence is the employee about itself (eval e14 F01): "הנה" instead. */
const SELF_SHOW_MASC = new RegExp(`(?:^|[.!?,\\n]\\s*)(?:אני )?מציג(?![${HE}])`, "u");
const SELF_SHOW_FEM = new RegExp(`(?:^|[.!?,\\n]\\s*)(?:אני )?מציגה(?![${HE}])`, "u");
const SELF_MASC = w("אני (?:לא )?(?:בודק|יכול|מבין|שמח|מצטער|ממליץ|מציע|חושב|רואה|בטוח)|בודק רגע|שמח לעזור|שמח לשמוע|מצטער על|לא בטוח(?! לי)|אני מעביר|מעביר את השיחה|מעביר אותך");
const SELF_FEM = w("אני (?:לא )?(?:בודקת|יכולה|מבינה|שמחה|מצטערת|ממליצה|מציעה|חושבת|רואה|בטוחה)|בודקת רגע|שמחה לעזור|שמחה לשמוע|מצטערת על|לא בטוחה|אני מעבירה|מעבירה את השיחה|מעבירה אותך");

const COLOUR = /(?<![A-Za-z])(?:black|white|navy|beige|camel|oat|grey|gray|olive|cream|ivory|brown|red|blue|green|pink|ecru|sand|khaki|charcoal|burgundy)(?![A-Za-z])|(?<![\u0590-\u05FF])[ובה]?(?:שחור|שחורה|לבן|לבנה|נייבי|בז'|קאמל|אפור|אפורה|זית|שמנת|חום|חומה|אדום|אדומה|כחול|כחולה|ירוק|ירוקה|ורוד|ורודה)(?![֐-׿])/iu;
const SIZE = /(?:מידה|מידות|size|sizes)\s*(?:XXS|XS|S|M|L|XL|XXL|\d{2})(?![A-Za-z])/i;
const PRICE = /[₪$€]\s?\d|\d\s?(?:₪|ש["״']?ח|שקל|ILS)/i;
/** The prices a text states, as plain numbers ("₪389", "349 ש״ח", "1,290 ILS" -> "389", "349", "1290"). */
export function statedPrices(text: string): string[] {
  const out: string[] = [];
  const re = /[₪$€]\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:₪|ש["״']?ח|שקל|ILS)/gi;
  for (const m of text.matchAll(re)) out.push(normalPrice(m[1] ?? m[2] ?? ""));
  return out.filter(Boolean);
}
function normalPrice(n: string): string {
  return n.replace(/,/g, "").replace(/\.0+$/, "");
}
/** The prices in a reply that appear nowhere in what grounds it. */
export function ungroundedPrices(reply: string, grounding: string): string[] {
  const known = new Set(groundedAmounts(grounding));
  return statedPrices(reply).filter((p) => !known.has(p));
}
/**
 * The amounts the grounding states AS money: with a currency, as a price field,
 * or as the customer's budget ("עד 300"). Any number used to count (dev
 * 2026-10-27: "₪29" for shipping passed because "29.5577" sat in a prompt
 * example; the store charges 25).
 */
export function groundedAmounts(grounding: string): string[] {
  const out = new Set(statedPrices(grounding));
  const n = "(\\d[\\d,]*(?:\\.\\d+)?)";
  for (const re of [
    new RegExp(`"(?:regular_|sale_)?price"\\s*:\\s*"?${n}`, "gi"),
    new RegExp(`(?:price|מחיר|עולה|עולות|עולים)\\s*[:=]?\\s*${n}`, "gi"),
    new RegExp(`(?:עד|תקציב(?: של)?|budget(?: of)?|under|up to|מעל|above|over|from|מ-?)\\s*${n}`, "gi"),
    new RegExp(`${n}\\s*(?:NIS|ש["״']?ח|שקלים)`, "gi"),
  ]) for (const m of grounding.matchAll(re)) out.add(normalPrice(m[1]));
  return [...out].filter(Boolean);
}
/** The first price in the text, as written, that nothing in the grounding states; null when none. */
function ungroundedPriceIn(text: string, grounding: string): string | null {
  const made = new Set(ungroundedPrices(text, grounding));
  if (!made.size) return null;
  const re = /[₪$€]\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:₪|ש["״']?ח|שקל|ILS)/gi;
  for (const m of text.matchAll(re)) if (made.has(normalPrice(m[1] ?? m[2] ?? ""))) return m[0];
  return null;
}
/**
 * A made-up price removed in code, when even the rewrite kept it: the price and
 * the verb that carries it ("עולה ₪389", "במחיר 389 ש״ח"), then the punctuation
 * it leaves behind. The rest of the reply stands.
 */
export function stripPrices(reply: string, prices: string[]): string {
  let out = reply;
  for (const p of prices) {
    // "1290" is written "1,290" too.
    const n = p.split(".").map((part, i) => (i ? part : part.split("").join(",?"))).join("\\.");
    const amount = `(?:[₪$€]\\s?${n}(?:\\.0+)?|${n}(?:\\.0+)?\\s?(?:₪|ש["״']?ח|שקל|ILS))`;
    out = out.replace(new RegExp(`\\s*,?\\s*(?:(?:(?<![\u0590-\u05FF])(?:ש)?(?:עולה|עולות|עולים|במחיר(?: של)?|ב[-\u2011]?)|\\b(?:costs?|is|are|for|at|priced at))\\s*)?${amount}`, "gi"), "");
  }
  return out.replace(/\s+([.,!?؟])/g, "$1").replace(/,\s*([.!?؟])/g, "$1").replace(/ {2,}/g, " ").trim();
}
const STOCK = w("במלאי|אזל|אזלה|אזלו|נגמר|זמין|זמינה|זמינים") ;

/** Commitments with no tool behind them on a shop floor. */
const RESERVE = w("לקבוע תור|נקבע תור|אקבע תור|תור למדידה|שאשלח לאיסוף|אשלח לאיסוף|לסדר איסוף|נסדר איסוף|אסדר איסוף|שאעזור להשלים את ההזמנה|לעזור להשלים את ההזמנה|נשלים את ההזמנה|אשלים את ההזמנה|לשמור מקום|נשמור מקום|נשמור לך|אשמור לך|לשמור לך|לשמור עבורך|נשמור עבורך|אשמור עבורך|נשמור את המידה|לשריין|נשריין|אשריין|שמרנו|שמרתי|שריינו|שריינתי|רשמנו לך|רשמתי לך|רשמתי לנציג|רשמנו לנציג");
/** Adding to the cart: the card's button does it, never the employee (eval e6 A01, A02, A04). */
const ADD_TO_CART = w("אוסיף|נוסיף|שאוסיף|שנוסיף|להוסיף לך|להוסיף עבורך");
const CART = /לסל|לעגלה|לסלסלה|to (?:your |the )?cart/i;
const FOLLOW_UP = w("נבדוק (?:את זה )?מי?יד|אבדוק (?:את זה )?מי?יד|נבדוק מי?יד|בודקים מי?יד|אחזור אליך|נחזור אליך|אחזור אלייך|אעדכן אותך|נעדכן אותך|אבדוק ואחזור|נבדוק ונחזור|אבדוק מול|נבדוק מול|אצור קשר|ניצור קשר|נתקשר|אתקשר");
const HANDOFF_PROMISE = w("נציג יחזור|נציגה תחזור|הצוות יחזור|מישהו מהצוות יחזור|יחזרו אליך|העברנו|העברתי|העברנו לצוות|להעביר לצוות|מעבירים לצוות");
/** Ending on an offer to go and check what a tool could check now: "לבדוק אם יש בחום?". */
/** Ending on a push to buy or continue: "להמשיך עם הצעיף?", "להוסיף לסל מהכרטיס?", "רוצה שאפתח את כרטיס המוצר?" (eval e11 L01, F01, H01). */
const PUSH_QUESTION = /(?:להמשיך|נמשיך|ממשיכים|להוסיף (?:ל|את|אותו|אותה)|לסל|לעגלה|בעגלה|כרטיס המוצר|כרטיס|להזמין|לרכישה|לקנות|להשלים (?:את )?ה?הזמנה|להגיע לסכום|לשריין|add (?:it )?to (?:your |the )?cart|checkout|place (?:the|an|your) order)[^.!?؟\n]*[?؟]\s*\S{0,3}\s*$/iu;
/** Asking whether to look, when the search tool is right there: "להראות עכשיו צעיפים באפור?" (eval e11 L01). */
const ASK_TO_SHOW = /(?:להראות|להציג|לבדוק|שאבדוק|שנבדוק|שאחפש|שנחפש|לחפש)[^.!?؟\n]*[?؟]\s*\S{0,3}\s*$/iu;
/** Naming our own sources to the customer (urban-e28). */
const SOURCE_LEAK = /[^.!?؟\n]*(?:(?<![\u0590-\u05FF])[בלהמש]{0,2}(?:מסמכים|מסמך|מסמכי)(?![\u0590-\u05FF])|בסיס (?:ה)?(?:דמו|ידע|נתונים|המידע)|מאגר (?:ה)?(?:ידע|מידע)|דף [A-Z][\w&' -]{2,40}|(?<![\u0590-\u05FF])(?:לפי |ב|מ)?(?:ה)?חיפוש (?:ה)?(?:מהיר|שלי|שלנו|שעשיתי|שביצעתי|שערכתי)(?![\u0590-\u05FF])|knowledge base|our (?:documents?|records|files)|demo (?:base|data)|quick search)[^.!?؟\n]*[.!?؟]?/iu;
const SHOP_DEMO_LEAK = /[^.!?؟\n]*(?:(?<![\u0590-\u05FF])(?:בדמו|לדמו|מהדמו|שבדמו|הדמו)(?![\u0590-\u05FF])|(?:גרסת|סביבת|חנות|אתר) ה?דמו|\bdemo (?:store|site|version)\b)[^.!?؟\n]*[.!?؟]?/iu;

const CARD_NARRATION = /[^.!?؟\n]*(?:(?<![\u0590-\u05FF])[בלה]?(?:כרטיס(?:ים|י)?|כפתור|תמונות)(?![\u0590-\u05FF])(?!\s*(?:אשראי|מתנה|ביקור|חיוב))|הוספ(?:ה|ת) (?:ל)?(?:סל|עגלה)|(?<![\u0590-\u05FF])ש?מתחת(?![\u0590-\u05FF])(?!\s*ל)|\b(?:the )?(?:cards?|buttons?) (?:below|above)\b|add to cart button)[^.!?؟\n]*[.!?؟]?/iu;

/** Offering to show what the cards already show: "אפשר להראות את הפרטים של שניהם?" (urban-e24). */
export const OFFER_SHOW_BOTH = /(?:^|[.!?؟\n]\s*)[^.!?؟\n]*(?:להראות|להציג|לשלוח|שאראה|שאציג|שאשלח)[^.!?؟\n]*(?:שניהם|שתיהן|שלושתם|כולם|both|all of them)[^.!?؟\n]*[?؟]\s*$/iu;
const OFFER_TO_CHECK = new RegExp(`(?:^|[\\s,.])(?:רוצה ש|שאבדוק|שנבדוק|לבדוק|אפשר לבדוק|נבדוק|אבדוק|(?:לשלוח|ש?אשלח|ש?נשלח)(?:\\s+(?:עבורך|לך))?(?:\\s+את)?\\s+(?:ה?פרטי|פרטים|תמונות)|shall i check|want me to check|should i check)[^.!?؟\\n]*[?؟]\\s*\\S{0,3}\\s*$`, "iu");

/** A message that only acknowledges, or carries no words at all (an emoji). */
export function addsNothing(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  return ACK_ONLY.test(t) || !/[\p{L}\p{N}]/u.test(t);
}

/** The customer asks which promotions or coupons there are. */
const PROMOTIONS_ASKED = /מבצע|הנח|קופון|קוד הנחה|\bsales?\b|promo|discount|coupon/i;

/** A customer message that only acknowledges: "מגניב", "סבבה", "אוקיי", "אחלה". */
const ACK_ONLY = /^\s*(?:אוקיי?|אוקי|אוקיי סבבה|סבבה|מגניב|אחלה|יופי|מעולה|טוב|הבנתי|ok(?:ay)?|cool|great|got it|nice)[\s!.,👍🙂😊]*$/iu;

/** Saying the store lacks something, or has none in stock. */
// A stock claim, in any gender or number ("לא נמצאה חולצה לבנה במלאי", eval
// 2026-10-26: the white Oxford shirt was in stock in every size).
const ABSENCE = w("אין (?:לנו |כרגע |במלאי )?(?:[^.!?\\n]{0,30})?במלאי|אין לנו|אין אצלנו|אין כרגע|(?:אינו|אינה|אינם|אינן) (?:זמין|זמינה|זמינים|זמינות)|לא נמצאו|לא נמצא[הו]?(?:[^.!?\\n]{0,30})?במלאי|לא (?:(?:זמין|זמינה|זמינים|זמינות) )?במלאי|חסר[הים]? במלאי|לא קיים|לא קיימים|אזל|אזלה|אזלו|לא מחזיקים|we don't (?:have|carry)|out of stock|not in stock");

/** The model writes its own Latin name in Hebrew, and gets it wrong. */
const NAME_MISSPELLINGS: Record<string, RegExp> = {
  noa: w("נועא|נואה|נוע'ה|נועע"),
};

/** A plural second person to the customer: the last resort, never beside a singular "לך". */
const PLURAL_TO_CUSTOMER = new RegExp(`(?<![${HE}])[ושכ]?(?:מחפשים|מעדיפים|רוצים|צריכים|מתכננים|מעוניינים|אוהבים|תרצו|תוכלו|תבחרו)(?![${HE}])`, "u");
/** A singular "you" suffix, the same for a man and a woman unvocalized: לך, שלך, אשתך. */
const SINGULAR_SUFFIX = new RegExp(`(?<![${HE}])(?:לך|שלך|בשבילך|אצלך|אותך|ממך|עליך|אשתך|בעלך|לאשתך|לבעלך|לחברה שלך)(?![${HE}])`, "u");
/** Openers that recap the customer instead of reacting (Omer, 2026-10-26). */
const RECAP_OPENER = /^\s*(?:נשמע ש|נשמע כמו ש|הבנתי ש|אז את|אז אתה|אז מחפשים|מעולה,? כדי|טוב,? כדי|כדי להציע|כדי שנוכל להציע|כדי שאוכל)/u;
const GREETING_ONLY = /^\s*(?:היי+|הי|שלום|אהלן|הלו|בוקר טוב|ערב טוב|hi+|hey+|hello)[\s!.,🙂😊👋]*$/iu;

/** The last question in a text, raw, or null. */
function lastQuestionRaw(text: string): string | null {
  const parts = String(text ?? "").split(/(?<=[.!\n])\s+/);
  const q = parts.filter((p) => /[?؟]\s*\S{0,3}\s*$/.test(p)).pop();
  return q ?? null;
}

/** How many options a question lists: "שמלה, סריג, מעיל או אקססוריז" is four. */
export function menuSize(question: string): number {
  const OR = /(?<![\u0590-\u05FF])או(?![\u0590-\u05FF])|\bor\b/;
  // A list of sizes is a menu, in parentheses or not: "(XS, S, M, L, XL)",
  // "מבין XS, S, M, L, XL" (dev 2026-10-27).
  const sizes = question.match(/(?<![A-Za-z])(?:XXS|XS|S|M|L|XL|XXL|XXXL)(?![A-Za-z])/g) ?? [];
  if (sizes.length >= 3) return sizes.length;
  // So is any list of three or more in parentheses.
  for (const m of question.matchAll(/\(([^()]*)\)/g)) {
    const items = m[1].split(/,|(?<![\u0590-\u05FF])או(?![\u0590-\u05FF])|\bor\b/).map((x) => x.trim()).filter(Boolean);
    if (items.length >= 3) return items.length;
  }
  const body = question.replace(/\([^()]*\)/g, "");
  // No "או": a question, not a choice ("היי, איך אפשר לעזור?").
  if (!OR.test(body)) return 1;
  const colon = body.lastIndexOf(":");
  const tail = colon >= 0 ? body.slice(colon + 1) : body;
  const items = tail.split(/,|(?<![\u0590-\u05FF])או(?![\u0590-\u05FF])|\bor\b/).map((x) => x.trim()).filter((x) => x.length > 1);
  // Without a colon the first comma part is the question itself ("איזה סוג פריט מעניין, שמלה, ...").
  return colon < 0 && tail.includes(",") ? Math.max(1, items.length - 1) : items.length;
}

/** Two replies that say the same with a word or two changed (urban-e24: "סבבה" got the description again). */
function nearlySame(a: string, b: string): boolean {
  const words = (t: string) => new Set(t.replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 3));
  const x = words(a), y = words(b);
  if (x.size < 5 || y.size < 5) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 0.7;
}

/** The reply's first word when it is the customer's own word echoed back, then a comma or a dash. */
export function echoOpener(text: string, incoming: string): string | null {
  // The word alone, or with a word of praise ("מעיל טוב,", "מעיל מצוין,", urban-e30).
  const m = /^\s*([\p{L}'׳"]{2,})(?:\s+(?:טוב|טובה|מצוין|מצוינת|נהדר|נהדרת|מעולה|יפה|אחלה|מושלם|מושלמת))?\s*[,:\u2013\u2014-]/u.exec(text);
  if (!m) return null;
  const said = new Set(String(incoming ?? "").replace(/[^\p{L}'׳\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 2));
  return said.has(m[1]) ? m[0] : null;
}

/** The content words of a question, to compare two questions by what they offer. */
function questionWords(q: string): Set<string> {
  return new Set(q.replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 3));
}

/** The same choice asked again in other words (Omer, 2026-10-26: the category question twice). */
export function repeatsChoice(draft: string, previous: string[]): string | null {
  const q = lastQuestionRaw(draft);
  if (!q || menuSize(q) < 2) return null;
  const a = questionWords(q);
  for (const r of previous) {
    const pq = lastQuestionRaw(r);
    if (!pq || menuSize(pq) < 2) continue;
    const b = questionWords(pq);
    const shared = [...a].filter((w) => b.has(w)).length;
    if (shared / Math.min(a.size, b.size) >= 0.5) return q.slice(0, 80);
  }
  return null;
}

/** The customer asks to see products: "תראה לי", "show me" (dev 2026-10-27: answered in words, no cards). */
export const SHOW_ME = /(?<![\u0590-\u05FF])(?:תראה|תראי|תראו|הראה|הראי|תציג|תציגי|להראות|להציג)(?![\u0590-\u05FF])|\bshow me\b|\blet me see\b/iu;

/** A gift and a budget in one message: enough to show something. */
export const GIFT_WITH_BUDGET = /(?=.*(?:מתנה|מתנות|\bgift))(?=.*(?:עד|תקציב|budget|under|up to)\s*₪?\s*\d{2,})/isu;

/** The customer does not mind: stop asking and recommend (Omer, 2026-10-26). */
export const DONT_MIND = /לא משנה|סתם מסתכל|סתם|לא יודע|לא יודעת|אין לי מושג|תמליצי|תמליץ|תמליצו|מה שתמליצ|מה שבא לך|מה שאת חושבת|מה שאתה חושב|רק שתהיה|רק שיהיה|תפתיע|הפתיעי|whatever|anything|you choose|surprise me|recommend/i;

/** The last question in a text, normalised, or null. */
function lastQuestion(text: string): string | null {
  const parts = String(text ?? "").split(/(?<=[?؟])/);
  const q = parts.filter((p) => /[?؟]\s*$/.test(p)).pop();
  if (!q) return null;
  const n = q.split(/[.!\n]/).pop()!.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  return n.length >= 6 ? n : null;
}

/**
 * The customer asks for steps: how to install, connect, set up or do
 * something, or for instructions (Omer 2026-11-10, Demo: "מה השלבים להתקנה של
 * מתג לתריס?" was flattened into one paragraph by the length rule).
 */
export function stepsAsked(text: string | null | undefined): boolean {
  return /שלבים|שלב אחר שלב|הוראות|מדריך|איך (?:מתקינים|להתקין|מחברים|לחבר|מגדירים|להגדיר|מפעילים|להפעיל|מאפסים|לאפס|עושים|משייכים|לשייך)|התקנה|להתקין|\bsteps?\b|instructions|how (?:do i|to|can i) (?:install|set ?up|connect|configure|pair|reset|use)|\bsetup\b/i.test(String(text ?? ""));
}

const STEP_LINE = /^\s*(\d{1,2})[.)]\s+\S/;
/**
 * A short numbered list, one step per line: 2 to 6 steps numbered 1, 2, 3...
 * in order, each at most 140 characters, and at most two other lines (a
 * lead-in and a closing question). Anything longer is still too long.
 */
export function isStepList(text: string | null | undefined): boolean {
  const lines = String(text ?? "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const steps = lines.filter((l) => STEP_LINE.test(l));
  if (steps.length < 2 || steps.length > 6 || lines.length - steps.length > 2) return false;
  if (steps.some((l) => l.length > 140)) return false;
  return steps.every((l, i) => Number(STEP_LINE.exec(l)![1]) === i + 1);
}

/**
 * Steps the model wrote inline ("השלבים: 1. לנתק מתח. 2. להסיר את המתג.") go
 * one per line. Only a run numbered 1, 2, 3... in order, each marker after a
 * space or a line start and before a letter, so "₪1.5" or "גרסה 2." stay.
 */
export function stepsOnLines(text: string): string {
  const t = String(text ?? "");
  const marks = [...t.matchAll(/(^|[\s:])(\d{1,2})\.\s+(?=[\p{L}])/gu)];
  const run: number[] = [];
  for (const m of marks) if (Number(m[2]) === run.length + 1) run.push(m.index! + m[1].length);
  if (run.length < 2) return t;
  let out = t;
  for (const at of [...run].reverse()) {
    const before = out.slice(0, at).replace(/[ \t]+$/, "");
    if (!before || before.endsWith("\n")) continue;
    out = `${before}\n${out.slice(at)}`;
  }
  // A closing line after the last step goes on its own line too.
  return out.replace(/^(\d{1,2}\.[^\n]*?[.!])\s+([^\n\d][^\n]*[?؟])\s*$/m, "$1\n$2");
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
export function phantomActions(text: string, ctx: Pick<StyleCheckContext, "toolsOffered" | "incomingMessage" | "toolsCalled"> & { shopFloor?: boolean }): string[] {
  const out: string[] = [];
  const tools = ctx.toolsOffered ?? [];
  const m = (re: RegExp) => text.match(re)?.[0];
  // "רשמנו" with nothing recorded this turn: on a shop floor, or where no tool
  // could record it. A sales employee's "רשמתי את המייל" before its CRM write
  // is the Quality Contract's own 2a, not a phantom.
  const couldRecord = tools.some((t) => RECORD_TOOL.test(t));
  if ((ctx.shopFloor || !couldRecord) && !(ctx.toolsCalled ?? []).some((t) => RECORD_TOOL.test(t))) { const r = m(RECORDED); if (r) out.push(r); }
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

  // Steps asked for and answered as a short numbered list: the list is the answer, not "too long".
  const detailAsked = /פרט|תפרט|הסבר|תסביר|איך (?:עושים|מחזירים|מזמינים)|explain|details|step/i.test(ctx.incomingMessage)
    || (stepsAsked(ctx.incomingMessage) && isStepList(text));
  // A one-line question gets a short answer (eval e8 U7: "כמה עולה משלוח?" got
  // every rate there is): two sentences, not three.
  const oneLine = ctx.incomingMessage.trim().length <= 60 && !/\n/.test(ctx.incomingMessage.trim());
  // "Which promotions are there?" is answered with each of them (dev 2026-10-27:
  // the rewrite for length dropped free shipping over ₪299).
  const maxSentences = oneLine && !PROMOTIONS_ASKED.test(ctx.incomingMessage) ? 2 : 3;
  // A bare "היי!" before the answer is not a sentence of it.
  const counted = sentences(plain.replace(GREETING_START, "").replace(/^[\s,!.🙂😊]+/u, ""));
  // Three short sentences are not long: up to 160 characters they pass (urban-e29:
  // too_long was 4 of 7 rewrites, most of them on short replies).
  const shortEnough = counted <= 3 && plain.length <= 160;
  if (!detailAsked && ((counted > maxSentences && !shortEnough) || plain.length > (oneLine ? 240 : 360))) hit("too_long", `${counted} sentences, ${plain.length} chars`);
  // After a plain acknowledgement ("מגניב", "סבבה", "אוקיי") no push and no
  // offer (eval L01 L-3: a cart nudge after every one). Not when our last
  // reply asked something still open: "סבבה" to "יום-יומי או פורמלי?" answers
  // nothing, and asking the one open thing again is the nudge (dev 2026-10-27:
  // the rewrite came back "מעולה, נשמע מצוין.").
  // Only a push to buy or to continue counts (urban-e23: dropping a plain
  // question left "הנה שתי אופציות שמתאימות." and nothing else).
  if (ACK_ONLY.test(ctx.incomingMessage) && PUSH_QUESTION.test(plain) && !ctx.openQuestion) hit("push_after_ack", "a push after an acknowledgement");

  if (!ctx.isFirstReply) hit("greeting_after_first", plain.match(GREETING_START));
  hit("self_intro", plain.match(SELF_INTRO));

  const lower = plain.toLowerCase();
  // "היי, איך אפשר לעזור?" is the right answer to a bare hello (Omer, 2026-10-26).
  const helloBack = ctx.isFirstReply && GREETING_ONLY.test(ctx.incomingMessage);
  for (const b of ctx.locale === "he" ? BANNED_HE : BANNED_EN) {
    if (helloBack && /אפשר לעזור|how can i help/i.test(b)) continue;
    if (lower.includes(b.toLowerCase())) { hit("banned_phrase", b); break; }
  }

  hit("slash_form", plain.match(SLASH));
  // Always neutral, even when the customer wrote "אני מחפשת" or "אחי" (Omer,
  // 2026-10-26; eval e11 F03 "תוכל לבחור", B04 "מעדיפה"): following the
  // customer's form guessed wrong too often to be worth it.
  if (ctx.locale === "he") {
    hit("gendered_address", plain.match(MASC_TO_CUSTOMER) ?? plain.match(IMPERATIVE_MASC));
    hit("gendered_address", plain.match(FEM_TO_CUSTOMER) ?? plain.match(IMPERATIVE_FEM));
    hit("gendered_address", plain.match(PRONOUN_TO_CUSTOMER) ?? plain.match(PARTICIPLE_TO_CUSTOMER) ?? plain.match(PARTICIPLE_IN_QUESTION));
  }

  if (ctx.employeeGender === "feminine") hit("self_gender", plain.match(SELF_MASC) ?? plain.match(SELF_SHOW_MASC));
  else if (ctx.employeeGender === "masculine") hit("self_gender", plain.match(SELF_FEM) ?? plain.match(SELF_SHOW_FEM));
  else hit("self_gender", plain.match(SELF_MASC) ?? plain.match(SELF_FEM) ?? plain.match(SELF_SHOW_MASC) ?? plain.match(SELF_SHOW_FEM));

  const name = (ctx.employeeName ?? "").trim().toLowerCase();
  if (NAME_MISSPELLINGS[name]) hit("own_name", plain.match(NAME_MISSPELLINGS[name]));

  if (ctx.shopFloor && !ctx.productFactsAvailable) {
    // A price the store's own text states (free shipping over ₪299, a coupon's
    // minimum) is grounded with no product looked up (dev 2026-10-27: the
    // promotions answer lost its coupon to "₪299").
    const price = ctx.groundingText == null ? plain.match(PRICE) : ungroundedPriceIn(plain, ctx.groundingText);
    hit("ungrounded_attribute", plain.match(SIZE) ?? price ?? plain.match(COLOUR) ?? plain.match(STOCK));
  } else if (ctx.shopFloor && ctx.groundingText != null) {
    // Product facts exist, but not THIS price (dev 2026-10-26: "ג'ינס... עולה
    // ₪389" with no tool this turn; the jeans are ₪349 and 389 is nowhere).
    const made = ungroundedPrices(plain, ctx.groundingText);
    if (made.length) hit("ungrounded_price", `₪${made[0]}`);
  }

  hit("promise", plain.match(RESERVE) ?? plain.match(FOLLOW_UP));
  if (CART.test(plain)) hit("promise", plain.match(ADD_TO_CART));
  if (!ctx.handedOff) hit("promise", plain.match(HANDOFF_PROMISE));
  // A time for a phone call is a promise even after a handoff: nobody here can
  // place that call (eval e10 X4: "מתי נוח לקבל שיחה" after a real handoff).
  if (CALLBACK_ASK.test(plain) && CALLBACK_WORD.test(plain)) hit("promise", "collecting details for a callback");
  for (const m of phantomActions(plain, ctx)) hit("phantom_action", m);
  if (ctx.shopFloor) hit("offer_to_check", plain.match(OFFER_TO_CHECK) ?? plain.match(OFFER_SHOW_BOTH));
  // Narrating the cards or their buttons (urban-e25: "מתחת מופיעים הכרטיסים
  // עם הפרטים והוספת סל", "לשניהם יש תמונות וכפתור הוספה לעגלה למטה").
  // "החיוב בכרטיס", "פרטי כרטיס", "אישור עסקה": a payment card, never a product card (rating of dcf2158e: 4 such cuts).
  const cardHit = plain.match(CARD_NARRATION);
  hit("card_narration", cardHit && /(?<![\u0590-\u05FF])[הבול]?(?:חיוב|תשלום|עסקה|אשראי|ויזה|זיכוי|מאסטרקארד)(?![\u0590-\u05FF])|\b(?:charge|payment|transaction|credit|debit)\b/iu.test(cardHit[0]) ? null : cardHit);
  hit("source_leak", plain.match(SOURCE_LEAK));
  // On a shop's floor "the demo" is our test store, never a meeting (urban-e30:
  // "זמן הגעה בדמו"). A sales employee's "לקבוע דמו" is untouched.
  if (ctx.shopFloor) hit("source_leak", plain.match(SHOP_DEMO_LEAK));
  // "מעיל, הנה..." echoes the customer's own word back (urban-e24).
  hit("echo_opener", echoOpener(plain, ctx.incomingMessage));

  // "We don't have it" on an empty TITLE search is false (eval e5 S1).
  // ...and neither is it after a search that never asked for the colour or size
  // the customer named (urban-e29: "אין אצלנו חולצה לבנה" after a search for
  // "shirts"; the white Oxford shirt was in stock).
  if (ctx.searchesAllEmpty || ctx.attributeUnsearched) hit("false_absence", plain.match(ABSENCE));

  // Another script inside a Hebrew reply: "אם تريد" (eval e5 H01).
  if (ctx.locale === "he") hit("foreign_script", plain.match(/[\u0600-\u06FF\u0400-\u04FF]+/u));

  // Asking again, word for word, what she already asked (eval e5 D02, D03).
  const ask = lastQuestion(plain);
  if (ask && (ctx.previousReplies ?? []).some((r) => lastQuestion(r) === ask)) hit("repeated_question", ask);
  else hit("repeated_question", repeatsChoice(plain, ctx.previousReplies ?? []));
  // The same reply, word for word, again (eval L01c: "מעולה, שמחים שזה מתאים." twice).
  const norm = (x: string) => x.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
  if (norm(plain).length >= 6 && (ctx.previousReplies ?? []).some((r) => norm(r) === norm(plain) || nearlySame(r, plain))) hit("repeated_reply", plain.slice(0, 60));

  const questions = (plain.match(/[?؟]/g) ?? []).length;
  if (questions > 1) hit("two_questions", `${questions} questions`);

  if (ctx.locale === "he") {
    // A plural address next to a singular "לך"/"אשתך" in one sentence (Omer,
    // 2026-10-26: "נשמע שמחפשים מתנה איכותית לאשתך").
    for (const sentence of plain.split(/(?<=[.!?؟\n])\s+/)) {
      const pl = sentence.match(PLURAL_TO_CUSTOMER);
      if (pl && SINGULAR_SUFFIX.test(sentence)) { hit("mixed_address", sentence.trim().slice(0, 80)); break; }
    }
    // "נשמע ש...", "הבנתי ש...", "מעולה, כדי להציע": a recap, not a reaction.
    hit("recap_opener", plain.match(RECAP_OPENER));
    // A menu of three or more options in the question (eval: "שמלה, סריג, מעיל או אקססוריז").
    const q = lastQuestionRaw(plain);
    if (q && menuSize(q) >= 3) hit("long_menu", q.slice(0, 80));
    // A bare "היי" gets a short hello and one open question, not a menu.
    if (ctx.isFirstReply && GREETING_ONLY.test(ctx.incomingMessage) && (plain.length > 45 || (q && menuSize(q) >= 2))) hit("menu_greeting", plain.slice(0, 80));
  }
  // Store titles in the sentence: two or more, one in parentheses, or a line
  // that starts with one (Omer: "Cotton Trench Coat, Wool Blend Overcoat. איזה...",
  // "(כמו Wool Blend Overcoat)"). The cards show the titles; the text describes.
  if (ctx.locale === "he") {
    const keys = (text.match(/PRODUCT_\d+/gi) ?? []).length;
    const titles = (ctx.productTitles ?? []).filter((t) => t && text.includes(t)).length;
    if (keys + titles >= 2 || /\([^()]*(?:PRODUCT_\d+|[A-Z][a-z]+ [A-Z][a-z]+)[^()]*\)/.test(text) || /(?:^|\n)\s*(?:PRODUCT_\d+|[A-Z][a-z]+ [A-Z])/.test(text)) {
      hit("latin_titles", text.match(/PRODUCT_\d+|[A-Z][a-z]+(?: [A-Z][a-z]+)+/)?.[0] ?? "titles");
    }
  }
  if (ctx.customerClosing && questions > 0) hit("question_after_thanks", "a question after a thank-you");

  return out;
}

const CORRECTIVE: Record<StyleViolationKind, { he: string; en: string }> = {
  too_long: { he: "Too long. One or two short sentences that answer exactly what was asked.", en: "Too long. One or two short sentences that answer exactly what was asked." },
  greeting_after_first: { he: "Do not greet: this conversation already started. Open with the substance.", en: "Do not greet: this conversation already started. Open with the substance." },
  self_intro: { he: "Do not introduce yourself; the chat already shows who you are.", en: "Do not introduce yourself; the chat already shows who you are." },
  banned_phrase: { he: "Remove the stock phrase and say it the way a person in a shop would.", en: "Remove the stock phrase and say it the way a person would." },
  slash_form: { he: "No slash forms. Rewrite neutrally: \"אפשר לבחור\", \"מה מחפשים?\", an infinitive or the plural.", en: "No slash forms." },
  gendered_address: { he: "Address the customer neutrally ALWAYS, even when they wrote about themselves as a man or a woman: no gendered verbs, participles or pronouns to them (not \"תוכל\", \"מעדיפה\", \"את רוצה\"). First choice, a לך construction, the same for a man and a woman: \"מה בא לך?\", \"מה חשוב לך?\", \"מתאים לך?\". Next, \"אפשר\" + infinitive. The plural only as a last resort.", en: "Address the customer neutrally." },
  mixed_address: { he: "You mixed a plural address with a singular \"לך\" in one sentence (\"מחפשים... לאשתך\"). Use the לך construction throughout: \"מה בא לך לקנות לה?\", \"יש לך כיוון?\".", en: "Do not mix plural and singular address." },
  recap_opener: { he: "Do not open by recapping what they said (\"נשמע ש...\", \"הבנתי ש...\", \"מעולה, כדי להציע...\"). React like a person (\"איזה כיף, מתנה!\") or just answer.", en: "Do not open with a recap of what the customer said; react or answer." },
  long_menu: { he: "Your question lists three or more options. Ask with at most two, or better, show one or two concrete products.", en: "At most two options in a question." },
  latin_titles: { he: "Do not write the store's English titles in the Hebrew sentence: the cards show them. Describe the products in Hebrew in a few words (\"מעיל צמר ארוך ואלגנטי, או טרנץ' קליל\"). Never a title in parentheses, never a line that starts with one.", en: "Do not list product titles in the text; the cards show them." },
  source_leak: { he: "Never name where the information comes from (documents, pages, files, the demo, a knowledge base). If two amounts disagree, give neither: the shipping cost shows at checkout, anything else a person from the team can confirm.", en: "Never name where information comes from; if two amounts disagree, give neither: shipping shows at checkout, anything else the team can confirm." },
  card_narration: { he: "Do not describe the cards, their pictures or buttons (\"מתחת מופיעים הכרטיסים\", \"כפתור הוספה לעגלה\"): they are on screen. Say only what helps choose.", en: "Do not narrate the cards or their buttons." },
  echo_opener: { he: "Do not open by echoing the customer's word back (\"מעיל, הנה...\"). Start with the substance.", en: "Do not open by echoing the customer's word back." },
  menu_greeting: { he: "The customer only said hello. Reply with a short hello and one open question, no menu: \"היי! מה מחפשים?\" or \"היי, איך אפשר לעזור?\".", en: "A short hello and one open question, no menu." },
  self_gender: { he: "Your own grammatical form is wrong: follow the Persona's gender, or when it is not configured speak as the business in the plural (\"נבדוק\", \"יש לנו\").", en: "Keep your own grammatical form consistent." },
  own_name: { he: "Your name is misspelled. Leave it out unless asked; if needed write it exactly as configured.", en: "Your name is misspelled; leave it out." },
  ungrounded_price: { he: "You stated a price that no tool result, card or store information in this conversation shows. Never guess a price: remove it, or search the product first.", en: "You stated a price nothing in this conversation shows. Never guess a price: remove it, or search first." },
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
  // The store's other option names (urban-e32 U5: "ב‑Dusty Rose" in a Hebrew reply).
  "dusty rose": "ורוד מעושן", rose: "ורוד", "washed black": "שחור דהוי", "heather grey": "אפור מלאנז'",
  "heather gray": "אפור מלאנז'", oat: "בז' בהיר", stone: "אבן", sage: "ירוק מרווה", lilac: "לילך",
  mustard: "חרדל", tan: "חום בהיר", purple: "סגול", yellow: "צהוב", orange: "כתום", sky: "תכלת",
};
// Longest first, so "Dusty Rose" is one colour and not "Dusty" and a rose.
const COLOUR_EN = new RegExp(`(?<![A-Za-z])(${Object.keys(COLOUR_HE).sort((a, b) => b.length - a.length).map((k) => k.replace(/ /g, "\\s+")).join("|")})(?![A-Za-z])`, "gi");

/**
 * Safe, deterministic touches on the final Hebrew text: a colour written in
 * English becomes Hebrew, except inside a product title the store wrote; and
 * "529 ILS" / "ILS 529" becomes "₪529".
 */
/**
 * The honest line after an empty search, when even the rewrite still says the
 * store lacks it (the regeneration is not re-checked; this is its backstop).
 */
export function notFoundByNameLine(locale: "he" | "en"): string {
  return locale === "he"
    ? "לא מצאתי את זה בשם הזה. אפשר לנסות לחפש לפי סוג המוצר?"
    : "I couldn't find that by that name. Want to try by the type of product?";
}

/** What no tool here can arrange, said plainly, with the one thing that can (eval e11 C02, A05, C06). */
export function cannotArrangeLine(locale: string): string {
  return locale?.startsWith("he")
    ? "את זה אין לנו אפשרות לסדר מכאן. אפשר להעביר את השיחה לצוות כאן בצ'אט, להעביר?"
    : "That isn't something we can arrange from here. I can pass this conversation to the team here in the chat, shall I?";
}

/** A product fact nothing grounds, when even dropping it leaves nothing true to send. */
export function lookItUpLine(locale: string): string {
  return locale?.startsWith("he")
    ? "כדי לענות על זה בדיוק צריך לחפש את המוצר. איך הוא נקרא?"
    : "To answer that exactly I need to look the product up. What is it called?";
}

/**
 * Telling the customer the cards failed (dev 2026-10-26, conv cmvpghp1…: "מצטערים,
 * לא הצלחנו לשלוח את הקרוסלה כרגע. אפשר לשלוח כרטיס מוצר אחד בכל פעם"). A card that
 * did not go out is our problem, never the customer's news: the sentence goes,
 * and the caller resends what was shown or answers in text.
 */
const CARD_SEND_TROUBLE = new RegExp(
  [
    "(?:לא הצלחנו|לא הצלחתי|לא ניתן|אי אפשר|אין אפשרות|תקלה|בעיה|נכשל)[^.!?؟\\n:]*(?:לשלוח|להציג|קרוסל|כרטיס)",
    "(?:קרוסל|כרטיס)[^.!?؟\\n:]*(?:לא הצלח|נכשל|תקלה|אחד בכל פעם|אחד אחד)",
    "(?:couldn'?t|could not|can'?t|cannot|unable to|failed to)[^.!?\\n:]*(?:send|show|display)[^.!?\\n:]*(?:carousel|cards?)",
    "(?:carousel|cards?)[^.!?\\n:]*(?:failed|didn'?t go|one at a time)",
  ].join("|"),
  "iu",
);

export function cardSendTrouble(text: string | null | undefined): boolean {
  return CARD_SEND_TROUBLE.test(String(text ?? ""));
}

/** The reply without its card-trouble sentences; a question after a colon in one stays ("…: מה בא לך?"). */
export function stripCardSendTrouble(text: string): string {
  const parts = text.split(/(?<=[.!?؟\n])\s+/);
  const kept = parts.flatMap((p) => {
    if (!CARD_SEND_TROUBLE.test(p)) return [p];
    const after = p.split(/:\s+/).slice(1).join(": ").trim();
    return after && !CARD_SEND_TROUBLE.test(after) && /[?؟]\s*$/.test(after) ? [after] : [];
  });
  return kept.join(" ").replace(/^[,\s]+/, "").trim();
}

/** A reply that points at cards below it ("שני מעילים למטה", "the cards below"). */
export function pointsToCardsBelow(text: string | null | undefined): boolean {
  return /למטה|(?:^|\s)below\b/iu.test(String(text ?? ""));
}

/** "Below" said when nothing below was sent: the word goes, the sentence stays. */
export function dropBelow(text: string): string {
  return text.replace(/\s*(?<![\u0590-\u05FF])(?:כאן |פה )?למטה(?![\u0590-\u05FF])/gu, "").replace(/\s+(?:right |just )?below\b/giu, "").replace(/\s+([,.!?؟])/g, "$1").trim();
}

/** When the cards could not be resent: they are still up in the conversation. */
export function cardsAboveLine(locale: string): string {
  return locale?.startsWith("he") ? "המוצרים מופיעים למעלה בשיחה. איזה מהם מעניין?" : "The products are up in the conversation. Which one interests you?";
}

/**
 * "שלח לי" with nothing named, after cards were shown (dev 2026-10-27: "איזה מהם
 * לשלוח לך?" about the two coats just shown twice): the last cards again.
 */
export function asksToResend(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  return t.split(/\s+/).length <= 4 && /(?<![\u0590-\u05FF])(?:שלח|תשלח|שלחי|תשלחי|שלחו|תשלחו)(?![\u0590-\u05FF])|\bsend (?:me|it|them)\b/iu.test(t);
}

/** The line over the cards sent again on request. */
export function sendAgainLine(locale: string): string {
  return locale?.startsWith("he") ? "הנה שוב:" : "Here you go:";
}

/** The customer chose a product: a short, natural acknowledgement before the add-ons. */
export function choiceAckLine(locale: string): string {
  return locale?.startsWith("he") ? "בחירה מצוינת!" : "Great choice!";
}

/** Cards resent because a send failed: the line over them. */
export function cardsAgainLine(locale: string): string {
  return locale?.startsWith("he") ? "הנה הם שוב:" : "Here they are again:";
}

/**
 * What can be fixed in code, with no regeneration (dev 2026-10-27: a rewrite on
 * every turn, 2 to 11s each, mostly for these): our own PRODUCT_n keys in the
 * sentence, a greeting after the first reply, a question after a bare
 * acknowledgement, a trailing offer to check.
 */
export const FIXED_IN_CODE: ReadonlySet<StyleViolationKind> = new Set(["latin_titles", "greeting_after_first", "push_after_ack", "offer_to_check", "echo_opener", "card_narration"]);

/**
 * What a removed title leaves behind (dev 2026-10-27: "מעיל שמתאים לגבר, למשל."):
 * a "למשל" / "כמו" with nothing after it goes, a sentence that ends on a word
 * that needs an object ("את", "של", "עם") goes, and so does a trailing comma.
 */
export function tidyFragments(text: string): string {
  let out = text.replace(/[,\s]*(?<![\u0590-\u05FF])(?:למשל|כמו|כגון|לדוגמה)(?![\u0590-\u05FF])\s*(?=[.!?؟\n]|$)/gu, "");
  // Sentences with the whitespace after each, so a line break stays one.
  const tokens = out.split(/(?<=[.!?؟\n])(\s+)/);
  const pieces: Array<[string, string]> = [];
  for (let i = 0; i < tokens.length; i += 2) pieces.push([tokens[i], tokens[i + 1] ?? ""]);
  const kept = pieces.filter(([p]) => !/(?<![\u0590-\u05FF])(?:את|של|עם|על|אל)\s*[.!?؟]?\s*$/u.test(p.trim()));
  if (kept.length) out = kept.map(([p, sep]) => p + sep).join("");
  return out.replace(/,\s*(?=[.!?؟]|$)/g, "").trim();
}

/** The PRODUCT_n keys out of the sentence: the cards show the products. */
export function stripProductKeys(text: string): string {
  return tidyFragments(stripKeysOnly(text));
}

function stripKeysOnly(text: string): string {
  return text
    .replace(/\s*\(\s*PRODUCT_\d+\s*\)/gi, "")
    .replace(/PRODUCT_\d+(?:\s*(?:,|(?<![\u0590-\u05FF])ו[-\u2010\u2011]?|\band\b|&)\s*PRODUCT_\d+)*/gi, "")
    .replace(/[:,]\s*(?=[.!?؟]|$)/g, "")
    .replace(/\s+([.,!?؟:;])/g, "$1")
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * The draft with the in-code kinds fixed. The caller re-checks it and
 * regenerates only when something remains.
 */
export function fixInCode(text: string, violations: StyleViolation[]): string {
  const kinds = new Set(violations.map((v) => v.kind));
  let out = text;
  if (kinds.has("latin_titles")) out = stripProductKeys(out);
  if (kinds.has("greeting_after_first")) out = out.replace(GREETING_START, "").replace(/^[\s,!.🙂😊]+/u, "").trim();
  if (kinds.has("push_after_ack")) {
    const parts = out.split(/(?<=[.!?؟\n])\s+/).filter((p) => p.trim());
    while (parts.length > 1 && /[?؟]\s*\S{0,3}\s*$/.test(parts[parts.length - 1])) parts.pop();
    out = parts.join(" ").trim();
  }
  if (kinds.has("offer_to_check")) {
    // "אפשר להראות את הפרטים של שניהם?" asks to show what the cards show: the
    // preference is the question (urban-e24).
    const tokens = out.split(/(?<=[.!?؟\n])(\s+)/);
    const last = tokens[tokens.length - 1] ?? "";
    if (tokens.length > 1 && OFFER_SHOW_BOTH.test(last)) {
      tokens[tokens.length - 1] = /[a-z]/i.test(last) ? "Which one suits you better?" : "מה מתאים לך יותר?";
      out = tokens.join("");
    } else out = stripTrailingOffer(out);
  }
  if (kinds.has("card_narration")) {
    // The sentence that narrates the cards goes; the cards speak for themselves.
    const parts = out.split(/(?<=[.!?؟\n])\s+/).filter((p) => p.trim());
    const kept = parts.filter((p) => !CARD_NARRATION.test(p));
    if (kept.length && kept.length < parts.length) out = kept.join(" ");
  }
  if (kinds.has("echo_opener")) {
    const echo = violations.find((v) => v.kind === "echo_opener")?.match;
    if (echo && out.startsWith(echo.trimStart())) out = out.slice(echo.trimStart().length).trim();
  }
  return out;
}

/**
 * The products to show, named on a line of their own (urban-e23): "SHOW:
 * PRODUCT_1, PRODUCT_2" as the model's last line, never inside a sentence.
 * The text without that line, and the keys it named.
 */
export function takeShowLine(text: string | null | undefined): { text: string; keys: string[] } {
  const keys: string[] = [];
  const take = (list: string) => { for (const k of list.match(/PRODUCT_\d+/gi) ?? []) keys.push(k.toUpperCase()); return ""; };
  const out = String(text ?? "")
    .replace(/^[ \t]*SHOW[ \t]*:[ \t]*(.*)$/gim, (_m, list: string) => take(list))
    // Inline at the end of a sentence (urban-e32 U4: "...שכנראה תאהב. SHOW: PRODUCT_1",
    // and the customer saw "SHOW").
    .replace(/[ \t]*\bSHOW[ \t]*:[ \t]*(PRODUCT_\d+(?:[ \t]*,[ \t]*PRODUCT_\d+)*)[ \t]*/g, (_m, list: string) => take(list));
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), keys: [...new Set(keys)] };
}

/**
 * Does the text describe more products than the cards show (P5, Tehila
 * cmw26crzp 13:51: three scarves described, one card, "אנה")? With SHOW keys:
 * more keys than cards that went out. Without: one card, and the text speaks
 * of several ("כמה", "שלוש", "אפשרויות", or a list: two commas or more).
 */
export function proseOutnumbersCards(text: string | null | undefined, keys: number, cards: number): boolean {
  if (cards <= 0) return false;
  if (keys > 0) return keys > cards;
  if (cards !== 1) return false;
  const t = String(text ?? "");
  return /(?<![א-ת])(?:כמה|שלוש|שלושה|שתי|שני|שניים|שתיים|אפשרויות|דגמים|מבחר)(?![א-ת])|\b(?:several|a few|two|three|options)\b/i.test(t)
    || (t.match(/,/g) ?? []).length >= 2;
}

/**
 * Offers the bot cannot carry out (P4): sending something over another
 * channel ("לשלוח הוראות מדויקות לתיבת וואטסאפ או אימייל?", Tehila
 * cmw4lyhod), "checking" a product detail it should answer from what it read
 * ("נוכל לבדוק עבורך איזה חומר בכל דגם, להמשיך?", 15:40), telling the
 * customer when something is back, a preorder ("לבדוק אפשרות להזמנה מראש?",
 * Smoovee). And a colour or size question when no product shown comes in more
 * than one ("איזה צבע מעניין אותך?" over three single-colour surfaces).
 */
const UNBACKED_OFFER = /(?:לשלוח|ששלח|שאשלח|נשלח)[^.!?؟\n]*(?:וואטסאפ|ווטסאפ|whatsapp|אימייל|מייל|email|sms|הודעת טקסט)|(?:לבדוק|נבדוק|אבדוק|שאבדוק|שנבדוק)[^.!?؟\n]*(?:חומר|מידות|מידה|אורך|רוחב|גודל|זמינות|מלאי|אפשרות|הזמנה מראש|דגם)|(?:להודיע|לעדכן|שאודיע|שאעדכן|נעדכן|נודיע)[^.!?؟\n]*(?:כש|ברגע ש|when)|הזמנה מראש|להזמין מראש|pre-?order|(?:send|email|text)[^.!?\n]*(?:whatsapp|e-?mail|sms)|(?:let you know|notify you) when/iu;
const CHOICE_QUESTION = /(?:איזה|איזו|באיזה|באיזו|איזה סוג של)\s+(?:צבע|גוון|מידה|גודל)|which (?:colou?r|size)|what (?:colou?r|size)/iu;

export function unbackedOffer(
  reply: string,
  o: { locale: "he" | "en"; canHandOver: boolean; shownOptions?: { colours: boolean; sizes: boolean } },
): { text: string; kind: "offer" | "choice" | null } {
  const t = String(reply ?? "").trim();
  const parts = t.split(/(?<=[.!?؟\n])\s+/);
  const last = parts[parts.length - 1] ?? "";
  if (!/[?؟]\s*\S{0,3}\s*$/.test(last)) return { text: reply, kind: null };
  const rest = parts.slice(0, -1).join(" ").trim();
  if (UNBACKED_OFFER.test(last)) {
    const team = o.locale === "he" ? "רוצים שאעביר את השאלה לצוות שיחזור אליכם?" : "Would you like me to pass your question to the team so they can get back to you?";
    if (o.canHandOver) return { text: rest ? `${rest}\n${team}` : team, kind: "offer" };
    return rest.length >= 3 ? { text: rest, kind: "offer" } : { text: reply, kind: null };
  }
  if (o.shownOptions && CHOICE_QUESTION.test(last)) {
    const colour = /צבע|גוון|colou?r/i.test(last), size = /מידה|גודל|size/i.test(last);
    if ((colour && !o.shownOptions.colours) || (size && !o.shownOptions.sizes)) return rest.length >= 3 ? { text: rest, kind: "choice" } : { text: reply, kind: null };
  }
  return { text: reply, kind: null };
}

/** Do the products shown come in more than one colour / size? Read from their store text ("צבע: אדום, כחול"). */
export function shownOptionsOf(details: Array<string | undefined>): { colours: boolean; sizes: boolean } {
  const many = (re: RegExp) => details.some((d) => { const m = re.exec(String(d ?? "")); return !!m && /,/.test(m[1]); });
  return { colours: many(/(?:צבע|גוון|colou?r)[^:·]{0,12}:\s*([^·]*)/i), sizes: many(/(?:מידה|מידות|גודל|size)[^:·]{0,12}:\s*([^·]*)/i) };
}

// ─── The final gate (urban-e23) ──────────────────────────────────────────────
//
// Every transform that removes text left new broken punctuation, and the
// patches stacked. So the text that leaves is normalised once, at the end, and
// checked once: a fragment, a key or a store title, a dangling word, a gendered
// address, a "הנה" over no cards. The caller then drops the sentence, rewrites
// once, or sends a safe line; it never sends the fragment.

/** Punctuation that removals leave behind: ",:" / "-," / ":," / " ," / a leading comma / double spaces. */
export function normalizePunctuation(text: string): string {
  return String(text ?? "")
    .replace(/[ \t]*([,:;–—-](?:[ \t]*[,:;–—-])+)[ \t]*/g, (m) => {
      const first = m.match(/[,:;]/)?.[0] ?? ",";
      return `${first} `;
    })
    .replace(/[ \t]*[,:;][ \t]*(?=[.!?؟])/g, "")
    .replace(/[ \t]+([.,!?؟:;])/g, "$1")
    .replace(/^[\s,:;.–—-]+/u, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    // A blank line between two lines of a chat message reads as a gap (urban-e27).
    .replace(/\n[ \t]*\n+/g, "\n")
    .trim();
}

/** A masculine product noun with a feminine adjective in the same phrase: "מעיל ... ארוך וחמימה" (urban-e27). */
const NOUN_AGREEMENT = /(?<![\u0590-\u05FF])[הוב]?(?:מעיל|צעיף|כובע|סוודר|קרדיגן|ז'קט|תיק|חגור|טרנץ')(?![\u0590-\u05FF])[^.,!?؟\n]{0,30}?(?<![\u0590-\u05FF])ו?(?:חמימה|חמה|ארוכה|קלה|רכה|יפה|קצרה|נוחה|אלגנטית|קלאסית)(?![\u0590-\u05FF])/u;

const DANGLING_END = /(?<![֐-׿])(?:למשל|כמו|כגון|לדוגמה|את|של|עם|על|אל)\s*[.!?؟,:]?\s*$/u;
/** "באיזו מידה בדרך כלל?": a question with no verb (urban-e23). */
const VERBLESS_QUESTION = /(?:^|[.!?؟\n]\s*)(?:באיזו|באיזה|איזו|איזה)\s+\S+(?:\s+\S+)?\s+בדרך כלל\s*[?؟]/u;
const POINTS_AT_PRODUCTS = /(?<![֐-׿])הנה(?![֐-׿])|\bhere (?:are|is)\b/iu;
/** Saying products are shown, at any length (urban-e29: "מוצגות כמה חלופות קרובות." over no cards). */
const SAYS_SHOWN = /(?<![\u0590-\u05FF])(?:מוצגות|מוצגים|מוצג|מוצגת|מצורפות|מצורפים|מצורף|מצורפת|הצגתי|הצגנו)(?![\u0590-\u05FF])|\b(?:shown|attached) (?:below|here)\b/iu;

// ─── Transliterated title words (urban-e28: "קרופד הודי", "כובע צמר ריב") ─────
//
// The store's titles are English; the reply describes them in Hebrew. A Hebrew
// word that only spells an English title word ("קרופד" = Cropped) is caught by
// comparing consonant skeletons. Real Hebrew loanwords stay.

const LOANWORDS = new Set(["כותנה", "פופלין", "טרנץ", "קרדיגן", "מרינו", "גינס", "גקט", "זקט", "קפוצון", "סוודר", "טישירט", "דנים", "פשתן", "קשמיר", "סקיני", "וופל", "סווטשירט", "ספורטיבי", "קלאסי", "קלאסית", "אוקספורד", "גרזי", "פליז", "קורדרוי", "צינו", "קשמיר", "טוויד", "פלנל"]);
// b and v/w are one class: ב is both, and "אוברשירט" spells Overshirt.
const PRODUCT_OR_MATERIAL = /(?:כובע|חולצ|מעיל|צעיף|תיק|סוודר|שמל|מכנס|גופי|קפוצ'ון|ז'קט|ג'קט|צמר|כותנה|פשתן|עור|ג'ינס|סריג)/u;
/** Everyday Hebrew words whose consonants happen to spell a title word ("שירות" ~ Shirt). */
const COMMON_WORDS = new Set(["שירות", "שירותים", "שירותי", "משלוח", "שורה", "שורות", "סרט", "קורס", "בלוג", "קלים", "שלום", "בולט", "בולטת", "בולטים", "בולטות"]);
const EN_CLASS: Record<string, string> = { b: "B", c: "K", k: "K", q: "K", d: "D", f: "P", p: "P", g: "G", j: "G", h: "H", l: "L", m: "M", n: "N", r: "R", s: "S", z: "Z", t: "T", v: "B", w: "B", x: "KS" };
const HE_CLASS: Record<string, string> = { "ב": "B", "כ": "K", "ך": "K", "ק": "K", "ד": "D", "פ": "P", "ף": "P", "ג": "G", "ל": "L", "מ": "M", "ם": "M", "נ": "N", "ן": "N", "ר": "R", "ס": "S", "ש": "S", "ז": "Z", "ת": "T", "ט": "T", "צ": "TS", "ץ": "TS" };

function enSkeleton(word: string): string {
  const w = word.toLowerCase().replace(/ph/g, "f").replace(/ck/g, "k").replace(/[^a-z]/g, "");
  let out = "";
  for (const [i, ch] of [...w].entries()) {
    const c = i === 0 && ch === "h" ? "H" : ch === "h" ? "" : EN_CLASS[ch] ?? "";
    if (c && !out.endsWith(c)) out += c;
  }
  return out;
}

function heSkeleton(word: string): string {
  const w = word.replace(/['"׳״]/g, "");
  let out = "";
  for (const [i, ch] of [...w].entries()) {
    // ה, ו, י, א, ע are vowels here, except a ה or ו that opens the word.
    const c = i === 0 && ch === "ה" ? "H" : i === 0 && ch === "ו" ? "B" : HE_CLASS[ch] ?? "";
    if (c && !out.endsWith(c)) out += c;
  }
  return out;
}

/** "kpd" in order inside "krpd"? */
function inOrder(small: string, big: string): boolean {
  let j = 0;
  for (const ch of big) if (ch === small[j]) j++;
  return j === small.length;
}

/** The first Hebrew word that only spells one of these English title words; null when none. */
export function transliteratedTitleWord(text: string, titles: string[]): string | null {
  const words = new Set(titles.flatMap((t) => String(t ?? "").split(/[^A-Za-z]+/)).filter((w) => w.length >= 4).map((w) => w.toLowerCase()));
  const skeletons = [...words].map(enSkeleton).filter((k) => k.length >= 2);
  if (!skeletons.length) return null;
  const tokens = String(text ?? "").match(/[\u0590-\u05FF'׳"]{2,}/g) ?? [];
  for (const [idx, raw] of tokens.entries()) {
    if (raw.replace(/['"׳״]/g, "").length < 3) continue;
    // A short skeleton counts only beside a product or material word ("כובע צמר ריב").
    const afterProduct = idx > 0 && PRODUCT_OR_MATERIAL.test(tokens[idx - 1]);
    const unquoted = raw.replace(/['"׳״]/g, "");
    const bare = unquoted.replace(/^[ובלהמש](?=[\u0590-\u05FF]{3,})/, "");
    if (LOANWORDS.has(bare) || LOANWORDS.has(unquoted) || COMMON_WORDS.has(bare) || COMMON_WORDS.has(unquoted)) continue;
    const he = heSkeleton(bare);
    if (he.length < 2) continue;
    for (const en of skeletons) {
      // The whole word (3+ consonants), most of a long one in order, or a short
      // stem of a short one ("ריב" for Ribbed). Precision over recall: a miss
      // costs a word, a false hit costs a rewrite of a good reply.
      if ((he.length >= 4 && he === en) || (he.length === 3 && he === en && afterProduct) || (he.length >= 4 && inOrder(he, en) && he.length / en.length >= 0.75) || (he.length === 2 && afterProduct && bare === unquoted && !/^[ובלהמש]/.test(bare) && en.length === 3 && en.startsWith(he) && bare.length <= 4)) return raw;
    }
  }
  return null;
}

// An apology or a search's "not found", and nothing else in the sentence that
// moves on. "אין לנו משלוח לאילת." is an answer, not a dead end.
const DEAD_END = /^(?:(?:אנחנו |אני )?(?:מצטער|מצטערת|מצטערים|לצערי|סליחה)[,.!\s]*)?(?:(?:לצערי |כרגע |עדיין )?(?:לא (?:מצאנו|מצאתי|נמצאו|נמצא|הצלחנו למצוא|הצלחתי למצוא))(?:(?!אבל|אך |יש |במקום|אולי|אפשר)[^.!?؟])*)?[.!]?$|^(?:(?:i'm|we're) )?sorry[.!]?$|^(?:(?:sorry|unfortunately),? )?(?:we|i) (?:couldn'?t|could not|didn'?t) find(?:(?!but |however|instead|there)[^.!?])*[.!]?$/iu;

// Two amounts for one shipping cost ("עולה כ ₪25, ₪29", "בין ₪25 ל־₪29", urban-e32
// U4): the knowledge disagrees and the price is undecided, so neither is said.
const MONEY_RE = String.raw`(?:[₪$€]\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(?:₪|ש["״']?ח|ILS|NIS))`;
const TWO_AMOUNTS = new RegExp(`(?:${MONEY_RE}|(\\d+(?:\\.\\d+)?))\\s*(?:[–—-]|,|או|עד|ל[־-]?|to|or)\\s*${MONEY_RE}`, "giu");
function twoShippingPrices(sentence: string): boolean {
  if (!/משלוח|דמי (?:ה)?משלוח|shipping|delivery/iu.test(sentence)) return false;
  for (const m of sentence.matchAll(TWO_AMOUNTS)) {
    const first = m[1] ?? m[2] ?? m[3];
    const second = m[4] ?? m[5];
    if (first && second && Number(first) !== Number(second)) return true;
  }
  return false;
}

// Size, in a question ("איזו מידה מתאימה לך?", "יש צבע או מידה מועדפים?").
const SIZE_WORD = /(?<![\u0590-\u05FF])[בה]?מיד(?:ה|ות)(?![\u0590-\u05FF])|\bsizes?\b/iu;
const sentencesIn = (t: string) => t.split(/(?<=[.!?؟\n])\s+/).filter((p) => p.trim());
const asksSizeIn = (sentence: string) => SIZE_WORD.test(sentence) && /[?؟]\s*$/.test(sentence);
// The customer gave a size.
const GIVES_SIZE = /(?<![A-Za-z])(?:xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl)(?![A-Za-z])|(?<![\u0590-\u05FF])[בה]?מיד(?:ה|ות)(?![\u0590-\u05FF])|\bsize\b|(?<!\d)\d{2}(?!\d)/iu;

/**
 * The size question once more, after the customer let it pass (urban-e33 U1:
 * "יש צבע או מידה מועדפים?", "בשבילי לגבר", "איזה מידה מתאימה לך?"): the
 * question goes, the rest stays. Unchanged when the last reply asked nothing
 * about size, the customer gave one, or nothing would be left.
 */
export function dropIgnoredSizeQuestion(text: string, previousReplies: string[], incoming: string): string {
  const last = previousReplies[previousReplies.length - 1] ?? "";
  if (!sentencesIn(last).some(asksSizeIn) || GIVES_SIZE.test(incoming ?? "")) return text;
  const parts = sentencesIn(text);
  const kept = parts.filter((p) => !asksSizeIn(p));
  if (kept.length === parts.length) return text;
  const out = kept.join(" ").trim();
  return out.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= 3 ? out : text;
}

export interface FinalGateContext extends StyleCheckContext {
  /** Cards go out with this message. */
  cardsShown: boolean;
  /** A support turn (a fault, setting up, an order): Latin technical terms ("Access Point", "Wi-Fi") are not store titles. */
  supportTurn?: boolean;
}

/** What is wrong with the text as it would leave; empty when it may go. */
export function finalTextIssues(text: string, ctx: FinalGateContext): string[] {
  const t = String(text ?? "").trim();
  const out: string[] = [];
  if (!t) return ["empty"];
  if (/PRODUCT_\d+/i.test(t)) out.push("key");
  // Any SHOW left anywhere, with or without its colon (urban-e32: "...תאהב. SHOW").
  if (/^[ \t]*SHOW[ \t]*:/im.test(t) || /(?<![A-Za-z])SHOW(?![A-Za-z])/.test(t)) out.push("show_line");
  if (ctx.locale === "he" && ctx.cardsShown && (ctx.productTitles ?? []).some((x) => x && t.includes(x))) out.push("title");
  const sentencesOf = t.split(/(?<=[.!?؟\n])\s+/).map((x) => x.trim()).filter(Boolean);
  // A line ending in ":" over the cards ("עוד מוצרים שיכולים להתאים לך:") introduces them.
  if (sentencesOf.some((x) => DANGLING_END.test(x) && !(ctx.cardsShown && /:\s*$/.test(x)))) out.push("dangling");
  if (VERBLESS_QUESTION.test(t)) out.push("verbless_question");
  const words = t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (words < 3 && !/:\s*$/.test(t) && !ctx.customerClosing) out.push("too_short");
  if (!ctx.cardsShown && ((POINTS_AT_PRODUCTS.test(t) && !/[?؟]/.test(t) && words <= 6) || SAYS_SHOWN.test(t))) out.push("points_at_nothing");
  // Over new cards, a question and nothing else says nothing about them
  // ("היי! איזו מידה מתאימה לך?", urban-e27): one line about them first.
  if (ctx.cardsShown && !/:\s*$/.test(t) && sentencesOf.every((x) => /[?؟]\s*$/.test(x) || GREETING_ONLY.test(x))) out.push("question_only");
  // Only "sorry, we found nothing" with nothing on screen and nothing asked
  // (urban replay 2026-10-28: the checker cut the question and a bare
  // apology went out): a dead end, never a reply.
  if (!ctx.cardsShown && sentencesOf.every((x) => !/[?؟]\s*$/.test(x) && DEAD_END.test(x))) out.push("dead_end");
  if (sentencesOf.some(twoShippingPrices)) out.push("two_prices");
  if (ctx.locale === "he" && NOUN_AGREEMENT.test(t)) out.push("agreement");
  if (ctx.locale === "he" && transliteratedTitleWord(t, ctx.productTitles ?? [])) out.push("transliteration");
  // A store title in the Hebrew sentence with no card under it (urban-e28:
  // "אצלנו יש Lambswool Scarf במחיר מבצע", answered from the knowledge text).
  // Not on a support turn: troubleshooting names "Access Point", "Wi-Fi Direct"
  // (Demo 2026-11-10: the whole answer became the safe line over "Access Point").
  if (ctx.locale === "he" && !ctx.cardsShown && !ctx.supportTurn && /\b[A-Z][a-z]{2,}(?: [A-Z][a-z]{2,})+\b/.test(t)) out.push("title");
  // A rewrite is not style-checked again, and urban-e26's came back as the
  // previous reply nearly word for word.
  const norm = (x: string) => x.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
  // Our own short lines ("הנה שוב:", "בכיף 🙂") may recur; only a real reply counts.
  if (words >= 5 && (ctx.previousReplies ?? []).some((r) => norm(r) === norm(t) || nearlySame(r, t))) out.push("repeated");
  for (const v of checkReplyStyle(t, ctx)) {
    if (v.kind === "gendered_address" || v.kind === "mixed_address") out.push("gendered");
    if (v.kind === "banned_phrase") out.push("calque");
    if (v.kind === "card_narration") out.push("card_narration");
    if (v.kind === "source_leak") out.push("source_leak");
  }
  return [...new Set(out)];
}

/** The text without the sentences that carry a dangling word or a gendered address; null when that leaves too little. */
export function dropBrokenSentences(text: string, ctx: FinalGateContext): string | null {
  const parts = text.split(/(?<=[.!?؟\n])\s+/).filter((p) => p.trim());
  const kept = parts.filter((p) => {
    const issues = finalTextIssues(p, { ...ctx, customerClosing: true });
    return !issues.includes("dangling") && !issues.includes("gendered") && !issues.includes("verbless_question") && !issues.includes("card_narration") && !issues.includes("source_leak") && !issues.includes("points_at_nothing");
  });
  if (kept.length === parts.length || !kept.length) return null;
  // The only question, with nothing on screen, carried the turn: dropping it
  // leaves "אפשר לעזור לבחור מתנה עד ₪300." (urban-e24). Rewrite instead.
  if (!ctx.cardsShown && parts.some((p) => /[?؟]\s*$/.test(p)) && !kept.some((p) => /[?؟]\s*$/.test(p))) return null;
  const out = normalizePunctuation(kept.join(" "));
  const words = out.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return words >= 4 && !finalTextIssues(out, ctx).length ? out : null;
}

/** The safe line for the turn, when even one rewrite is not clean. */
export function safeTurnLine(locale: string, o: { cardsShown: boolean; cardCount: number }): string {
  const he = locale?.startsWith("he");
  if (o.cardsShown) return he ? (o.cardCount === 1 ? "הנה אפשרות שיכולה להתאים:" : "הנה כמה אפשרויות שיכולות להתאים:") : (o.cardCount === 1 ? "Here is one that could fit:" : "Here are a few that could fit:");
  return he ? "אפשר לפרט קצת יותר מה מחפשים?" : "Could you tell me a bit more about what you're looking for?";
}

/** The one clean rewrite's instruction, naming what was wrong. */
export function finalRewriteInstruction(text: string, issues: string[], locale: "he" | "en"): string {
  return [
    `Your message as it would be sent: «${text}»`,
    `It is not ready (${issues.join(", ")}). Rewrite it once as complete, natural ${locale === "he" ? "Hebrew" : "English"} sentences that keep what it says:`,
    "- no product key (PRODUCT_1), no store title, no SHOW line: the cards show the products;",
    "- address the customer neutrally (no gendered verb, participle or pronoun);",
    "- no fragment, no dangling word, every question with a verb; adjectives agree with their noun (מעיל חם, not חמה);",
    "- over cards just shown, one short line about them first, then at most one question;",
    "- never what you already said in an earlier message: if it was a repeat, say something new in one short line (the one open question, or a light nudge);",
    "- never name where information comes from (documents, pages, the demo, our search);",
    "- never two prices or a range for one shipping cost: say the exact cost shows at checkout;",
    "- never only an apology or a \"not found\": say what there is, or ask one short question that moves on;",
    "- describe products in plain Hebrew words, never an English title word in Hebrew letters (not \"קרופד הודי\" but \"קפוצ'ון קצר\");",
    "- one or two short sentences. Reply with the message only.",
  ].join("\n");
}

/** The kinds that make a reply untrue, not just unpolished. */
const TRUTH_KINDS: ReadonlySet<StyleViolationKind> = new Set(["ungrounded_price", "ungrounded_attribute", "false_absence", "phantom_action", "promise", "source_leak"]);

/** The reply without the sentence that carries this text; unchanged when no sentence does. */
function dropSentenceWith(text: string, match: string): string {
  const needle = match.trim();
  if (!needle) return text;
  const parts = text.split(/(?<=[.!?؟\n])\s+/);
  const kept = parts.filter((p) => !p.includes(needle));
  return kept.length === parts.length ? text : kept.join(" ").trim();
}

/**
 * The rewrite, checked like the draft (Omer's eval, 2026-10-26: titles, "לא
 * נמצאה במלאי" and a made-up ₪389 all came out of a rewrite, which nothing
 * checked). Style leftovers pass; anything untrue is fixed in code:
 *   - collecting details for what no tool does: the "can't arrange" line;
 *   - "out of stock" after an empty title search: the not-found line;
 *   - a price nothing grounds: removed;
 *   - a promise, or a size / colour / price / stock with no product facts at
 *     all: its sentence dropped;
 *   - and when something untrue is still there, or nothing is left: a plain line.
 * A trailing offer to check or to send details is dropped on a shop's floor.
 */
export function finalizeRewrite(text: string, ctx: StyleCheckContext): { text: string; fixed: string[] } {
  const untrue = (t: string) => checkReplyStyle(t, ctx).filter((v) => TRUTH_KINDS.has(v.kind));
  const fixed: string[] = [];
  let out = text;
  let left = untrue(out);
  if (left.some((v) => v.kind === "phantom_action" || (v.kind === "promise" && /callback/.test(v.match)))) {
    return { text: cannotArrangeLine(ctx.locale), fixed: ["cannot_arrange_line"] };
  }
  if (left.some((v) => v.kind === "false_absence")) return { text: notFoundByNameLine(ctx.locale), fixed: ["not_found_line"] };
  if (ctx.shopFloor && left.some((v) => v.kind === "ungrounded_price")) {
    // Sentence by sentence: the price comes out, and a sentence left with
    // fewer than three words ("הג'ינס.", "The jeans.") goes with it.
    const made = ungroundedPrices(out, ctx.groundingText ?? "");
    const parts = out.split(/(?<=[.!?؟\n])\s+/).map((p) => {
      if (!ungroundedPrices(p, ctx.groundingText ?? "").length) return p;
      const stripped = stripPrices(p, made);
      return stripped.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= 3 ? stripped : "";
    });
    const next = parts.filter(Boolean).join(" ").trim();
    if (next !== out) { out = next; fixed.push("price_removed"); }
  }
  for (const v of untrue(out)) {
    if (v.kind !== "promise" && v.kind !== "ungrounded_attribute" && v.kind !== "source_leak") continue;
    const dropped = dropSentenceWith(out, v.match);
    if (dropped !== out) { out = dropped; fixed.push(`${v.kind}_dropped`); }
  }
  if (ctx.shopFloor) {
    const trimmed = stripTrailingOffer(out);
    if (trimmed !== out) { out = trimmed; fixed.push("offer_dropped"); }
  }
  // A gendered address the rewrite kept ("הי, מחפש מעיל?", urban-e22): its
  // sentence goes when something else is left. Omer's rule, not a style hint.
  for (const v of checkReplyStyle(out, ctx).filter((x) => x.kind === "gendered_address")) {
    const dropped = dropSentenceWith(out, v.match);
    if (dropped !== out && dropped.trim()) { out = dropped; fixed.push("gendered_dropped"); }
  }
  left = out.trim() ? untrue(out) : [];
  // What is left once the untrue part is gone is only an offer ("לשלוח את
  // פרטי המוצר ותמונות?"): nothing was answered, so say what is needed.
  const onlyOffer = fixed.length > 0 && OFFER_TO_CHECK.test(" " + out.trim());
  if (!out.trim() || left.length || onlyOffer) {
    const promise = left.some((v) => v.kind === "promise" || v.kind === "phantom_action");
    return { text: promise ? cannotArrangeLine(ctx.locale) : lookItUpLine(ctx.locale), fixed: [...fixed, "plain_line"] };
  }
  return { text: out, fixed };
}

/**
 * Hebrew verb forms the model gets wrong, fixed in code (P6, Tehila): "רוצים
 * שאנחם אתכם" is "to console you", not "to guide you" (שאנחה); "להתאם איסוף"
 * is no word (לתאם). Whole words only; a form that is a real word elsewhere is
 * fixed only in the phrase it was wrong in.
 */
const HEBREW_FORM_FIXES: Array<[RegExp, string]> = [
  [/(?<![א-ת])(ש?)אנחם(?=\s+(?:אתכם|אותכם|אותך|אתך|אתכן|אותכן)(?![א-ת]))/gu, "$1אנחה"],
  [/(?<![א-ת])(ש?)ננחם(?=\s+(?:אתכם|אותכם|אותך|אתך)(?![א-ת]))/gu, "$1ננחה"],
  [/(?<![א-ת])להתאם(?![א-ת])/gu, "לתאם"],
];
export function fixHebrewForms(text: string): string {
  let t = String(text ?? "");
  for (const [re, to] of HEBREW_FORM_FIXES) t = t.replace(re, to);
  return t;
}

export function polishReply(text: string, opts: { locale: "he" | "en"; productTitles?: string[]; incomingMessage?: string; cardsShown?: boolean }): string {
  if (!text) return text;
  text = fixHebrewForms(text);
  // Invisible direction marks copied from scraped pages ("‎₪299", urban-e26):
  // the chat lays out the text itself; a stray mark only shifts it.
  text = text.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
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
  // With cards out, two or more English titles in the Hebrew sentence (eval e14
  // B04, K01, F01: "Cotton Trench Coat, טרנץ' כותנה קל, Chunky Cardigan, סריג
  // עבה"): a title followed by its Hebrew description loses the title. The
  // regenerated reply is never checked again, so this is the backstop.
  if (opts.locale === "he" && opts.cardsShown) {
    const TITLE = "(?:\u0000\\d+\u0000|[A-Z][A-Za-z'’-]+(?: (?:[A-Z0-9][A-Za-z'’-]*|&))+)";
    const named = (out.match(new RegExp(TITLE, "g")) ?? []).length;
    if (named >= 2) out = out.replace(new RegExp(`${TITLE}\\s*[,:]\\s*(?=[\u0590-\u05FF])`, "g"), "");
    // Every store title the search returned, one or many, comes out of the
    // Hebrew sentence with the punctuation around it: the cards carry it (dev
    // 2026-10-27: "מעיל טרנץ' קליל, Cotton Trench Coat, ומעיל...", "המעיל Wool
    // Blend Overcoat מופיע"). Between two separators the first one stays. A
    // title fused to a Hebrew prefix ("ה-Chunky Cardigan, סריג עבה, עולה ₪529")
    // is the sentence's subject and stays (eval e14 AD1).
    out = out.replace(/(?<![\u0590-\u05FF][-\u2010\u2011])(\s*[,:;\u2013\u2014]\s*|\s*-\s+)?(?<![\u0590-\u05FF][-\u2010\u2011])\u0000\d+\u0000(\s*[,:;\u2013\u2014]\s*|\s+-\s*)?/g, (_m, before?: string, after?: string) =>
      before && after ? `${before.trim()} ` : before || after ? "" : " ");
    out = out.replace(/^[\s,:;\u2013\u2014-]+/, "").replace(/\s+([.,!?؟:])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
    out = tidyFragments(out);
  }
  // A code and what it gives, joined by a wide dash ("welcome10 — 10% הנחה"):
  // a colon. Left as a dash, the outbox's number-range guard read "10 — 10"
  // as a range and sent "welcome10-10%" (dev 2026-10-27, urban-e22).
  out = out.replace(/([A-Za-z][A-Za-z0-9]*\d)\s*[\u2013\u2014\u2015]\s*(?=\d)/g, "$1: ");
  // A semicolon reads as a document, not a chat (eval e5 S6): a comma.
  out = out.replace(/(?<!&#?[a-z0-9]{1,8})\s*;\s*/gi, ", ");
  // A word in another script inside a Hebrew reply ("ג'رسي", eval e10 X6) is
  // removed: a regenerated reply is not checked again.
  if (opts.locale === "he") out = out.replace(/\S*[\u0600-\u06FF\u0400-\u04FF]\S*/gu, "").replace(/[ \t]{2,}/g, " ");
  if (opts.locale === "he") out = hebrewTouches(out, opts.incomingMessage ?? "");
  if (opts.locale === "he") out = out
    .replace(COLOUR_EN, (m) => COLOUR_HE[m.toLowerCase().replace(/\s+/g, " ")] ?? m)
    .replace(/(\d[\d,]*(?:\.\d+)?)\s?ILS\b/g, "₪$1")
    .replace(/\bILS\s?(\d[\d,]*(?:\.\d+)?)/g, "₪$1")
    // After the colours are Hebrew (eval e12: "ב-Black" became "ב-שחור"): a
    // prefix before a Hebrew word attaches, "וב‑שחור" included; before Latin it stays.
    .replace(/(?<![\u0590-\u05FF])([ובלהמש]{1,2})[\u2011\u2010-](?=[\u0590-\u05FF])/gu, "$1");
  // After the colours are Hebrew, so "אפור פחם (Charcoal)" is seen as a repeat
  // (eval e8 U6). A parenthetical that repeats what the sentence already says, or narrates
  // the card (eval e7 T4: "Heavyweight Hoodie במלאי (Heavyweight Hoodie)",
  // "בז' (בז')", "(ראו מטה: Chino Pants)"), is dropped.
  out = out.replace(/\s*\(([^()\n]{1,80})\)/g, (m, inner: string, at: number, whole: string) => {
    const raw = inner.replace(/\u0000(\d+)\u0000/g, (_x, i) => held[Number(i)]).trim();
    if (/(?:ראו|ראוי|רואים|ראי|see)\s*(?:ל?מטה|below)/i.test(raw)) return "";
    // A store title in parentheses breaks the line's direction (Omer: "(כמו Wool Blend Overcoat)").
    if (/\u0000\d+\u0000/.test(inner) || /^(?:כמו |למשל |e\.g\. )?[A-Z][A-Za-z]+(?: [A-Z][A-Za-z-]+)+$/.test(raw)) return "";
    const before = whole.slice(0, at).replace(/\u0000(\d+)\u0000/g, (_x, i) => held[Number(i)]);
    return raw && before.toLowerCase().includes(raw.toLowerCase()) ? "" : m;
  });
  // Narrating the cards (eval e11 E05: "יש, שמתי עבורך תוצאות חיות למטה. ראו: X",
  // a regenerated reply, so never checked again): the cards speak for themselves.
  if (opts.locale === "he") {
    const narrated = out
      .replace(/\s*(?<![\u0590-\u05FF])שמתי (?:עבורך|לך|לכם)[^.!?\n]*?(?:ל?מטה|חיות)[^.!?\n]*[.!]?/g, "")
      .replace(/\s*(?<![\u0590-\u05FF])ראו:\s*[^.!?\n]*$/g, "")
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
// Product words without their first letter, none of them a word on its own.
const EATEN_STEMS: Record<string, string> = {
  "עיל": "מעיל", "עילים": "מעילים", "ולצה": "חולצה", "ולצות": "חולצות", "כנסיים": "מכנסיים", "וודר": "סוודר",
  "צאית": "חצאית", "רדיגן": "קרדיגן", "רנץ'": "טרנץ'", "ישירט": "טישירט", "ופייה": "גופייה", "רביים": "גרביים",
};
// The whole token: a prefix (ו, ה, ב, ל, ש, כ, מ and their pairs), then the stem.
const EATEN_FIRST_LETTER = new RegExp(
  `(?<![\\u0590-\\u05FF'])((?:וה|וב|ול|וש|ומ|וכ|שה|שב|של|מה|כש|ו|ה|ב|ל|ש|כ|מ)?)(${Object.keys(EATEN_STEMS).sort((a, b) => b.length - a.length).join("|")})(?![\\u0590-\\u05FF'])`,
  "gu",
);
// Real words that look like a prefix and a stem ("כאמור לעיל"). A prefix that
// ends in the missing letter is the word itself ("מעיל", "ומכנסיים").
const EATEN_KEEP: ReadonlySet<string> = new Set(["לעיל", "כלעיל", "מלעיל"]);

function hebrewTouches(text: string, incoming: string): string {
  let out = text
    // "בתוקף עד 2027-09-30": a date as it is written here, 30.09.2027 (urban-e23).
    .replace(/(?<![\d-])(20\d{2})-(\d{2})-(\d{2})(?![\d-])/g, "$3.$2.$1")
    // "שני אופציות": the numeral agrees with a feminine noun, "שתי" (urban-e30).
    .replace(/(?<![\u0590-\u05FF])(ו?)שני(?=\s+(?:אופציות|אפשרויות|חולצות|שמלות|חצאיות|דרכים|מידות|חלופות|הצעות))/gu, "$1שתי")
    // "קיים קוד WELCOME10" reads as a form; a person says "יש" (dev 2026-10-27).
    .replace(/(^|[.!?\n]\s*)(?:קיים|קיימת|קיימים|קיימות)(?= )/gu, "$1יש")
    .replace(/(?<![A-Za-z])off[- ]white(?![A-Za-z])/gi, "אוף וייט")
    .replace(/לא נשען/g, "לא נלבש")
    // The model's "קל־קל" (Omer's test, 08:18Z) is "קליל"; a maqaf is never sent.
    .replace(/קל[\u05BE\s-]קל/g, "קליל")
    .replace(/\u05BE/g, " ")
    .replace(/(?<![\u0590-\u05FF])למגברים(?![\u0590-\u05FF])/g, "לגברים")
    // "במקטגוריית" (dev 2026-10-26): two prefixes, one of them wrong.
    .replace(/(?<![\u0590-\u05FF])במקטגורי/g, "בקטגורי")
    .replace(/(?<![\u0590-\u05FF])([ובלה]?)מכופר(ת|ות|ים)?(?![\u0590-\u05FF])/g, "$1מכופתר$2")
    // A product word with its first letter eaten ("טרנץ' קל, ועיל צמר ארוך",
    // urban-e31: so in the model's own reply): the letter put back.
    // "טרנץ' קל מקטון" (urban-e33 U3): cotton in Hebrew letters is כותנה.
    .replace(/(?<![\u0590-\u05FF])([ובלהמש]?)(?:קוטון|קטון|כוטון)(?![\u0590-\u05FF])/gu, "$1כותנה")
    .replace(EATEN_FIRST_LETTER, (whole: string, prefix: string, stem: string) => (EATEN_KEEP.has(whole) || prefix.endsWith(EATEN_STEMS[stem][0]) ? whole : `${prefix}${EATEN_STEMS[stem]}`));
  // A sentence that narrates the cards (eval e14: "הצגתי אותה עבורך", "מציגים
  // אותם למטה", "הצגתי כרטיס מוצר עם הווריאנט"): the cards speak for themselves.
  const narr = out.split(/(?<=[.!?])\s+/);
  const kept = narr.filter((x) => !/(?:הצגתי|הצגנו|מציגים|מציגה|מציג|שלחתי|שלחנו)[^.!?\n]{0,40}(?:למטה|מטה|עבורך|בשבילך|כרטיס|הווריאנט)/.test(x));
  if (kept.length && kept.length < narr.length) out = kept.join(" ");
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
  // A short close that thanks the customer back ("מעולה, תודה.", eval e12 A04) is not a close.
  const thanksBack = /תודה|thank/i.test(reply);
  if (!ONLY_CLOSING.test(incomingMessage ?? "") || (reply.trim() && isShortClose(reply) && !thanksBack)) return reply;
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
  const out = reply.replace(/[\s,]*(?<![\u0590-\u05FF])(?:בכיף|anytime)\s*[🙂😊❤️🙏]*\s*$/iu, "").trim();
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
// Whole words only, with up to two Hebrew prefixes: "חומר" is not brown, "הלבנה" is white.
const COLOUR_WORD: Array<[RegExp, string[]]> = COLOUR_ASK.map(([re, words]) => [new RegExp(`^(?:${re.source})$`, "iu"), words]);

export function askedColours(text: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const token of String(text ?? "").split(/[^\p{L}'׳]+/u).filter(Boolean)) {
    const forms = [token, token.replace(/^[ובלהשמכ]/, ""), token.replace(/^[ובלהשמכ]{2}/, "")];
    for (const [re, words] of COLOUR_WORD) if (forms.some((f) => re.test(f))) words.forEach((w) => out.add(w));
  }
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

/** The customer asked something (a question, or a size or colour on its own: "מידה M"). */
export function asksSomething(incomingMessage: string): boolean {
  const t = String(incomingMessage ?? "");
  return /[?؟]/.test(t) || /^\s*(?:כמה|מה|איך|יש|האם|מתי|איפה|באיזה|באיזו|למה|אפשר|ו?יש|how|what|is|are|do|does|can)(?=[\s?,.!]|$)/iu.test(t)
    || /(?:מידה|מידות|size)\s*(?:XXS|XS|S|M|L|XL|XXL|\d{2})(?![A-Za-z])/i.test(t) || askedColours(t).length > 0;
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
