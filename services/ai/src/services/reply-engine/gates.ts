/**
 * Gate 1 (before the model: reply at all?) and Gate 3 (before send: are the
 * claims backed?). Gate 2 lives with the tool runner (tools.ts).
 *
 * Gate 1 here is the AI-service half. The worker already decided owner-recent,
 * assigned / handed over, business hours (silent), the autonomy budget and a
 * request for a person before it called us; v2 re-checks only what the AI
 * service owns: the employee is ACTIVE, the tenant may spend AI, and the cost
 * budget allows a turn.
 */
import { checkAiAllowed } from "@chatcenter/shared";
import { ungroundedPrices, stripPrices, checkReplyStyle, type StyleViolationKind } from "../reply-style-check.service";
import { validateActionHonesty } from "../action-honesty.service";
import type { Claim, ClaimProblem, Gate3Verdict, ToolRunRecord } from "./contract";

export type Gate1 =
  | { reply: true }
  | { reply: false; escalation: { reason: string; priority: "low" | "medium" | "high"; summary: string } };

export async function gate1(opts: {
  tenantId: string;
  agentStatus: string;
  platformPaid: boolean;
  billingSummary: (a: any) => string;
  deps?: { checkAiAllowed?: typeof checkAiAllowed };
}): Promise<Gate1> {
  if (opts.agentStatus !== "ACTIVE") {
    return { reply: false, escalation: { reason: `agent_inactive:${opts.agentStatus}`, priority: "low", summary: `AI employee is ${opts.agentStatus} - conversation needs a human.` } };
  }
  if (!opts.platformPaid) {
    const allowed = await (opts.deps?.checkAiAllowed ?? checkAiAllowed)(opts.tenantId);
    if (!allowed.allowed && allowed.reason) {
      return { reply: false, escalation: { reason: `billing_blocked:${allowed.reason}`, priority: "medium", summary: opts.billingSummary(allowed) } };
    }
  }
  return { reply: true };
}

/** Style kinds that are a hard fail in v2 (everything else is advisory, logged only). */
export const HARD_STYLE: ReadonlySet<StyleViolationKind> = new Set<StyleViolationKind>([
  "gendered_address",
  "mixed_address",
  "self_gender",
  "slash_form",
  "banned_phrase",
  "self_intro",
  "ungrounded_price",
  "card_narration",
  "recap_opener",
  "echo_opener",
  "false_absence",
] as StyleViolationKind[]);

/** Hebrew phrasings the legacy engine learned to ban that its checker does not name (eval 2026-11-16). */
const V2_BANS_HE: Array<[string, RegExp]> = [
  // "מצאתי ..." narrates the search; "לא מצאתי" (honest not-found) stays allowed.
  ["found_narration", /(?<![\u0590-\u05FF])(?<!לא\s)(?:ו|ש)?מצאתי(?![\u0590-\u05FF])/u],
  ["imperative_notice", /(?<![\u0590-\u05FF])(?:שים|שימי)\s+לב(?![\u0590-\u05FF])/u],
  ["gendered_prefers", /(?<![\u0590-\u05FF])(?:מעדיף|מעדיפה)(?![\u0590-\u05FF])/u],
  // A callback or a "we'll get back to you": there is no call tool, and the answer comes in the chat.
  ["callback_promise", /(?<![\u0590-\u05FF])[וש]?(?:נחזור|יחזרו|יחזור|תחזור|נתקשר|יתקשרו|יתקשר|ניצור קשר|ייצרו קשר|יצרו איתך קשר)(?:\s+אלי(?:ך|כם))?(?![\u0590-\u05FF])/u],
  // The employee speaking of itself in a gendered form (eval K02 "הייתי הולכת על"): always neutral.
  // Prod replay 3: "שמחה שהסתדרת", the employee as female. Feelings in the first person too.
  ["self_gendered", /(?<![\u0590-\u05FF])(?:(?:הייתי\s+(?:הולכת|הולך|לוקחת|לוקח|בוחרת|בוחר|ממליצה|ממליץ|צריכה|צריך|בטוחה|בטוח|שמחה|שמח|מציעה|מציע)|אני\s+(?:ממליצה|ממליץ|מציעה|מציע|חושבת|חושב|בודקת|בודק|מעבירה|מעביר|יודעת|יודע|שמחה|שמח|מצטערת|מצטער|בטוחה|בטוח|זמינה|זמין|מבינה|מבין))(?![\u0590-\u05FF])|(?<!(?:חג|יום|שבוע)\s)(?:שמחה|שמח)(?=\s+[של][\u0590-\u05FF])|(?:מצטערת|מצטער)(?=\s+(?:ש|על|לשמוע|מאוד|באמת)|\s*[,.!])|(?<!(?:את|אתה|אתם|אתן|הוא|היא)\s)(?:מבינה|מבין)(?=\s*[,.!]|\s+(?:את|ש|לגמרי|אותך|אותכם|לחלוטין)(?![\u0590-\u05FF])))/u],
  // Prod replay 13: "צודק" to a customer referred to as female; neutral always.
  ["gendered_agree", /(?<![\u0590-\u05FF])(?:צודק|צודקת)(?![\u0590-\u05FF])/u],
  // Prod replay 4: "מה אפשר לעזור" (במה), "ביקשתם ממך" (one customer, two persons).
  ["help_grammar", /(?<![\u0590-\u05FF])מה\s+(?:אפשר|אוכל|נוכל|ניתן)\s+לעזור/u],
  ["mixed_person", /(?<![\u0590-\u05FF])(?:ביקשתם\s+ממך|ביקשת\s+מכם|שלחתם\s+לך|אמרתם\s+לך)(?![\u0590-\u05FF])/u],
];

const ATTRIBUTE_ASK = /(?<![\u0590-\u05FF])(?:מגרד|מגרדת|נעים|נעימה|רך|רכה|עבה|דק|דקה|חומר|בד|מאיזה|עשוי|עשויה|כותנה|צמר|מרינו|פשתן|גזרה|גזרת|מידות|מידה|קטן|גדול|לכבס|כביסה|מכונה|ייבוש|מיוצר|תוצרת|איפה מייצרים|שקוף|נמתח|נמתחת|מחמם|חם|צבע|צבעים|בצבע|באיזה צבע|באילו צבעים|גוון|גוונים)(?![\u0590-\u05FF])|\b(?:colou?rs?|shades?|itch(?:y)?|soft|material|fabric|made of|fit|sizing|runs (?:small|large)|wash|care|origin|made in|warm|stretch)\b/iu;
const NO_INFO = /אין (?:לי|לנו)(?: כאן)? (?:מידע|פרטים)|אין (?:לי|לנו|ברשותי)(?: כאן)? את (?:ה)?(?:כתובת|פרטים|מידע|שעות|מספר)|(?:לא|אינה|אינו) (?:זמין|זמינה|זמינים|מופיע|מופיעה|מופיעים)|לא (?:בטוח|בטוחה|יודע|יודעת|ידוע)|(?:לבדוק|אבדוק|נבדוק|בודקים)(?: את זה)? (?:מול|עם) הצוות|\b(?:I don'?t have (?:that |the )?(?:info|information|details|address|exact address)|not (?:available|listed)|not sure|check with the team)\b/iu;

// A handoff silences the AI for the rest of the conversation, so it is kept for
// these only (Omer via the Supervisor, 2026-11-16): an explicit ask for a person,
// a strong complaint, a damaged item, a late order. Not for a tool that failed,
// a discount, instalments or care details: those are answered, or checked with
// the team as a question (respond.team_question) while the AI keeps the chat.
const ASKS_FOR_PERSON = /(?<![\u0590-\u05FF])(?:נציג|נציגה|נציגים|בן אדם|בנאדם|אדם אמיתי|מישהו אמיתי|אנושי|אנושית|לדבר עם (?:מישהו|מישהי|מנהל|מנהלת|אחראי)|תעבירו אותי|להעביר אותי|מנהל|מנהלת)(?![\u0590-\u05FF])|\b(?:human|real person|representative|agent|someone real|talk to (?:a|someone)|manager|speak to)\b/iu;
// Damage, prod replay 2026-11-16: "לא מחוברים", "מפורק", "חסר" (a missing part) and
// "הגיע הרוס" were missed, so a damaged delivery was argued out of its handoff
// three times and became team questions. "חסר במלאי" is stock, not damage.
const STRONG_CASE = /(?<![\u0590-\u05FF])(?:[וש]?(?:פגום|פגומה|פגומים|פגומות|שבור|שבורה|שבורים|שבורות|נשבר|נשברה|נשברו|סדוק|סדוקה|נסדק|קרוע|קרועה|נקרע|נקרעה|מפורק|מפורקת|מפורקים|מפורקות|התפרק|התפרקה|התפרקו|לא מחובר|לא מחוברת|לא מחוברים|לא מחוברות|התנתק|התנתקה|התנתקו|לא תקין|לא תקינה|לא עובד|לא עובדת|לא נדלק|חסר(?!\s+(?:במלאי|לכם|לך))|חסרה|חסרים|חסרות|הגיע הרוס|הגיעה הרוסה|הגיעו הרוסים|הגיע פגום|הגיעה פגומה)|נזק|הרוס|הרוסה|לא הגיע|לא הגיעה|עדיין לא קיבלתי|לא קיבלתי|באיחור|איחור|מאחר|תקוע|תקועה|לא מקובל|מחפיר|שערורייה|עורך דין|תביעה|הונאה|נוכלים|רמאים|החזר כספי|כסף בחזרה|כבר שבוע|שבוע שלם|כבר שבועיים|כבר חודש|לא התקדמתם|לא מתקדם|לא מתקדמים|אין התקדמות|אין שום התקדמות|אף אחד לא (?:עונה|חוזר|עונים|מתייחס)|לא עונים לי|נמאס|נמאס לי|מתסכל|מאוכזב|מאוכזבת|מאוכזבים|לא רציני|לא רציניים|זלזול)(?![\u0590-\u05FF])|\b(?:damaged|broken|torn|defective|cracked|came apart|missing (?:a |the )?(?:part|piece|item)|doesn'?t work|not working|never arrived|hasn'?t arrived|didn'?t arrive|late|lawyer|scam|fraud|chargeback|refund|a week (?:already|and nothing)|no progress|nobody (?:answers|replies|gets back)|fed up|frustrat\w*|disappointed)\b/iu;

// A safety or damage complaint anywhere in the conversation keeps its handoff
// (prod replay 7: an appliance tipping over had its handoff removed).
const SAFETY = /(?<![\u0590-\u05FF])[וש]?(?:מתהפך|מתהפכת|מתהפכים|התהפך|התהפכה|נופל|נופלת|נפל|נפלה|נפלו|מסוכן|מסוכנת|מסוכנים|לא\s+בטיחותי|לא\s+בטיחותית|סכנה|נשרף|נשרפה|נמס|נמסה|התחמם|התחממה|ניצוץ|קצר|נשבר|נשברה|נשברו|פגום|פגומה|פגומים|נפצע|נפצעה|פציעה|מתגלגל|מתגלגלת|מתגלגלים|גלגול|כלכול|כלכל|מתכלכל|התגלגל|התגלגלה|נהפך|נהפכת|נהפכו|מתרומם|מתרוממת|התרומם|התרוממה|מחליק|מחליקה|מחליקים|נשמט|נשמטת|לא\s+יציב|לא\s+יציבה|מתנדנד|מתנדנדת|כמעט\s+נפל|כמעט\s+נפלה|נופל\s+אחורה|זז\s+(?:לבד|אחורה)|זזה\s+(?:לבד|אחורה)|לא\s+(?:מונע|עוצר)\s+(?:את\s+זה|את\s+הנפילה|את\s+ההחלקה))(?![\u0590-\u05FF])|\b(?:rolls? (?:back|off)|rolling|slid(?:es?|ing)?|slipp(?:ing|ed)|wobbl\w*|unstable|tips? over|tipped|fell|unsafe|dangerous|hazard|burn(?:t|ed)?|melt(?:ed)?|spark|injur\w*|broke|broken|defective)\b/iu;
export const safetyCase = (inbound: string[]) => SAFETY.test(inbound.join("\n"));
// The product in use: its parts, its use, its size (not a collaboration or a coupon).
const IN_USE = /(?<![\u0590-\u05FF])[והבלמש]?(?:משטח|משטחים|מכשיר|מכשירים|מעצור|מעצורים|גלגל|גלגלים|מיקסר|השימוש|שימוש|להשתמש|משתמש|משתמשת|עובד|עובדת|בסיס|רגליות)(?![\u0590-\u05FF])|\b(?:the (?:mat|pad|appliance|stopper|wheels?)|using it)\b/iu;
// What the product does in use: a part and a behaviour ("המעצור לא מונע", "המשטח זז").
const BEHAVIOUR = /(?<![\u0590-\u05FF])[וש]?(?:מונע|מונעת|עוצר|עוצרת|מחזיק|מחזיקה|זז|זזה|זזים|נתקע|נתקעת|יציב|יציבה|עובד|עובדת|נוגע|נוגעת)(?![\u0590-\u05FF])/u;
/** The customer's OWN message describes a safety issue or the product's behaviour in use (prod replay 13: the stop-use line on a UGC inquiry). */
export const customerDescribesUse = (incoming: string) => SAFETY.test(incoming ?? "") || (IN_USE.test(incoming ?? "") && BEHAVIOUR.test(incoming ?? ""));
/** This text is about the product in use (a safety word, its parts or use, or a size). */
export const aboutProductInUse = (texts: string[]) => { const t = texts.join("\n"); return SAFETY.test(t) || IN_USE.test(t) || DIMENSIONS.test(t); };
/** The safety word that matched, for the trace. */
export const safetyWord = (inbound: string[]) => SAFETY.exec(inbound.join("\n"))?.[0]?.trim() ?? null;

const MEDIA_PLACEHOLDER = /^(?:\[(?:Image|Photo|Video|Voice message|Audio|Document|Sticker|File|תמונה|סרטון|הודעה קולית|מסמך)[^\]]*\]|)$/i;

/** A handoff the customer's own words do not call for. */
export function needlessHandoff(handoff: string | null | undefined, recentInbound: string[], toolsAskedPerson: boolean): boolean {
  if (!handoff) return false;
  if (toolsAskedPerson) return false;
  if (safetyCase(recentInbound)) return false;
  // Photos sent right after the words ("[Image]") must not push them out of the window.
  const recent = recentInbound.filter((m) => !MEDIA_PLACEHOLDER.test(String(m ?? "").trim())).slice(-3).join("\n");
  return !ASKS_FOR_PERSON.test(recent) && !STRONG_CASE.test(recent);
}

/** The customer asked about a product's material, feel, fit, care or origin, and the reply pleads no info without reading the product. */
export const statusAsk = (incoming: string) => STATUS_ASK.test(incoming ?? "");
export const noInfo = (reply: string) => NO_INFO.test(reply ?? "");
export const teamLineIn = (reply: string) => TEAM_LINE.test(reply ?? "");

// A material answered from the business description without reading the product (prod replay 12:
// "stainless steel" from the product data in one conversation, something else from the description in another).
const MATERIAL_ASK = /(?<![\u0590-\u05FF])(?:חומר|מאיזה\s+חומר|עשוי|עשויה|עשויים|ממה|נירוסטה|כסף|זהב|ציפוי|מצופה|פליז|נחושת|אלומיניום|פלדה|כותנה|פשתן|משי|צמר)(?![\u0590-\u05FF])|\b(?:material|made of|stainless|silver|gold|plated|steel|cotton|linen|silk|wool)\b/iu;
export function unreadProduct(reply: string, incoming: string, tools: ToolRunRecord[], toolsOffered: string[], teamQuestion = false): boolean {
  const materialStated = MATERIAL_ASK.test(incoming ?? "") && MATERIAL_ASK.test(reply ?? "");
  if (!ATTRIBUTE_ASK.test(incoming ?? "") && !MATERIAL_ASK.test(incoming ?? "")) return false;
  if (!(teamQuestion || NO_INFO.test(reply ?? "") || materialStated)) return false;
  const canRead = toolsOffered.some((n) => /get_product|list_products|search_products|variation/i.test(n));
  const read = tools.some((t) => /product|variation|inventory/i.test(t.tool) && t.decision === "allow");
  return canRead && !read;
}


const ORDER_ASK = /(?<![\u0590-\u05FF])(?:משלוח|המשלוח|מתי (?:יגיע|תגיע|זה מגיע|זה יגיע|אקבל)|הזמנה|ההזמנה|הזמנתי|מעקב|מספר מעקב|החבילה|איפה החבילה|נשלח|נשלחה|יצא|יצאה)(?![\u0590-\u05FF])|\b(?:delivery|shipping|shipped|tracking|my order|order status|where is my)\b/iu;
const COUPON_ASK = /(?<![\u0590-\u05FF])(?:קופון|הקופון|קוד הנחה|קוד קופון|קוד הטבה|להזין (?:את )?(?:הקוד|הקופון)|איפה (?:מזינים|שמים) (?:את )?(?:הקוד|הקופון)|מדיניות|החזרות|החלפה|החלפות)(?![\u0590-\u05FF])|\b(?:coupon|promo code|discount code|return policy|exchange)\b/iu;

/** A delivery or order question sent to the team (or "no info") while order/tracking tools were there and none was called. */
export function unreadOrder(reply: string, incoming: string, tools: ToolRunRecord[], toolsOffered: string[], teamQuestion = false): boolean {
  if (!ORDER_ASK.test(incoming ?? "") || !(teamQuestion || NO_INFO.test(reply ?? ""))) return false;
  const canRead = toolsOffered.some((n) => /order|tracking|fulfil?lment|shipment/i.test(n));
  const read = tools.some((t) => /order|tracking|fulfil?lment|shipment/i.test(t.tool));
  return canRead && !read;
}

// The business's own facts (prod replay 3: "where is the studio" got "the exact
// address is not available" while the knowledge had it).
const BUSINESS_ASK = /(?<![\u0590-\u05FF])(?:איפה (?:אתם|נמצאים|נמצא|נמצאת|הסטודיו|החנות|העסק|המשרד|המחסן|אפשר לאסוף)|כתובת|הכתובת|מיקום|המיקום|שעות\s+ה?(?:פתיחה|פעילות)|פתוחים|פתוח|סגורים|איסוף|לאסוף|איסוף עצמי|דמי משלוח|משלוח חינם|כמה (?:עולה|עולים|זמן לוקח|זמן לוקחת)\s+ה?משלוח|עושים משלוחים|שולחים ל|החזרה|החזרות|להחזיר|החלפה|להחליף|טלפון|מספר טלפון|ליצור קשר|מייל|אימייל|חניה)(?![\u0590-\u05FF])|\b(?:address|location|where are you|opening hours|open(?:ing)? times|pick ?up|shipping (?:cost|time|policy)|returns?|exchange|contact|phone number|email)\b/iu;
// One order of theirs, not the shop's policy.
const MY_ORDER = /(?<![\u0590-\u05FF])(?:הזמנה|ההזמנה|הזמנתי|החבילה|החבילה שלי|מעקב|מספר מעקב|מתי (?:יגיע|תגיע|אקבל|זה מגיע))(?![\u0590-\u05FF])|\d{4,}|\b(?:my order|order (?:number|#)|tracking|my package)\b/iu;

/** A question about the business itself (address, hours, pickup, shipping, returns, contact) answered "not available" or sent to the team without searching the knowledge. */
export function unreadBusinessInfo(reply: string, incoming: string, tools: ToolRunRecord[], toolsOffered: string[], teamQuestion = false): boolean {
  if (!BUSINESS_ASK.test(incoming ?? "") || MY_ORDER.test(incoming ?? "")) return false;
  if (!(teamQuestion || NO_INFO.test(reply ?? ""))) return false;
  return toolsOffered.includes("search_knowledge") && !tools.some((t) => t.tool === "search_knowledge");
}

// "I couldn't check" after a store search timed out (prod replay 3: a category ask
// got that where legacy named the category).
const GAVE_UP = /(?:הקטלוג\s+לא\s+(?:נפתח|נטען)|לא\s+נפתח\s+לי|תקלה|לא (?:הצלחתי|הצלחנו|יכולתי|יכולנו|מצליח|מצליחה) (?:לבדוק|לגשת|לראות|לחפש)|(?:אין|אין לי) (?:גישה|אפשרות לבדוק)|כרגע (?:לא ניתן|אי אפשר) לבדוק|לבדוק (?:את זה )?כרגע)|\b(?:could(?:n'?t| not) (?:check|look|access|search)|unable to (?:check|look|access))\b/iu;
/** A product search timed out, nothing else was found this turn, and the reply gives up on the customer. */
export function gaveUpSearch(reply: string, tools: ToolRunRecord[]): boolean {
  const search = (t: ToolRunRecord) => /list_products|search_products|get_product|variation/i.test(t.tool);
  if (!tools.some((t) => search(t) && (t.outcome === "timeout" || t.outcome === "error"))) return false;
  if (tools.some((t) => search(t) && (t.outcome === "ok" || t.outcome === "empty"))) return false;
  return GAVE_UP.test(reply ?? "");
}

/** A coupon or policy question sent to the team without searching the knowledge. */
export function unreadKnowledge(incoming: string, tools: ToolRunRecord[], toolsOffered: string[], teamQuestion = false): boolean {
  if (!teamQuestion || !COUPON_ASK.test(incoming ?? "")) return false;
  return toolsOffered.includes("search_knowledge") && !tools.some((t) => t.tool === "search_knowledge");
}

// A note meant for the engine (a simulated or test run) must never reach the customer, in any lane.
const SIMULATION_LEAK = /(?:סביבת (?:ה)?(?:בדיקה|בדיקות|ניסוי|טסט)|סימולציה|בסימולציה|לא בוצע(?:ה)? בפועל|שיחת (?:ה)?(?:בדיקה|ניסיון)|הודעת בדיקה)|\b(?:simulat(?:ed|ion)|sandbox|test (?:environment|conversation|mode)|not (?:actually|really) (?:performed|executed|sent))\b/iu;
export const simulationLeak = (reply: string) => SIMULATION_LEAK.test(reply ?? "");

// "I passed it to the team", said again while the team already has it open.
const TEAM_LINE = /(?:העברתי|העברנו|הועבר|הועברה|הועברו)(?:\s+(?:את\s+)?(?:השאלה|הבקשה|הפנייה|זה|הנושא|הפרטים))?\s+(?:ל|אל\s+)ה?צוות|(?:הצוות|צוות)\s+(?:כבר\s+)?(?:יבדוק|בודק|בודקים|יחזור|יעדכן|יענה|מטפל|מטפלים)|(?:כבר\s+)?אצל\s+הצוות|(?:בבדיקה|לבדוק)\s+(?:מול|עם)\s+הצוות|\b(?:passed (?:it|this|your question) (?:on )?to the team|the team (?:will|is) (?:already )?(?:check|look|get back|on it)\w*|the team already has (?:it|this))\b/iu;
const STATUS_ASK = /(?<![\u0590-\u05FF])(?:מה (?:קורה|קרה|המצב|עם זה|נשמע)|יש (?:חדש|חדשות|עדכון|תשובה)|עדכון|עדכנו|נו|כמה זמן|עוד כמה|מתי תהיה תשובה|ענו|הצוות)(?![\u0590-\u05FF])|\b(?:any (?:update|news)|still waiting|heard back)\b/iu;
/** The reply announces the team hand-off again although it is already open and the customer did not ask about it. */
export function repeatedTeamLine(reply: string, incoming: string, teamAlreadyOpen: boolean, newTeamQuestion: boolean): boolean {
  if (!teamAlreadyOpen || newTeamQuestion) return false;
  return TEAM_LINE.test(reply ?? "") && !STATUS_ASK.test(incoming ?? "");
}

// Prod replay 4: "the measurements were passed to the team" with no team question,
// and "we will not ship before we update you": a promise nothing carries out.
const FUTURE_PROMISE = /(?<![\u0590-\u05FF])(?:[וש]?(?:נעדכן|אעדכן|נודיע|אודיע|נדאג|אדאג|נעכב|נשמור\s+(?:לך|לכם)|אשמור\s+(?:לך|לכם))|לא\s+(?:נשלח|נשלחים|נשלחת|נוציא)\s+(?:לפני|עד|בלי))(?![\u0590-\u05FF])|\b(?:we(?:'ll| will) (?:update you|let you know|hold it|keep it for you)|(?:won'?t|will not) ship (?:before|until))\b/iu;
/** "Passed to the team" or a promise of a later action, with nothing in this turn carrying it (no team question, no handoff, nothing open). */
export function unbackedPromises(reply: string, o: { teamQuestion: boolean; handedOff: boolean; teamAlreadyOpen: boolean; approvalPending: boolean }): string[] {
  if (o.teamQuestion || o.handedOff || o.approvalPending) return [];
  const out: string[] = [];
  const team = TEAM_LINE.exec(reply ?? "");
  if (team && !o.teamAlreadyOpen) out.push(team[0]);
  const promise = FUTURE_PROMISE.exec(reply ?? "");
  if (promise && !o.teamAlreadyOpen) out.push(promise[0]);
  return out;
}

// Prod replay 4: "wood/bamboo pads are not sold" four times while the store sells
// bamboo. "We don't have / don't sell / no match / doesn't exist" is a fact.
const ABSENCE = /(?<![\u0590-\u05FF])(?:אין\s+(?:לנו|אצלנו)(?!\s+(?:כאן\s+)?(?:מידע|פרטים|גישה|אפשרות|תשובה))|(?:אנחנו\s+)?לא\s+(?:מוכרים|מחזיקים|משווקים|מייצרים)|לא\s+(?:קיים|קיימת|קיימים|קיימות)|אין\s+(?:התאמה|דגם|מוצר|כזה|כזו|כאלה|כאלו)|לא\s+(?:מצאנו|נמצא|נמצאה|נמצאו)\s+(?:התאמה|מוצר|דגם|כזה|כזו)|לא\s+(?:מצאתי|מצאנו|מוצאת|מוצא|מוצאים))(?![\u0590-\u05FF])|\b(?:(?:i|we) (?:didn'?t|did not|couldn'?t|could not) find|no results|we (?:don'?t|do not) (?:sell|carry|have|stock)|(?:is|are) not (?:sold|available|in our (?:range|catalog(?:ue)?))|(?:doesn'?t|does not) exist|no (?:match|such))\b/iu;
const ABSENCE_WORDS = new Set(["אין", "לנו", "אצלנו", "אנחנו", "לא", "מוכרים", "מחזיקים", "משווקים", "מייצרים", "קיים", "קיימת", "קיימים", "קיימות", "התאמה", "דגם", "מוצר", "כזה", "כזו", "כאלה", "כאלו", "מצאנו", "נמצא", "נמצאה", "נמצאו", "כרגע", "בכלל", "במלאי", "שלנו", "רק", "גם", "את", "של", "עם", "על", "זה", "זו", "יש", "אבל", "מאוד", "לצערי", "מצאתי", "מוצאת", "מוצא", "מוצאים", "פריט", "פריטים", "בשם", "הזה", "הזו", "find", "didn't", "couldn't", "results", "item", "called", "we", "dont", "don't", "do", "not", "sell", "carry", "have", "stock", "is", "are", "sold", "available", "exist", "doesn't", "does", "match", "such", "the", "and", "any", "for"]);
const CAPABILITY_ABSENCE = /(?<![\u0590-\u05FF])(?:אין\s+(?:לנו\s+|באפשרותנו\s+)?אפשרות|אין\s+באפשרותנו|אנחנו\s+לא\s+(?:יכולים|יכולות|עושים)|לא\s+(?:ניתן|נוכל)|אי\s+אפשר)(?![\u0590-\u05FF])|\b(?:we (?:can'?t|cannot|are unable to|don'?t do)|it'?s not possible|not possible to)\b/iu;
const CAPABILITY_WORDS = new Set(["אפשרות", "באפשרותנו", "יכולים", "יכולות", "עושים", "ניתן", "נוכל", "אפשר", "לצערנו", "לצערי", "כרגע", "can't", "cannot", "unable", "possible", "don't"].map((w) => w.toLowerCase()));
// Final letters (ך ם ן ף ץ) as their plain forms: "טלפון" is in "טלפוני".
const unfinal = (w: string) => w.replace(/ך/g, "כ").replace(/ם/g, "מ").replace(/ן/g, "נ").replace(/ף/g, "פ").replace(/ץ/g, "צ");
const stem = (w: string) => unfinal((w.length > 3 && /^[הובלמשכ]/.test(w) ? w.slice(1) : w).toLowerCase());
const CAPABILITY_STEMS = new Set([...CAPABILITY_WORDS].flatMap((w) => [w, stem(w)]));
const termsOf = (sentence: string) => [...new Set((sentence.match(/[\u0590-\u05FFA-Za-z]{3,}/g) ?? []).filter((w) => !ABSENCE_WORDS.has(w.toLowerCase())).map(stem))];
const SEARCH_TOOL = /list_products|search_products|get_product|variation|search_knowledge|categor/i;
const PRODUCT_TOOL = /list_products|search_products|get_product|variation/i;
/**
 * Absence claims no search backs: grounded only by a search this turn whose query
 * covers the claim's words and that did not return them. Without such words
 * ("אין לנו כזה"), any product search that ran this turn grounds it.
 */
export function ungroundedAbsence(reply: string, tools: ToolRunRecord[], knowledge = ""): string[] {
  const sentences = String(reply ?? "").match(/[^.!?\n]+[.!?]*/g) ?? [];
  const searches = tools.filter((t) => SEARCH_TOOL.test(t.tool) && (t.outcome === "ok" || t.outcome === "empty"));
  const out: string[] = [];
  // What the business itself says it cannot do (prod replay 5: "we can't arrange a
  // phone call", twice, to upset customers). Grounded only by the business's own
  // words: the knowledge or a tool result naming the same thing.
  const said = unfinal([knowledge, ...tools.map((t) => String(t.content ?? ""))].join("\n").toLowerCase());
  for (const sentence of sentences) {
    if (!CAPABILITY_ABSENCE.test(sentence) || ABSENCE.test(sentence)) continue;
    const clause = sentence.split(/,|;|\s+(?:אבל|אך|but)\s+/iu).filter((c) => CAPABILITY_ABSENCE.test(c)).join(" ");
    const terms = termsOf(clause).filter((w) => !CAPABILITY_STEMS.has(w));
    if (terms.length && !terms.some((w) => said.includes(w))) out.push(sentence.trim().slice(0, 120));
  }
  for (const sentence of sentences) {
    if (!ABSENCE.test(sentence)) continue;
    // Only the clause that says it ("אין לנו כזה, אבל יש דומה": not "דומה").
    const clause = sentence.split(/,|;|\s+(?:אבל|אך|רק|but)\s+/iu).filter((c) => ABSENCE.test(c)).join(" ");
    const terms = termsOf(clause);
    let grounded: boolean;
    if (!terms.length) grounded = searches.some((t) => PRODUCT_TOOL.test(t.tool));
    else {
      const query = (t: ToolRunRecord) => termsOf(Object.values(t.args ?? {}).filter((v) => typeof v === "string").join(" "));
      // The search must cover the claim's words (all of two, all but one of more): "pads" alone is not "bamboo pads".
      const need = terms.length <= 2 ? terms.length : terms.length - 1;
      const ranFor = searches.filter((t) => { const q = query(t); return terms.filter((w) => q.some((x) => x.includes(w) || w.includes(x))).length >= need; });
      // A product search that returned the very thing contradicts the claim.
      const returned = ranFor.some((t) => PRODUCT_TOOL.test(t.tool) && terms.some((w) => unfinal(String(t.content ?? "").toLowerCase()).includes(w)) && t.outcome === "ok");
      grounded = ranFor.length > 0 && !returned;
    }
    if (!grounded) out.push(sentence.trim().slice(0, 120));
  }
  return out;
}

const ADDRESS_DENIED = /(?:(?<![\u0590-\u05FF])(?:ה)?כתובת(?:\s+המדויקת)?[^.\n]{0,40}(?:לא\s+(?:מופיעה|מופיע|זמינה|זמין|ידועה|נמצאת|מצוינת)|אינה\s+(?:מופיעה|זמינה))|אין\s+(?:לי|לנו|ברשותי)[^.\n]{0,25}(?:ה)?כתובת)|\b(?:(?:the )?(?:exact )?address (?:is not|isn'?t) (?:available|listed|in my details)|(?:i|we) (?:don'?t|do not) have the (?:exact )?address)\b/iu;
const INFO_DENIED = /(?<![\u0590-\u05FF])(?:לא\s+(?:מופיע|מופיעה|מופיעים|מופיעות)(?:\s+(?:אצלנו|אצלי|כרגע|במידע))?|אין\s+(?:לנו|לי)\s+(?:כרגע\s+)?(?:מידע|פרטים)\s+(?:על|לגבי|בנושא))(?![\u0590-\u05FF])|\b(?:(?:is|are) not (?:listed|on file)|we have no (?:information|details) (?:on|about))\b/iu;
const INFO_STOP = new Set(["פרטי", "פרטים", "מידע", "כרגע", "אצלנו", "לגבי", "בנושא", "מופיע", "מופיעה", "מופיעים", "מופיעות"]);
/** Sentences saying something is not on file while the knowledge names it (two of their word stems, or one 5+ letters). */
export function infoDeniedButKnown(reply: string, knowledge: string): string[] {
  const k = unfinal(String(knowledge ?? "").toLowerCase());
  if (!k) return [];
  return (String(reply ?? "").match(/[^.!?\n]+[.!?]*/g) ?? []).filter((x) => {
    if (!INFO_DENIED.test(x)) return false;
    const stems = (x.match(/[\u0590-\u05FFa-z]{4,}/giu) ?? []).filter((w) => !INFO_STOP.has(w)).map(stem).filter((w) => w.length >= 3);
    const hits = stems.filter((w) => k.includes(w));
    return hits.length >= 2 || hits.some((w) => w.length >= 5);
  }).map((x) => x.trim().slice(0, 120));
}

/** Sentences that say the address is not known. */
export function addressDenied(reply: string): string[] {
  return (String(reply ?? "").match(/[^.!?\n]+[.!?]*/g) ?? []).filter((x) => ADDRESS_DENIED.test(x)).map((x) => x.trim().slice(0, 120));
}

/**
 * Products are verified by KEY, never by name (eval 2026-11-16: the model names
 * English catalogue titles in Hebrew, "טרנץ' כותנה דוחה מים", and name matching
 * failed 22 of 66 correct turns). A claim or a card citing PRODUCT_n must point
 * at a product this turn's tools returned; a claim with no key is not a fact to
 * verify on its own (its price is still checked against the grounding).
 */
export function unknownProductKeys(claims: Claim[], cards: string[], candidateCount: number): string[] {
  const keys = [
    ...claims.filter((c) => c.kind === "product").flatMap((c) => String(c.text ?? "").match(/PRODUCT_\d+/gi) ?? []),
    ...cards.flatMap((k) => String(k ?? "").match(/PRODUCT_\d+/gi) ?? []),
  ];
  return [...new Set(keys.map((k) => k.toUpperCase()))].filter((k) => {
    const n = Number(k.slice("PRODUCT_".length));
    return !(n >= 1 && n <= candidateCount);
  });
}

// Prod replay 5: a category and a colour were given, the customer said the site was
// hard, and the reply asked for a photo three times and showed nothing.
const PHOTO_ASK = /(?<![\u0590-\u05FF])(?:תמונה|תמונות|צילום|לצלם|תצלמו|תצלמי|תצלם|צלמו)(?![\u0590-\u05FF])|\b(?:photo|picture|pic)s?\b/iu;
const PRODUCT_WANT = /(?<![\u0590-\u05FF])(?:מחפש|מחפשת|מחפשים|יש לכם|רוצה|רוצים|צריך|צריכה|בצבע|בגוון|צבע|גוון|מתאים|מתאימה|דגם|מידה)(?![\u0590-\u05FF])|\b(?:looking for|do you have|i want|i need|colou?r)\b/iu;
const OCCASION = /(?<![\u0590-\u05FF])(?:לחתונה|לאירוע|אירוע|חגיגי|חגיגית|חגיגיים|מתנה|למתנה|ליום\s+הולדת|לחג|לבר\s+מצווה|לבת\s+מצווה|ערב|יומיומי|יומיומית)(?![\u0590-\u05FF])|\b(?:wedding|occasion|gift|party|festive|everyday)\b/iu;
/** A product ask (a category, colour, size or occasion) met with a photo request or a team question, while the store search was there and did not run. */
const DIMENSIONS = /\d{1,3}(?:[.,]\d)?\s*(?:ס["״']?מ|cm)?\s*(?:[x×*]|על|by)\s*\d{1,3}/iu;
const NOT_GUESSING = /(?<![\u0590-\u05FF])(?:לא\s+(?:רוצה|רוצים|נרצה)\s+לנחש|לא\s+אנחש|לא\s+ננחש|כדי\s+לא\s+לטעות|בלי\s+לנחש)(?![\u0590-\u05FF])|\b(?:don'?t want to guess|not to guess)\b/iu;
// The customer wants to buy, or cannot find it on the site (prod replay 10, Smoovee on
// WhatsApp): the reply carries name, price and link from a store search, whatever it says.
const PURCHASE = /(?<![\u0590-\u05FF])[וש]?(?:להזמין|לקנות|לרכוש|אזמין|אקנה|רוצה\s+להזמין|איך\s+(?:מזמינים|קונים)|לא\s+(?:מוצא|מוצאת|מוצאים)(?:\s+(?:את\s+זה\s+)?באתר)?|קישור|לינק|תשלחו\s+(?:לי\s+)?(?:קישור|לינק))(?![\u0590-\u05FF])|\b(?:buy|order (?:it|one|this)|purchase|can'?t find (?:it )?on the (?:site|website)|link)\b/iu;
export function purchaseWithoutSearch(incoming: string, tools: ToolRunRecord[], toolsOffered: string[]): boolean {
  if (!PURCHASE.test(incoming ?? "")) return false;
  const canSearch = toolsOffered.some((n) => /list_products|search_products/i.test(n));
  return canSearch && !tools.some((t) => /list_products|search_products|get_product/i.test(t.tool));
}

// "Where do I find the code itself" answered with where to ENTER it (prod replay 13, three times).
const GET_CODE = /(?:(?:איפה|איך|מאיפה|מהיכן)\s+(?:אני\s+)?(?:מוצא|מוצאת|מוצאים|משיג|משיגה|משיגים|מקבל|מקבלת|מקבלים|יש)\s+(?:את\s+)?(?:ה)?(?:קוד|קופון)|מאיפה\s+(?:ה)?(?:קוד|קופון)|(?:ה)?(?:קוד|קופון)\s+עצמו)|\b(?:where (?:do i|can i) (?:get|find) (?:a |the )?(?:code|coupon))\b/iu;
const ENTER_CODE = /(?<![\u0590-\u05FF])(?:מזינים|להזין|הזינו|שדה|בעמוד\s+התשלום|בקופה)(?![\u0590-\u05FF])|\b(?:enter|field|checkout)\b/iu;
/** The customer asks where to GET a code, and the reply only says where to enter one. */
export function couponSourceMissed(incoming: string, reply: string): boolean {
  return GET_CODE.test(incoming ?? "") && ENTER_CODE.test(reply ?? "") && !/(?:ניוזלטר|מבצע|מבצעים|הרשמה|נרשמים|במייל|newsletter|promotion)/iu.test(reply ?? "");
}

/** The reply presents or names products for a product ask, and no store search ran. */
export function namesProductsUnsearched(reply: string, incoming: string, tools: ToolRunRecord[], toolsOffered: string[]): boolean {
  if (!(PRODUCT_WANT.test(incoming ?? "") || PURCHASE.test(incoming ?? "")) || !(PRESENTS.test(reply ?? "") || PRODUCT_NOUN.test(reply ?? ""))) return false;
  const canSearch = toolsOffered.some((n) => /list_products|search_products/i.test(n));
  return canSearch && !tools.some((t) => /list_products|search_products|get_product/i.test(t.tool));
}
/** The knowledge holds the customer's device or item (a 4+ letter word of their message): it may answer. */
export function knowledgeHasIt(incoming: string, knowledge: string): boolean {
  const k = String(knowledge ?? "").toLowerCase();
  return !!k && tipWords(incoming).filter((w) => !["אפשר", "איזה", "איזו", "מתאים", "מתאימה", "שלכם", "עבור"].includes(w)).some((w) => k.includes(w));
}

export function photoInsteadOfSearch(reply: string, incoming: string, tools: ToolRunRecord[], toolsOffered: string[], teamQuestion = false): boolean {
  // Prod replay 8: sizes, a category or an item given, and a question (or "I don't want to guess") instead of the search legacy ran.
  // A question counts only when it replaces the products: no price, no size, no number in the reply.
  const asksInstead = /\?/.test(reply ?? "") && !/₪|ש["״']ח|\d/.test(reply ?? "");
  const deflects = PHOTO_ASK.test(reply ?? "") || teamQuestion || NOT_GUESSING.test(reply ?? "") || asksInstead;
  if (!deflects || !(PRODUCT_WANT.test(incoming ?? "") || OCCASION.test(incoming ?? "") || DIMENSIONS.test(incoming ?? ""))) return false;
  const canSearch = toolsOffered.some((n) => /list_products|search_products/i.test(n));
  return canSearch && !tools.some((t) => /list_products|search_products|get_product/i.test(t.tool));
}

const qWords = (s: string) => new Set((String(s ?? "").match(/[\u0590-\u05FFA-Za-z0-9]{2,}/g) ?? []).map((w) => w.toLowerCase()));
/** A question (or a photo request) the employee already asked in this conversation. */
export function repeatedAsk(reply: string, previousBotReplies: string[]): boolean {
  if (!previousBotReplies.length) return false;
  if (PHOTO_ASK.test(reply ?? "") && previousBotReplies.some((p) => PHOTO_ASK.test(p) && /\?/.test(p))) return true;
  const questions = (String(reply ?? "").match(/[^.!?\n]+\?/g) ?? []).map(qWords).filter((q) => q.size >= 3);
  const before = previousBotReplies.flatMap((p) => String(p).match(/[^.!?\n]+\?/g) ?? []).map(qWords);
  return questions.some((q) => before.some((b) => { let n = 0; for (const w of q) if (b.has(w)) n++; return n / Math.max(q.size, b.size) >= 0.7; }));
}

// The employee offered a person, or asked if it is urgent, and the customer said yes (prod replay 5).
const OFFERED_PERSON = /(?<![\u0590-\u05FF])[וש]?(?:דחוף|דחופה|להעביר|שאעביר|שנעביר|אעביר|נעביר|נציג|נציגה|נציגים|צוות|הצוות|לצוות|מהצוות|מישהו|מישהי|שיחזרו|שיחזור|שתחזור|שנחזור|לחבר\s+אותך|שיתקשרו|שיתקשר|לדבר\s+עם)(?![\u0590-\u05FF])|\b(?:urgent|connect you|pass (?:this|you) (?:on|to)|talk to (?:someone|a person))\b/iu;
const YES = /^\s*(?:כן|כן\s+בבקשה|כן\s+דחוף|דחוף|ברור|בטח|אשמח|בהחלט|yes|yeah|yep|please|sure)(?:[\s,.!]|$)/iu;
/** The customer accepted the employee's own offer of a person, and the reply does neither hand over nor record it. */
export function ignoredYes(incoming: string, lastBotReply: string | null | undefined, handedOff: boolean, teamQuestion: boolean): boolean {
  if (handedOff || teamQuestion || !lastBotReply) return false;
  return /\?/.test(lastBotReply) && OFFERED_PERSON.test(lastBotReply) && YES.test(incoming ?? "");
}

// The reply tells the customer a person will continue (prod replay 6: three
// "נציג מהצוות ימשיך איתך" with no handoff). Never a promise without the action.
const PERSON_CONTINUES = /(?<![\u0590-\u05FF])(?:(?:נציג|נציגה|מישהו|מישהי|אחד\s+מהצוות)\s+(?:מהצוות\s+)?(?:ימשיך|תמשיך|יחזור|תחזור|יטפל|תטפל|יענה|תענה|ייצור\s+קשר|תיצור\s+קשר|יצור\s+קשר)|(?:מעביר|מעבירה|מעבירים)\s+(?:אותך\s+|את\s+השיחה\s+)?ל(?:נציג|נציגה|צוות)|העברתי\s+(?:אותך\s+|את\s+השיחה\s+)?ל(?:נציג|נציגה)|הצוות\s+(?:יחזור|ימשיך|ייצור\s+קשר)(?:\s+אלי(?:ך|כם))?)(?![\u0590-\u05FF])|\b(?:a (?:person|team member|representative|human) (?:will|is going to) (?:continue|take over|get back)|(?:i'?m|we'?re) (?:transferring|passing) you)\b/iu;
export const promisesPerson = (reply: string) => PERSON_CONTINUES.test(reply ?? "");

// "הנה בנדנות מרובעות" with no name, price or card (prod replay 6, Tehila).
const PRESENTS = /(?<![\u0590-\u05FF])(?:הנה|יש\s+לנו|יש\s+כמה|אפשרויות|דגמים|כמה\s+סוגים|שני\s+סוגים)(?![\u0590-\u05FF])|\b(?:here (?:are|is)|we have|options)\b/iu;
/** A product ask answered as if products were shown, with none named, priced or carded (a text channel gets the list appended, so never there when products came back). */
export function namelessProducts(reply: string, incoming: string, cards: string[], titles: string[], listAppended = false): boolean {
  if (listAppended || !PRODUCT_WANT.test(incoming ?? "") || !PRESENTS.test(reply ?? "") || cards.length) return false;
  if (titles.some((t) => t && reply.includes(t))) return false;
  return !/₪|ש["״']ח|\d+\s?(?:NIS|ILS)|https?:\/\//.test(reply ?? "") && !/\?/.test(reply ?? "");
}

// "בתמונה", "מצורף", "below" with nothing attached (prod replay 7, Smoovee: twice).
const PICTURE_REF = /(?<![\u0590-\u05FF])(?:[וש]?(?:הנה|שלחתי|שלחנו|מצרפת|מצרף|מצרפים|צירפתי|צירפנו)\s+(?:לך\s+|לכם\s+)?(?:את\s+)?(?:ה)?(?:תמונה|תמונות|צילום|צילומים)|(?:ה)?(?:תמונה|צילום)\s+(?:מצורפ\w*|עם\s+ה)|בתמונה|בתמונות|בכרטיס|בכרטיסים|מצורף|מצורפת|מצורפים|מצורפות|כאן\s+למטה|בהמשך\s+ההודעה|רואים\s+ב(?:תמונה|כרטיס))(?![\u0590-\u05FF])|\b(?:in the (?:picture|photo|card)s?|attached|see below|shown below)\b/iu;
/** Sentences that point at a picture or card when none goes out with the reply. */
export function cardReferences(reply: string, cardsShown: boolean): string[] {
  if (cardsShown) return [];
  return (String(reply ?? "").match(/[^.!?\n]+[.!?]*/g) ?? []).filter((x) => PICTURE_REF.test(x)).map((x) => x.trim().slice(0, 120));
}

// A size the customer typed, stated back as a product's own (prod replay 9: "90×90"
// confirmed while the product data says 70×70). A size about their device is theirs to state.
const SIZE = /(\d{1,3}(?:[.,]\d)?)\s*(?:ס["״']?מ\s*)?(?:[x×*]|על)\s*(\d{1,3}(?:[.,]\d)?)|(?<![\d/])(\d{2,3})\s*\/\s*(\d{2,3})(?![\d/])/gu;
const PRODUCT_NOUN = /(?<![\u0590-\u05FF])(?:ה?משטח|ה?משטחים|ה?מוצר|ה?דגם|ה?מגש|ה?שטיח|ה?כיסוי|ה?פריט|בגודל|במידה|במידות|מידות)(?![\u0590-\u05FF])|\b(?:the (?:mat|pad|product|model|item)|size)\b/iu;
const THEIR_DEVICE = /(?<![\u0590-\u05FF])(?:שלך|שלכם|שלכן|המכשיר|למכשיר|המיקסר|למיקסר|התנור|לתנור|המקרר|הבסיס|שציינת|שציינתם|שנתת|שנתתם)(?![\u0590-\u05FF])|\b(?:your|you gave|you mentioned)\b/iu;
const sizeKeys = (text: string) => new Set([...String(text ?? "").matchAll(SIZE)].map((m) => [m[1] ?? m[3], m[2] ?? m[4]].map((x) => x.replace(",", ".")).sort().join("x")));
/** Sentences stating a product's size that only the customer's own messages give. */
export function echoedSizes(reply: string, customerText: string, sourceText: string): string[] {
  const theirs = sizeKeys(customerText);
  if (!theirs.size) return [];
  const known = sizeKeys(sourceText);
  return (String(reply ?? "").match(/[^.!?\n]+[.!?]*/g) ?? []).filter((x) => {
    const echoed = [...sizeKeys(x)].some((k) => theirs.has(k) && !known.has(k));
    return echoed && PRODUCT_NOUN.test(x) && !THEIR_DEVICE.test(x);
  }).map((x) => x.trim().slice(0, 120));
}

// A usage tip in a safety conversation that the knowledge does not give (prod replay 11:
// "check that the stopper touches the wheels" on an appliance tipping back).
const TIP = /(?<![\u0590-\u05FF])(?:כדאי\s+(?:לוודא|לבדוק|לנסות|להזיז|לסובב|למקם|להניח)|יש\s+(?:לוודא|לבדוק|להקפיד)|מומלץ\s+(?:לוודא|לבדוק|לנסות|למקם|להניח)|תוודאו|תוודא|תבדקו|תבדוק|נסו|תנסו|אפשר\s+לנסות|לבדוק\s+ש|לוודא\s+ש)(?![\u0590-\u05FF])|\b(?:make sure|check that|try (?:to|placing|moving)|you can try)\b/iu;
const STOP_USE = /(?<![\u0590-\u05FF])(?:להפסיק\s+(?:להשתמש|לעבוד|את\s+השימוש)|לא\s+להשתמש|לא\s+לעבוד\s+(?:עם|על)|להימנע\s+(?:משימוש|מלהשתמש)|stop using|don'?t use|avoid using)(?![\u0590-\u05FF])/iu;
const tipWords = (t: string) => (String(t ?? "").toLowerCase().match(/[\u0590-\u05FFa-z]{4,}/g) ?? []);
/** In a safety conversation: tip sentences that the knowledge does not contain (two of their words or more). */
export function unsafeTips(reply: string, knowledge: string, safety: boolean): string[] {
  if (!safety) return [];
  const k = unfinal(String(knowledge ?? "").toLowerCase());
  // By stem ("שהמעצור" is "המעצור"), final letters plain.
  return (String(reply ?? "").match(/[^.!?\n]+[.!?]*/g) ?? []).filter((x) => TIP.test(x) && !STOP_USE.test(x) && tipWords(x).map(stem).filter((w) => k.includes(w)).length < 2).map((x) => x.trim().slice(0, 120));
}
export const hasStopUse = (reply: string) => STOP_USE.test(reply ?? "");

// The same paragraph again (prod replay 6: one paragraph sent 7 times in one conversation).
/** A reply that mostly repeats one of the employee's last five. */
export function nearDuplicate(reply: string, previousBotReplies: string[]): boolean {
  const mine = qWords(reply);
  if (mine.size < 6) return false;
  return previousBotReplies.slice(-5).some((p) => {
    const theirs = qWords(p);
    let n = 0;
    for (const w of mine) if (theirs.has(w)) n++;
    return n / Math.max(mine.size, theirs.size) > 0.7;
  });
}

// One sentence again, inside an otherwise new reply (prod replay 10: "3-7 ימי עסקים" four times).
/** Sentences (6+ words) that repeat one of the employee's last five replies. */
export function repeatedSentences(reply: string, previousBotReplies: string[]): string[] {
  const before = previousBotReplies.slice(-5).flatMap((p) => String(p).match(/[^.!?\n]+[.!?]*/g) ?? []).map(qWords).filter((w) => w.size >= 6);
  return (String(reply ?? "").match(/[^.!?\n]+[.!?]*/g) ?? []).filter((x) => {
    const mine = qWords(x);
    if (mine.size < 6) return false;
    return before.some((b) => { let n = 0; for (const w of mine) if (b.has(w)) n++; return n / Math.max(mine.size, b.size) >= 0.8; });
  }).map((x) => x.trim());
}

// A character from another script inside a Hebrew or English reply (prod replay 5: "כשמ折לים").
const FOREIGN_SCRIPT = /[^\p{Script=Hebrew}\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\s]/gu;
export const foreignScript = (reply: string) => (String(reply ?? "").match(FOREIGN_SCRIPT) ?? []).length > 0;
export const stripForeignScript = (reply: string) => String(reply ?? "").replace(FOREIGN_SCRIPT, "");

// How the system works is not the customer's business (prod replay 5: "the number is linked to your contact details").
const INTERNAL_JARGON = /(?<![\u0590-\u05FF])(?:(?:מקושר|מקושרת|משויך|משויכת)\s+ל(?:פרטי\s+(?:ה)?קשר|איש\s+(?:ה)?קשר|חשבון|כרטיס)|פרטי\s+הקשר\s+(?:השמורים|המאומתים|המקושרים)|אימות\s+זהות|הרשאות?\s+גישה|במערכת\s+שלנו\s+(?:מופיע|רשום))(?![\u0590-\u05FF])|access_denied|cross_customer|(?<![\u0590-\u05FF])(?:לא\s+מפורט(?:ים|ות|ת)?\s+(?:כאן|אצלנו|במידע)|אין\s+במידע|במידע\s+(?:שיש\s+)?(?:לי|לנו)\s+(?:אין|לא))(?![\u0590-\u05FF])|(?<![\u0590-\u05FF])(?:בתיאור\s+העסק|בפרטי\s+העסק|במידע\s+שלנו\s+(?:מופיע|מופיעה|מופיעים|כתוב)|אצלנו\s+(?:מופיע|מופיעה|מופיעים|רשום)|לא\s+(?:מופיע|מופיעה|מופיעים|מופיעות)\s+אצלנו|צירוף\s+(?:של\s+)?תבנית|הודעה\s+(?:קריאה|שאינה\s+קריאה)|לא\s+התקבלה\s+הודעה\s+קריאה)(?![\u0590-\u05FF])|\b(?:template attachment|template message|readable message)\b|(?<![\u0590-\u05FF])(?:נוסף|נוספה|הוספתי|הוספנו|שמרתי|שמרנו|עודכן|עודכנה|עדכנו)\s+(?:את\s+\S+\s+)?(?:ל|אל\s+)?(?:פרטי\s+(?:ה)?קשר|הכרטיס\s+שלך|לכרטיס|למערכת)(?![\u0590-\u05FF])|(?<![\u0590-\u05FF])(?:ההודעה\s+(?:שלא\s+נתמכה|שאינה\s+נתמכת|לא\s+נתמכת)|הודעה\s+(?:שלא\s+נתמכה|שאינה\s+נתמכת|לא\s+נתמכת))(?![\u0590-\u05FF])|\bunsupported (?:message|media)\b|\b(?:linked to your contact|contact details on file|verified identity|tool call|the system shows)\b|(?<![\u0590-\u05FF])[וש]?(?:מקור\s+(?:נוסף|אחר)|במקור\s+(?:אחר|נוסף)|לפי\s+(?:המסמך|המסמכים|המקור|המקורות)|במסמך\s+(?:אחר|נוסף)|התקנון\s+(?:מציין|אומר|קובע)[^.\n]{0,80}\s+ו(?:במקום|מקור|בשאלות|ב?מסמך)|יש\s+סתירה\s+בין)(?![\u0590-\u05FF])|\b(?:another source|one (?:document|source) says|according to the documents?)\b/iu;
export const internalJargon = (reply: string) => INTERNAL_JARGON.test(reply ?? "");

// A tool failure told to the customer (prod replay 8: "the catalogue didn't open for me").
const FAILURE_NARRATION = /(?<![\u0590-\u05FF])(?:(?:ה)?(?:צילום|תמונה|קובץ|הודעה)\s+לא\s+(?:הגיע|הגיעה|נפתח|נפתחה)(?:\s+אלינו)?(?:\s+כטקסט)?|שאפשר\s+לקרוא|לא\s+(?:הצלחתי|הצלחנו|ניתן)\s+(?:לפתוח|לקרוא|לראות)\s+(?:את\s+)?(?:ה)?(?:תמונה|צילום|קובץ)|(?:ה)?(?:בדיקה|בקשה|הזמנה|מערכת|קטלוג|עמוד|קישור|חיפוש)(?:\s+של\s+[\u0590-\u05FF]+)?\s+לא\s+(?:נפתח|נפתחה|נטען|נטענה|עבד|עבדה|הצליח|הצליחה)|הקטלוג\s+לא\s+(?:נפתח|נטען|עובד|זמין)|לא\s+נפתח\s+לי|לא\s+נטען\s+לי|יש\s+(?:לי\s+)?(?:תקלה|בעיה\s+טכנית)|תקלה\s+(?:טכנית|במערכת|בחיפוש)|המערכת\s+לא\s+(?:עובדת|עונה|מאפשרת)|החיפוש\s+(?:נכשל|לא\s+עבד))(?![\u0590-\u05FF])|\b(?:catalog(?:ue)? (?:didn'?t|did not|won'?t) (?:open|load)|technical (?:issue|problem)|the system (?:is down|isn'?t working)|search failed)\b/iu;
export const failureNarration = (reply: string) => FAILURE_NARRATION.test(reply ?? "");

// Broken Hebrew seen in prod replay 8 ("חשוב לנו לשמוע מה לא מרוצה").
// "זה באמת לא בטיחותי" (prod replay 13): the business never affirms its product is unsafe.
const AFFIRMS_UNSAFE = /(?<![\u0590-\u05FF])(?:זה|המשטח|המוצר|המכשיר|הוא|היא)\s+(?:באמת\s+|ממש\s+|אכן\s+)?(?:לא\s+בטיחותי(?:ת)?|מסוכנ(?:ת|ים)?|מסוכן)(?![\u0590-\u05FF])|\b(?:it(?:'s| is) (?:really |indeed )?(?:unsafe|dangerous))\b/iu;
// "ייתכן שהמשטח יזוז" (prod replay 12): a hedge that invents a fault.
const ODD_HEDGE = /(?<![\u0590-\u05FF])(?:ייתכן|יתכן|אולי|יכול\s+להיות)\s+ש(?:ה)?(?:משטח|מכשיר|מוצר|זה)\s+(?:יזוז|תזוז|יחליק|תחליק|ייפול|יתהפך|לא\s+יחזיק)(?![\u0590-\u05FF])/u;
const BROKEN_HE = /(?<![\u0590-\u05FF])(?:מה\s+לא\s+(?:מרוצה|מרוצים|מרוצות)|(?:לא\s+)?מצוין\s+התאמה)(?![\u0590-\u05FF])/u;
// A statement written as a question ("יש כמה מטפחות חגיגיות בגווני כחול?") when products are shown.
// A plain statement only: no comma (a question after it) and no question word inside.
const STATEMENT_Q = /(?:^|(?<=[.!]\s))(יש\s+(?:כמה|לנו)(?:(?!\s(?:איזה|איזו|אילו|לאיזה|לאיזו|מה|איך|האם|מתאים|מתאימה|רוצים|רוצה|תרצו)(?![\u0590-\u05FF]))[^.?!,\n]){3,80})\?/gu;

export interface Gate3Input {
  reply: string;
  claims: Claim[];
  cards: string[];
  /** Products this turn's tools returned (keys PRODUCT_1..N). */
  candidateCount: number;
  tools: ToolRunRecord[];
  /** Everything a price or product may come from: tool results, state, knowledge, the conversation. */
  grounding: string;
  locale: "he" | "en";
  incomingMessage: string;
  isFirstReply: boolean;
  employeeGender: "feminine" | "masculine" | null;
  employeeName: string | null;
  toolsOffered: string[];
  shopFloor: boolean;
  handedOff: boolean;
  approvalPending: boolean;
  /** A question was recorded for the team this turn (respond.team_question). */
  teamQuestion?: boolean;
  /** The reply's handoff and the customer's last messages (the handoff check). */
  handoff?: string | null;
  recentInbound?: string[];
  /** A tool this turn needs a person (an approval, a denied action): a handoff may follow. */
  toolsNeedPerson?: boolean;
  /** The team already has an open question from this conversation (state.pending). */
  teamAlreadyOpen?: boolean;
  /** This turn's team question is a NEW issue (not a repeat of the open one). */
  newTeamQuestion?: boolean;
  /** The business's own words this turn: the knowledge shown and search_knowledge results. */
  knowledge?: string;
  /** The employee's own earlier replies in this conversation, oldest first (never a person's). */
  previousBotReplies?: string[];
  /** A safety or damage conversation (sticky once seen). */
  safety?: boolean;
  /** A store search this turn timed out or failed. */
  searchFailed?: boolean;
  /** The business's address as the prompt gives it (profile, or the documents'). */
  businessAddress?: string | null;
  /** The titles of the products this turn's tools returned. */
  candidateTitles?: string[];
  /** The channel shows product cards. */
  cardsChannel?: boolean;
  /** A text channel with products this turn: the engine appends them (name, price, link). */
  listAppended?: boolean;
  /** The customer's own messages, and everything else a fact may come from (tools, knowledge, a person, the state). */
  customerText?: string;
  sourceText?: string;
}

export function gate3(i: Gate3Input): Gate3Verdict {
  const problems: ClaimProblem[] = [];
  const reply = String(i.reply ?? "").trim();
  if (!reply) return { ok: false, problems: [{ kind: "style", codes: ["empty"] }] };

  const prices = ungroundedPrices(reply, i.grounding);
  if (prices.length) problems.push({ kind: "ungrounded_price", prices });

  // Shadow and replay judge a simulated write as live would see it: done, or awaiting approval.
  const simApproval = (t: ToolRunRecord) => t.decision === "simulated" && /awaiting_approval/.test(String(t.content ?? ""));
  const log = i.tools.map((t) => ({
    tool: t.tool,
    decision: t.decision === "allow" ? "executed" : t.decision === "approval" || simApproval(t) ? "awaiting_approval" : t.decision === "simulated" ? "executed" : t.decision,
    sideEffect: t.decision === "approval" || simApproval(t) ? "awaiting_approval" : t.decision === "deny" ? "denied" : undefined,
  }));
  // A handoff, or a question recorded for the team, is evidence for "I passed it to the team".
  if (i.handedOff || i.teamQuestion) log.push({ tool: "escalate_to_human", decision: "executed", sideEffect: "escalate" });
  const honesty = validateActionHonesty(reply, log as any, { hasBackgroundJob: i.approvalPending });
  const unbacked = [
    ...(honesty.ok ? [] : honesty.unsupported.map((u: any) => String(u?.match ?? u?.kind ?? u))),
    ...unbackedPromises(reply, { teamQuestion: !!i.teamQuestion, handedOff: i.handedOff, teamAlreadyOpen: !!i.teamAlreadyOpen, approvalPending: i.approvalPending }),
  ];
  if (unbacked.length) problems.push({ kind: "unsupported_action", claims: [...new Set(unbacked)] });
  const absent = ungroundedAbsence(reply, i.tools, i.knowledge ?? "");
  // "Not on file" about something the knowledge does mention (prod replay 12: pickup "בתיאום מראש").
  absent.push(...infoDeniedButKnown(reply, i.knowledge ?? ""));
  // "The address is not in my details" while the prompt gives one (prod replay 10, Tehila).
  if (i.businessAddress) absent.push(...addressDenied(reply));
  if (absent.length) problems.push({ kind: "ungrounded_absence", claims: absent });

  if (gaveUpSearch(reply, i.tools)) problems.push({ kind: "gave_up_search" });
  else if (unreadProduct(reply, i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion)) problems.push({ kind: "unread_product" });
  else if (unreadBusinessInfo(reply, i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion)) problems.push({ kind: "unread_knowledge" });
  // "Still with the team" about a coupon or policy: the general answer is in the knowledge (prod replay 11: 3 times).
  else if (unreadKnowledge(i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion || (!!i.teamAlreadyOpen && TEAM_LINE.test(reply)))) problems.push({ kind: "unread_knowledge" });
  else if (unreadOrder(reply, i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion)) problems.push({ kind: "unread_order" });
  else if (unreadKnowledge(i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion)) problems.push({ kind: "unread_knowledge" });
  if (needlessHandoff(i.handoff, i.recentInbound ?? [i.incomingMessage], !!i.toolsNeedPerson)) problems.push({ kind: "needless_handoff" });
  // Products this turn mean a search ran.
  if (!i.candidateCount && (photoInsteadOfSearch(reply, i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion) || purchaseWithoutSearch(i.incomingMessage, i.tools, i.toolsOffered)
    // A text channel: products named from the knowledge alone get no name, price or link (prod replay 11).
    || (!i.cardsChannel && namesProductsUnsearched(reply, i.incomingMessage, i.tools, i.toolsOffered)))) problems.push({ kind: "no_search" });
  if (i.searchFailed && i.teamQuestion && knowledgeHasIt(i.incomingMessage, i.knowledge ?? "")) problems.push({ kind: "knowledge_has_it" });
  if (couponSourceMissed(i.incomingMessage, reply)) problems.push({ kind: "coupon_source" });
  if (namelessProducts(reply, i.incomingMessage, i.cards, i.candidateTitles ?? [], !!i.listAppended)) problems.push({ kind: "nameless_products" });
  const tips = unsafeTips(reply, i.knowledge ?? "", !!i.safety);
  if (tips.length) problems.push({ kind: "unsafe_tip", claims: tips });
  const echoed = i.customerText != null ? echoedSizes(reply, i.customerText, i.sourceText ?? "") : [];
  if (echoed.length) problems.push({ kind: "echoed_size", claims: echoed });
  const pictures = cardReferences(reply, !!i.cardsChannel && i.cards.length > 0);
  if (pictures.length) problems.push({ kind: "card_reference", claims: pictures });
  if (ignoredYes(i.incomingMessage, (i.previousBotReplies ?? []).at(-1), i.handedOff, !!i.teamQuestion)) problems.push({ kind: "ignored_yes" });
  const unknown = unknownProductKeys(i.claims, i.cards, i.candidateCount);
  if (unknown.length) problems.push({ kind: "unknown_product", names: unknown });

  const style = checkReplyStyle(reply, {
    locale: i.locale,
    isFirstReply: i.isFirstReply,
    incomingMessage: i.incomingMessage,
    employeeGender: i.employeeGender,
    employeeName: i.employeeName,
    productFactsAvailable: i.tools.some((t) => /product|search|variation|inventory/i.test(t.tool)),
    shopFloor: i.shopFloor,
    toolsOffered: i.toolsOffered,
    handedOff: i.handedOff,
    customerClosing: false,
    toolsCalled: i.tools.map((t) => t.tool),
    groundingText: i.grounding,
  })
    .map((v) => v.kind)
    // Prices are the claims check above, with the same grounding.
    .filter((k) => HARD_STYLE.has(k) && k !== "ungrounded_price") as string[];
  if (i.locale === "he") for (const [code, re] of V2_BANS_HE) if (re.test(reply)) style.push(code);
  if (simulationLeak(reply)) style.push("simulation_leak");
  if (foreignScript(reply)) style.push("foreign_script");
  if (internalJargon(reply)) style.push("internal_jargon");
  if (failureNarration(reply)) style.push("failure_narration");
  if (i.locale === "he" && BROKEN_HE.test(reply)) style.push("broken_hebrew");
  if (i.locale === "he" && ODD_HEDGE.test(reply)) style.push("odd_hedge");
  if (AFFIRMS_UNSAFE.test(reply)) style.push("affirms_unsafe");
  if (i.locale === "he" && (i.candidateCount > 0 || i.cards.length > 0) && new RegExp(STATEMENT_Q.source, "u").test(reply)) style.push("statement_question");
  if (repeatedAsk(reply, i.previousBotReplies ?? [])) style.push("repeated_ask");
  if (nearDuplicate(reply, i.previousBotReplies ?? [])) style.push("near_duplicate");
  else if (repeatedSentences(reply, i.previousBotReplies ?? []).length) style.push("repeated_sentence");
  if (repeatedTeamLine(reply, i.incomingMessage, !!i.teamAlreadyOpen, !!i.newTeamQuestion)) style.push("repeated_team_line");
  if (style.length) problems.push({ kind: "style", codes: [...new Set(style)] });

  return { ok: problems.length === 0, problems };
}

/**
 * The problems that may stop a reply after the rewrite: a fact the customer would
 * be misled by. Everything else (style, an unread lookup, a needless handoff) is
 * cleaned or sent as is, never swapped for a canned line (prod replay 2 2026-11-16:
 * 17 fallbacks on Smoovee, most of them style, replaced real answers).
 */
export const FACTUAL_KINDS: ReadonlySet<ClaimProblem["kind"]> = new Set<ClaimProblem["kind"]>(["ungrounded_price", "unsupported_action", "unknown_product", "ungrounded_absence", "card_reference", "echoed_size", "unsafe_tip"]);
export const factualProblems = (problems: ClaimProblem[]) => problems.filter((p) => FACTUAL_KINDS.has(p.kind));

const SENTENCES = /[^.!?\n]+[.!?]*\s*/g;
const dropSentences = (s: string, re: RegExp) => (s.match(SENTENCES) ?? [s]).filter((x) => !re.test(x)).join("").trim();

// The employee's gendered first person -> the team's plural ("שמחה ש" -> "שמחים ש").
const FIRST_PERSON_PLURAL: Record<string, string> = {
  שמחה: "שמחים", שמח: "שמחים", מצטערת: "מצטערים", מצטער: "מצטערים", ממליצה: "ממליצים", ממליץ: "ממליצים",
  מציעה: "מציעים", מציע: "מציעים", חושבת: "חושבים", חושב: "חושבים", בודקת: "בודקים", בודק: "בודקים",
  מעבירה: "מעבירים", מעביר: "מעבירים", יודעת: "יודעים", יודע: "יודעים", בטוחה: "בטוחים", בטוח: "בטוחים",
  זמינה: "זמינים", זמין: "זמינים", מבינה: "מבינים", מבין: "מבינים",
};
const FIRST_PERSON_WORDS = Object.keys(FIRST_PERSON_PLURAL).sort((a, b) => b.length - a.length).join("|");
export function neutralFirstPerson(s: string): string {
  return s
    .replace(new RegExp(`(?<![\\u0590-\\u05FF])אני\\s+(${FIRST_PERSON_WORDS})(?![\\u0590-\\u05FF])`, "gu"), (_m, w) => `אנחנו ${FIRST_PERSON_PLURAL[w]}`)
    .replace(/(?<![\u0590-\u05FF])(?<!(?:חג|יום|שבוע)\s)(שמחה|שמח)(?=\s+[של][\u0590-\u05FF])/gu, "שמחים")
    .replace(/(?<![\u0590-\u05FF])(מצטערת|מצטער)(?=\s+(?:ש|על|לשמוע|מאוד|באמת)|\s*[,.!])/gu, "מצטערים")
    .replace(/(?<![\u0590-\u05FF])הייתי\s+(?:צריכה|צריך)(?![\u0590-\u05FF])/gu, "היה צריך")
    .replace(/(?<![\u0590-\u05FF])(?<!(?:את|אתה|אתם|אתן|הוא|היא)\s)(?:מבינה|מבין)(?=\s*[,.!]|\s+(?:את|ש|לגמרי|אותך|אותכם|לחלוטין)(?![\u0590-\u05FF]))/gu, "מבינים");
}

/**
 * A FACT problem loses its sentence (prod replay 5: 3 canned lines, each where one
 * sentence, an absence or a promise, failed and the rest of the reply was fine).
 * A made-up price loses the price. What is left is judged again by the caller.
 */
export function stripFactProblems(reply: string, problems: ClaimProblem[]): string {
  let s = String(reply ?? "");
  for (const p of problems) {
    // A made-up price loses its sentence ("התיק עולה ₪120." would leave "התיק עולה.").
    if (p.kind === "ungrounded_price") {
      const priced = (x: string) => p.prices.some((pr) => stripPrices(x, [pr]) !== x);
      s = (s.match(SENTENCES) ?? [s]).filter((x) => !priced(x)).join("").trim();
    }
    if (p.kind === "ungrounded_absence" || p.kind === "unsupported_action" || p.kind === "card_reference" || p.kind === "echoed_size" || p.kind === "unsafe_tip") {
      const marks = p.claims.map((c) => String(c ?? "").trim().slice(0, 40)).filter((m) => m.length >= 3);
      if (marks.length) s = (s.match(SENTENCES) ?? [s]).filter((x) => !marks.some((m) => x.includes(m))).join("").trim();
      // The honesty check names some claims by kind only: "passed to the team" and promises go by pattern.
      if (p.kind === "unsupported_action") s = dropSentences(dropSentences(s, TEAM_LINE), FUTURE_PROMISE);
    }
  }
  return s.trim();
}

/**
 * The lookups a rewrite needs that the engine can make itself, with no model
 * round: the customer's own words in the store (an absence, a photo asked
 * instead of a search, a search that gave up), or in the knowledge (a business
 * fact). Two at most. Product and order reads need the model (which product,
 * which order) and are not here.
 */
export function autoLookups(problems: ClaimProblem[], incoming: string, toolsOffered: string[], done: ToolRunRecord[]): Array<{ id: string; function: { name: string; arguments: string } }> {
  const out: Array<{ id: string; function: { name: string; arguments: string } }> = [];
  const words = String(incoming ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!words) return out;
  const store = toolsOffered.find((n) => /(?:^|\.)(?:list_products|search_products)$/.test(n));
  const has = (k: ClaimProblem["kind"]) => problems.some((p) => p.kind === k);
  if (store && (has("ungrounded_absence") || has("no_search"))) {
    out.push({ id: "auto_store_1", function: { name: store, arguments: JSON.stringify({ query: words, per_page: 5 }) } });
  } else if (store && has("gave_up_search")) {
    const last = [...done].reverse().find((t) => t.tool === store && t.outcome === "timeout");
    const narrow = String((last?.args as any)?.query ?? words).split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
    out.push({ id: "auto_store_1", function: { name: store, arguments: JSON.stringify({ query: narrow, per_page: 5 }) } });
  }
  if (has("unread_knowledge") && toolsOffered.includes("search_knowledge")) {
    out.push({ id: "auto_knowledge_1", function: { name: "search_knowledge", arguments: JSON.stringify({ query: words }) } });
  }
  return out.slice(0, 2);
}

/**
 * Deterministic cleanup of a reply whose remaining problems are style only: what
 * code can fix safely is fixed, the rest is sent as written. An empty result means
 * nothing is left to say.
 */
export function cleanStyle(reply: string, codes: string[], previousBotReplies: string[] = []): string {
  const c = new Set(codes);
  let s = String(reply ?? "");
  if (c.has("repeated_sentence")) {
    const again = new Set(repeatedSentences(s, previousBotReplies));
    s = (s.match(SENTENCES) ?? [s]).filter((x) => !again.has(x.trim())).join("").trim();
  }
  if (c.has("simulation_leak")) s = dropSentences(s, SIMULATION_LEAK);
  if (c.has("repeated_team_line")) s = dropSentences(s, TEAM_LINE);
  // "מצאתי כמה אפשרויות" -> "יש כמה אפשרויות"; "לא מצאתי" is left alone (the ban skips it too).
  if (c.has("found_narration")) s = s.replace(/(?<![֐-׿])(?<!לא\s)((?:ו|ש)?)מצאתי(?![֐-׿])/gu, "$1יש");
  if (c.has("self_gendered")) s = neutralFirstPerson(s);
  if (c.has("foreign_script")) s = stripForeignScript(s);
  if (c.has("internal_jargon")) s = dropSentences(s, INTERNAL_JARGON);
  if (c.has("failure_narration")) s = dropSentences(s, FAILURE_NARRATION);
  if (c.has("odd_hedge")) s = dropSentences(s, ODD_HEDGE);
  if (c.has("affirms_unsafe")) s = dropSentences(s, AFFIRMS_UNSAFE);
  if (c.has("gendered_agree")) s = s.replace(/(?<![\u0590-\u05FF])(?:(?:את|אתה)\s+)?(?:צודק|צודקת)(?![\u0590-\u05FF])/gu, "נכון");
  if (c.has("broken_hebrew")) s = s.replace(/(?<![\u0590-\u05FF])מה\s+לא\s+(?:מרוצה|מרוצים|מרוצות)(?![\u0590-\u05FF])/gu, "מה לא היה בסדר").replace(/(?<![\u0590-\u05FF])מצוין(?=\s+התאמה)/gu, "מצוינת");
  if (c.has("statement_question")) s = s.replace(STATEMENT_Q, "$1.");
  if (c.has("repeated_ask")) s = dropSentences(s, PHOTO_ASK);
  if (c.has("help_grammar")) s = s.replace(/(?<![\u0590-\u05FF])מה(\s+(?:אפשר|אוכל|נוכל|ניתן)\s+לעזור)/gu, "במה$1");
  if (c.has("mixed_person")) s = s.replace(/(?<![\u0590-\u05FF])(?:ביקשתם)(?=\s+ממך)/gu, "ביקשנו").replace(/(?<![\u0590-\u05FF])(?:שלחתם)(?=\s+לך)/gu, "שלחנו").replace(/(?<![\u0590-\u05FF])(?:אמרתם)(?=\s+לך)/gu, "אמרנו");
  return normalizeDashes(s).replace(/[ \t]{2,}/g, " ").trim();
}

const words = (s: string) => (String(s ?? "").match(/[\u0590-\u05FFA-Za-z0-9]+/g) ?? []).length;
const QUESTION = /\?|(?<![\u0590-\u05FF])(?:מה|איך|איפה|מתי|כמה|למה|האם|יש|אפשר|מאיזה|איזה|אילו)(?![\u0590-\u05FF])|\b(?:what|how|where|when|which|do you|can i|is there)\b/iu;
const PRODUCT_ASK = /(?<![\u0590-\u05FF])(?:מחפש|מחפשת|מחפשים|יש לכם|יש לך|אפשר לקבל|ממליצים|תמליצו|המלצה|צריך|צריכה|רוצה|רוצים|בא לי|מעוניין|מעוניינת|מה יש|מה מתאים|איזה|אילו|בגוון|בצבע)(?![\u0590-\u05FF])|\b(?:looking for|do you have|recommend|i need|i want|something (?:in|for))\b/iu;
/**
 * A reply that does not answer: cut to a word or two by the cleanup while the
 * customer asked something, or (prod replay 4, Tehila: "ברור, דווקא חגיגית ובגווני
 * כחול.") a product ask met with no product, no price and no question.
 */
export function tooThin(cleaned: string, original: string, incoming: string, shown: { cards?: string[]; titles?: string[] } = {}): boolean {
  if (cleaned.trim() !== String(original ?? "").trim() && words(cleaned) < 3 && QUESTION.test(incoming ?? "")) return true;
  if (!PRODUCT_ASK.test(incoming ?? "")) return false;
  const hasProduct = (shown.cards ?? []).length > 0 || (shown.titles ?? []).some((t) => t && cleaned.includes(t)) || /PRODUCT_\d+|₪|ש["״']ח|\d+\s?(?:NIS|ILS)/.test(cleaned);
  return !hasProduct && !/\?/.test(cleaned);
}

/** Hyphens inside a word become "-"; a dash between words becomes a comma (U+2010 to U+2015, U+2212; prod replay 6: U+2011). */
export function normalizeDashes(s: string): string {
  return String(s ?? "")
    // A range stays a range: "3\u20137 ימי עסקים" is "3-7" (prod replay 7: it became "3, 7").
    .replace(/(\d)\s*[\u2010-\u2015\u2212]\s*(?=\d)/g, "$1-")
    .replace(/[\u2010\u2011\u2212]/g, "-")
    .replace(/\s*[\u2012-\u2015]\s*/g, ", ");
}

/** The ONE targeted correction note for the rewrite round. */
export function correctionNote(problems: ClaimProblem[], locale: "he" | "en"): string {
  const lines = ["Your reply cannot be sent as is. Rewrite it once, fixing exactly this, and call respond again:"];
  for (const p of problems) {
    if (p.kind === "ungrounded_price") lines.push(`- These prices are not in any tool result or the knowledge: ${p.prices.join(", ")}. Remove them or state only prices a tool returned.`);
    if (p.kind === "unsupported_action") lines.push(`- You said something was done that no tool did this turn (${p.claims.join("; ")}). Say only what really happened; offer a person if needed.`);
    if (p.kind === "needless_handoff") lines.push("- Do NOT hand this over: a handoff silences you for the rest of the chat, and the customer did not ask for a person. Set handoff to null. Answer from what you know; if the team must answer (a discount, instalments, a detail not in the product text), say you will check with the team and put the question in team_question. A tool that failed is not a reason: say you could not check it right now.");
    if (p.kind === "unread_order") lines.push("- The customer asked about their order or delivery. Look it up first: call the order or tracking tool now (ask for the order number or phone only if you truly need it), answer from what it returns, and only if it cannot tell say the team will check.");
    if (p.kind === "unread_knowledge") lines.push("- The customer asked about the business itself (an address, hours, pickup, shipping, returns, contact, a coupon or a policy). Call search_knowledge now and answer from it, or from the business details you were given; only if neither has it put the question in team_question.");
    if (p.kind === "ungrounded_absence" && p.claims.some((c) => ADDRESS_DENIED.test(c))) lines.push("- The business's address IS in the business details above: give it.");
    if (p.kind === "ungrounded_absence") lines.push(`- You said we do not have or sell something (${p.claims.join("; ")}), but no search for those words ran this turn, or it returned them. Search for it now (the customer's own words), and answer from what comes back; if nothing does, say you did not find it by that name and ask.`);
    if (p.kind === "no_search") lines.push("- The customer told you what they want (a category, a colour, a size). Search the store with their words now and show what fits; ask at most one short question, never for a photo you already asked for.");
    if (p.kind === "unsafe_tip") lines.push(`- This is a safety conversation: give no usage tip the business's knowledge does not state (${p.claims.join("; ")}). Say to stop using it until a person from the team checks, and that a person will continue here.`);
    if (p.kind === "coupon_source") lines.push("- The customer asks where to GET a code, not where to enter it. Say where codes come from if the knowledge says (a promotion, the newsletter); otherwise put the question in team_question. Do not repeat where to enter it.");
    if (p.kind === "knowledge_has_it") lines.push("- The store search did not answer, but the business's knowledge above already answers this (a device or size table): answer from it, and do not send it to the team.");
    if (p.kind === "echoed_size") lines.push(`- A product's size comes from the product data, never from the number the customer typed (${p.claims.join("; ")}). State the size the search returned, or that it is not listed.`);
    if (p.kind === "card_reference") lines.push("- No picture or card goes out with this reply: do not refer to one (\"בתמונה\", \"מצורף\"). Name the product instead.");
    if (p.kind === "nameless_products") lines.push("- You present products without naming any. Name one to three of the products the search returned, each with its price, or put their keys in cards.");
    if (p.kind === "ignored_yes") lines.push("- The customer said yes to your own offer of a person (or that it is urgent). Hand over now: set handoff, and say a person from the team will continue here.");
    if (p.kind === "gave_up_search") lines.push("- The store search took too long. Call it once more with a narrower query (the category, or one or two words, per_page 5). If you still have nothing, answer from what you know (the categories, the knowledge, what was already shown) and ask what matters to the customer. Never say you could not check.");
    if (p.kind === "unread_product") lines.push("- The customer asked about the product itself (material, colours, feel, fit, care, origin). Read it first: call get_product (or the product search) now, answer from its text, and only if the text truly lacks it say you will check.");
    if (p.kind === "unknown_product") lines.push(`- These product keys are not in this turn's results: ${p.names.join("; ")}. Use only the PRODUCT_n keys a tool returned this turn.`);
    if (p.kind === "style") {
      const c = new Set(p.codes);
      if (c.has("gendered_address") || c.has("slash_form")) lines.push(locale === "he" ? "- Address the customer neutrally (לך / אפשר + infinitive), no gendered verbs and no slash forms." : "- Address the customer neutrally.");
      if (c.has("self_gender")) lines.push("- Speak of yourself in your configured gender, or neutrally.");
      if (c.has("banned_phrase") || c.has("self_intro")) lines.push("- Drop stock phrases and self-introductions; answer directly.");
      if (c.has("card_narration")) lines.push("- Do not describe the cards, their pictures or buttons; they are on screen.");
      if (c.has("callback_promise")) lines.push("- No \"נחזור אליך\" or any callback: say the question went to the team and the answer will come here in the chat (\"העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט\").");
      if (c.has("foreign_script")) lines.push("- A character from another alphabet slipped into a word: rewrite the reply in the customer's language only.");
      if (c.has("failure_narration")) lines.push("- Never tell the customer a tool or the catalogue failed. Search again narrower, or ask one question about what they want, or show the closest products from earlier in this conversation.");
      if (c.has("statement_question")) lines.push("- \"יש כמה ...\" about the products you show is a statement: end it with a full stop, not a question mark.");
      if (c.has("affirms_unsafe")) lines.push("- Never affirm on the business's behalf that the product is unsafe or dangerous: apologise, say to stop using it until a person checks, and a person continues here.");
      if (c.has("gendered_agree")) lines.push("- \"נכון\" or \"בדיוק\", not \"צודק/צודקת\" (the customer's gender is not known).");
      if (c.has("odd_hedge")) lines.push("- No hedge that invents a fault (\"ייתכן שהמשטח יזוז\").");
      if (c.has("broken_hebrew")) lines.push("- \"מה לא היה בסדר\" (or \"מה לא עבד\"), not \"מה לא מרוצה\".");
      if (c.has("internal_jargon")) lines.push("- Do not explain how the system works (linked details, identity, access) and never mention sources or documents (\"another source says\"): when the business's texts disagree, give the more specific policy's rule and put the conflict in team_question.");
      if (c.has("repeated_sentence")) lines.push("- A sentence of this reply was already sent in this conversation: do not send it again; say only what is new.");
      if (c.has("near_duplicate")) lines.push("- That reply repeats one you already sent in this conversation. Answer the new message itself, briefly, or only what is new.");
      if (c.has("repeated_ask")) lines.push("- You already asked that in this conversation: do not ask it again. Use what you have, or move on.");
      if (c.has("help_grammar")) lines.push("- \"במה אפשר לעזור\", not \"מה אפשר לעזור\".");
      if (c.has("mixed_person")) lines.push("- One person per sentence: we asked you (\"ביקשנו ממך\"), not \"ביקשתם ממך\".");
      if (c.has("self_gendered")) lines.push("- Speak of yourself neutrally (\"כדאי\", \"ממליצים\", \"הכי מתאים לך\"), never a gendered first person.");
      if (c.has("found_narration")) lines.push("- Do not narrate the search (\"מצאתי\"); just say what there is.");
      if (c.has("imperative_notice") || c.has("gendered_prefers") || c.has("mixed_address")) lines.push("- No \"שים לב\" or \"מעדיף/ה\": rephrase neutrally.");
      if (c.has("recap_opener") || c.has("echo_opener")) lines.push("- Do not open by restating what the customer said; answer.");
      if (c.has("false_absence")) lines.push("- An empty search is not proof the store lacks it: say you did not find it by that name.");
      if (c.has("empty")) lines.push("- The reply was empty: write the message to the customer.");
      if (c.has("simulation_leak")) lines.push("- Never mention a test, a simulation or that something was not really done: write to the customer as in any real conversation.");
      if (c.has("repeated_team_line")) lines.push("- The team already has this question: do not say again that you passed it on, and do not set team_question for it again. Answer this new message itself.");
    }
  }
  return lines.join("\n");
}

/** An absence the search could not back, and nothing found: say what is true, not a hand-off (prod replay 6). */
export function notFoundReply(locale: "he" | "en"): string {
  return locale === "he" ? "לא מצאתי את זה בשם הזה. אפשר לתאר את זה במילים אחרות?" : "I didn't find that by that name. Could you describe it another way?";
}

/** The canned team lines (both forms), to know one was already sent. */
export function isCannedTeamLine(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  return !!t && ([safeFallback("he"), safeFallback("he", true), safeFallback("en"), safeFallback("en", true)].includes(t));
}

/** The safe fixed reply when the rewrite fails too: honest, short, hands the case on. */
export function safeFallback(locale: "he" | "en", teamAlreadyOpen = false): string {
  // The team already has it: say so once more without announcing a new hand-off.
  if (teamAlreadyOpen) {
    return locale === "he"
      ? "זה כבר אצל הצוות, והתשובה תגיע כאן בצ'אט."
      : "The team already has this, and the answer will come here in the chat.";
  }
  // What really happens: the question goes to the team (respond.team_question /
  // the unanswered list) and the answer comes in this chat. Never a callback:
  // there is no call tool (eval arm5 "promise" flags on "נחזור אליך").
  return locale === "he"
    ? "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט."
    : "I've passed your question to the team, and the answer will come here in the chat.";
}

/**
 * The fallback for a product turn whose reply failed twice: the products this
 * turn's tools returned, with their store prices, never a handoff (a product
 * question is ours to answer; eval 2026-11-16 handed 30 of them to a person).
 */
export function groundedProductFallback(
  candidates: Array<{ title: string; price?: number | null; currency?: string | null; inventoryState?: string; priceOnSite?: boolean }>,
  locale: "he" | "en",
  cards: boolean,
): string | null {
  const shown = candidates.filter((c) => c?.title && c.inventoryState !== "out_of_stock").slice(0, 3);
  if (!shown.length) return null;
  if (cards) return locale === "he" ? "הנה מה שיש לנו שמתאים." : "Here is what we have that fits.";
  const cur = (c: string | null | undefined) => (c === "ILS" || !c ? "₪" : `${c} `);
  const line = (c: (typeof shown)[number]) => (c.price != null && !c.priceOnSite ? `${c.title}, ${cur(c.currency)}${c.price}` : c.title);
  return (locale === "he" ? "הנה מה שיש לנו שמתאים:\n" : "Here is what we have that fits:\n") + shown.map((c) => `• ${line(c)}`).join("\n");
}
