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
  // Eval 2026-11-17: "כן אחי, ..." to a customer. A vocative only (start, or after a greeting or a comma); "בושם גבר" is a product.
  ["familiar_address", /(?:^|[.!?]\s*|(?<![֐-׿])(?:כן|היי|הי|אהלן|תודה|בטח|סבבה|שלום|וואו)\s+|,\s*)(?:אחי|אחותי|אחיי|גבר|מותק|נשמה|חמוד|חמודה|מלך|מלכה|בובה|יקירי|יקירתי)(?=\s*[,!.?]|\s*$)/u],
  ["mixed_person", /(?<![\u0590-\u05FF])(?:ביקשתם\s+ממך|ביקשת\s+מכם|שלחתם\s+לך|אמרתם\s+לך)(?![\u0590-\u05FF])/u],
];

// A question about a product's own properties, in generic words (no fabric, metal or part names).
// Bans in any language: a callback (there is no call tool; the answer comes in the chat).
const V2_BANS_ANY: Array<[string, RegExp]> = [
  ["callback_promise", /\b(?:we(?:'ll| will) (?:call you|give you a call|phone you|ring you)|call you back|(?:someone|a person|the team|we) will (?:call|phone|ring) you)\b/iu],
];

const ATTRIBUTE_ASK = /(?<![\u0590-\u05FF])(?:מגרד|מגרדת|נעים|נעימה|רך|רכה|קשיח|קשיחה|עבה|דק|דקה|נוח|נוחה|כבד|כבדה|עמיד|עמידה|חומר|מאיזה|עשוי|עשויה|עשויים|ממה|גזרה|גזרת|מידות|מידה|גודל|מימדים|משקל|אורך|רוחב|גובה|עובי|קיבולת|לכבס|כביסה|לנקות|ניקוי|טיפול|מיוצר|תוצרת|ארץ\s+ייצור|איכות|צבע|צבעים|בצבע|באיזה\s+צבע|באילו\s+צבעים|גוון|גוונים|מה\s+כולל|מה\s+בערכה|תואם|תואמת|מתאים\s+ל|אחריות)(?![\u0590-\u05FF])|\b(?:colou?rs?|shades?|itch(?:y)?|soft|comfortable|heavy|light|durable|material|fabric|made of|fit|sizing|size|dimensions?|weight|length|width|height|capacity|runs (?:small|large)|wash|clean|care|origin|made in|quality|compatible|what'?s included|warranty)\b/iu;
const NO_INFO = /אין (?:לי|לנו)(?: כאן)? (?:מידע|פרטים|פירוט)|(?<![\u0590-\u05FF])לא\s+נבדק(?:ו|ה)?(?![\u0590-\u05FF])|אין (?:לי|לנו|ברשותי)(?: כאן)? את (?:ה)?(?:כתובת|פרטים|מידע|שעות|מספר)|(?:לא|אינה|אינו) (?:זמין|זמינה|זמינים|מופיע|מופיעה|מופיעים)|לא (?:בטוח|בטוחה|יודע|יודעת|ידוע)|(?:לבדוק|אבדוק|נבדוק|בודקים)(?: את זה)? (?:מול|עם) הצוות|\b(?:I don'?t have (?:that |the )?(?:info|information|details|address|exact address)|not (?:available|listed)|not sure|check with the team)\b/iu;

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
// (prod replay 7). GENERIC by design (2026-11-17, Omer: no product words): harm
// that happened (an injury, a burn, fire or smoke, a shock, a fall or tip-over, a
// rash or an allergic reaction, something swallowed) or a product called unsafe.
// A topic alone ("is it safe for a child?", "I have an allergy") is not harm.
// What a product's own hazards are comes from the business's knowledge
// (knowledgeHazard below), never from a word list here.
const SAFETY = /(?<![\u0590-\u05FF])[וש]?(?:מסוכן|מסוכנת|מסוכנים|לא\s+בטיחותי|לא\s+בטיחותית|סכנה|סכנת|נפצע|נפצעה|נפצעו|נפגע|נפגעה|נפגעו|פציעה|פצע|נחתך|נחתכה|חתך|מדמם|מדממת|דימום|נכווה|נכוותה|כוויה|כוויות|נשרף|נשרפה|נשרפו|שריפה|עלה\s+באש|עלתה\s+באש|עשן|עשה\s+עשן|ניצוץ|ניצוצות|קצר\s+חשמלי|התחשמל|התחשמלה|מכת\s+חשמל|נמס|נמסה|התחמם\s+מאוד|התחממה\s+מאוד|רותח|נפל|נפלה|נפלו|נופל|נופלת|כמעט\s+נפל|כמעט\s+נפלה|התהפך|התהפכה|מתהפך|מתהפכת|נהפך|נהפכה|קרס|קרסה|התמוטט|התמוטטה|לא\s+יציב|לא\s+יציבה|פריחה|תגובה\s+אלרגית|אלרגיה\s+(?:קשה|חזקה)|התנפח|התנפחה|נחנק|נחנקה|בלע|בלעה|רעיל|רעילה|הרעלה|נשבר|נשברה|נשברו|פגום|פגומה|פגומים)(?![\u0590-\u05FF])|\b(?:dangerous|unsafe|hazard(?:ous)?|injur(?:y|ed|ies)|hurt (?:myself|me|him|her|them|my)|cut (?:myself|my)|bleed(?:ing)?|burn(?:t|ed|s)? (?:me|my|myself|him|her)|caught fire|on fire|smok(?:e|ing)|sparks?|electric(?:al)? shock|shocked me|melt(?:ed|ing)|overheat(?:ed|ing)|fell (?:over|off|down)|tip(?:s|ped)? over|collapsed|unstable|rash|allergic reaction|swallowed|chok(?:e|ed|ing)|toxic|poison(?:ed|ing)?|broke|broken|defective)\b/iu;
// The business's own warnings: a knowledge sentence that warns (or says what not to do).
const WARNS = /(?<![\u0590-\u05FF])(?:אזהרה|אזהרות|זהירות|בזהירות|סכנה|סכנת|להרחיק|לא\s+להשתמש|עלול\s+(?:לגרום|להיפגע|ליפול|להישבר))(?![\u0590-\u05FF])|\b(?:warning|caution|danger|hazard|keep away from|risk of|may cause|could cause)\b/iu;
// Something is wrong (a negation or a complaint), not a question before buying.
const WENT_WRONG = /(?<![\u0590-\u05FF])(?:לא|אינו|אינה|כבר\s+לא|עדיין|שוב|כל\s+הזמן|למרות)(?![\u0590-\u05FF])|\b(?:not|doesn'?t|didn'?t|won'?t|isn'?t|keeps|still|again)\b/iu;
const STEM_STOP = new Set(["אני", "שלי", "שלו", "שלה", "שלכם", "אבל", "גם", "רק", "עוד", "כבר", "את", "של", "עם", "על", "זה", "זו", "הוא", "היא", "יש", "אין", "לא", "כל", "מה", "איך", "this", "that", "with", "have", "from", "your", "they", "when", "what", "it's", "does", "doesn't", "still"]);
const contentStems = (t: string) => [...new Set((String(t ?? "").toLowerCase().match(/[\p{L}]{3,}/gu) ?? []).filter((w) => !STEM_STOP.has(w)).map((w) => stem(w)).filter((w) => w.length >= 3))];
/** The customer reports a problem with something the business's knowledge warns about (two shared word stems with a warning sentence). */
export function knowledgeHazard(incoming: string, knowledge: string): boolean {
  if (!knowledge || !WENT_WRONG.test(incoming ?? "")) return false;
  const mine = contentStems(incoming);
  if (mine.length < 2) return false;
  const warnings = (String(knowledge).match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => WARNS.test(x)).map((x) => unfinal(x.toLowerCase()));
  return warnings.some((w) => mine.filter((m) => w.includes(m)).length >= 2);
}
export const safetyCase = (inbound: string[], knowledge = "") => SAFETY.test(inbound.join("\n")) || (!!knowledge && knowledgeHazard(inbound.at(-1) ?? "", knowledge));
// A problem with the product in use, in generic verbs (no product parts): "it doesn't hold",
// "it doesn't stop it", "it keeps moving". Asked only inside a safety conversation.
const BEHAVIOUR = /(?<![\u0590-\u05FF])(?:לא\s+(?:עובד|עובדת|מונע|מונעת|עוצר|עוצרת|מחזיק|מחזיקה|נשאר|נשארת|יציב|יציבה)|[וש]?(?:זז|זזה|זזים|נתקע|נתקעת|נתקעו|נשמט|נשמטת)|(?:מחליק|נפתח|נסגר)\s+לבד)(?![\u0590-\u05FF])|\b(?:doesn'?t (?:work|hold|stop|stay)|won'?t (?:hold|stay|stop)|keeps (?:moving|slipping|falling)|moves on its own|got stuck)\b/iu;
/** The customer's OWN message describes a safety issue or a problem with the product in use (prod replay 13: not on a UGC inquiry). */
export const customerDescribesUse = (incoming: string, knowledge = "") => {
  const t = String(incoming ?? "");
  return SAFETY.test(t) || (!!knowledge && knowledgeHazard(t, knowledge)) || BEHAVIOUR.test(t);
};
/** The safety word that matched, for the trace. */
export const safetyWord = (inbound: string[]) => SAFETY.exec(inbound.join("\n"))?.[0]?.trim() ?? null;

// Mail no customer wrote (prod replay 2026-11-17, a held-out store: 75 of 92 email turns were
// newsletters, account notices, password resets and our own alerts; legacy answered none, v2
// translated slogans, offered services and acted on instructions inside them). Generic signals
// only: the ingest's hint (a list or a no-reply sender), the sender's address, and on an email
// channel the footer every bulk mail carries. A customer on WhatsApp asking how to unsubscribe is a customer.
const EMAIL_CHANNEL = /^(?:EMAIL|GMAIL|OUTLOOK)$/i;
const NO_REPLY_SENDER = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply[-_.].*|.*[-_.]noreply|notifications?|notification[-_.].*|notify|alerts?|mailer|bounces?|newsletters?|marketing|promotions?|digest|security|security[-_.].*|accounts?|account[-_.].*|verify|verification|password|login|signin|auth|reply[-_.][a-z0-9]+|mailer-daemon|automated|robot|bot)@/i;
// A sending subdomain of a larger domain ("mail.instagram.com", "em.brand.com"); "mail.ru" itself is a mailbox.
const BULK_DOMAIN = /@(?:em\d*|email|mail|mailer|mailing|news|newsletter|marketing|bounces?|notify|notification|notifications|alerts?|accounts?|security)\.[^@\s.]+\.[^@\s]+$/i;
// The structure automated mail has, in the languages seen here (the body is often only its first lines).
const AUTOMATED_TEXT = /\b(?:unsubscribe|manage (?:your )?(?:email |notification )?(?:preferences|settings)|this is an automated (?:message|email|notification)|do not reply to this (?:e-?mail|message)|please do not reply|you(?:'re| are) receiving this (?:e-?mail|message|because)|you received this (?:e-?mail|message)|this (?:e-?mail|message) was sent (?:to|by|automatically)|view (?:this )?(?:e-?mail )?in (?:your )?browser|(?:we received a )?request to reset (?:your )?(?:\w+ )?password|reset your (?:\w+ )?password|password reset (?:request|code|link)|(?:we noticed a |unusual |new )(?:login|sign-?in)(?: attempt)?(?: (?:to|on|from))?|login attempt|sign-?in attempt|your (?:verification|security|login|confirmation|one-time) code is|\d{4,8} is your (?:\w+ )?code|(?:your )?subscription (?:is )?(?:about to )?(?:expir\w*|renew\w*|end\w*)|subscription (?:has )?expired|out of (?:the )?office|automatic reply|auto-?reply|automated response|auto-?response|our (?:office|business|working) hours (?:are|is)|(?:we|our team|the team) will (?:respond|reply|get back to you) within|department operates|this (?:mailbox|inbox|e-?mail address) is (?:not monitored|unattended|no longer|only)|i am (?:currently )?(?:away|out of)|thank you for (?:contacting|your (?:e-?mail|message))[^.]{0,40}(?:we will|we'll) (?:get back|respond|reply))\b|(?:להסרה מרשימת|הסרה מרשימת התפוצה|להסרת המנוי|הודעה זו נשלחה|אין להשיב להודעה זו|נא לא להשיב להודעה|לאיפוס הסיסמה|איפוס סיסמה|קוד האימות שלך|קוד האימות הוא|ניסיון התחברות|זיהינו התחברות|התחברות חדשה ל|המנוי שלך (?:עומד|יפוג|פג|הסתיים)|מחוץ למשרד|מענה אוטומטי|תשובה אוטומטית|שעות הפעילות (?:של )?(?:המשרד|המחלקה)|נחזור אליך תוך|תיבה זו אינה|رمز التحقق|إعادة تعيين كلمة المرور|رد تلقائي|код подтверждения|сброс пароля|автоответ|código de verificación|restablecer (?:tu )?contraseña|respuesta automática|código de verificação|redefinir (?:sua )?senha|code de vérification|réinitialiser (?:votre )?mot de passe|réponse automatique)/iu;
/** Why this inbound message is automated mail (no reply, no handoff, no team question), or null. */
export function automatedInbound(m: { channel?: string | null; sender?: string | null; body?: string | null; metadata?: any; platformSender?: string | null }): string | null {
  const bulk = m.metadata?.email?.bulk;
  if (typeof bulk === "string" && bulk) return `ingest_${bulk}`;
  const sender = String(m.sender ?? "").trim().toLowerCase();
  const email = /@/.test(sender);
  if (email && m.platformSender && sender === String(m.platformSender).trim().toLowerCase()) return "platform_sender";
  if (email && NO_REPLY_SENDER.test(sender)) return "no_reply_sender";
  if (email && BULK_DOMAIN.test(sender)) return "bulk_domain";
  if (EMAIL_CHANNEL.test(String(m.channel ?? "")) && AUTOMATED_TEXT.test(String(m.body ?? ""))) return "bulk_footer";
  return null;
}

const MEDIA_PLACEHOLDER = /^(?:\[(?:Image|Photo|Video|Voice message|Audio|Document|Sticker|File|תמונה|סרטון|הודעה קולית|מסמך)[^\]]*\]|)$/i;

const CANCEL_REQUEST = /(?<![\u0590-\u05FF])[וש]?(?:לבטל|לביטול|ביטול|בטלו|תבטלו|תבטלי|תבטל|מבטל|מבטלת|להחזיר\s+(?:את\s+)?(?:ה)?כסף|החזר\s+כספי|זיכוי)(?![\u0590-\u05FF])|\b(?:cancel(?:l?ation)?|refund|money back|chargeback)\b/iu;
export const cancelRequest = (t: string) => CANCEL_REQUEST.test(normalizeQuotes(t ?? ""));
/** A handoff the customer's own words do not call for. */
export function needlessHandoff(handoff: string | null | undefined, recentInbound: string[], toolsAskedPerson: boolean): boolean {
  if (!handoff) return false;
  if (toolsAskedPerson) return false;
  if (safetyCase(recentInbound)) return false;
  // Photos sent right after the words ("[Image]") must not push them out of the window.
  const recent = recentInbound.filter((m) => !MEDIA_PLACEHOLDER.test(String(m ?? "").trim())).slice(-3).join("\n");
  // A payment or checkout failure is a support case: a person may take it.
  // A cancel or refund request too (prod replay 2026-11-17, Urban: its handoff was removed).
  // A charge or refund complaint too (rating 657e5f85: "I was charged" lost its team pass as "needless").
  return !ASKS_FOR_PERSON.test(recent) && !STRONG_CASE.test(recent) && !PAY_PROBLEM.test(normalizeQuotes(recent)) && !CANCEL_REQUEST.test(normalizeQuotes(recent)) && !PAYMENT_WORDS.test(normalizeQuotes(recent));
}

/** The customer asked about a product's material, feel, fit, care or origin, and the reply pleads no info without reading the product. */
export const statusAsk = (incoming: string) => STATUS_ASK.test(incoming ?? "");
export const noInfo = (reply: string) => NO_INFO.test(reply ?? "");
export const teamLineIn = (reply: string) => TEAM_LINE.test(reply ?? "");
// Any statement that the team has it or will: past, present or future (prod replay 2026-11-17: the fixed line
// appended after a sentence that already said it, six turns running).
const TEAM_PASS_ANY = /(?<![\u0590-\u05FF])[וש]?(?:נעביר|אעביר|נשאל|אשאל|נבדוק|אבדוק|נברר|אברר|נעדכן|אעדכן|נחזור\s+(?:אליך|אלייך|אליכם)|יתקבל\s+מענה|הצוות\s+(?:יבדוק|יחזור|יעדכן|יענה|בודק|יטפל))(?![\u0590-\u05FF])[^.!?\n]{0,40}(?:צוות|אצלנו)?|\b(?:pass(?:ed|ing)? (?:it|this|that|your \w+) (?:on )?to the team|the team (?:will|is going to|is) (?:check|look|get back|answer)\w*|(?:i|we)(?:'ll| will) (?:ask|check with) the team)\b/iu;
/** The reply already says the team has it (or will): no team line is appended. */
export const teamPassIn = (reply: string) => TEAM_LINE.test(reply ?? "") || WE_WILL_WITH_TEAM.test(reply ?? "") || TEAM_PASS_ANY.test(reply ?? "");
export const removeTeamLines = (reply: string) => (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*\s*/g) ?? [String(reply ?? "")]).filter((x) => !TEAM_LINE.test(x)).reduce(joinKept, "").trim();

// A material answered from the business description without reading the product (prod replay 12:
// "stainless steel" from the product data in one conversation, something else from the description in another).
const MATERIAL_ASK = /(?<![\u0590-\u05FF])(?:חומר|מאיזה\s+חומר|עשוי|עשויה|עשויים|ממה\s+(?:זה|הוא|היא)\s+עשוי)(?![\u0590-\u05FF])|\b(?:material|made of|made from)\b/iu;
// A price ask about the product in focus answered with no price, or with a request for its name or link (dev round k3
// on b3d2bbf3: "כמה היא עולה?" right after two shirts were named, only the knowledge searched).
const PRICE_ASK = /(?<![\u0590-\u05FF])(?:כמה\s+(?:זה\s+|היא\s+|הוא\s+|הם\s+|הן\s+)?(?:עולה|עולים|עולות)|מה\s+(?:ה)?מחיר|ה?מחיר\s+של)(?![\u0590-\u05FF])|\b(?:how much|what(?:'s| is) the price|price of)\b/iu;
const NO_PRICE_GIVEN = /(?<![\u0590-\u05FF])(?:(?:אין|לא)\s+(?:לנו\s+|לי\s+|כרגע\s+)?(?:[\u0590-\u05FF]+\s+){0,2}?(?:ה)?מחיר|מחיר\s+(?:מאומת|מעודכן)|(?:לשלוח|לכתוב|שלחו|כתבו)\s+(?:את\s+)?(?:ה)?(?:שם|קישור|לינק)|שם\s+או\s+קישור)(?![\u0590-\u05FF])|\b(?:(?:no|don't have (?:a|the)) price|send (?:me )?(?:the )?(?:name|link))\b/iu;
export function unreadProduct(reply: string, incoming: string, tools: ToolRunRecord[], toolsOffered: string[], teamQuestion = false): boolean {
  if (PRICE_ASK.test(incoming ?? "") && (teamQuestion || NO_INFO.test(reply ?? "") || NO_PRICE_GIVEN.test(reply ?? ""))) {
    const canReadP = toolsOffered.some((n) => /get_product|list_products|search_products/i.test(n));
    const readP = tools.some((t) => /product|variation|inventory/i.test(t.tool) && t.decision === "allow");
    if (canReadP && !readP) return true;
  }
  // Asked what it is made of and answered anyway (any statement that is not a question or "no info"):
  // a product fact with no product read behind it (prod replay 12: the description said otherwise).
  const materialStated = MATERIAL_ASK.test(incoming ?? "") && !/\?\s*$/.test(String(reply ?? "").trim()) && !NO_INFO.test(reply ?? "");
  if (!ATTRIBUTE_ASK.test(incoming ?? "") && !MATERIAL_ASK.test(incoming ?? "")) return false;
  if (!(teamQuestion || NO_INFO.test(reply ?? "") || materialStated)) return false;
  const canRead = toolsOffered.some((n) => /get_product|list_products|search_products|variation/i.test(n));
  const read = tools.some((t) => /product|variation|inventory/i.test(t.tool) && t.decision === "allow");
  return canRead && !read;
}


export const ORDER_ASK = /(?<![\u0590-\u05FF])(?:משלוח|המשלוח|מתי (?:יגיע|תגיע|זה מגיע|זה יגיע|אקבל)|הזמנה|ההזמנה|הזמנתי|מעקב|מספר מעקב|החבילה|איפה החבילה|נשלח|נשלחה|יצא|יצאה)(?![\u0590-\u05FF])|\b(?:delivery|shipping|shipped|tracking|my order|order status|where is my)\b/iu;
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
const GAVE_UP = /(?:החיפוש\s+לא\s+(?:החזיר|מצא|העלה)|הקטלוג\s+לא\s+(?:נפתח|נטען)|לא\s+נפתח\s+לי|תקלה|לא (?:הצלחתי|הצלחנו|יכולתי|יכולנו|מצליח|מצליחה) (?:לבדוק|לגשת|לראות|לחפש)|(?:אין|אין לי) (?:גישה|אפשרות לבדוק)|כרגע (?:לא ניתן|אי אפשר) לבדוק|לבדוק (?:את זה )?כרגע)|\b(?:could(?:n'?t| not) (?:check|look|access|search)|unable to (?:check|look|access))\b/iu;
// The work handed back to the customer (prod replay 2026-11-17, Smoovee: "נסי שם אחר", "כדאי לבדוק באתר").
const RETURNS_WORK = /(?<![\u0590-\u05FF])(?:(?:נסי|נסה|נסו|תנסי|תנסה|תנסו)\s+(?:שם|מילה|ניסוח|לחפש)|(?:כדאי|אפשר|מומלץ)\s+(?:לבדוק|לחפש|להיכנס|לראות)\s+(?:ב|את\s+ה)?אתר|(?:תבדקי|תבדוק|תבדקו|תחפשי|תחפש|תחפשו)\s+(?:ב|את\s+ה)?אתר|(?:בדקי|בדקו|בדוק|תבדקי|תבדוק|תבדקו|כדאי\s+לבדוק|אפשר\s+לבדוק|אפשר\s+לראות)\s+(?:ב|את\s+)?(?:דף|עמוד)\s+(?:ה)?מוצר|(?:אפשר|כדאי)\s+לחפש\s+בעצמ)(?![\u0590-\u05FF])|\b(?:try (?:another|a different) (?:name|word|search)|search (?:for it )?(?:on|in) (?:our|the) (?:website|site|store)|check (?:on |at )?(?:our|the) (?:website|site))\b/iu;
export const returnsWork = (reply: string) => RETURNS_WORK.test(reply ?? "");
/**
 * A product search timed out or failed, nothing else was found this turn, and the reply gives
 * up: says it could not check, hands the work back to the customer, or sends a simple browse to
 * the team (prod replay 2026-11-17).
 */
export function gaveUpSearch(reply: string, tools: ToolRunRecord[], incoming = "", teamQuestion = false, knowledge = ""): boolean {
  const search = (t: ToolRunRecord) => /list_products|search_products|get_product|variation/i.test(t.tool);
  if (!tools.some((t) => search(t) && (t.outcome === "timeout" || t.outcome === "error"))) return false;
  if (tools.some((t) => search(t) && (t.outcome === "ok" || t.outcome === "empty"))) return false;
  // A product want sent to the team, by a team question or by the reply's words (rating d7782dd2, Tehila).
  if (GAVE_UP.test(reply ?? "") || RETURNS_WORK.test(reply ?? "") || ((teamQuestion || teamPassIn(reply)) && PRODUCT_WANT.test(incoming ?? ""))) return true;
  return knowledgeAnswersIt(reply, incoming, teamQuestion, knowledge);
}
const FIT_ASK = /(?<![\u0590-\u05FF])[וש]?(?:מתאים|מתאימה|יתאים|תתאים|מידה|מידות|גודל|ס["״']?מ)(?![\u0590-\u05FF])|\b(?:fits?|size|sizes|dimensions?|cm)\b/iu;
/** A device-fit ask ("משטח שמתאים לנינג'ה קריספי", "fits my mixer"): the business's device table belongs in it. */
export const deviceFitAsk = (incoming: string) => FIT_ASK.test(String(incoming ?? "")) && /\p{L}{3,}/u.test(String(incoming ?? ""));
/** Sent to the team while the business's own knowledge speaks of what they asked. */
export function knowledgeAnswersIt(reply: string, incoming: string, teamQuestion: boolean, knowledge: string): boolean {
  // Sent to the team while the business's own knowledge speaks of what they asked (prod rating 2026-11-17,
  // Smoovee: an appliance size after a search timeout went to the team, not to the device table).
  const passed = teamQuestion || teamPassIn(reply);
  const k = String(knowledge ?? "").toLowerCase();
  const theirs = (String(incoming ?? "").toLowerCase().match(/\p{L}{4,}/gu) ?? []).map((w) => w.replace(/^[הולבמש]/, ""));
  return passed && !!k && theirs.some((w) => w.length >= 4 && k.includes(w));
}

/** A coupon or policy question sent to the team without searching the knowledge. */
export function unreadKnowledge(incoming: string, tools: ToolRunRecord[], toolsOffered: string[], teamQuestion = false): boolean {
  if (!teamQuestion || !COUPON_ASK.test(incoming ?? "")) return false;
  return toolsOffered.includes("search_knowledge") && !tools.some((t) => t.tool === "search_knowledge");
}

// A note meant for the engine (a simulated or test run) must never reach the customer, in any lane.
const SIMULATION_LEAK = /(?:סביבת (?:ה)?(?:בדיקה|בדיקות|ניסוי|טסט)|סימולציה|בסימולציה|לא בוצע(?:ה)? בפועל|שיחת (?:ה)?(?:בדיקה|ניסיון)|הודעת בדיקה)|\b(?:simulat(?:ed|ion)|sandbox|test (?:environment|conversation|mode)|not (?:actually|really) (?:performed|executed|sent))\b/iu;
/** A test or simulation named in the reply; never when the business's own texts say the same words (a demo site's notice). */
// "No date yet" is honest only while no source gives one; it is the one caveat that can be wrong (a date in the
// knowledge or a tool result makes it a claim to cut or correct).
const DATE_CAVEAT = /(?<![\u0590-\u05FF])ו?אין\s+(?:לנו\s+|לי\s+)?(?:כרגע\s+)?(?:תאריך|מועד|צפי)(?![\u0590-\u05FF])|\bno (?:date|eta|estimate)\b/iu;
// The words of the item a "no date" caveat names ("של אליס שחור"), its colour and size words aside.
const CAVEAT_FRAME = new Set(["אין", "לנו", "לי", "כרגע", "תאריך", "מועד", "צפי", "לחידוש", "חידוש", "המלאי", "מלאי", "של", "את", "עדיין", "עוד", "no", "date", "eta", "estimate", "for", "the", "restock", "yet"]);
/** "No date yet" holds unless a source gives a restock statement (not a bare number) for the item it names. */
export const caveatHolds = (x: string, sources: string) => {
  if (!CAVEAT.test(x)) return false;
  if (!DATE_CAVEAT.test(x)) return true;
  const item = ((String(x).match(/[\p{L}]{3,}/gu) ?? []) as string[]).map((w) => w.toLowerCase()).filter((w) => !CAVEAT_FRAME.has(w) && !VARIANT_WORDS.has(w) && !COLOURS.includes(w));
  if (!item.length) return true;
  const lines = String(sources ?? "").split(/\n+|(?<=[.!?])\s+(?!\d)/u);
  return !lines.some((l) => RESTOCK_STATEMENT.test(l) && item.every((w) => new RegExp(`(?<![\\p{L}])[הולב]?${w}(?![\\p{L}])`, "iu").test(l)));
};
const RESTOCK_STATEMENT = /(?<![\u0590-\u05FF])(?:(?:יחזור|יחזרו|תחזור|יגיע|יגיעו|תגיע)|(?:צפוי|צפויה|צפויים|צפויות)\s+(?:לחזור|להגיע))\s+(?:שוב\s+)?ל?מלאי|(?<![\u0590-\u05FF])צפי(?![\u0590-\u05FF])|חידוש\s+(?:ה)?מלאי\s+(?:ב|צפוי)|\b(?:back in stock|restock(?:ed|ing)?\s+(?:on|by)|expected (?:on|by|in))\b/iu;
const CAVEAT = /(?<![\u0590-\u05FF])ו?(?:אין\s+(?:לנו\s+|לי\s+)?(?:כרגע\s+)?(?:תאריך|מועד|צפי)|אין\s+(?:לנו\s+|לי\s+)?(?:במידע|בנתונים|בתיאור|בפרטי\s+המוצר)\s+(?:אישור|ציון|מידע)|אין\s+(?:לנו\s+|לי\s+)?אישור|לא\s+(?:מאושר|מאושרת|אושר|אושרה|מצוין|מצוינת)\s+(?:ל|כ|ש)|לא\s+מופיע\s+(?:אישור|ש))|\b(?:not confirmed|no confirmation|isn'?t confirmed|not (?:stated|listed) (?:as|for))\b/iu;
const PAYMENT_TALK = /(?<![\u0590-\u05FF])[הבול]?(?:כרטיס|האשראי|אשראי|חיוב|חויבתי|חייבו|תשלום|שילמתי|עסקה|ויזה)(?![\u0590-\u05FF])|\b(?:card|charged?|payment|paid)\b/iu;
const herCardTalk = (i: { incomingMessage?: string; recentInbound?: string[] }) => PAYMENT_TALK.test([i.incomingMessage ?? "", ...(i.recentInbound ?? [])].join("\n"));
// A sentence that names or points at a product card, whatever she wrote.
const PRODUCT_CARD = /(?<![\u0590-\u05FF])(?:[בהל]?כרטיס(?:י)?\s+(?:ה)?מוצר|[בהל]?כרטיס\s+של\s+(?:ה)?מוצר|[בהלו]?(?:ה)?כרטיסים|[בהל]?כרטיס(?:\s+[\u0590-\u05FF]+){0,2}\s+(?:למטה|למעלה|שלמעלה|שלמטה|כאן|הראשון|השני|השלישי|ששלחתי|ששלחנו|המצורף)|[בהל]?כרטיס\s+(?:הראשון|השני|השלישי|שלמעלה|שלמטה|המצורף)|(?:מופיע|מופיעה|מופיעים|מופיעות|רואים|רואה|תראי|תראה|ראי|ראו|תסתכלי|תסתכל)\s+(?:[\u0590-\u05FF]+\s+){0,3}?[בהל]?כרטיס)(?![\u0590-\u05FF])|\b(?:product cards?|cards? (?:below|above)|the (?:first|second) card)\b/iu;
/** A bare payment-card mention: the card word, no product card named or pointed at. */
// A see/appear verb before the card ("אישור מופיע בכרטיס") points at a product card only with no payment word in the
// sentence (dev round on 51d0273e: her approval on her card).
const SEE_CARD = /(?<![\u0590-\u05FF])(?:מופיע|מופיעה|מופיעים|מופיעות|רואים|רואה|תראי|תראה|ראי|ראו|תסתכלי|תסתכל)\s+(?:[\u0590-\u05FF]+\s+){0,3}?[בהל]?כרטיס(?![\u0590-\u05FF])/u;
const PAYMENT_WORD = /(?<![\u0590-\u05FF])[הבול]?(?:אישור|חיוב|עסקה|תשלום|זיכוי|אשראי)(?![\u0590-\u05FF])/u;
const barePaymentCard = (x: string) => /כרטיס|\bcards?\b/iu.test(x) && !(PRODUCT_CARD.test(x) && !(SEE_CARD.test(x) && !PRODUCT_CARD_POINTED.test(x) && PAYMENT_WORD.test(x)));
const PRODUCT_CARD_POINTED = /(?<![\u0590-\u05FF])(?:[בהל]?כרטיס(?:י)?\s+(?:ה)?מוצר|[בהל]?כרטיס\s+של\s+(?:ה)?מוצר|[בהלו]?(?:ה)?כרטיסים|[בהל]?כרטיס(?:\s+[\u0590-\u05FF]+){0,2}\s+(?:למטה|למעלה|שלמעלה|שלמטה|כאן|הראשון|השני|השלישי|ששלחתי|ששלחנו|המצורף)|[בהל]?כרטיס\s+(?:הראשון|השני|השלישי|שלמעלה|שלמטה|המצורף))(?![\u0590-\u05FF])|\b(?:product cards?|cards? (?:below|above)|the (?:first|second) card)\b/iu;
export const simulationLeak = (reply: string, sources = "") => {
  const m = SIMULATION_LEAK.exec(reply ?? "");
  return !!m && !String(sources ?? "").toLowerCase().includes(m[0].toLowerCase());
};

// "I passed it to the team", said again while the team already has it open.
const TEAM_LINE = /(?:העברתי|העברנו|הועבר|הועברה|הועברו|מעבירים|מעבירה|מעביר)(?:\s+(?:את\s+)?[\u0590-\u05FF"'׳״-]+){0,3}?\s+(?:ל|אל\s+)ה?צוות|(?:הצוות|צוות)\s+(?:כבר\s+)?(?:יבדוק|בודק|בודקים|יחזור|יעדכן|יענה|מטפל|מטפלים)|(?:כבר\s+)?אצל\s+הצוות|(?:בבדיקה|לבדוק)\s+(?:מול|עם)\s+הצוות|\b(?:passed (?:it|this|your question) (?:on )?to the team|the team (?:will|is) (?:already )?(?:check|look|get back|on it)\w*|the team already has (?:it|this))\b/iu;
const STATUS_ASK = /(?<![\u0590-\u05FF])(?:מה (?:קורה|קרה|המצב|עם זה|נשמע)|יש (?:חדש|חדשות|עדכון|תשובה)|עדכון|עדכנו|נו|כמה זמן|עוד כמה|מתי תהיה תשובה|ענו|הצוות)(?![\u0590-\u05FF])|\b(?:any (?:update|news)|still waiting|heard back)\b/iu;
/** The reply announces the team hand-off again although it is already open and the customer did not ask about it. */
export function repeatedTeamLine(reply: string, incoming: string, teamAlreadyOpen: boolean, newTeamQuestion: boolean, onOpenItem = false): boolean {
  // Back on that very subject: saying it is with the team is the answer (prod replay 2026-11-17, NE'A).
  if (!teamAlreadyOpen || newTeamQuestion || onOpenItem) return false;
  // New details for the open item (a card's last four, an order number: the digits withNewDetails adds) are passed on
  // now; saying so is no repeat (rating of b3d2bbf3: that sentence was cut, the waiting line went out twice in a row).
  if (/\d{4,}/.test(String(incoming ?? ""))) return false;
  return TEAM_LINE.test(reply ?? "") && !STATUS_ASK.test(incoming ?? "");
}

// Prod replay 4: "the measurements were passed to the team" with no team question,
// and "we will not ship before we update you": a promise nothing carries out.
const FUTURE_PROMISE = /(?<![\u0590-\u05FF])(?:[וש]?(?:נעדכן|אעדכן|נודיע|אודיע|נדאג|אדאג|נעכב|נבדוק\s+(?:את\s+זה|ונחזור|ונעדכן|ונודיע|ונשלח)|אבדוק\s+(?:את\s+זה|ואחזור|ואעדכן)|נשמור\s+(?:לך|לכם)|אשמור\s+(?:לך|לכם))|לא\s+(?:נשלח|נשלחים|נשלחת|נוציא)\s+(?:לפני|עד|בלי))(?![\u0590-\u05FF])|\b(?:we(?:'ll| will) (?:update you|let you know|hold it|keep it for you|check (?:it|this|that|on it)(?: and get back)?)|i(?:'ll| will) (?:check (?:it|this|that) and (?:get back|let you know)|look into it and get back)|(?:won'?t|will not) ship (?:before|until))\b/iu;
// "We recorded / saved / updated it" (prod replay 2026-11-17, Tehila: "תודה, רשמנו את סכום ההזמנה"
// with no tool call): a record is claimed only when a write tool returned ok this turn.
const RECORDED = /(?<![\u0590-\u05FF])[וש]?(?:רשמנו|רשמתי|רשמתם|שמרנו|שמרתי|עדכנו|עדכנתי|הוספנו|הוספתי|תיעדנו|נרשם|נרשמה|נרשמו|נשמר|נשמרה|נשמרו|עודכן|עודכנה|עודכנו|תועד|תועדה)(?![\u0590-\u05FF])|\b(?:(?:i|we)(?:'ve| have)? (?:saved|noted|updated|recorded|registered|logged|added)|(?:it|this|that|your \w+)(?:'s| is| has been| was) (?:saved|noted|updated|recorded|registered|logged))\b/iu;
const READ_TOOL = /^(?:get|list|search|read|find|check|track|lookup|order_lookup|fetch|validate|summarize)(?:_|$)/i;
/** Sentences claiming something was recorded, saved or updated with no write this turn. */
export function unbackedRecords(reply: string, tools: ToolRunRecord[]): string[] {
  // A write tool that returned ok this turn; the bot's own state facts are its memory, not a record
  // the business made (the Supervisor, 2026-11-17).
  const wrote = tools.some((t) => t.decision === "allow" && t.outcome === "ok" && !READ_TOOL.test(String(t.tool).split(".").pop() ?? "") && t.tool !== "search_knowledge" && t.tool !== "read_skill");
  if (wrote) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => RECORDED.test(x)).map((x) => x.trim().slice(0, 120));
}

/** "Passed to the team" or a promise of a later action, with nothing in this turn carrying it (no team question, no handoff, nothing open). */
// A first-person-plural future with the team or "us" in the same sentence (prod replay 2026-11-17:
// "נבדוק את הפער מול הצוות" with no team item): a promise the team carries, so it needs one.
const WE_WILL_WITH_TEAM = /(?<![\u0590-\u05FF])[וש]?(?:נבדוק|נברר|נעדכן|נחזור|נטפל|נוודא|נבחן|נסדר|נתאם)(?![\u0590-\u05FF])[^.!?\n]{0,50}(?<![\u0590-\u05FF])(?:צוות|הצוות|לצוות|מהצוות|אצלנו)(?![\u0590-\u05FF])|(?<![\u0590-\u05FF])(?:נבדוק|נברר)\s+מול(?![\u0590-\u05FF])|\b(?:we(?:'ll| will) (?:check|look into|verify|sort out|clarify)[^.!?\n]{0,40}(?:with the team|internally|on our end))\b/iu;
export function unbackedPromises(reply: string, o: { teamQuestion: boolean; handedOff: boolean; teamAlreadyOpen: boolean; approvalPending: boolean }): string[] {
  if (o.teamQuestion || o.handedOff || o.approvalPending) return [];
  const out: string[] = [];
  const withTeam = WE_WILL_WITH_TEAM.exec(reply ?? "");
  if (withTeam && !o.teamAlreadyOpen) out.push(withTeam[0]);
  const team = TEAM_LINE.exec(reply ?? "");
  if (team && !o.teamAlreadyOpen) out.push(team[0]);
  const promise = FUTURE_PROMISE.exec(reply ?? "");
  if (promise && !o.teamAlreadyOpen) out.push(promise[0]);
  return out;
}

// Prod replay 4: "wood/bamboo pads are not sold" four times while the store sells
// bamboo. "We don't have / don't sell / no match / doesn't exist" is a fact.
const ABSENCE = /(?<![\u0590-\u05FF])(?:אין\s+(?:לנו|אצלנו)(?!\s+(?:כאן\s+)?(?:מידע|פרטים|גישה|אפשרות|תשובה))|(?:אנחנו\s+)?לא\s+(?:מוכרים|מחזיקים|משווקים|מייצרים)|לא\s+(?:קיים|קיימת|קיימים|קיימות)|אין\s+(?:התאמה|דגם|מוצר|כזה|כזו|כאלה|כאלו)|לא\s+(?:מצאנו|נמצא|נמצאה|נמצאו)\s+(?:התאמה|מוצר|דגם|כזה|כזו)|לא\s+(?:מצאתי|מצאנו|מוצאת|מוצא|מוצאים))(?![\u0590-\u05FF])|(?<![\u0590-\u05FF])(?:אין\s+(?:כרגע\s+)?(?:בקטלוג|באתר|בחנות)|לא\s+(?:מופיע|מופיעה|מופיעים|מופיעות|נמצא|נמצאים|נמצאת)\s+(?:כרגע\s+)?(?:בקטלוג|באתר|בחנות))(?![\u0590-\u05FF])|\b(?:(?:i|we) (?:didn'?t|did not|couldn'?t|could not|can'?t|cannot) find|no results|we (?:don'?t|do not) (?:currently |actually |really )?(?:sell|carry|have|stock|offer)|(?:is|are) not (?:sold|available|in our (?:range|catalog(?:ue)?))|(?:doesn'?t|does not) exist|no (?:match|such)|there (?:are|is) no|(?:i'?m|we'?re|i am|we are) not (?:seeing|finding)|(?:doesn'?t|does not|don'?t|do not) (?:include|contain|list|carry)|(?:isn'?t|aren'?t|is not|are not) (?:in|part of) (?:our|the) (?:catalog(?:ue)?|store|range|collection|shop))\b/iu;
const ABSENCE_WORDS = new Set(["אין", "לנו", "אצלנו", "אנחנו", "לא", "מוכרים", "מחזיקים", "משווקים", "מייצרים", "קיים", "קיימת", "קיימים", "קיימות", "התאמה", "דגם", "מוצר", "כזה", "כזו", "כאלה", "כאלו", "מצאנו", "נמצא", "נמצאה", "נמצאו", "כרגע", "בכלל", "במלאי", "שלנו", "רק", "גם", "את", "של", "עם", "על", "זה", "זו", "יש", "אבל", "מאוד", "לצערי", "מצאתי", "מוצאת", "מוצא", "מוצאים", "פריט", "פריטים", "בשם", "הזה", "הזו", "find", "didn't", "couldn't", "results", "item", "called", "we", "dont", "don't", "do", "not", "sell", "carry", "have", "stock", "is", "are", "sold", "available", "exist", "doesn't", "does", "match", "such", "the", "and", "any", "for", "won't", "can't", "isn't", "aren't", "doesn't", "couldn't", "didn't", "don't", "catalog", "catalogue", "store", "shop", "site", "website", "here", "קטלוג", "בקטלוג", "הקטלוג", "חנות", "בחנות", "אתר", "באתר", "האתר", "currently", "right", "now", "there", "seeing", "finding", "include", "contain", "list", "range", "collection", "offer", "part", "our", "בקטלוג"]);
const CAPABILITY_ABSENCE = /(?<![\u0590-\u05FF])(?:אין\s+(?:לנו\s+|באפשרותנו\s+)?אפשרות|אין\s+באפשרותנו|אנחנו\s+לא\s+(?:יכולים|יכולות|עושים)|לא\s+(?:ניתן|נוכל)|אי\s+אפשר)(?![\u0590-\u05FF])|\b(?:we (?:can'?t|cannot|are unable to|don'?t do)|it'?s not possible|not possible to)\b/iu;
const CAPABILITY_WORDS = new Set(["אפשרות", "באפשרותנו", "יכולים", "יכולות", "עושים", "ניתן", "נוכל", "אפשר", "לצערנו", "לצערי", "כרגע", "can't", "cannot", "unable", "possible", "don't"].map((w) => w.toLowerCase()));
// Final letters (ך ם ן ף ץ) as their plain forms: "טלפון" is in "טלפוני".
const unfinal = (w: string) => w.replace(/ך/g, "כ").replace(/ם/g, "מ").replace(/ן/g, "נ").replace(/ף/g, "פ").replace(/ץ/g, "צ");
const stem = (w: string) => unfinal((w.length > 3 && /^[הובלמשכ]/.test(w) ? w.slice(1) : w).toLowerCase());
const CAPABILITY_STEMS = new Set([...CAPABILITY_WORDS].flatMap((w) => [w, stem(w)]));
const termsOf = (sentence: string) => [...new Set((sentence.match(/\p{L}+(?:['’]\p{L}+)*/gu) ?? []).map((w) => w.replace(/’/g, "'")).filter((w) => w.length >= 3).filter((w) => !ABSENCE_WORDS.has(w.toLowerCase())).map(stem))];
const SEARCH_TOOL = /list_products|search_products|get_product|variation|search_knowledge|categor/i;
const NARROWING = ["on_sale", "price_min", "price_max", "min_price", "max_price", "in_stock", "stock_status", "product_type", "vendor", "tag", "category", "option", "options", "size", "color", "colour", "fits_cm", "fits_cm_all", "audience"];
/** A product search narrowed by a filter, or a Shopify one that is in stock only by default. */
export function filteredSearch(t: ToolRunRecord): boolean {
  const a: any = t.args ?? {};
  if (NARROWING.some((k) => a[k] != null && a[k] !== "" && a[k] !== false && a[k] !== 0 && !(Array.isArray(a[k]) && !a[k].length))) return true;
  return /(?:^|\.)search_products$/.test(String(t.tool)) && !/^woocommerce\./.test(String(t.tool)) && a.in_stock_only !== false;
}
const PRODUCT_TOOL = /list_products|search_products|get_product|variation/i;
/** What a search searched: its own string arguments, and of customer_query (her whole message, added by the engine
 *  when the query is not Hebrew) only its product words (dev round k5 on 0b5f2b46: "יש", "לכם" in no claim). */
export function searchTextOf(t: ToolRunRecord): string {
  const a: any = t.args ?? {};
  const own = Object.entries(a).filter(([k, v]) => k !== "customer_query" && typeof v === "string").map(([, v]) => String(v));
  const cq = typeof a.customer_query === "string" ? storeQueryWords(a.customer_query) : null;
  return [...own, ...(cq ? [cq] : [])].join(" ");
}
/**
 * Absence claims no search backs: grounded only by a search this turn whose query
 * covers the claim's words and that did not return them. Without such words
 * ("אין לנו כזה"), any product search that ran this turn grounds it.
 */
// Hebrew letters as Latin consonants, vowel letters dropped: a borrowed product noun keeps its consonants.
const HE_CONS: Record<string, string> = { ב: "b", ג: "g", ד: "d", ה: "h", ז: "z", ח: "h", ט: "t", כ: "k", ך: "k", ל: "l", מ: "m", ם: "m", נ: "n", ן: "n", ס: "s", פ: "p", ף: "f", צ: "ts", ץ: "ts", ק: "k", ר: "r", ש: "sh", ת: "t" };
const heSkeleton = (w: string) => String(w ?? "").replace(/^[הוב](?=[\u0590-\u05FF]{3,})/u, "").replace(/ג['׳]/gu, "j").replace(/צ['׳]/gu, "ch").replace(/ז['׳]/gu, "j").replace(/[\u0590-\u05FF]/gu, (c) => HE_CONS[c] ?? "").replace(/['׳"״]/g, "");
const enSkeleton = (w: string) => String(w ?? "").toLowerCase().replace(/ph/g, "f").replace(/ck/g, "k").replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/x/g, "ks").replace(/w/g, "").replace(/[aeiouy]/g, "").replace(/(.)\1+/g, "$1");
/** A Hebrew word and a Latin one for the same thing: a colour by the colour map, or a borrowed noun by its consonants (3+). */
export function sameAcrossLanguages(he: string, en: string): boolean {
  if (!/[\u0590-\u05FF]/.test(he) || !/^[a-z-]+$/i.test(en)) return false;
  const bareHe = he.replace(/^[הוב](?=[\u0590-\u05FF]{3,})/u, "");
  if (COLOURS.some((c) => COLOUR_RE(c).test(bareHe) && (COLOUR_EN[c] ?? []).includes(en.toLowerCase()))) return true;
  const a = heSkeleton(bareHe).replace(/(.)\1+/g, "$1"), b = enSkeleton(en);
  // A plural s on either side is the same word.
  return Math.min(a.length, b.length) >= 3 && (a === b || a === `${b}s` || `${a}s` === b);
}
export function ungroundedAbsence(reply: string, tools: ToolRunRecord[], knowledge = ""): string[] {
  const sentences = String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? [];
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
      const query = (t: ToolRunRecord) => termsOf(searchTextOf(t));
      // The search must cover the claim's words (all of two, all but one of more): "pads" alone is not "bamboo pads".
      const need = terms.length <= 2 ? terms.length : terms.length - 1;
      const ranFor = searches.filter((t) => { const q = query(t); return terms.filter((w) => q.some((x) => x.includes(w) || w.includes(x))).length >= need; });
      // A product search that returned the very thing contradicts the claim.
      const returned = ranFor.some((t) => PRODUCT_TOOL.test(t.tool) && terms.some((w) => unfinal(String(t.content ?? "").toLowerCase()).includes(w)) && t.outcome === "ok");
      // An empty search NARROWER than the claim proves nothing about it (prod replay 2026-11-17, a
      // snowboard store: "snowboard beginner" came back empty and the reply said there is no
      // snowboard). Only a search whose words are all in the claim backs it.
      // A filtered search (a price, stock, a type or an option) proves nothing about the item itself
      // (Shopify's search is in stock only unless told otherwise).
      const asBroad = ranFor.filter((t) => !filteredSearch(t) && query(t).every((x) => terms.some((w) => x.includes(w) || w.includes(x))));
      // An empty, unfiltered search no wider than the claim backs it too (dev round on 6320af2f: "ג'ינס" came back
      // empty, so there is no black jeans), whatever the other searches of the turn returned.
      // Every word of the query counts, short ones too ("משטח עץ" is narrower than "משטחי במבוק", never within it).
      const bare = (x: string) => x.replace(/['׳"״]/g, "").toLowerCase();
      const claimWords = (clause.match(/[\p{L}\p{N}'׳]+/gu) ?? []).map(bare);
      const claimAsWritten = (normalizeQuotes(clause).match(/[\p{L}\p{N}'׳]+/gu) ?? []) as string[];
      const rawWords = (t: ToolRunRecord) => (searchTextOf(t).match(/[\p{L}\p{N}'׳]+/gu) ?? []).map(bare);
      // A query in the other language counts too (dev round k4 on 259d48ea: "black jeans" came back empty for "לא
      // מצאנו ג'ינס שחור"): a colour by the colour map, a borrowed noun by its consonants (ג'ינס, jeans: "jns").
      const emptyWithin = searches.some((t) => t.outcome === "empty" && PRODUCT_TOOL.test(t.tool) && !filteredSearch(t) && rawWords(t).length > 0 && rawWords(t).every((x) => claimWords.some((w) => w === x || (x.length >= 3 && w.includes(x))) || claimAsWritten.some((w) => sameAcrossLanguages(w, x))));
      // ... unless an ok product search of this turn holds the claim's words in what it returned ("ג'ינס" empty, then
      // "ג׳ינס שחור" returned "ג'ינס שחור סלים": the claim is contradicted).
      const held = searches.some((t) => t.outcome === "ok" && PRODUCT_TOOL.test(t.tool) && (() => { const c = bare(unfinal(normalizeQuotes(String(t.content ?? "")))); return terms.filter((w) => c.includes(bare(unfinal(w)))).length >= need; })());
      grounded = (asBroad.length > 0 && !returned) || (emptyWithin && !held);
    }
    if (!grounded) out.push(sentence.trim().slice(0, 120));
  }
  return out;
}

// ONE rule for every number a reply states as a fact (2026-11-17, the generic pass): a
// time, a quantity, a measure or a percentage must appear in this turn's evidence (the
// tools, the knowledge, the business details, the state, a person's or the customer's
// own lines). Prices have their own check; a size pair ("90x90") has echoedSizes.
const UNIT_NUMBER = /(\d+(?:[.,]\d+)?)(?:\s*(?:-|עד|to)\s*(\d+(?:[.,]\d+)?))?\s*(?=(?:ימי\s+עסקים|ימים|ימי|יום|שעות|שעה|דקות|שבועות|שבוע|חודשים|חודש|שנים|שנה|יחידות|יחידה|פריטים|זוגות|%|אחוז|ס["״']?מ|מ["״']?מ|ק["״']?ג|גרם|ליטר|מ["״']?ל|מטר|business days?|days?|hours?|minutes?|weeks?|months?|years?|units?|items?|pieces?|pairs?|percent|cm|mm|kg|grams?|lit(?:er|re)s?|ml|meters?|inch(?:es)?)(?![\p{L}]))/giu;
const numbersIn = (t: string) => new Set((String(t ?? "").match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", ".")));
// A product's price from the knowledge while the store says otherwise (prod replay 2026-11-17, NE'A:
// 178 from a document, the store 160.20): the store wins, and a product price needs a store read.
const PRICE_IN = /(?:₪\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(?:₪|ש["״']?ח|NIS|ILS|shekels?))/giu;
export function priceAgainstStore(reply: string, candidates: Array<{ title: string; price?: number | null; was?: number | null }>, tools: ToolRunRecord[], storeOffered: boolean): string[] {
  const read = tools.some((t) => /list_products|search_products|get_product|variation/i.test(t.tool) && t.outcome === "ok");
  const toolText = tools.map((t) => String(t.content ?? "")).join("\n");
  const out: string[] = [];
  for (const x of String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []) {
    const prices = [...x.matchAll(PRICE_IN)].map((m) => Number(String(m[1] ?? m[2]).replace(",", ".")));
    if (!prices.length) continue;
    const named = candidates.filter((c) => c?.title && x.toLowerCase().includes(String(c.title).toLowerCase()) && c.price != null);
    // The store's own price for a product this sentence names, and the sentence says another.
    if (named.length && prices.some((p) => !named.some((c) => Math.abs(Number(c.price) - p) < 0.01 || (c.was != null && Math.abs(Number(c.was) - p) < 0.01)))) { out.push(x.trim().slice(0, 120)); continue; }
    // A product price with no store read at all, from a document only.
    if (storeOffered && !read && PRODUCT_NOUN.test(x) && prices.some((p) => !toolText.includes(String(p)))) out.push(x.trim().slice(0, 120));
  }
  return out;
}

// An order's state stated while every order lookup this turn failed (prod replay 2026-11-17, Urban:
// "עדיין לא בוטלה"): a failed lookup grounds nothing.
const ORDER_STATE = /(?<![\u0590-\u05FF])[וש]?(?:בוטלה|בוטל|לא\s+בוטלה|נשלחה|נשלח|יצאה|יצא|בדרך|הגיעה|נמסרה|בטיפול|בהכנה|מוכנה|ממתינה|אושרה|שולמה)(?![\u0590-\u05FF])|\b(?:(?:was|is|has been|hasn'?t been|not) (?:cancelled|canceled|shipped|delivered|dispatched|paid|processed)|on its way|is being (?:prepared|processed))\b/iu;
const ORDER_WORD = /(?<![\u0590-\u05FF])[וש]?ה?(?:הזמנה|ההזמנה|חבילה|החבילה|משלוח|המשלוח)(?![\u0590-\u05FF])|\b(?:order|package|parcel|shipment)\b/iu;
export function orderStateWithoutLookup(reply: string, tools: ToolRunRecord[]): string[] {
  const orders = tools.filter((t) => ORDER_LOOKUP_TOOL.test(t.tool) || /tracking|fulfil?lment|shipment/i.test(t.tool));
  if (!orders.length || orders.some((t) => t.outcome === "ok" || t.outcome === "empty")) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => ORDER_STATE.test(x) && ORDER_WORD.test(x)).map((x) => x.trim().slice(0, 120));
}

/** Sentences stating a number with a unit that no evidence this turn holds. */
export function ungroundedNumbers(reply: string, evidence: string): string[] {
  const known = numbersIn(evidence);
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => {
    // Never the digits of a link ("95%d7" in a percent-encoded path read as "95%": prod 2026-11-18).
    for (const m of x.replace(/https?:\/\/\S+/gi, " ").matchAll(UNIT_NUMBER)) {
      if ([m[1], m[2]].filter(Boolean).some((n) => !known.has(String(n).replace(",", ".")))) return true;
    }
    return false;
  }).map((x) => x.trim().slice(0, 120));
}

const ADDRESS_DENIED = /(?:(?<![\u0590-\u05FF])(?:ה)?כתובת(?:\s+המדויקת)?[^.\n]{0,40}(?:לא\s+(?:מופיעה|מופיע|זמינה|זמין|ידועה|נמצאת|מצוינת)|אינה\s+(?:מופיעה|זמינה))|אין\s+(?:לי|לנו|ברשותי)[^.\n]{0,25}(?:ה)?כתובת)|\b(?:(?:the )?(?:exact )?address (?:is not|isn'?t) (?:available|listed|in my details)|(?:i|we) (?:don'?t|do not) have the (?:exact )?address)\b/iu;
const INFO_DENIED = /(?<![\u0590-\u05FF])(?:לא\s+(?:מופיע|מופיעה|מופיעים|מופיעות)(?:\s+(?:אצלנו|אצלי|כרגע|במידע))?|אין\s+(?:(?:לנו|לי)\s+)?(?:(?:כרגע|כאן)\s+)*(?:מידע|פרטים)\s+(?:על|לגבי|בנושא))(?![\u0590-\u05FF])|\b(?:(?:is|are) not (?:listed|on file)|we have no (?:information|details) (?:on|about))\b/iu;
const INFO_STOP = new Set(["פרטי", "פרטים", "מידע", "כרגע", "אצלנו", "לגבי", "בנושא", "מופיע", "מופיעה", "מופיעים", "מופיעות"]);
/** Sentences saying something is not on file while the knowledge names it (two of their word stems, or one 5+ letters). */
export function infoDeniedButKnown(reply: string, knowledge: string): string[] {
  const k = unfinal(String(knowledge ?? "").toLowerCase());
  if (!k) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => {
    if (!INFO_DENIED.test(x)) return false;
    const stems = (x.match(/\p{L}{4,}/giu) ?? []).filter((w) => !INFO_STOP.has(w)).map(stem).filter((w) => w.length >= 3);
    const hits = stems.filter((w) => k.includes(w));
    return hits.length >= 2 || hits.some((w) => w.length >= 5);
  }).map((x) => x.trim().slice(0, 120));
}

// Denying what the employee itself sent earlier in this conversation (prod replay 2026-11-17: a YouTube
// link sent, then "no video link available"): its own earlier facts stand.
const DENIES_LINK = /(?<![\u0590-\u05FF])(?:אין\s+(?:לי|לנו)?\s*(?:(?:כרגע|כאן)\s+)*(?:קישור|לינק|סרטון)|לא\s+(?:מצאתי|מצאנו|קיים|זמין)\s+(?:קישור|לינק|סרטון)|(?:קישור|לינק|סרטון)[^.!?\n]{0,20}(?:לא\s+(?:זמין|קיים|מופיע)|אין))(?![\u0590-\u05FF])|\b(?:no (?:video|link|url)\b|(?:link|video) (?:is not|isn'?t) available|(?:don'?t|do not) have (?:a|the) (?:link|video))/iu;
const DENIES_PRICE = /(?<![\u0590-\u05FF])(?:אין\s+(?:לי|לנו)\s+(?:את\s+)?(?:ה)?מחיר|המחיר\s+לא\s+(?:מופיע|זמין|ידוע))(?![\u0590-\u05FF])|\b(?:(?:price|pricing) (?:is not|isn'?t) (?:available|listed)|(?:don'?t|do not) have the price)\b/iu;
/** Sentences denying a link, a video or a price the employee itself gave earlier in this conversation. */
export function contradictsEarlier(reply: string, previousBotReplies: string[]): string[] {
  const said = previousBotReplies.join("\n");
  const hadLink = /https?:\/\//i.test(said), hadPrice = /₪\s*\d|\d\s*(?:₪|ש["״']?ח)/.test(said);
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => (hadLink && DENIES_LINK.test(x)) || (hadPrice && DENIES_PRICE.test(x))).map((x) => x.trim().slice(0, 120));
}

// A return question answered with half the policy (prod replay 2026-11-17, Tehila: refunds only).
const RETURN_ASK = /(?<![\u0590-\u05FF])[וש]?(?:להחזיר|מחזיר|מחזירה|מחזירים|אחזיר|נחזיר|החזרה|החזרות|החזר|להחליף|מחליף|מחליפים|אחליף|החלפה|החלפות)(?![\u0590-\u05FF])|\b(?:return|returns|exchange|exchanges)\b/iu;
const SAYS_RETURN = /(?<![\u0590-\u05FF])[וש]?ה?(?:החזרה|החזרות|החזר|להחזיר|זיכוי)(?![\u0590-\u05FF])|\b(?:return|refund)/iu;
const SAYS_EXCHANGE = /(?<![\u0590-\u05FF])[וש]?ה?(?:החלפה|החלפות|להחליף)(?![\u0590-\u05FF])|\bexchange/iu;
/** The business offers returns and exchanges, the customer asks about one, and the reply gives only one of them. */
export function partialReturnPolicy(reply: string, incoming: string, knowledge: string): boolean {
  if (!RETURN_ASK.test(incoming ?? "") || !SAYS_RETURN.test(knowledge ?? "") || !SAYS_EXCHANGE.test(knowledge ?? "")) return false;
  return SAYS_RETURN.test(reply ?? "") !== SAYS_EXCHANGE.test(reply ?? "");
}

/** Sentences that say the address is not known. */
export function addressDenied(reply: string): string[] {
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => ADDRESS_DENIED.test(x)).map((x) => x.trim().slice(0, 120));
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
  // A general "can I order?" names no product: the site or the knowledge answers it, no store search (dev live
  // round on 9480dfb2: "אפשר להזמין?" went to the team as no_search).
  if (!storeQueryOf(incoming)) return false;
  const canSearch = toolsOffered.some((n) => /list_products|search_products/i.test(n));
  return canSearch && !tools.some((t) => /list_products|search_products|get_product/i.test(t.tool));
}

// "Where do I GET it" answered with where to USE it (prod replay 13, three times, about a
// code). Generic: any obtainable thing (a code, a voucher, a form, an invoice, a link).
const OBTAINABLE = String.raw`(?:ה)?(?:קוד|קופון|שובר|גיפט\s*קארד|כרטיס\s+מתנה|טופס|חשבונית|קבלה|קישור|לינק)`;
const GET_IT = new RegExp(String.raw`(?:(?:איפה|איך|מאיפה|מהיכן)\s+(?:אני\s+)?(?:מוצא|מוצאת|מוצאים|משיג|משיגה|משיגים|מקבל|מקבלת|מקבלים|יש)\s+(?:את\s+)?${OBTAINABLE}|מאיפה\s+${OBTAINABLE}|${OBTAINABLE}\s+עצמו)|\b(?:where (?:do i|can i) (?:get|find|obtain) (?:a |the )?(?:code|coupon|voucher|gift card|form|invoice|receipt|link)|how (?:do i|can i) get (?:a |the )?(?:code|coupon|voucher|gift card|form|invoice|receipt|link))\b`, "iu");
const USE_IT = /(?<![\u0590-\u05FF])(?:מזינים|להזין|הזינו|שדה|בעמוד\s+התשלום|בקופה|לוחצים|ממלאים)(?![\u0590-\u05FF])|\b(?:enter|field|checkout|click|fill in)\b/iu;
// How one is obtained: given, sent, received, signed up for (any channel).
const OBTAIN = /(?<![\u0590-\u05FF])(?:מקבלים|מתקבל|מתקבלת|נשלח|נשלחת|נשלחים|שולחים|מחלקים|ניתן|ניתנת|נרשמים|בהרשמה|הרשמה|נרשמ\S*|מצטרפים|מנויים|במבצע|במבצעים|מבצע|מבצעים)(?![\u0590-\u05FF])|\b(?:sent|given|receive|you get|sign(?:ing)? up|subscrib\w*|promotion|issued)\b/iu;
// "איפה מוצאת את זה" after a code was discussed: the pronoun is the code (prod replay 2026-11-17, third time).
const GET_PRONOUN = /(?:(?:איפה|איך|מאיפה|מהיכן)\s+(?:אני\s+)?(?:מוצא|מוצאת|מוצאים|משיג|משיגה|משיגים|מקבל|מקבלת|מקבלים|יש)\s+(?:את\s+)?(?:זה|אותו|אותה)(?![\u0590-\u05FF]))|\b(?:where (?:do i|can i) (?:get|find) (?:it|that|one)|how (?:do i|can i) get (?:it|that|one))\b/iu;
const CODE_CONTEXT = new RegExp(String.raw`${OBTAINABLE}|\b(?:code|coupon|voucher|gift card)\b`, "iu");
/**
 * Where something is obtained, stated with nothing in the knowledge saying so (prod replay 2026-11-17:
 * "את הקוד עצמו מקבלים מהצוות", invented). Backed by a knowledge sentence naming a code (or the like)
 * and how it is obtained.
 */
export function ungroundedSource(incoming: string, reply: string, context: string, knowledge: string): string[] {
  const asks = GET_IT.test(incoming ?? "") || (GET_PRONOUN.test(incoming ?? "") && CODE_CONTEXT.test(context ?? ""));
  if (!asks) return [];
  const known = (String(knowledge ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).some((x) => CODE_CONTEXT.test(x) && OBTAIN_ANY.test(x));
  if (known) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => OBTAIN_ANY.test(x) && !/\?\s*$/.test(x.trim())).map((x) => x.trim().slice(0, 120));
}
// How a thing is obtained, wider than OBTAIN: from someone ("מקבלים מהצוות"), by mail, at purchase.
const OBTAIN_ANY = new RegExp(`${OBTAIN.source}|(?<![\\u0590-\\u05FF])(?:מקבלים|מקבל|מקבלת|תקבל|תקבלי|תקבלו|מגיע|מגיעה|נשלח|נשלחת)\\s+(?:מ|ב|אחרי|לאחר|עם)[\\u0590-\\u05FF]*|\\b(?:you (?:get|receive) (?:it|one|the code) (?:from|by|after|with|when))\\b`, "iu");

/** The customer asks where to GET something (named, or "it" after one was discussed), and the reply only says where to use it. */
export function couponSourceMissed(incoming: string, reply: string, context = ""): boolean {
  const asks = GET_IT.test(incoming ?? "") || (GET_PRONOUN.test(incoming ?? "") && CODE_CONTEXT.test(context ?? ""));
  return asks && USE_IT.test(reply ?? "") && !OBTAIN.test(reply ?? "");
}

/** The reply presents or names products for a product ask, and no store search ran. */
// A recommendation names products as much as "here are" does (a statement; "מתאים לך?" asks).
const statementsOf = (t: string) => (String(t ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => !x.trim().endsWith("?")).join(" ");
const RECOMMENDS_SRC = String.raw`(?<![\u0590-\u05FF])(?:מתאים\s+(?:לך|לכם|לזה)|מתאימה\s+(?:לך|לכם)|מומלץ|ממליצים|הכי\s+מתאים)(?![\u0590-\u05FF])|\b(?:i(?:'d| would) recommend|we recommend|would suit|fits you|best (?:fit|option))\b`;
const RECOMMENDS = /(?<![\u0590-\u05FF])(?:מתאים\s+(?:לך|לכם|לזה)|מתאימה\s+(?:לך|לכם)|מומלץ|ממליצים|הכי\s+מתאים|כדאי\s+(?:לך\s+)?(?:את|ב))(?![\u0590-\u05FF])|\b(?:i(?:'d| would) recommend|we recommend|would suit|fits you|best (?:fit|option))\b/iu;
export function namesProductsUnsearched(reply: string, incoming: string, tools: ToolRunRecord[], toolsOffered: string[]): boolean {
  if (!(PRODUCT_WANT.test(incoming ?? "") || PURCHASE.test(incoming ?? "")) || !(PRESENTS.test(reply ?? "") || PRODUCT_NOUN.test(reply ?? "") || RECOMMENDS.test(statementsOf(reply)))) return false;
  const canSearch = toolsOffered.some((n) => /list_products|search_products/i.test(n));
  return canSearch && !tools.some((t) => /list_products|search_products|get_product/i.test(t.tool));
}
/** Every sentence of the reply says the team has it. */
export const bareTeamLine = (reply: string) => { const xs = (String(reply ?? "").match(/[^.!?\n]+[.!?]*/g) ?? []).map((x) => x.trim()).filter(Boolean); return xs.length > 0 && xs.every((x) => TEAM_LINE.test(x) || TEAM_PASS_ANY.test(x)); };
/** An information question (how, what, which, is there), not about her own order and with no number of hers. */
export const infoQuestion = (incoming: string) => { const t = String(incoming ?? ""); return /(?<![\u0590-\u05FF])(?:מה|איך|איזה|איזו|אילו|האם|יש|אפשר|כמה)(?![\u0590-\u05FF])|\b(?:what|how|which|is there|can i|do you)\b/iu.test(t) && !ORDER_ASK.test(t) && !/\d{3,}/.test(t); };
/** Two or more of her content words (4+ letters, the joined ה and ו off) in the retrieved knowledge. */
export const knowledgeSpeaksTo = (incoming: string, knowledge: string) => {
  const k = String(knowledge ?? "").toLowerCase();
  if (!k) return false;
  const words = [...new Set(tipWords(incoming).map((w) => w.replace(/^[הו](?=[\u0590-\u05FF]{3,})/u, "")).filter((w) => !talkWord(w) && !["אפשר", "איזה", "איזו", "אילו", "שלכם", "עבור", "האם"].includes(w)))];
  // By stem: "אפשרויות" by "אפשר", "תשלום" by "לשלם" (dev round k4 on 259d48ea).
  const stem = (w: string) => w.replace(/^[לבמש](?=[\u0590-\u05FF]{4,})/u, "").replace(/(?:ויות|יות|ות|ים|ה|ת)$/u, "").slice(0, 4);
  const kStems = new Set(((k.match(/[\u0590-\u05FFa-z]{3,}/gu) ?? []) as string[]).map((x) => stem(x.replace(/^[הו](?=[\u0590-\u05FF]{3,})/u, ""))));
  const root = (w: string) => w.replace(/^ת(?=ש)/u, "");
  return words.filter((w) => k.includes(w) || kStems.has(stem(w)) || [...kStems].some((x) => x.length >= 3 && root(stem(w)).length >= 3 && (x.includes(root(stem(w))) || root(stem(w)).includes(x)))).length >= 2;
};
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

// Any alphabet (prod check 2026-11-17: a Russian or Arabic chat must not pass the repeat checks).
const qWords = (s: string) => new Set((String(s ?? "").match(/[\p{L}\p{N}]{2,}/gu) ?? []).map((w) => w.toLowerCase()));
/** A question (or a photo request) the employee already asked in this conversation. */
export function repeatedAsk(reply: string, previousBotReplies: string[]): boolean {
  if (!previousBotReplies.length) return false;
  if (PHOTO_ASK.test(reply ?? "") && previousBotReplies.some((p) => PHOTO_ASK.test(p) && /\?/.test(p))) return true;
  const questions = (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n])+\?/g) ?? []).map(qWords).filter((q) => q.size >= 3);
  const before = previousBotReplies.flatMap((p) => String(p).match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n])+\?/g) ?? []).map(qWords);
  return questions.some((q) => before.some((b) => { let n = 0; for (const w of q) if (b.has(w)) n++; return n / Math.max(q.size, b.size) >= 0.7; }));
}

// The employee offered a person, or asked if it is urgent, and the customer said yes (prod replay 5).
const OFFERED_PERSON = /(?<![\u0590-\u05FF])[וש]?(?:דחוף|דחופה|להעביר|שאעביר|שנעביר|אעביר|נעביר|נציג|נציגה|נציגים|צוות|הצוות|לצוות|מהצוות|מישהו|מישהי|שיחזרו|שיחזור|שתחזור|שנחזור|לחבר\s+אותך|שיתקשרו|שיתקשר|לדבר\s+עם)(?![\u0590-\u05FF])|\b(?:urgent|connect you|pass (?:this|you) (?:on|to)|talk to (?:someone|a person))\b/iu;
const YES = /^\s*(?:כן|כן\s+בבקשה|כן\s+דחוף|דחוף|ברור|בטח|אשמח|בהחלט|yes|yeah|yep|please|sure)(?:[\s,.!]|$)/iu;
/** The customer accepted the employee's own offer of a person, and the reply does neither hand over nor record it. */
// A person offered, in the question itself (rating ed780586: "כן" after "לבדוק עם הצוות?" became a handoff).
const PERSON_OFFER = /(?<![\u0590-\u05FF])[וש]?[לה]?(?:נציג|נציגה|נציגים|מישהו\s+מהצוות|מישהי\s+מהצוות|אחד\s+מהצוות|לדבר\s+עם\s+(?:נציג|נציגה|מישהו|אדם)|לחבר\s+אותך|להעביר\s+אותך|שאעביר\s+אותך|שנעביר\s+אותך|שיחזרו\s+אלי+(?:ך|כם)|שיחזור\s+אלי+(?:ך|כם)|שיתקשרו|שיתקשר)(?![\u0590-\u05FF])|\b(?:connect you|transfer you|pass you (?:on|to)|talk to (?:someone|a person|a human|an agent)|(?:a|an) (?:person|agent|representative|human))\b/iu;
export function offeredPerson(lastBotReply: string | null | undefined): boolean {
  const t = String(lastBotReply ?? "");
  // A question that offers a person, or a question whose "if so" offers one ("זה דחוף? אם כן אעביר לנציג").
  // Urgency or priority alone is no person (rating 83086356: "כן" to a high-priority check became a handoff).
  if ((t.match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n])+\?/g) ?? []).some((q) => PERSON_OFFER.test(q))) return true;
  const ifSo = /\?\s*(?:ו?אם\s+כן|if so)[^.!?\n]{0,80}/iu.exec(t);
  return !!ifSo && PERSON_OFFER.test(ifSo[0]);
}
export function ignoredYes(incoming: string, lastBotReply: string | null | undefined, handedOff: boolean, teamQuestion: boolean): boolean {
  if (handedOff || teamQuestion || !lastBotReply) return false;
  return offeredPerson(lastBotReply) && YES.test(incoming ?? "");
}

// The reply tells the customer a person will continue (prod replay 6: three
// "נציג מהצוות ימשיך איתך" with no handoff). Never a promise without the action.
const PERSON_CONTINUES = /(?<![\u0590-\u05FF])(?:(?:נציג|נציגה|מישהו|מישהי|אחד\s+מהצוות)\s+(?:מהצוות\s+)?(?:ימשיך|תמשיך|יחזור|תחזור|יטפל|תטפל|יענה|תענה|ייצור\s+קשר|תיצור\s+קשר|יצור\s+קשר)|(?:מעביר|מעבירה|מעבירים)\s+(?:אותך\s+|את\s+השיחה\s+)?ל(?:נציג|נציגה|צוות)|העברתי\s+(?:אותך\s+|את\s+השיחה\s+)?ל(?:נציג|נציגה)|הצוות\s+(?:יחזור|ימשיך|ייצור\s+קשר)(?:\s+אלי(?:ך|כם))?)(?![\u0590-\u05FF])|\b(?:a (?:person|team member|representative|human) (?:will|is going to) (?:continue|take over|get back)|(?:i'?m|we'?re) (?:transferring|passing) you)\b/iu;
export const promisesPerson = (reply: string) => PERSON_CONTINUES.test(reply ?? "");
/** The reply without its sentences that say a person continues (used when a needless handoff is removed). */
export const dropPersonPromises = (reply: string) => (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*\s*/g) ?? [String(reply ?? "")]).filter((x) => !PERSON_CONTINUES.test(x)).reduce(joinKept, "").trim();

// "הנה בנדנות מרובעות" with no name, price or card (prod replay 6, Tehila).
const PRESENTS = /(?<![\u0590-\u05FF])(?:הנה|יש\s+לנו|יש\s+כמה|אפשרויות|דגמים|כמה\s+סוגים|שני\s+סוגים)(?![\u0590-\u05FF])|\b(?:here (?:are|is)|we have|options)\b/iu;
/** A product ask answered as if products were shown, with none named, priced or carded (a text channel gets the list appended, so never there when products came back). */
export function namelessProducts(reply: string, incoming: string, cards: string[], titles: string[], listAppended = false): boolean {
  if (listAppended || !PRODUCT_WANT.test(incoming ?? "") || !PRESENTS.test(reply ?? "") || cards.length) return false;
  if (titles.some((t) => t && reply.includes(t))) return false;
  return !/₪|ש["״']ח|\d+\s?(?:NIS|ILS)|https?:\/\//.test(reply ?? "") && !/\?/.test(reply ?? "");
}

// "בתמונה", "מצורף", "below" with nothing attached (prod replay 7, Smoovee: twice).
const PICTURE_REF = /(?<![\u0590-\u05FF])(?:[וש]?(?:הנה|שלחתי|שלחנו|מצרפת|מצרף|מצרפים|צירפתי|צירפנו)\s+(?:לך\s+|לכם\s+)?(?:את\s+)?(?:ה)?(?:תמונה|תמונות|צילום|צילומים)|(?:ה)?(?:תמונה|צילום)\s+(?:מצורפ\w*|עם\s+ה)|בתמונה|בתמונות|(?<!(?:חיוב|החיוב|תשלום|התשלום|עסקה|העסקה|פרטי|בפרטי|נרשם\s+חיוב)\s+)בכרטיס(?![\u0590-\u05FF])(?!\s+(?:ה?אשראי|חיוב|מתנה|דביט|ויזה|האשראי))|בכרטיסים|מצורף|מצורפת|מצורפים|מצורפות|כאן\s+למטה|בהמשך\s+ההודעה|רואים\s+ב(?:תמונה|כרטיס))(?![\u0590-\u05FF])|\b(?:in the (?:picture|photo|card)s?|attached|see below|shown below)\b/iu;
/** Sentences that point at a picture or card when none goes out with the reply. */
export function cardReferences(reply: string, cardsShown: boolean): string[] {
  if (cardsShown) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => PICTURE_REF.test(x)).map((x) => x.trim().slice(0, 120));
}

// A size the customer typed, stated back as a product's own (prod replay 9: "90×90"
// confirmed while the product data says 70×70). A size about their device is theirs to state.
const SIZE = /(\d{1,3}(?:[.,]\d)?)\s*(?:ס["״']?מ\s*)?(?:[x×*]|על)\s*(\d{1,3}(?:[.,]\d)?)|(?<![\d/])(\d{2,3})\s*\/\s*(\d{2,3})(?![\d/])/gu;
// A product spoken of, in generic nouns; the store's own titles are added per turn (echoedSizes).
const PRODUCT_NOUN = /(?<![\u0590-\u05FF])(?:ה?מוצר|ה?מוצרים|ה?דגם|ה?דגמים|ה?פריט|ה?פריטים|בגודל|במידה|במידות|מידות|מידה)(?![\u0590-\u05FF])|\b(?:the (?:product|model|item)|size|sized)\b/iu;
// The customer's own thing, in generic words: "yours", "you gave", "you mentioned".
const THEIR_DEVICE = /(?<![\u0590-\u05FF])(?:שלך|שלכם|שלכן|שציינת|שציינתם|שנתת|שנתתם|שכתבת|שכתבתם|שמדדת|שמדדתם)(?![\u0590-\u05FF])|\b(?:your|you gave|you mentioned|you measured)\b/iu;
const sizeKeys = (text: string) => new Set([...String(text ?? "").matchAll(SIZE)].map((m) => [m[1] ?? m[3], m[2] ?? m[4]].map((x) => x.replace(",", ".")).sort().join("x")));
/** Sentences stating a product's size that only the customer's own messages give. */
export function echoedSizes(reply: string, customerText: string, sourceText: string, productTitles: string[] = []): string[] {
  const theirs = sizeKeys(customerText);
  if (!theirs.size) return [];
  const known = sizeKeys(sourceText);
  // The store's own product words (this turn's titles) name a product as well as "המוצר" does.
  const titleStems = [...new Set(productTitles.flatMap((t) => contentStems(t)).filter((w) => w.length >= 3))];
  const namesProduct = (x: string) => PRODUCT_NOUN.test(x) || titleStems.some((w) => unfinal(x.toLowerCase()).includes(w));
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => {
    const echoed = [...sizeKeys(x)].some((k) => theirs.has(k) && !known.has(k));
    return echoed && namesProduct(x) && !THEIR_DEVICE.test(x);
  }).map((x) => x.trim().slice(0, 120));
}

// A usage tip in a safety conversation that the knowledge does not give (prod replay 11:
// "check that the stopper touches the wheels" on an appliance tipping back).
const TIP = /(?<![\u0590-\u05FF])(?:כדאי\s+(?:לוודא|לבדוק|לנסות|להזיז|לסובב|למקם|להניח)|יש\s+(?:לוודא|לבדוק|להקפיד)|מומלץ\s+(?:לוודא|לבדוק|לנסות|למקם|להניח)|תוודאו|תוודא|תבדקו|תבדוק|נסו|תנסו|אפשר\s+לנסות|לבדוק\s+ש|לוודא\s+ש)(?![\u0590-\u05FF])|\b(?:make sure|check that|try (?:to|placing|moving)|you can try)\b/iu;
const STOP_USE = /(?<![\u0590-\u05FF])(?:להפסיק\s+(?:להשתמש|לעבוד|את\s+השימוש)|לא\s+להשתמש|לא\s+לעבוד\s+(?:עם|על)|להימנע\s+(?:משימוש|מלהשתמש)|stop using|don'?t use|avoid using)(?![\u0590-\u05FF])/iu;
const tipWords = (t: string) => (String(t ?? "").toLowerCase().match(/\p{L}{4,}/gu) ?? []);
/** In a safety conversation: tip sentences that the knowledge does not contain (two of their words or more). */
export function unsafeTips(reply: string, knowledge: string, safety: boolean): string[] {
  if (!safety) return [];
  const k = unfinal(String(knowledge ?? "").toLowerCase());
  // By stem ("שהמעצור" is "המעצור"), final letters plain.
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => TIP.test(x) && !STOP_USE.test(x) && tipWords(x).map(stem).filter((w) => k.includes(w)).length < 2).map((x) => x.trim().slice(0, 120));
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
  const before = previousBotReplies.slice(-5).flatMap((p) => String(p).match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).map(qWords).filter((w) => w.size >= 6);
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => {
    const mine = qWords(x);
    if (mine.size < 6) return false;
    return before.some((b) => { let n = 0; for (const w of mine) if (b.has(w)) n++; return n / Math.max(mine.size, b.size) >= 0.8; });
  }).map((x) => x.trim());
}

// A character from another script inside the reply (prod replay 5: "כשמ折לים"). Hebrew, Latin and
// the scripts the customer writes in are the conversation's; anything else slipped in.
const SCRIPTS = ["Arabic", "Cyrillic", "Greek", "Armenian", "Georgian", "Thai", "Devanagari", "Han", "Hiragana", "Katakana", "Hangul", "Ethiopic", "Amharic"].filter((n) => { try { new RegExp(`\\p{Script=${n}}`, "u"); return true; } catch { return false; } });
const scriptsIn = (text: string) => SCRIPTS.filter((n) => new RegExp(`\\p{Script=${n}}`, "u").test(text ?? ""));
const foreignScriptRe = (allowedText = "") => {
  const extra = scriptsIn(allowedText).map((n) => `\\p{Script=${n}}`).join("");
  return new RegExp(`[^\\p{Script=Hebrew}\\p{Script=Latin}\\p{Script=Common}\\p{Script=Inherited}${extra}\\s]`, "gu");
};
export const foreignScript = (reply: string, allowedText = "") => (String(reply ?? "").match(foreignScriptRe(allowedText)) ?? []).length > 0;
export const stripForeignScript = (reply: string, allowedText = "") => String(reply ?? "").replace(foreignScriptRe(allowedText), "");

// How the system works is not the customer's business (prod replay 5: "the number is linked to your contact details").
const INTERNAL_JARGON = /(?<![\u0590-\u05FF])(?:(?:מקושר|מקושרת|משויך|משויכת)\s+ל(?:פרטי\s+(?:ה)?קשר|איש\s+(?:ה)?קשר|חשבון|כרטיס)|פרטי\s+הקשר\s+(?:השמורים|המאומתים|המקושרים)|אימות\s+זהות|הרשאות?\s+גישה|במערכת\s+שלנו\s+(?:מופיע|רשום))(?![\u0590-\u05FF])|access_denied|cross_customer|(?<![\u0590-\u05FF])(?:לא\s+מפורט(?:ים|ות|ת)?\s+(?:כאן|אצלנו|במידע)|אין\s+במידע|במידע\s+(?:שיש\s+)?(?:לי|לנו)\s+(?:אין|לא))(?![\u0590-\u05FF])|(?<![\u0590-\u05FF])(?:בתיאור\s+העסק|בפרטי\s+העסק|במידע\s+שלנו\s+(?:מופיע|מופיעה|מופיעים|כתוב)|אצלנו\s+(?:מופיע|מופיעה|מופיעים|רשום)|לא\s+(?:מופיע|מופיעה|מופיעים|מופיעות)\s+אצלנו|צירוף\s+(?:של\s+)?תבנית|הודעה\s+(?:קריאה|שאינה\s+קריאה)|לא\s+התקבלה\s+הודעה\s+קריאה)(?![\u0590-\u05FF])|\b(?:template attachment|template message|readable message)\b|(?<![\u0590-\u05FF])(?:נוסף|נוספה|הוספתי|הוספנו|שמרתי|שמרנו|עודכן|עודכנה|עדכנו)\s+(?:את\s+\S+\s+)?(?:ל|אל\s+)?(?:פרטי\s+(?:ה)?קשר|הכרטיס\s+שלך|לכרטיס|למערכת)(?![\u0590-\u05FF])|(?<![\u0590-\u05FF])(?:ההודעה\s+(?:שלא\s+נתמכה|שאינה\s+נתמכת|לא\s+נתמכת)|הודעה\s+(?:שלא\s+נתמכה|שאינה\s+נתמכת|לא\s+נתמכת))(?![\u0590-\u05FF])|\bunsupported (?:message|media)\b|\b(?:linked to your contact|contact details on file|verified identity|tool call|the system shows)\b|(?<![\u0590-\u05FF])[וש]?(?:מקור\s+(?:נוסף|אחר)|במקור\s+(?:אחר|נוסף)|לפי\s+(?:המסמך|המסמכים|המקור|המקורות)|במסמך\s+(?:אחר|נוסף)|התקנון\s+(?:מציין|אומר|קובע)[^.\n]{0,80}\s+ו(?:במקום|מקור|בשאלות|ב?מסמך)|יש\s+סתירה\s+בין)(?![\u0590-\u05FF])|\b(?:another source|one (?:document|source) says|according to the documents?)\b/iu;
// The bot describing its own lookup or what it did or did not verify (rating of b3d2bbf3 and dev round k3: "בחיפוש
// לפי חולצת טי", "לא אומתו", "מחיר מאומת", "שתוארו קודם", "לא בדקנו את התיאור", "המידע שיש לנו מתאר").
const PROCESS_TALK = /(?<![\u0590-\u05FF])(?:בחיפוש\s+(?:לפי|של|על)|לא\s+מצוין\s+(?:אם|האם)|(?:ה)?(?:מלאי|מידות|צבעים|מחיר|מחירים|זמינות)(?:\s+ו?(?:ה)?(?:מלאי|מידות|צבעים|מחיר|מחירים|זמינות))?\s+(?:לא|טרם)\s+(?:נבדק|נבדקו|נבדקה|אומתו)(?![\u0590-\u05FF])|(?:ב|ש|ה)?(?:פריטים|מוצרים|חולצות|דגמים)\s+ש(?:מופיעים|מופיעות)\s+(?:אצלנו|כאן|באתר)|לא\s+(?:אומת|אומתו|אומתה|מאומת|מאומתים|מאומתות|מאומתת)|(?:מחיר|מחירים|צבע|צבעים|מלאי)\s+(?:מאומת|מאומתים|מאומתות)|ש(?:תוארו|תואר|תוארה|הוזכרו|הוזכר|הוזכרה)\s+(?:קודם|לפני\s+כן|מקודם)|(?:לא\s+)?(?:בדקנו|בדקתי)\s+את\s+(?:ה)?(?:תיאור|מידע|פרטים)|המידע\s+שיש\s+(?:לנו|לי)\s+(?:מתאר|מציין|אומר))(?![\u0590-\u05FF])/u;
// The same as a clause before the real question ("אין כאן פנייה קודמת פתוחה ..., אפשר לכתוב במה מדובר?"): the clause goes.
const PROCESS_CLAUSE = /(?<![\u0590-\u05FF])(?:אין\s+(?:לי\s+)?(?:כאן|פה|אצלנו)\s+(?:פנייה|בקשה|שיחה|הודעה)[^,.!?\n]{0,80}),\s*/gu;
export const internalJargon = (reply: string) => INTERNAL_JARGON.test(reply ?? "") || PROCESS_TALK.test(reply ?? "") || new RegExp(PROCESS_CLAUSE.source, "u").test(reply ?? "");

// A tool failure told to the customer (prod replay 8: "the catalogue didn't open for me").
/** The reply narrating its own reasoning about the results (rating 93f9fdff, Tehila: "...לא תואמות למה שתיארת, אז לא אציע אותן"). */
/**
 * The model talking about its own tools to the customer (87076cab replay, return 97837: "מצטערים, לא נדרש כאן
 * חיפוש מוצר"). Cut, and never a reason to search again (unlike internal_reasoning).
 */
const TOOL_TALK = /(?<![\u0590-\u05FF])(?:לא\s+(?:נדרש|נדרשת|צריך|צריכה)\s+(?:כאן\s+|פה\s+)?(?:חיפוש|לחפש|בדיקה\s+במערכת)|אין\s+צורך\s+(?:כאן\s+|פה\s+)?(?:לחפש|בחיפוש|לבדוק\s+במערכת)|(?:הכלי|הכלים|המערכת)\s+(?:לא\s+)?(?:החזיר|החזירה|מחזיר|מחזירה)|חיפוש\s+(?:ה)?מוצר(?:ים)?\s+לא\s+(?:נדרש|רלוונטי))(?![\u0590-\u05FF])|\b(?:no (?:product )?search (?:is )?needed|(?:the )?tool (?:returned|did not return)|no need to search)\b/iu;
const INTERNAL_REASONING = /(?<![\u0590-\u05FF])(?:(?:אז\s+|ולכן\s+|לכן\s+)?לא\s+(?:אציע|אמליץ|אראה|אשלח|נציע|נמליץ)(?:\s+(?:אותן|אותם|אותה|אותו|לך|לכם))?|(?:לא\s+)?(?:תואמות|תואמים|תואם|תואמת)\s+(?:ל)?(?:מה\s+ש(?:תיארת|ביקשת|כתבת|חיפשת))|(?:שמופיעות|שמופיעים|שמצאתי|שעלו)\s+(?:באתר|בחיפוש)\s+לא\s+(?:תואמות|תואמים|מתאימות|מתאימים))(?![\u0590-\u05FF])|\b(?:so i won'?t (?:offer|suggest|show)|(?:they|these) (?:don'?t|do not) match what you (?:described|asked))\b/iu;
const FAILURE_NARRATION = /(?<![\u0590-\u05FF])(?:החיפוש\s+לא\s+(?:החזיר|מצא|העלה)(?:\s+(?:שום\s+)?(?:התאמה|תוצאות|תוצאה))?|(?:ה)?(?:צילום|תמונה|קובץ|הודעה)\s+לא\s+(?:הגיע|הגיעה|נפתח|נפתחה)(?:\s+אלינו)?(?:\s+כטקסט)?|שאפשר\s+לקרוא|לא\s+(?:הצלחתי|הצלחנו|ניתן)\s+(?:לפתוח|לקרוא|לראות)\s+(?:את\s+)?(?:ה)?(?:תמונה|צילום|קובץ)|(?:ה)?(?:בדיקה|בקשה|הזמנה|מערכת|קטלוג|עמוד|קישור|חיפוש)(?:\s+של\s+[\u0590-\u05FF]+)?\s+לא\s+(?:נפתח|נפתחה|נטען|נטענה|עבד|עבדה|הצליח|הצליחה)|הקטלוג\s+לא\s+(?:נפתח|נטען|עובד|זמין)|לא\s+נפתח\s+לי|לא\s+נטען\s+לי|יש\s+(?:לי\s+)?(?:תקלה|בעיה\s+טכנית)|תקלה\s+(?:טכנית|במערכת|בחיפוש)|המערכת\s+לא\s+(?:עובדת|עונה|מאפשרת)|החיפוש\s+(?:נכשל|לא\s+עבד))(?![\u0590-\u05FF])|\b(?:catalog(?:ue)? (?:didn'?t|did not|won'?t) (?:open|load)|technical (?:issue|problem)|the system (?:is down|isn'?t working)|search failed)\b/iu;
export const failureNarration = (reply: string) => FAILURE_NARRATION.test(reply ?? "");

// Broken Hebrew seen in prod replay 8 ("חשוב לנו לשמוע מה לא מרוצה").
// "זה באמת לא בטיחותי" (prod replay 13): the business never affirms its product is unsafe.
const AFFIRMS_UNSAFE = /(?<![\u0590-\u05FF])(?:זה|הוא|היא|ה[\u0590-\u05FF]{2,})\s+(?:באמת\s+|ממש\s+|אכן\s+)?(?:לא\s+בטיחותי(?:ת)?|מסוכנ(?:ת|ים)?|מסוכן)(?![\u0590-\u05FF])|\b(?:(?:it|this|the \w+)(?:'s| is) (?:really |indeed |actually )?(?:unsafe|dangerous))\b/iu;
// "ייתכן שהמשטח יזוז" (prod replay 12): a hedge that invents a fault.
// Generic: a hedge that predicts a fault in the product (any subject, a fault verb).
const ODD_HEDGE = /(?<![\u0590-\u05FF])(?:ייתכן|יתכן|אולי|יכול\s+להיות)\s+ש(?:ה?[\u0590-\u05FF]{2,}\s+)?(?:יזוז|תזוז|יחליק|תחליק|ייפול|תיפול|יתהפך|תתהפך|יישבר|תישבר|יתקלקל|תתקלקל|לא\s+(?:יחזיק|תחזיק|יעבוד|תעבוד))(?![\u0590-\u05FF])|\b(?:it )?(?:might|may|could) (?:slip|fall|tip over|break|stop working|not hold)\b/iu;
const BROKEN_HE = /(?<![\u0590-\u05FF])(?:מה\s+לא\s+(?:מרוצה|מרוצים|מרוצות)|(?:לא\s+)?מצוין\s+התאמה)(?![\u0590-\u05FF])/u;
// A statement written as a question ("יש כמה מטפחות חגיגיות בגווני כחול?") when products are shown.
// A plain statement only: no comma (a question after it) and no question word inside.
const STATEMENT_Q = /(?:^|(?<=[.!]\s))(יש\s+(?:כמה|לנו)(?:(?!\s(?:איזה|איזו|אילו|לאיזה|לאיזו|מה|איך|האם|מתאים|מתאימה|רוצים|רוצה|תרצו)(?![\u0590-\u05FF]))[^.?!,\n]){3,80})\?/gu;

// "One of these payment methods" with no list, "the necklaces shown here" with no card (prod
// replay 2026-11-17): a pointer at a list or cards the outgoing message does not carry.
// "להיכנס לאחת מהן", "לבחור באחד מהם": a plural pointer to act on; a bare "אחד מהם" may point back at her words.
const DANGLING = /(?<![\u0590-\u05FF])(?:(?:מופיע|מופיעה|מופיעים|מופיעות)\s+ב(?:פריטים|כרטיסים|כרטיסיות)|(?:ל|ב)(?:אחת|אחד)\s+מה(?:ן|ם)|[\u0590-\u05FF]{2,}\s+(?:האלה|האלו|הבאים|הבאות|שלהלן)|(?:שמופיע|שמופיעה|שמופיעים|שמופיעות|המופיעים|המופיעות)\s+(?:כאן|למטה|בהמשך)|(?:כאן\s+)?למטה|ברשימה\s+(?:הבאה|כאן|למטה))(?![\u0590-\u05FF])|\b(?:the following|listed (?:below|here)|(?:shown|see) below|below|one of these|these (?:options|products|items|methods|ones|models)|from (?:the|this) list)\b/iu;
const HAS_LIST = /(?:^|\n)\s*(?:[•\-*]|\d+[.)])\s+\S/;
/** Sentences that point at a list or cards that do not go out with the reply. */
// "איזו מהן ראית", "ביניהן": a plural pointer back at items; it dangles when nothing before it in the reply names them
// (dev round on 6320af2f: the colour sentence was cut and "לא בטוח איזו מהן ראית" went out alone).
// A bare "אחד מהם" may point back at her own words ("האם גם אחד מהם נכשל?"); "איזו מהן" asks her to pick between ours.
const PLURAL_BACK = /(?<![\u0590-\u05FF])(?:(?:איזו|איזה|איזהו)\s+מה(?:ן|ם)|ביניה(?:ן|ם))(?![\u0590-\u05FF])|\b(?:which (?:one )?of them|between them)\b/iu;
// The items named in the same sentence after the pointer ("באחד מהם: אשראי, ביט או פייפאל", "איזה מהם ניסית, אשראי או ביט?").
// Close after it: a colon list, or within two words a comma and at most three words before "או" ("חלקה או מפוספסת"
// five words on is a question about her item, not the items).
const ITEMS_AFTER = /(?:מה(?:ן|ם)|ביניה(?:ן|ם)|of them|between them)(?:\s+[^\s.!?,:]+){0,2}\s*(?::\s*\S|,\s*(?:[^\s.!?,]+,?\s+){1,3}(?:או|or)\s)/iu;
// Her message names two things ("ההבדל בין X ל-Y", "X או Y"): "ביניהם" points at them.
const HER_TWO = /(?<![\u0590-\u05FF])(?:בין\s+\S+.{0,40}?\s(?:ל|לבין)|ההבדל|הבדל|או)(?![\u0590-\u05FF])|\b(?:between|difference|or)\b/iu;
export function danglingReferences(reply: string, carriesList: boolean, incoming = ""): string[] {
  if (carriesList || HAS_LIST.test(reply ?? "")) return [];
  const pointsAtHers = (x: string) => /ביניה(?:ן|ם)|between them/iu.test(x) && HER_TWO.test(String(incoming ?? ""));
  const exempt = (x: string) => ITEMS_AFTER.test(x) || pointsAtHers(x);
  const sentences = String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? [];
  return sentences.filter((x, k) => (DANGLING.test(x) || (k === 0 && PLURAL_BACK.test(x))) && !exempt(x)).map((x) => x.trim().slice(0, 120));
}

// The same advice or warning again, in other words (prod replay 2026-11-17: one warning in five
// replies, three in a row). An advice sentence whose key stems (3+) match one of the last five.
const ADVICE = new RegExp([TIP.source, STOP_USE.source, String.raw`(?<![֐-׿])(?:חשוב|מומלץ|כדאי|שימו\s+לב|זהירות|אזהרה|אסור|יש\s+ל)(?![֐-׿])|\b(?:important|we recommend|be careful|warning|please note|never|always|remember to|make sure)\b`].join("|"), "iu");
const adviceStems = (x: string) => contentStems(x).filter((w) => w.length >= 3);
/** Advice sentences that repeat one already given (3+ shared stems), unless the customer asks about it again. */
export function repeatedAdvice(reply: string, previousBotReplies: string[], incoming = ""): string[] {
  const before = previousBotReplies.slice(-5).flatMap((p) => String(p).match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => ADVICE.test(x)).map(adviceStems);
  if (!before.length) return [];
  const asked = new Set(adviceStems(incoming));
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => {
    if (!ADVICE.test(x)) return false;
    const mine = adviceStems(x);
    if (mine.filter((w) => asked.has(w)).length >= 2) return false;
    return before.some((b) => mine.filter((w) => b.some((y) => y === w || (w.length >= 4 && (y.includes(w) || w.includes(y))))).length >= 3);
  }).map((x) => x.trim());
}

// Asked to recommend among products, and the reply neither picks nor asks (prod replay 2026-11-17).
const ASKS_RECOMMEND = /(?<![\u0590-\u05FF])(?:ממליצים|תמליצו|תמליץ|תמליצי|המלצה|מה\s+(?:הכי\s+)?(?:כדאי|מומלץ|עדיף)|איזה\s+(?:[\u0590-\u05FF]+\s+){0,2}(?:הכי\s+)?(?:כדאי|מומלץ|עדיף|מתאים|מתאימה)|איזו\s+(?:[\u0590-\u05FF]+\s+){0,2}(?:הכי\s+)?(?:כדאי|מומלצת|עדיפה|מתאימה)|מה\s+(?:אתם\s+)?ממליצים)(?![\u0590-\u05FF])|\b(?:recommend|suggest|which (?:one|board|model|is better|should i)|what would you (?:pick|choose|suggest)|best (?:one|option|for me))\b/iu;
const PICKS = new RegExp([RECOMMENDS_SRC, String.raw`(?<![֐-׿])(?:הייתי\s+הולך|הייתי\s+בוחר|הבחירה|הכי\s+טוב|עדיף|בגלל\s+ש|כי\s+(?:הוא|היא|זה))(?![֐-׿])|\b(?:best|go with|pick|because|great (?:choice|fit)|ideal)\b`].join("|"), "iu");
/** The reply picks a product (a recommendation with a reason). */
export const picksProduct = (reply: string) => PICKS.test(reply ?? "");
/**
 * Products came back for a recommendation ask, and the reply has no pick and no question. Once the
 * employee asked its qualifying question and the customer answered it, a question is no longer
 * enough: the reply picks (prod replay 2026-11-17, NE'A: a shade refused after the answer).
 */
export function noRecommendation(reply: string, incoming: string, candidateCount: number, recentInbound: string[] = [], lastBotReply = "", titles: string[] = []): boolean {
  if (!candidateCount) return false;
  const askedNow = ASKS_RECOMMEND.test(incoming ?? "");
  const answeredQualifier = !askedNow && /\?\s*$/.test(String(lastBotReply ?? "").trim()) && recentInbound.slice(-4, -1).some((m) => ASKS_RECOMMEND.test(m ?? "")) && !/\?/.test(incoming ?? "");
  if (!askedNow && !answeredQualifier) return false;
  if (PICKS.test(reply ?? "")) return false;
  // A product named as the one that fits is a pick ("אליס מתאים לנינג'ה קריספי").
  if (namesCandidate(reply, titles) && PICK_WORDS.test(reply ?? "")) return false;
  return answeredQualifier || !/\?/.test(reply ?? "");
}

// Gendered forms to a customer whose gender is not known become the plural (prod replay 2026-11-17).
const TO_PLURAL: Record<string, string> = {
  תשלחי: "תשלחו", שלחי: "שלחו", בחרי: "בחרו", תבחרי: "תבחרו", תוכלי: "תוכלו", תרצי: "תרצו", תרצה: "תרצו", תגידי: "תגידו",
  כתבי: "כתבו", תכתבי: "תכתבו", לחצי: "לחצו", תלחצי: "תלחצו", תזמיני: "תזמינו", הזמיני: "הזמינו", הסתכלי: "הסתכלו", תסתכלי: "תסתכלו",
  ראי: "ראו", תראי: "תראו", תארי: "תארו", הוסיפי: "הוסיפו", תוסיפי: "תוסיפו", תבדקי: "תבדקו", בדקי: "בדקו",
  כנסי: "היכנסו", היכנסי: "היכנסו", תיכנסי: "תיכנסו", תכנסי: "תיכנסו", צייני: "ציינו", תצייני: "תציינו", תני: "תנו", נסי: "נסו", תנסי: "תנסו",
  תגללי: "תגללו", שימי: "שימו", תשימי: "תשימו",
  תוכל: "תוכלו", תבחר: "תבחרו", תבדוק: "תבדקו", בדוק: "בדקו", תסתכל: "תסתכלו", הסתכל: "הסתכלו", היכנס: "היכנסו", תיכנס: "תיכנסו",
  תוסיף: "תוסיפו", הוסף: "הוסיפו", תציין: "תציינו", תשלח: "תשלחו", תכתוב: "תכתבו", תלחץ: "תלחצו", תזמין: "תזמינו", תגיד: "תגידו", תנסה: "תנסו", נסה: "נסו",
  מחפשת: "מחפשים", מעדיפה: "מעדיפים", מעוניינת: "מעוניינים", צריכה: "צריכים", מתלבטת: "מתלבטים", רוצה: "רוצים",
};
const PLURAL_WORDS = Object.keys(TO_PLURAL).sort((a, b) => b.length - a.length).join("|");
/** Second-person gendered verbs and participles as the plural ("תשלחי" -> "תשלחו"). Participles only where the customer is the subject ("את מחפשת", a question). */
export function neutralSecondPerson(s: string): string {
  // A sentence the plural reached says "לכם" too, never "כתבו ... יש לך" (prod replay of 9480dfb2, NE'A).
  const parts = String(s ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*\s*|\n+/g) ?? [String(s ?? "")];
  return parts.map((p) => {
    const q = neutralSecondPersonPart(p);
    return q === p ? p : q.replace(/(?<![\u0590-\u05FF])(ו?)(?:לך)(?![\u0590-\u05FF])/gu, "$1לכם").replace(/(?<![\u0590-\u05FF])(ו?)(?:אלייך|אליך)(?![\u0590-\u05FF])/gu, "$1אליכם");
  }).join("");
}
function neutralSecondPersonPart(s: string): string {
  return String(s ?? "")
    .replace(/(?<![\u0590-\u05FF])(?:את|אתה)\s+(מחפשת|מחפש|מעדיפה|מעדיף|מעוניינת|מעוניין|צריכה|צריך|רוצה)(?![\u0590-\u05FF])/gu, (_m, w) => TO_PLURAL[w] ?? ({ מחפש: "מחפשים", מעדיף: "מעדיפים", מעוניין: "מעוניינים", צריך: "צריכים" } as Record<string, string>)[w] ?? w)
    .replace(new RegExp(`(?<![\\u0590-\\u05FF])(ו?ש?|כש)(${PLURAL_WORDS.split("|").filter((w) => !["מחפשת", "מעדיפה", "מעוניינת", "צריכה", "מתלבטת", "רוצה"].includes(w)).join("|")})(?![\\u0590-\\u05FF])`, "gu"), (_m, v, w) => `${v}${TO_PLURAL[w]}`)
    // A participle opening a question to the customer ("מחפשת משהו חגיגי?").
    .replace(/(^|[.!?,]\s*)(מחפשת|מעדיפה|מעוניינת|מתלבטת)(?=[^.!?\n]*\?)/gu, (_m, p, w) => `${p}${TO_PLURAL[w]}`);
}

// An English sentence inside a Hebrew reply (eval 2026-11-17, twice). Four or more Latin words and
// no Hebrew, not a product's own title or a link.
export function foreignLanguageSentences(reply: string, titles: string[] = []): string[] {
  if (!/[֐-׿]/.test(reply ?? "")) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => {
    if (/[֐-׿]/.test(x) || /https?:\/\/|PRODUCT_\d+/i.test(x)) return false;
    if (titles.some((t) => t && x.toLowerCase().includes(t.toLowerCase()))) return false;
    return (x.match(/[A-Za-z]{2,}/g) ?? []).length >= 4;
  }).map((x) => x.trim());
}

// A payment or charge status stated with nothing behind it (prod replay 2026-11-17, Smoovee:
// "the cancelled order was not charged, you can order again" while its own team question on the
// charge was open). Backed only by a tool result this turn that carries payment data.
const PAYMENT_CLAIM = /(?<![֐-׿])(?:לא\s+(?:חויב|חויבת|חויבתם|חויבה|חויבו|נגבה|נגבו|ירד(?:\s+(?:לך|לכם))?\s+(?:כסף|חיוב)|נלקח\s+כסף)|החיוב\s+(?:בוטל|יבוטל|הוחזר|לא\s+עבר|לא\s+בוצע)|הכסף\s+(?:יוחזר|הוחזר|חזר|יחזור|יזוכה)|(?:יוחזר|הוחזר|יזוכה|זוכה|זיכינו|נזכה)\s+(?:לך|לכם|לחשבון|לכרטיס|בחזרה)|קיבלת\s+זיכוי|(?:תקבל|תקבלי|תקבלו)\s+(?:זיכוי|החזר)|אפשר\s+(?:להזמין|לבצע\s+הזמנה)\s+(?:שוב|מחדש))(?![֐-׿])|\b(?:(?:were|was|have|has|haven'?t|hasn'?t|weren'?t|wasn'?t)\s+(?:not\s+)?(?:been\s+)?charged|not\s+(?:been\s+)?charged|(?:the\s+)?charge\s+(?:was|has been|will be|is)\s+(?:cancelled|canceled|reversed|refunded|voided)|you(?:'ll| will)\s+(?:get|receive)\s+(?:a\s+|your\s+)?(?:refund|money back)|(?:has|have|was|were)\s+(?:been\s+)?refunded|you can (?:order|place (?:the|a new|another) order) again)\b/iu;
const PAYMENT_EVIDENCE = /refund|financial_status|date_paid|payment_status|transaction_id|chargeback|voided|"paid"|"total_refunded"|זיכוי|החזר כספי/i;
/** Payment or charge sentences that no tool result this turn backs. */
// Speculation about what happened to a payment ("maybe the approval did not become a charge"): never a
// fact, whatever a tool returned (prod replay 2026-11-17, Smoovee severe).
const PAYMENT_SPECULATION = /(?<![\u0590-\u05FF])[^.!?\n]{0,60}(?:חיוב|חויב|תשלום|אישור|עסקה|הזמנה)[^.!?\n]{0,40}(?:לכאורה|כביכול)|(?<![\u0590-\u05FF])(?:לכאורה|כביכול)[^.!?\n]{0,60}(?:חיוב|חויב|תשלום|אישור|עסקה|הזמנה)|(?<![\u0590-\u05FF])(?:לא\s+)?(?:אמור|אמורה|אמורים)\s+(?:לא\s+)?להיות\s+(?:(?:ה)?כפילות|(?:ה)?חיוב(?:\s+כפול)?|(?:ה)?תשלום\s+כפול)|\b(?:there\s+)?(?:should(?:n'?t| not)?|is(?:n'?t)? (?:supposed|meant) to)\s+(?:not\s+)?be\s+(?:a\s+)?(?:double|duplicate|second)\s+(?:charge|payment)|(?<![\u0590-\u05FF])(?:יכול\s+להיות|ייתכן|יתכן|אולי|כנראה|ככל\s+הנראה)\s+ש[^.!?\n]{0,70}(?:חיוב|חויב|תשלום|אישור\s+(?:ה)?(?:עסקה|אשראי|ויזה)|כסף|הזמנה\s+לא\s+נוצרה|לא\s+(?:הפך|הפכה|נהיה|נהייתה)\s+ל)|\b(?:maybe|perhaps|probably|it(?:'s| is) possible that|(?:the|your) (?:charge|payment|authori[sz]ation) (?:may|might))[^.!?\n]{0,70}(?:charge|payment|authori[sz]ation|order (?:was not|wasn'?t) created|never went through|did not (?:go through|become))/iu;
export function ungroundedPayment(reply: string, tools: ToolRunRecord[]): string[] {
  const sentences = String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? [];
  const speculation = sentences.filter((x) => PAYMENT_SPECULATION.test(x)).map((x) => x.trim().slice(0, 120));
  if (tools.some((t) => t.outcome === "ok" && PAYMENT_EVIDENCE.test(String(t.content ?? "")))) return speculation;
  return [...new Set([...sentences.filter((x) => PAYMENT_CLAIM.test(x)).map((x) => x.trim().slice(0, 120)), ...speculation])];
}
/**
 * A turn that may read orders (prod rating 2026-11-17, Tehila: on a "thanks" turn the engine looked up her
 * orders and volunteered one). The message asks about an order, a delivery, a payment, a return or a
 * cancellation; or it carries a number that can be an order's; or it answers our own ask for an order number.
 */
const ORDER_TURN_WORDS = /(?<![\u0590-\u05FF])[והשב]?(?:החזרה|להחזיר|החלפה|להחליף|ביטול|לבטל|חשבונית|קבלה|חיוב|חויב|חויבתי|תשלום|שילמתי|זיכוי|החזר)(?![\u0590-\u05FF])|\b(?:return|exchange|cancel|invoice|receipt|charge[ds]?|payment|paid|refund)\b/iu;
const ASKED_ORDER_NUMBER = /(?<![\u0590-\u05FF])(?:מספר\s+(?:ה)?הזמנה|מספר\s+ההזמנה)|\border\s+(?:number|#)/iu;
export function orderTurn(incoming: string, lastOutbound?: string | null): boolean {
  const t = String(incoming ?? "");
  if (ORDER_ASK.test(t) || ORDER_TURN_WORDS.test(t) || /(?<!\d)\d{4,8}(?!\d)/.test(t)) return true;
  return ASKED_ORDER_NUMBER.test(String(lastOutbound ?? ""));
}

export const PAYMENT_WORDS = /(?<![֐-׿])[וש]?(?:חיוב|חויב|חויבתי|תשלום|שילמתי|כסף|זיכוי|החזר|כרטיס\s+אשראי)(?![֐-׿])|\b(?:charge[ds]?|payment|paid|refund|money|credit card)\b/iu;

// A cancelled, failed or refunded order given as the customer's without its status (prod replay
// 2026-11-17): every number of an order marked inactive this turn must come with what it is.
const INACTIVE_WORDS = /(?<![֐-׿])[וש]?כ?(?:בוטל|בוטלה|מבוטל|מבוטלת|ביטול|הוחזר|הוחזרה|זוכה|נכשל|נכשלה|לא\s+פעיל|לא\s+פעילה)(?![֐-׿])|\b(?:cancel(?:l)?ed|refunded|failed|voided|inactive|not active)\b/iu;
function inactiveOrderNumbers(tools: ToolRunRecord[]): Set<string> {
  const out = new Set<string>();
  const walk = (v: any) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    if (v.inactive) for (const k of ["id", "number", "order_number", "name"]) { const d = String(v[k] ?? "").replace(/\D/g, ""); if (d.length >= 3) out.add(d); }
    for (const x of Object.values(v)) if (x && typeof x === "object") walk(x);
  };
  for (const t of tools) { try { walk(JSON.parse(String(t.content ?? ""))); } catch { /* not JSON */ } }
  return out;
}
/** The inactive order numbers this turn's tools returned (kept in the state for later turns). */
export const inactiveOrdersIn = (tools: ToolRunRecord[]) => [...inactiveOrderNumbers(tools)];
/** Sentences naming an inactive order's number (this turn's tools, or one known from an earlier turn) without saying it is cancelled, failed or refunded. */
export function unlabelledInactiveOrders(reply: string, tools: ToolRunRecord[], known: string[] = []): string[] {
  const nums = new Set([...inactiveOrderNumbers(tools), ...known]);
  if (!nums.size) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => (x.match(/\d{3,}/g) ?? []).some((d) => nums.has(d)) && !INACTIVE_WORDS.test(x)).map((x) => x.trim().slice(0, 120));
}

// Presenting as a named person who is not this employee (prod replay 2026-11-17, GOTCHA: "מתן",
// a real team member's name taken from the conversation). Only the configured name is the employee's.
const NAMED_SELF = /(?:קוראים\s+לי|שמי|my name is)\s+([֐-׿]{2,12}|[A-Z][a-z]{1,14})|(?:^|[.!?,]\s*|(?<![֐-׿])(?:היי|הי|שלום|אהלן)\s*,?\s*)(?:כאן|זה|זאת|זו)\s+([֐-׿]{2,12})(?=\s*(?:[,.!]|$|מ(?:ה)?צוות|מ-?\s*[֐-׿A-Za-z]{2,}))|\b(?:this is|i'?m|it'?s)\s+([A-Z][a-z]{1,14})(?=\s*(?:[,.!]|$|from\b))|(?<![֐-׿])אני\s+([֐-׿]{2,12})(?=\s+מ(?:ה)?צוות|\s*מ-\s*[֐-׿A-Za-z]{2,})|(?<![֐-׿])(?:זה|כאן)\s+([֐-׿]{2,12})(?=\s*(?:מ(?:ה)?צוות|מ-\s*[֐-׿A-Za-z]{2,}))/gu;
const NOT_A_NAME = new Set(["here", "sorry", "happy", "glad", "back", "sure", "afraid", "available", "the", "your", "נכון", "בסדר", "מעולה", "בדיוק", "הכל", "טוב", "אני", "אנחנו"]);
// A name's consonant skeleton across Hebrew and Latin ("דניאל" is "Daniel": d-n-l), so the
// configured name written in the other alphabet is still the employee's own.
const HE_SKELETON: Record<string, string> = { ב: "b", ג: "g", ד: "d", ז: "z", ח: "h", ט: "t", כ: "k", ך: "k", ל: "l", מ: "m", ם: "m", נ: "n", ן: "n", ס: "s", פ: "p", ף: "p", צ: "c", ץ: "c", ק: "k", ר: "r", ש: "s", ת: "t" };
export function nameSkeleton(name: string): string {
  const t = String(name ?? "").toLowerCase();
  if (/[\u0590-\u05FF]/.test(t)) return [...t].map((ch) => HE_SKELETON[ch] ?? "").join("");
  return t.replace(/ph/g, "p").replace(/ch|kh/g, "h").replace(/sh/g, "s").replace(/ts|tz/g, "c").replace(/[aeiouyhw]/g, "").replace(/f/g, "p").replace(/v/g, "b").replace(/[cq]/g, "k").replace(/x/g, "ks").replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1");
}
/** A name the reply gives itself that is not the employee's configured name (in either alphabet). */
export function wrongSelfName(reply: string, employeeName: string | null | undefined): string | null {
  const parts = String(employeeName ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const mine = new Set(parts);
  const skeletons = new Set(parts.map(nameSkeleton).filter((x) => x.length >= 2));
  for (const m of normalizeQuotes(String(reply ?? "")).matchAll(NAMED_SELF)) {
    const name = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim();
    if (!name || NOT_A_NAME.has(name.toLowerCase())) continue;
    if (mine.has(name.toLowerCase()) || skeletons.has(nameSkeleton(name).replace(/(.)\1+/g, "$1"))) continue;
    return name;
  }
  return null;
}

// A model the customer named, answered with a close name that is another model (prod replay
// 2026-11-17: "קריספי" answered with "קרמי"). Their distinguishing word must be in the product's
// title, or the reply must say it is a different, close option.
const ALTERNATIVE = /(?<![֐-׿])(?:דומה|דומים|קרוב|קרובה|במקום|חלופה|חלופי|אחר|אחרת|לא\s+(?:מצאתי|מצאנו|מוצא|מוצאים|נמצא)|אין\s+(?:לנו|כרגע)|בשם\s+הזה)(?![֐-׿])|\b(?:similar|closest|close (?:option|match)|instead|alternative|different (?:model|one)|not (?:found|by that name)|didn'?t find)\b/iu;
// Greetings are no noun (C pinned rating, Tehila: "היי מחפשת את הבובון" read "היי", and scarves came back).
const ASK_STOP = new Set(["היי", "הייי", "שלום", "אהלן", "הלו", "בוקר", "ערב", "טוב", "hey", "hello", "יש", "לכם", "לך", "אני", "מחפש", "מחפשת", "מחפשים", "רוצה", "רוצים", "צריך", "צריכה", "אפשר", "דגם", "דגמים", "מוצר", "מתאים", "מתאימה", "כמה", "עולה", "מחיר", "איזה", "איזו", "בבקשה", "תודה", "have", "want", "need", "looking", "model", "price", "does", "with", "please", "thanks"]);
const close = (w: string, a: string) => w !== a && !w.includes(a) && !a.includes(w) && w.length >= 3 && w.slice(0, 2) === a.slice(0, 2) && Math.abs(w.length - a.length) <= 3;
// "fits <Y>" / "מתאימה ל<Y>": the device or model the reply attributes the product to.
const FITS_TARGET = /(?<![\u0590-\u05FF])(?:מתאים|מתאימה|מתאימים|מתאימות|מיועד|מיועדת|תואם|תואמת)\s+ל([\u0590-\u05FF'"׳״-]+(?:\s+[\u0590-\u05FF'"׳״-]+)?)|\b(?:fits|suits|works with|is for|made for|compatible with)\s+(?:the\s+|a\s+|your\s+)?(\S+(?:\s+\S+)?)/giu;
/** The customer's distinguishing word that the named product's title lacks while a title word is close to it,
 * or that the reply's "fits <Y>" names as a close but different model. */
export function nearNameAsExact(reply: string, incoming: string, titles: string[]): { asked: string; shown: string } | null {
  if (ALTERNATIVE.test(reply ?? "")) return null;
  const theirs = (String(incoming ?? "").match(/\p{L}{4,}/gu) ?? []).filter((w) => !ASK_STOP.has(w.toLowerCase())).map((w) => stem(w));
  // The model the reply says the product fits (prod replay 2026-11-17: "קריספי" asked, "מתאימה לנינג'ה קרמי").
  for (const m of String(reply ?? "").matchAll(FITS_TARGET)) {
    const target = (String(m[1] ?? m[2] ?? "").match(/\p{L}{3,}/gu) ?? []).map((w) => stem(w));
    for (const a of theirs) {
      if (target.some((w) => w === a || w.includes(a) || a.includes(w))) continue;
      const hit = target.find((w) => close(w, a));
      if (hit) return { asked: a, shown: hit };
    }
  }
  if (!titles.length) return null;
  const named = titles.filter((t) => t && String(reply ?? "").toLowerCase().includes(String(t).toLowerCase().split(/\s+/).find((w) => w.length >= 3) ?? "\u0000"));
  for (const t of named) {
    const words = (String(t).match(/\p{L}{3,}/gu) ?? []).map((w) => stem(w));
    for (const a of theirs) {
      if (words.some((w) => w === a || w.includes(a) || a.includes(w))) continue;
      const close = words.find((w) => w.length >= 3 && w.slice(0, 2) === a.slice(0, 2) && Math.abs(w.length - a.length) <= 3 && String(reply ?? "").toLowerCase().includes(w));
      if (close) return { asked: a, shown: close };
    }
  }
  return null;
}

// The model says the message is a forwarded or automated notification (prod replay 2026-11-17):
// on an email channel that turn is automated mail, answered by no one.
export const MODEL_SAYS_AUTOMATED = /(?:נראה\s+ש(?:זו|זאת|זה|הדבקת|העתקת|שיתפת|העברת|קיבלת)\s+(?:לנו\s+)?(?:הודעה|התראה|מייל|הודעת|דוא["״]ל)|הודעה\s+אוטומטית|הודעת\s+מערכת)|\b(?:(?:it|this)\s+(?:looks|seems)\s+like\s+(?:an?\s+)?(?:automated|automatic|system|forwarded)\s+(?:message|email|notification)|(?:(?:it|this)\s+(?:seems|looks)\s+(?:like\s+)?(?:that\s+)?you(?:'ve|\s+have)?|you\s+(?:seem|appear)\s+to\s+have)\s+(?:forwarded|pasted|shared|copied)\s+(?:a|an|the|us\s+a|us\s+an)\s+(?:\w+\s+)?(?:notification|email|message|alert))/iu;

/**
 * Apostrophes and quotes as the patterns spell them (prod replay 2026-11-17: "I didn’t find a
 * snowboard" with a curly apostrophe matched no English pattern, so the absence went out
 * unchecked). Every check reads the text through this; the Hebrew geresh and gershayim too.
 */
export function normalizeQuotes(t: string): string {
  return String(t ?? "").replace(/[\u2018\u2019\u201A\u201B\u02BC\u2032\uFF07\u05F3`\u00B4]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033\uFF02\u05F4]/g, '"')
    // A hyphen in any of its forms, the Hebrew maqaf too ("מ־GOTCHA").
    .replace(/[\u05BE\u2010\u2011\u2212\uFE63\uFF0D]/g, "-");
}

// A stock or price claim about one option (a colour, a size, a model) backed only by the parent
// product (prod replay 2026-11-17, Smoovee: "black is in stock now", the parent read, black sold out).
const STOCK_WORDS = /(?<![֐-׿])[וש]?(?:במלאי|אזל|אזלה|אזלו|זמין|זמינה|זמינים|חזר\s+למלאי|חזרה\s+למלאי|יחזור\s+למלאי|יש\s+(?:לנו\s+)?(?:את\s+)?(?:ה)?)(?![֐-׿])|\b(?:in stock|out of stock|sold out|available|back in stock|restock\w*)\b/iu;
const OPTION_HE = /(?<![֐-׿])[וש]?ב?ה?(?:שחור|שחורה|לבן|לבנה|אדום|אדומה|כחול|כחולה|ירוק|ירוקה|צהוב|צהובה|ורוד|ורודה|סגול|סגולה|אפור|אפורה|חום|חומה|בז'|כתום|כתומה|זהב|זהוב|כסף|כסוף|תכלת|בורדו|נייבי|קרם|שמנת|מידה|מידת|צבע)(?![֐-׿])/u;
const OPTION_EN = /\b(?:black|white|red|blue|green|yellow|pink|purple|gr[ae]y|brown|beige|orange|gold|silver|navy|cream|size|colou?r)\b/i;
const OPTION_SIZE = /\b(?:XS|S|M|L|XL|XXL|\d{2}(?:\.\d)?\s?(?:cm|eu|us|EU|US))\b/;
const OPTION_WORDS = { test: (t: string) => OPTION_HE.test(t) || OPTION_EN.test(t) || OPTION_SIZE.test(t) };
const VARIATION_TOOL = /variation|variant/i;
/** Sentences claiming stock or a price for one option when no variation data was read this turn. */
const OPTION_COLOURS: Array<[string, string]> = [["שחור", "black"], ["לבן", "white"], ["אפור", "grey"], ["אפור", "gray"], ["כחול", "blue"], ["נייבי", "navy"], ["אדום", "red"], ["ירוק", "green"], ["ורוד", "pink"], ["חום", "brown"], ["בז'", "beige"], ["חול", "sand"], ["צהוב", "yellow"], ["סגול", "purple"], ["כתום", "orange"]];
export function optionClaimsWithoutVariations(reply: string, incoming: string, tools: ToolRunRecord[]): string[] {
  if (!OPTION_WORDS.test(incoming ?? "")) return [];
  // Variation data this turn: a variation read, or a product read that carries its variants with stock.
  const read = tools.some((t) => t.outcome === "ok" && (VARIATION_TOOL.test(t.tool) || /"variants?"\s*:\s*\[\s*\{[^\]]*(?:available|inventory|stock)/i.test(String(t.content ?? ""))));
  if (read) return [];
  // The product's own read lists the option ("Color: Black, Sand"): "בשחור יש את X" says it exists, which that read
  // grounds; only a stock claim (במלאי, אזל, in stock) still needs the variations (dev live round on dcf2158e).
  // Per product: only the read of the product the sentence names grounds it (the read of another product listing Black
  // never grounds "בשחור יש את X"); with no product named, only when a single product was read.
  const reads = tools.filter((t) => t.outcome === "ok" && /get_product/i.test(t.tool));
  const nameOf = (t: ToolRunRecord) => String(/"(?:name|title)"\s*:\s*"([^"]+)"/.exec(String(t.content ?? ""))?.[1] ?? "").toLowerCase();
  const readsFor = (x: string) => {
    const lx = x.toLowerCase();
    // Every word of the product's name, from 3 letters ("Zip Hoodie" needs "zip" too, never "hoodie" alone).
    const named = reads.filter((t) => { const n = nameOf(t); const ws = n.split(/\s+/).filter((w) => w.length >= 3); return !!n && (lx.includes(n) || (ws.length > 0 && ws.every((w) => lx.includes(w)))); });
    return named.length ? named : new Set(reads.map(nameOf)).size === 1 ? reads : [];
  };
  const optionListed = (x: string) => { const text = readsFor(x).map((t) => String(t.content ?? "")).join("\n").toLowerCase(); return !!text && OPTION_COLOURS.some(([he, en]) => new RegExp(`(?<![\\u0590-\\u05FF])[בהו]?${he}`, "u").test(x) && (new RegExp(`\\b${en}\\b`).test(text) || text.includes(he))); };
  const stockClaim = (x: string) => /(?<![\u0590-\u05FF])[וש]?(?:במלאי|אזל|אזלה|אזלו|חזר\s+למלאי|יחזור\s+למלאי)(?![\u0590-\u05FF])|\b(?:in stock|out of stock|sold out|back in stock)\b/iu.test(x);
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => STOCK_WORDS.test(x) && OPTION_WORDS.test(x) && !/\?\s*$/.test(x.trim()) && !(optionListed(x) && !stockClaim(x))).map((x) => x.trim().slice(0, 120));
}

// A payment or checkout failure is a support case, never a product list (prod replay 2026-11-17:
// "לא מצליח לשלם עם ביימי" answered with product cards).
const PAY_PROBLEM = /(?<![֐-׿])(?:לא\s+(?:מצליח|מצליחה|מצליחים|הצלחתי|הצלחנו|עובר|עובד|עבר|עבד)\s+(?:לשלם|התשלום|לבצע\s+(?:את\s+ה)?תשלום|להזמין|לסיים\s+(?:את\s+ה)?הזמנה)|התשלום\s+(?:לא\s+(?:עובר|עבר|עובד|מצליח)|נכשל|נדחה)|(?:ה)?כרטיס\s+(?:נדחה|לא\s+עובר)|נדחה\s+בתשלום|שגיאה\s+ב(?:תשלום|קופה))(?![֐-׿])|\b(?:can'?t (?:pay|check ?out|complete (?:the |my )?(?:order|payment|purchase))|payment (?:failed|declined|(?:is|was) declined|doesn'?t go through|won'?t go through|error)|card (?:was )?declined|checkout (?:error|fails|failed|isn'?t working))\b/iu;
export const paymentProblem = (incoming: string) => PAY_PROBLEM.test(normalizeQuotes(incoming ?? ""));
/** Products may answer this message: it is no support case (a payment problem, an order, a complaint). */
// "How do I...", "how to..." (not "how do I order", a purchase).
const HOW_TO = /(?<![\u0590-\u05FF])(?:איך|כיצד)\s+(?:אני\s+|אפשר\s+|ניתן\s+)?(?!(?:מזמינים|להזמין|קונים|לקנות|רוכשים))[\u0590-\u05FF]{2,}|\bhow (?:do|can|should) (?:i|we|you) (?!order|buy|purchase)\w+|\bhow to (?!order|buy|purchase)\w+/iu;
// A product named to be found: the product words, a purchase, or "יש <noun>?".
const NAMES_A_PRODUCT = /^\s*(?:היי[,!\s]*|שלום[,!\s]*)?יש\s+(?:לכם\s+|לך\s+)?(?!(?:עדכון|חדש|חדשות|תשובה|בעיה|אפשרות|מבצע|קופון|קוד|משלוח|החזר|זמן)(?![\u0590-\u05FF]))[\u0590-\u05FF]{3,}/u;
export function productAskNow(incoming: string): boolean {
  // Products answer a product ask only: never a support case (payment, an order of theirs, a complaint),
  // a policy or coupon question, or a how-to (prod replay 2026-11-17: the list replaced a policy answer).
  const t = normalizeQuotes(incoming ?? "");
  // A video or tutorial ask is no product ask, whatever its shape ("יש לכם סרטון הדרכה לכביסה?", dev live round on b369e939).
  if (PAY_PROBLEM.test(t) || MY_ORDER.test(t) || STRONG_CASE.test(t) || COUPON_ASK.test(t) || HOW_TO.test(t) || videoAsk(t)) return false;
  return PRODUCT_WANT.test(t) || PURCHASE.test(t) || PRODUCT_ASK.test(t) || NAMES_A_PRODUCT.test(t) || /\bhow (?:do|can) (?:i|we) (?:order|buy|purchase)\b/i.test(t);
}

// "There is no order / it cannot be located" said without the customer's own order lookup this turn
// (prod replay 2026-11-17, Smoovee severe: two turns later a lookup by their number found it).
const ORDER_ABSENCE = /(?<![֐-׿])(?:אין\s+(?:לנו\s+|לי\s+)?(?:מספר\s+)?הזמנה|לא\s+(?:ניתן|נוכל|אפשר|מצאנו|מצאתי|נמצאה|נמצא)\s+(?:לאתר\s+|למצוא\s+)?(?:את\s+)?(?:ה)?הזמנה|לא\s+(?:ניתן|נוכל|אפשר)\s+לאתר|ההזמנה\s+לא\s+(?:נמצאה|קיימת|מופיעה)|אין\s+הזמנה\s+(?:על|ב|רשומה))(?![֐-׿])|\b(?:(?:we|i)\s+(?:can'?t|cannot|couldn'?t|could not)\s+(?:find|locate)\s+(?:an?|your|the|any)\s+order|no order (?:was )?(?:found|under|on)|there(?:'s| is) no order)\b/iu;
const ORDER_LOOKUP_TOOL = /(?:list_customer_orders|get_customer_orders|find_latest_order|get_orders|search_orders|get_order|order_lookup|list_orders)$/;
/** Order-absence sentences with no order lookup this turn. */
export function ungroundedOrderAbsence(reply: string, tools: ToolRunRecord[]): string[] {
  // An empty lookup backs "no order"; one that FOUND orders contradicts it (prod replay 2026-11-17:
  // "no order was created" while the lookup found 97858, cancelled). Only no lookup at all, or found orders, flag it.
  const lookups = tools.filter((t) => ORDER_LOOKUP_TOOL.test(t.tool));
  if (lookups.some((t) => t.outcome === "empty") && !lookups.some((t) => t.outcome === "ok")) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => ORDER_ABSENCE.test(x)).map((x) => x.trim().slice(0, 120));
}
// "Per the terms" as the reason not to help (the same Smoovee turn): never the answer.
const TERMS_REFUSAL = /(?<![֐-׿])(?:(?:לפי|על\s+פי|בהתאם\s+ל)\s*(?:ה)?(?:תקנון|תנאים|תנאי\s+(?:ה)?שימוש|מדיניות))[^.!?\n]{0,60}(?:לא\s+(?:ניתן|נוכל|אפשר)|אין\s+אפשרות|אי\s+אפשר)|(?:לא\s+(?:ניתן|נוכל|אפשר)|אין\s+אפשרות|אי\s+אפשר)[^.!?\n]{0,60}(?:לפי|על\s+פי|בהתאם\s+ל)\s*(?:ה)?(?:תקנון|תנאים|תנאי\s+(?:ה)?שימוש)(?![֐-׿])|\b(?:(?:per|according to|under) (?:our|the) (?:terms|policy)[^.!?\n]{0,60}(?:can'?t|cannot|unable|not able)|(?:can'?t|cannot|unable)[^.!?\n]{0,60}(?:per|according to|under) (?:our|the) terms)\b/iu;
export const termsRefusal = (reply: string) => TERMS_REFUSAL.test(reply ?? "");

// A qualifier the customer gave that some of this turn's products carry: the reply names only those
// (prod replay 2026-11-17, NE'A: "fair skin" answered with four shades, Medium Dark among them).
/** Titles the reply names that lack the customer's qualifier while other named ones carry it. */
export function notNarrowed(reply: string, incoming: string, titles: string[]): string[] {
  const named = titles.filter((t) => t && String(reply ?? "").toLowerCase().includes(String(t).toLowerCase()));
  if (named.length < 2) return [];
  const asked = contentStems(incoming).filter((w) => w.length >= 3);
  const holds = (t: string) => asked.filter((w) => contentStems(t).some((x) => x === w || (w.length >= 4 && (x.includes(w) || w.includes(x)))));
  const withQ = named.filter((t) => holds(t).length > 0);
  if (!withQ.length || withQ.length === named.length) return [];
  return named.filter((t) => !holds(t).length);
}

// "We got the photo" with no photo, video or file in the customer's last messages (prod replay 2026-11-17).
const GOT_MEDIA = /(?<![\u0590-\u05FF])(?:קיבלנו|קיבלתי|ראינו|ראיתי|תודה\s+על)\s+(?:את\s+)?(?:ה)?(?:תמונה|תמונות|צילום|צילומים|סרטון|קובץ|מסמך)(?![\u0590-\u05FF])|(?<![\u0590-\u05FF])(?:ה)?(?:תמונה|תמונות|צילום|צילומים|סרטון|קובץ|מסמך)\s+(?:התקבל|התקבלה|התקבלו|הגיע|הגיעה|הגיעו)(?![\u0590-\u05FF])|\b(?:the |your )?(?:photo|picture|image|video|file|document)s? (?:came through|arrived|(?:was|were|has been|have been) received)\b|\b(?:(?:we|i)(?:'ve| have)? (?:got|received|seen) (?:the|your) (?:photo|picture|image|video|file|document)s?|thanks for the (?:photo|picture|image|video|file)s?)\b/iu;
const MEDIA_SENT = /\[(?:image|photo|video|voice|audio|document|file|sticker|תמונה|סרטון|הודעה קולית|מסמך|קובץ)[^\]]*\]|(?:^|\s)(?:IMG|VID|DOC)[-_]\d/iu;
/** Sentences claiming a photo or file came when none of the customer's last three messages carried one. */
export function claimsAttachment(reply: string, recentInbound: string[]): string[] {
  if (recentInbound.slice(-3).some((m) => MEDIA_SENT.test(String(m ?? "")))) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => GOT_MEDIA.test(x)).map((x) => x.trim().slice(0, 120));
}

// The employee as "the assistant" with no name (prod replay 2026-11-17, GOTCHA: "זה העוזר של GOTCHA" for Daniel).
const NAMELESS_SELF = /(?<![\u0590-\u05FF])(?:זה|כאן|אני)\s+ה(?:עוזר|עוזרת|נציג|נציגה|בוט)(?:\s+ה?(?:דיגיטלי|דיגיטלית|וירטואלי|וירטואלית|החכם|החכמה))?\s+(?:של|מ-?)|\b(?:this is|i'?m|i am)\s+(?:the\s+|your\s+)?(?:ai\s+|virtual\s+|digital\s+)?assistant\s+(?:of|from|at)\b/iu;
const NAMELESS_SELF_G = /(?<![\u0590-\u05FF])(זה|כאן|אני)\s+ה(?:עוזר|עוזרת|נציג|נציגה|בוט)(?:\s+ה?(?:דיגיטלי|דיגיטלית|וירטואלי|וירטואלית|החכם|החכמה))?\s+(?:של|מ-?)\s*/gu;

// A clarifying question offering an option the customer already gave (live 2026-11-17, NE'A: "face
// tint" asked back as "for the face or the lips?").
/** Question sentences "X or Y?" one of whose options the customer's own message already names. */
export function asksKnown(reply: string, incoming: string): string[] {
  const mine = new Set(contentStems(incoming).filter((w) => w.length >= 3));
  if (!mine.size) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n])+\?/g) ?? []).filter((q) => {
    const parts = q.split(/\s+(?:או|or)\s+/iu);
    if (parts.length < 2) return false;
    // The options themselves: the word right before "or" and what follows it (a shared head, "טינט", is not an option).
    const before = (parts.at(-2) ?? "").trim().split(/\s+/).slice(-1).join(" ");
    const after = (parts.at(-1) ?? "").replace(/\?.*$/, "").trim().split(/\s+/).slice(-2).join(" ");
    const head = new Set(contentStems((parts.at(-2) ?? "").trim().split(/\s+/).slice(0, -1).join(" ")));
    const opts = [before, after].map((p) => contentStems(p).filter((w) => !head.has(w)));
    return opts.some((o) => o.some((w) => mine.has(w) || [...mine].some((m) => m.length >= 4 && (m.includes(w) || w.includes(m)))));
  }).map((q) => q.trim());
}

// "One product that fits..." with no product named (live 2026-11-17, NE'A): a recommendation names it.
const UNNAMED_PICK = /(?<![֐-׿])(?:מוצר|פריט|דגם)\s+(?:אחד\s+)?ש?(?:מתאים|יתאים|מתאימה|עונה)|\b(?:one|a) (?:product|item|option|model) that (?:fits|suits|works|matches)\b/iu;
/** The reply recommends a product by description, naming none of this turn's products. */
// A pick by its kind with no name (rating 7af7c6d7, Smoovee: "משטח הזזה עם גלגלים" is what fits, no title).
const PICK_WORDS = /(?<![\u0590-\u05FF])(?:הכי\s+מתאים|הכי\s+מתאימה|מתאים|מתאימה|יתאים|תתאים|מומלץ|מומלצת|ממליץ|ממליצה|ממליצים|אמליץ|הייתי\s+(?:ממליץ|ממליצה|הולך|הולכת))(?![\u0590-\u05FF])|\b(?:fits|suits|recommend|best (?:option|choice) (?:is|would be)|i'?d go with)\b/iu;
/**
 * The reply names one of the products: its title, or a word of it that tells it apart (rating 93f9fdff,
 * Smoovee: "אליס" for "סמובי אליס 35*28"). A word every title shares (the brand "סמובי") tells none apart.
 */
export function namesCandidate(reply: string, titles: string[]): boolean {
  const t = String(reply ?? "").toLowerCase();
  const list = titles.map((x) => String(x ?? "").toLowerCase().trim()).filter(Boolean);
  if (!list.length) return false;
  const wordsOf = (x: string): string[] => [...(x.match(/\p{L}{3,}/gu) ?? [])];
  const shared = list.length > 1 ? new Set(wordsOf(list[0]).filter((w) => list.every((x) => wordsOf(x).includes(w)))) : new Set<string>();
  const inReply = new Set(wordsOf(t));
  return list.some((x) => t.includes(x) || wordsOf(x).some((w) => !shared.has(w) && inReply.has(w)));
}
/** The titles the text names, each by its full title or a word that tells it apart from the others. */
export function namedTitles(text: string, titles: string[]): string[] {
  const t = String(text ?? "").toLowerCase();
  const list = titles.map((x) => String(x ?? "").toLowerCase().trim());
  const wordsOf = (x: string): string[] => [...(x.match(/\p{L}{3,}/gu) ?? [])];
  const nonEmpty = list.filter(Boolean);
  const shared = nonEmpty.length > 1 ? new Set(wordsOf(nonEmpty[0]).filter((w) => nonEmpty.every((x) => wordsOf(x).includes(w)))) : new Set<string>();
  const inText = new Set(wordsOf(t));
  return titles.filter((_, i) => list[i] && (t.includes(list[i]) || wordsOf(list[i]).some((w) => !shared.has(w) && inText.has(w))));
}
export function unnamedRecommendation(reply: string, titles: string[]): boolean {
  // "One product that fits is..." must name the product itself: its title or the title's first two words.
  const t = String(reply ?? "").toLowerCase();
  const strictlyNamed = titles.some((x) => {
    const low = String(x ?? "").toLowerCase().trim();
    if (!low) return false;
    const head = low.split(/\s+/).slice(0, 2).join(" ");
    return t.includes(low) || (head.split(" ").length === 2 && t.includes(head));
  });
  if (UNNAMED_PICK.test(reply ?? "")) return !strictlyNamed;
  if (strictlyNamed || namesCandidate(reply, titles)) return false;
  // There are products this turn, the reply recommends one, and it names none of them.
  // A statement that picks ("X is the one that fits"), not a question asking whether it fits ("מתאים לך?").
  const statements = (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => !/[?؟]\s*$/.test(x));
  return titles.filter(Boolean).length > 0 && statements.some((x) => PICK_WORDS.test(x));
}

/**
 * A product said to fit a device other than the customer's (prod replay 2026-11-17, Smoovee: asked for a
 * Ninja Crispi, offered one that "fits the Ninja Slushi" with a link). The target shares the customer's
 * brand word but lacks their model word and names another: that sentence is cut.
 */
export function deviceMismatch(reply: string, incoming: string, grounding = ""): string[] {
  const theirs = (String(incoming ?? "").match(/\p{L}{3,}/gu) ?? []).filter((w) => !ASK_STOP.has(w.toLowerCase())).map((w) => stem(w));
  if (theirs.length < 2) return [];
  const out: string[] = [];
  for (const x of String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []) {
    for (const m of x.matchAll(FITS_TARGET)) {
      const target = (String(m[1] ?? m[2] ?? "").match(/\p{L}{3,}/gu) ?? []).map((w) => stem(w));
      const shared = target.filter((w) => theirs.some((a) => a === w || (a.length >= 4 && (a.includes(w) || w.includes(a)))));
      const missing = theirs.filter((a) => !target.some((w) => w === a || (a.length >= 4 && (a.includes(w) || w.includes(a)))));
      const other = target.filter((w) => !shared.includes(w));
      void grounding;
      if (shared.length && missing.length && other.length) { out.push(x.trim().slice(0, 120)); break; }
    }
  }
  return out;
}

export interface Gate3Input {
  /** The turn's products with their own prices (the named-product price check, 2026-11-18). */
  candidates?: Array<{ title?: string; price?: unknown; discount?: { was?: unknown; now?: unknown } | null }>;
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
  /** Everything the business sent recently (cards, links, buttons included), for "we never said that" checks. */
  earlierOutboundText?: string;
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
  /** Inactive (cancelled, failed, refunded) order numbers seen in earlier turns of this conversation. */
  knownInactiveOrders?: string[];
  /** This turn's products with their store prices (the store wins over a document's price). */
  candidatePrices?: Array<{ title: string; price?: number | null }>;
  /** The customer came back on the subject of an open team item. */
  onOpenItem?: boolean;
  /** The open team items' text (state.pending), for a payment question already being checked. */
  openTeamText?: string;
  /** The customer's own messages, and everything else a fact may come from (tools, knowledge, a person, the state). */
  customerText?: string;
  sourceText?: string;
}

export function gate3(input: Gate3Input): Gate3Verdict {
  const problems: ClaimProblem[] = [];
  // Every pattern reads ASCII quotes: the reply, the customer's words, what the business said.
  const i: Gate3Input = { ...input, reply: normalizeQuotes(input.reply), incomingMessage: normalizeQuotes(input.incomingMessage), recentInbound: input.recentInbound?.map(normalizeQuotes), previousBotReplies: input.previousBotReplies?.map(normalizeQuotes), customerText: input.customerText == null ? input.customerText : normalizeQuotes(input.customerText) };
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
    ...unbackedRecords(reply, i.tools),
  ];
  if (unbacked.length) problems.push({ kind: "unsupported_action", claims: [...new Set(unbacked)] });
  const absent = ungroundedAbsence(reply, i.tools, i.knowledge ?? "");
  absent.push(...ungroundedOrderAbsence(reply, i.tools).filter((x) => !absent.includes(x)));
  absent.push(...contradictsEarlier(reply, [...(i.previousBotReplies ?? []), i.earlierOutboundText ?? ""]).filter((x) => !absent.includes(x)));
  absent.push(...deniesKnownLink(reply, `${i.grounding ?? ""}\n${i.knowledge ?? ""}`).filter((x) => !absent.includes(x)));
  absent.push(...nameMissUnasked(reply, i.incomingMessage).filter((x) => !absent.includes(x)));
  // "Not on file" about something the knowledge does mention (prod replay 12: pickup "בתיאום מראש").
  absent.push(...infoDeniedButKnown(reply, `${i.knowledge ?? ""}\n${i.grounding ?? ""}`));
  // "The address is not in my details" while the prompt gives one (prod replay 10, Tehila).
  if (i.businessAddress) absent.push(...addressDenied(reply));
  // A caveat that limits a claim ("אין במידע אישור לשימוש מתחת לעיניים") is never cut as an absence: cutting it turns
  // the rest into the claim (prod replay of 9480dfb2, NE'A).
  const claimedAbsent = absent.filter((x) => !caveatHolds(x, `${i.knowledge ?? ""}\n${i.grounding ?? ""}\n${i.tools.map((t) => String(t.content ?? "")).join("\n")}`));
  if (claimedAbsent.length) problems.push({ kind: "ungrounded_absence", claims: claimedAbsent });

  // A fit or size ask: the business's device or size table answers it (rating 93f9fdff, Smoovee).
  if (gaveUpSearch(reply, i.tools, i.incomingMessage, !!i.teamQuestion, i.knowledge ?? "")) problems.push({ kind: "gave_up_search", ...(knowledgeAnswersIt(reply, i.incomingMessage, !!i.teamQuestion, i.knowledge ?? "") || FIT_ASK.test(i.incomingMessage ?? "") ? { fromKnowledge: true } : {}) });
  else if (unreadProduct(reply, i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion)) problems.push({ kind: "unread_product" });
  else if (unreadBusinessInfo(reply, i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion)) problems.push({ kind: "unread_knowledge" });
  // "Still with the team" about a coupon or policy: the general answer is in the knowledge (prod replay 11: 3 times).
  else if (unreadKnowledge(i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion || (!!i.teamAlreadyOpen && TEAM_LINE.test(reply)))) problems.push({ kind: "unread_knowledge" });
  else if (unreadOrder(reply, i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion)) problems.push({ kind: "unread_order" });
  else if (unreadKnowledge(i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion)) problems.push({ kind: "unread_knowledge" });
  if (needlessHandoff(i.handoff, i.recentInbound ?? [i.incomingMessage], !!i.toolsNeedPerson)) problems.push({ kind: "needless_handoff" });
  // Products this turn mean a search ran.
  const recommendUnsearched = ASKS_RECOMMEND.test(i.incomingMessage ?? "") && i.toolsOffered.some((n) => /list_products|search_products/i.test(n)) && !i.tools.some((t) => /list_products|search_products|get_product/i.test(t.tool));
  if (!i.candidateCount && (recommendUnsearched || photoInsteadOfSearch(reply, i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion) || purchaseWithoutSearch(i.incomingMessage, i.tools, i.toolsOffered)
    // A text channel: products named from the knowledge alone get no name, price or link (prod replay 11).
    || (!i.cardsChannel && namesProductsUnsearched(reply, i.incomingMessage, i.tools, i.toolsOffered))
    // Any channel: "יש כמה מטפחות..." or "נחפש..." with no store read this turn (rating of dcf2158e, Tehila: three
    // turns about a scarf with the knowledge searched only; on cards channels nothing flagged them).
    || claimsOrPromisesUnsearched(reply, i.incomingMessage, i.tools, i.toolsOffered, { grounding: i.grounding, knowledge: i.knowledge }))) problems.push({ kind: "no_search" });
  if (i.searchFailed && i.teamQuestion && knowledgeHasIt(i.incomingMessage, i.knowledge ?? "")) problems.push({ kind: "knowledge_has_it" });
  // A bare team line to an information question the retrieved knowledge speaks to (dev round k3 on b3d2bbf3: "מה
  // אפשרויות התשלום?" went to the team with the payment methods in the knowledge).
  // With or without a team question: the model may write the team line as its reply and leave team_question empty
  // (dev round k5 on 0b5f2b46).
  else if (bareTeamLine(reply) && infoQuestion(i.incomingMessage) && !productAskNow(i.incomingMessage ?? "") && knowledgeSpeaksTo(i.incomingMessage, i.knowledge ?? "")) problems.push({ kind: "knowledge_has_it" });
  if (couponSourceMissed(i.incomingMessage, reply, [...(i.recentInbound ?? []).slice(-4, -1), ...(i.previousBotReplies ?? []).slice(-2)].join("\n"))) problems.push({ kind: "coupon_source" });
  if (namelessProducts(reply, i.incomingMessage, i.cards, i.candidateTitles ?? [], !!i.listAppended)) problems.push({ kind: "nameless_products" });
  const tips = unsafeTips(reply, i.knowledge ?? "", !!i.safety);
  if (tips.length) problems.push({ kind: "unsafe_tip", claims: tips });
  const echoed = i.customerText != null ? echoedSizes(reply, i.customerText, i.sourceText ?? "", i.candidateTitles ?? []) : [];
  if (echoed.length) problems.push({ kind: "echoed_size", claims: echoed });
  const numbers = ungroundedNumbers(reply, [i.grounding, i.sourceText ?? "", i.customerText ?? i.incomingMessage, i.knowledge ?? "", i.businessAddress ?? ""].join("\n"));
  if (numbers.length) problems.push({ kind: "ungrounded_number", claims: numbers });
  // Her payment card: when her messages speak of her card or a payment, a BARE "בכרטיס" in a reply sentence is that card
  // (pre-check of 51d0273e: "אישור בכרטיס לא בהכרח אומר שההזמנה הושלמה."). Per sentence: one that names the product
  // card or points at one ("כרטיס המוצר", "הכרטיסים", "בכרטיס ... למטה/הראשון") stays a card reference.
  const pictures = cardReferences(reply, !!i.cardsChannel && i.cards.length > 0).filter((x) => !(herCardTalk(i) && barePaymentCard(x)));
  if (pictures.length) problems.push({ kind: "card_reference", claims: pictures });
  const dangling = danglingReferences(reply, (!!i.cardsChannel && i.cards.length > 0) || !!i.listAppended, i.incomingMessage ?? "").filter((x) => !pictures.includes(x));
  if (dangling.length) problems.push({ kind: "dangling_reference", claims: dangling });
  if (noRecommendation(reply, i.incomingMessage, i.candidateCount, i.recentInbound ?? [], (i.previousBotReplies ?? []).at(-1) ?? "", i.candidateTitles ?? [])) problems.push({ kind: "no_recommendation" });
  const payment = ungroundedPayment(reply, i.tools);
  if (payment.length) problems.push({ kind: "ungrounded_payment", claims: payment, teamOpen: !!i.openTeamText && PAYMENT_WORDS.test(i.openTeamText) });
  const inactive = unlabelledInactiveOrders(reply, i.tools, i.knownInactiveOrders ?? []);
  if (inactive.length) problems.push({ kind: "inactive_order_unlabelled", claims: inactive });
  const source = ungroundedSource(i.incomingMessage, reply, [...(i.recentInbound ?? []).slice(-4, -1), ...(i.previousBotReplies ?? []).slice(-2)].join("\n"), i.knowledge ?? "");
  if (source.length) problems.push({ kind: "ungrounded_source", claims: source });
  const priceClash = priceAgainstStore(reply, i.candidatePrices ?? [], i.tools, i.toolsOffered.some((n) => /(?:^|\.)(?:list_products|search_products)$/.test(n)));
  if (priceClash.length) problems.push({ kind: "price_against_store", claims: priceClash });
  const orderState = orderStateWithoutLookup(reply, i.tools);
  if (orderState.length) problems.push({ kind: "order_state_unread", claims: orderState });
  const media = claimsAttachment(reply, i.recentInbound ?? [i.incomingMessage]);
  if (media.length) problems.push({ kind: "claims_attachment", claims: media });
  const optionClaims = optionClaimsWithoutVariations(reply, i.incomingMessage, i.tools);
  if (optionClaims.length) problems.push({ kind: "option_without_variation", claims: optionClaims });
  const extra = notNarrowed(reply, i.incomingMessage, i.candidateTitles ?? []);
  if (extra.length) problems.push({ kind: "not_narrowed", extra });
  if (unnamedRecommendation(reply, i.candidateTitles ?? [])) problems.push({ kind: "unnamed_recommendation" });
  if (partialReturnPolicy(reply, i.incomingMessage, i.knowledge ?? "")) problems.push({ kind: "partial_return_policy" });
  const mismatch = deviceMismatch(reply, i.incomingMessage, i.grounding ?? "");
  const negFit = ungroundedNegativeFit(reply, i.incomingMessage, i.candidateTitles ?? [], i.grounding ?? "");
  const posFit = ungroundedPositiveFit(reply, i.incomingMessage, i.candidateTitles ?? [], i.grounding ?? "", i.knowledge ?? "");
  if (posFit.length) problems.push({ kind: "ungrounded_positive_fit", claims: posFit } as any);
  const wrongType = wrongProductType(reply, i.incomingMessage, i.candidateTitles ?? []);
  if (negFit.length) problems.push({ kind: "ungrounded_negative_fit", claims: negFit, fits: fittingBySize(i.incomingMessage, i.candidateTitles ?? []).slice(0, 3) } as any);
  if (mismatch.length) problems.push({ kind: "device_mismatch", claims: mismatch });
  // An attribute nothing states, a price that is another product's (prod 2026-11-18).
  const derived = derivedMeasure(reply, `${i.grounding ?? ""}\n${i.knowledge ?? ""}`);
  if (derived.length) problems.push({ kind: "derived_measure", claims: derived } as any);
  const attr = ungroundedAttribute(reply, `${i.grounding ?? ""}\n${i.knowledge ?? ""}\n${(i.candidateTitles ?? []).join("\n")}`, i.incomingMessage, i.candidateTitles ?? []);
  if (attr.length) problems.push({ kind: "ungrounded_attribute", claims: attr } as any);
  const otherPrice = priceOfOtherProduct(reply, i.candidates ?? []);
  if (otherPrice.length) problems.push({ kind: "price_of_other_product", claims: otherPrice } as any);
  const near = nearNameAsExact(reply, i.incomingMessage, i.candidateTitles ?? []);
  if (near) problems.push({ kind: "near_name", asked: near.asked, shown: near.shown });
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
  // card_narration is dropped only when every card mention in the reply is a bare payment-card one.
  if (herCardTalk(i)) {
    const cardSentences = (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n])+[.!?]*/g) ?? []).filter((x) => /כרטיס|\bcards?\b/iu.test(x));
    if (cardSentences.length && cardSentences.every(barePaymentCard)) { const k = style.indexOf("card_narration"); if (k >= 0) style.splice(k, 1); }
  }
  if (i.locale === "he") for (const [code, re] of V2_BANS_HE) if (re.test(reply)) style.push(code);
  for (const [code, re] of V2_BANS_ANY) if (re.test(reply)) style.push(code);
  if (simulationLeak(reply, `${i.knowledge ?? ""}\n${i.grounding ?? ""}`)) style.push("simulation_leak");
  if (foreignScript(reply, i.customerText ?? i.incomingMessage)) style.push("foreign_script");
  if (internalJargon(reply)) style.push("internal_jargon");
  if (INTERNAL_REASONING.test(reply ?? "")) style.push("internal_reasoning");
  if (TOOL_TALK.test(reply ?? "")) style.push("tool_talk");
  if (failureNarration(reply)) style.push("failure_narration");
  if (i.locale === "he" && BROKEN_HE.test(reply)) style.push("broken_hebrew");
  if (ODD_HEDGE.test(reply)) style.push("odd_hedge");
  // Unless the business itself says so (its own warning, quoted).
  if (AFFIRMS_UNSAFE.test(reply) && !/מסוכנ|לא\s+בטיחותי|unsafe|dangerous/iu.test(i.knowledge ?? "")) style.push("affirms_unsafe");
  if (i.locale === "he" && (i.candidateCount > 0 || i.cards.length > 0) && new RegExp(STATEMENT_Q.source, "u").test(reply)) style.push("statement_question");
  if (repeatedAsk(reply, i.previousBotReplies ?? [])) style.push("repeated_ask");
  if (nearDuplicate(reply, i.previousBotReplies ?? [])) style.push("near_duplicate");
  else if (repeatedSentences(reply, i.previousBotReplies ?? []).length) style.push("repeated_sentence");
  if (repeatedAdvice(reply, i.previousBotReplies ?? [], i.incomingMessage).length) style.push("repeated_advice");
  if (wrongSelfName(reply, i.employeeName)) style.push("wrong_identity");
  if (asksKnown(reply, i.incomingMessage).length) style.push("asks_known");
  if (wrongType) style.push("wrong_product_type");
  // Products this turn: several items asked, some never answered (a mixer, a toaster, a blender).
  if (i.candidateCount > 0 && unansweredItems(reply, i.incomingMessage).length) style.push("unanswered_items");
  if (orderNumberDiffers(reply, i.incomingMessage).length) style.push("order_number_differs");
  if (i.employeeName && NAMELESS_SELF.test(reply)) style.push("nameless_self");
  if (returnsWork(reply)) style.push("returns_work");
  if (termsRefusal(reply)) style.push("terms_refusal");
  if (i.locale === "he" && foreignLanguageSentences(reply, i.candidateTitles ?? []).length) style.push("mixed_language");
  if (repeatedTeamLine(reply, i.incomingMessage, !!i.teamAlreadyOpen, !!i.newTeamQuestion, !!i.onOpenItem)) style.push("repeated_team_line");
  if (style.length) problems.push({ kind: "style", codes: [...new Set(style)] });

  return { ok: problems.length === 0, problems };
}

/**
 * The problems that may stop a reply after the rewrite: a fact the customer would
 * be misled by. Everything else (style, an unread lookup, a needless handoff) is
 * cleaned or sent as is, never swapped for a canned line (prod replay 2 2026-11-16:
 * 17 fallbacks on Smoovee, most of them style, replaced real answers).
 */
export const FACTUAL_KINDS: ReadonlySet<ClaimProblem["kind"]> = new Set<ClaimProblem["kind"]>(["ungrounded_price", "unsupported_action", "unknown_product", "ungrounded_absence", "card_reference", "echoed_size", "unsafe_tip", "ungrounded_number", "dangling_reference", "ungrounded_payment", "inactive_order_unlabelled", "option_without_variation", "ungrounded_source", "price_against_store", "order_state_unread", "claims_attachment", "device_mismatch", "ungrounded_attribute", "price_of_other_product", "derived_measure", "ungrounded_negative_fit", "ungrounded_positive_fit"] as any);
export const factualProblems = (problems: ClaimProblem[]) => problems.filter((p) => FACTUAL_KINDS.has(p.kind));

// A decimal point is no sentence end ("99.5 ס"מ": the derived-measure claim spans it and was never cut).
const SENTENCES = /(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*\s*/g;
const dropSentences = (s: string, re: RegExp) => (s.match(SENTENCES) ?? [s]).filter((x) => !re.test(x)).reduce(joinKept, "").trim();

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
  // The same text the claims were cut from (gate3 reads it through normalizeQuotes).
  let s = normalizeQuotes(String(reply ?? ""));
  for (const p of problems) {
    // A made-up price loses its sentence ("התיק עולה ₪120." would leave "התיק עולה.").
    if ((p.kind as string) === "derived_measure") {
      // The derived clause goes, the measure the source states stays (prod replay on 1b35c535, Tehila: "the
      // triangle is 70 by 70, each side about 70" lost the whole sentence and the answer became a team line).
      const marks = (((p as any).claims ?? []) as string[]).map((c) => String(c ?? "").trim()).filter((m) => m.length >= 3);
      if (marks.length) s = (s.match(SENTENCES) ?? [s]).map((x) => (marks.some((m) => x.includes(m.slice(0, 40))) ? withoutClauses(x, marks) : x)).filter(Boolean).reduce(joinKept, "").trim();
      continue;
    }
    if ((p.kind as string) === "ungrounded_attribute" || (p.kind as string) === "price_of_other_product") {
      const marks = (((p as any).claims ?? []) as string[]).map((c) => String(c ?? "").trim().slice(0, 40)).filter((m) => m.length >= 3);
      if (marks.length) s = (s.match(SENTENCES) ?? [s]).filter((x) => !marks.some((m) => x.includes(m))).reduce(joinKept, "").trim();
    }
    if (p.kind === "ungrounded_price") {
      // Compared with the sentence normalized the same way: stripPrices trims, so a sentence with its trailing space
      // counted as priced and one made-up price cut the whole reply (found on d2f10620; on every sha back to b369e939).
      const priced = (x: string) => p.prices.some((pr) => stripPrices(x, [pr]) !== stripPrices(x, []));
      s = (s.match(SENTENCES) ?? [s]).filter((x) => !priced(x)).reduce(joinKept, "").trim();
    }
    if (p.kind === "ungrounded_absence" || p.kind === "unsupported_action" || p.kind === "card_reference" || p.kind === "echoed_size" || p.kind === "unsafe_tip" || p.kind === "ungrounded_number" || p.kind === "dangling_reference" || p.kind === "ungrounded_payment" || p.kind === "inactive_order_unlabelled" || p.kind === "option_without_variation" || p.kind === "ungrounded_source" || p.kind === "price_against_store" || p.kind === "order_state_unread" || p.kind === "claims_attachment" || p.kind === "device_mismatch" || p.kind === "ungrounded_negative_fit" || p.kind === "ungrounded_positive_fit") {
      const marks = p.claims.map((c) => String(c ?? "").trim().slice(0, 40)).filter((m) => m.length >= 3);
      // A caveat that limits a claim is never cut by an absence, fit or device check: the rest would read as the
      // claim (prod replay of 9480dfb2, NE'A: "אין במידע אישור לשימוש מתחת לעיניים").
      // A date caveat comes to the cut only when a source gives the date (caveatHolds above): then it goes.
      if (p.kind === "dangling_reference" && marks.length) {
        s = (s.match(SENTENCES) ?? [s]).map((x) => (marks.some((m) => x.includes(m)) ? (withoutPointer(x) ? `${withoutPointer(x)} ` : "") : x)).filter(Boolean).reduce(joinKept, "").trim();
        continue;
      }
      const keepCaveat = (x: string) => CAVEAT.test(x) && !DATE_CAVEAT.test(x) && (p.kind === "ungrounded_absence" || p.kind === "device_mismatch" || p.kind === "ungrounded_positive_fit" || p.kind === "ungrounded_negative_fit");
      if (marks.length) s = (s.match(SENTENCES) ?? [s]).filter((x) => keepCaveat(x) || !marks.some((m) => x.includes(m))).reduce(joinKept, "").trim();
      // The honesty check names some claims by kind only: "passed to the team" and promises go by pattern.
      if (p.kind === "unsupported_action") s = dropSentences(dropSentences(dropSentences(dropSentences(s, TEAM_LINE), FUTURE_PROMISE), RECORDED), WE_WILL_WITH_TEAM);
    }
  }
  return s.trim();
}

// The question around the product: never a store search word (prod replay on 1b35c535: "איך אדע מה התת גוון"
// searched as written found a powder; "מאיזה חומר השרשרת" found head coverings).
const QUERY_STOP = new Set(["איך", "כיצד", "אדע", "נדע", "לדעת", "יודעים", "יודעת", "יודע", "מאיזה", "מאיזו", "מאילו", "איזה", "איזו", "אילו", "מה", "מהו", "מהי", "מהם", "למה", "מתי", "האם", "איפה", "היכן", "כמה", "זה", "זאת", "הזה", "הזאת", "הזו", "האלה", "עשוי", "עשויה", "עשויים", "עשויות", "בדיוק", "באמת", "בעצם", "כאן", "פה", "אצלכם", "לי", "לנו", "שלכם", "how", "what", "which", "know", "tell", "is", "are", "the", "made", "of", "this", "that", "can", "do", "you", "me", "for", "about", "there", "any", "my", "your", "מזמינים", "להזמין", "קונים", "לקנות", "order", "buy", "לזה", "בזה", "עליו", "עליה", "אותו", "אותה", "שלו", "שלה", "it", "its", "does", "have", "has", "אשמח", "סרטון", "לסרטון", "סרטונים", "הדרכה", "מדריך", "קישור", "לינק", "video", "link", "tutorial", "please", "או", "or", "באילו", "באיזה", "באיזו", "שוקל", "שוקלת", "שוקלים", "weigh", "weighs", "יתאים", "יתאימו", "תתאים", "מתאים", "מתאימה", "מתאימים", "שלו", "שלה", "שלהם", "שלהן", "חשוב", "important"]);
// Attribute words: what is asked about a product, never its name (the Supervisor's probe on b77ec0d1: "יש כמה
// צבעים?" searched "צבעים", "מאיזה בד הוא עשוי?" searched "בד").
// The bare forms; a ה or ב form ("האורך", "בצבע") is always the attribute.
const ATTRIBUTE_WORDS = new Set(["צבע", "צבעים", "צבעי", "גוון", "גוונים", "גווני", "מידה", "מידות", "גודל", "בד", "חומר", "משקל", "אורך", "רוחב", "גובה", "עובי", "מלאי", "colour", "colours", "color", "colors", "size", "sizes", "fabric", "material", "weight", "length", "width", "height", "stock"]);
const attributeForm = (w: string) => { const l = w.toLowerCase(); return ATTRIBUTE_WORDS.has(l) || (/^[הב][\u0590-\u05FF]{2,}$/u.test(l) && ATTRIBUTE_WORDS.has(l.slice(1))); };
/**
 * An attribute word comes out of the query only where it is used as one (the Supervisor's probe on 13afc633: "משקל
 * מטבח", "צבע לקיר", "בד כותנה", "סרט מידה", "חומר ניקוי" are products): a ה or ב form ("האורך", "בצבע",
 * "המידות"), or a bare word with no content word right beside it ("יש כמה צבעים?", "מאיזה בד הוא עשוי?").
 */
const ASKS_ABOUT = new Set(["מאיזה", "מאיזו", "איזה", "איזו", "באיזה", "באיזו", "באילו", "אילו", "כמה", "מה", "what", "which", "how", "any"]);
function attributeUse(tokens: string[], i: number, content: (w: string) => boolean): boolean {
  const l = tokens[i].toLowerCase();
  if (!ATTRIBUTE_WORDS.has(l)) return attributeForm(l);
  // Right after a question word it is asked about ("מאיזה חומר", "כמה צבעים", "what material"); before a colour it is
  // the attribute of that colour ("גווני כחול", "גוון חום").
  if (ASKS_ABOUT.has(String(tokens[i - 1] ?? "").toLowerCase())) return true;
  if (COLOUR_WORD.test(String(tokens[i + 1] ?? "").replace(/^ב/u, ""))) return true;
  const beside = [tokens[i - 1], tokens[i + 1]].filter((x): x is string => !!x);
  // A number beside it is a value ("מידה 38"), never a product word.
  return !beside.some((x) => content(x) && !attributeForm(x) && !/^\d+$/.test(x));
}
const queryStop = (w: string) => {
  const l = w.toLowerCase();
  return QUERY_STOP.has(l) || ASK_STOP.has(l) || STEM_STOP.has(l) || (/^[הוש][\u0590-\u05FF]{2,}$/u.test(l) && (QUERY_STOP.has(l.slice(1)) || STEM_STOP.has(l.slice(1))));
};
// Words of the ask, never of the product (the Supervisor's probe on d5f288f6: "מחיר סרום" finds nothing on a search
// that needs every word, where "סרום" finds the serum).
const ASK_WORDS = new Set(["מחיר", "המחיר", "מחירים", "הנחה", "ההנחה", "הנחות", "מבצע", "מבצעים", "קיים", "קיימת", "קיימים", "קיימות", "המלצה", "המלצות", "ממליצים", "תמליצו", "הזמנה", "ההזמנה", "הזמנתי", "משלוח", "המשלוח", "משלוחים", "במידה", "במלאי", "price", "discount", "sale", "exists", "recommend", "recommendation", "order", "shipping"]);
/** An ask no product search answers: her order, shipping, a business fact, a coupon, a payment problem (no product wanted). */
export function nonProductAsk(incoming: string): boolean {
  const t = normalizeQuotes(String(incoming ?? ""));
  return !productAskNow(t) && (MY_ORDER.test(t) || ORDER_ASK.test(t) || BUSINESS_ASK.test(t) || COUPON_ASK.test(t) || PAY_PROBLEM.test(t) || STATUS_ASK.test(t));
}
/**
 * The customer's product words for a store search: the question and the ask words off, four at most; null with no
 * letter word left, or for an ask no product search answers (her order, shipping, a business fact, a coupon, a
 * payment problem). `substring`: the store matches inside titles (WooCommerce's search is SQL LIKE on title and
 * text), so one prefix letter (ה ו ל; never ב, which begins too many nouns) comes off a word of 5+ letters: the shorter form is a substring of the
 * word as written and can only add matches there. On a word search (Shopify) the word stays as written.
 */
// Words of a conversation, never of a product (the Supervisor's probes on 7100b0b6, L224 and L789): greetings, fillers,
// past and existence verbs, pronouns, the frame of a question.
const TALK_WORDS = new Set(["שאלה", "שאלות", "לגבי", "דוקא", "דווקא", "הייתה", "היתה", "היה", "היו", "הייתי", "אחת", "אחד", "מאוד", "עדיין", "ישנה", "יישנה", "ישנו", "ישנם", "שלום", "הי", "היי", "אולי", "פעם", "כבר", "ממש", "כזה", "כזאת", "כזו", "משהו", "ראיתי", "קניתי", "הזמנתי", "לי", "כדי", "לכל", "מוצרים", "פריטים", "בה", "בו", "בהם", "מתחת", "מעל", "ליד", "שוב", "יותר", "פחות", "מישהו", "תודה", "אשמח", "סליחה", "בבקשה", "בירור", "בדיקת", "בדיקה", "התאמת", "השוואה", "השוואת", "חיפוש", "מידע", "פרטי", "checking", "asking", "comparison", "מומלץ", "מומלצים", "מומלצות", "מומלצת", "נשמע", "קיבלתי", "ממך", "מכם", "מצליח", "מצליחה", "לשלם", "הסבר", "להסבר", "וכו", "וכדומה", "עדכון", "עדכונים", "חינם", "המלצה", "מלצה", "המלצות", "אלה", "אלו", "יחלק", "גוון", "כרגע", "למכשיר", "מכשיר", "להשתמש", "השתמש", "שימוש", "show", "me"]);
const PLAIN_ADJECTIVES = new Set(["יפה", "יפות", "יפים", "יפהפייה", "חדש", "חדשה", "חדשים", "חדשות", "נחמד", "נחמדה", "טוב", "טובה", "קלילה", "קליל", "עדין", "עדינה", "מיוחד", "מיוחדת", "שווה", "beautiful", "nice", "new", "pretty", "special"]);
const CONTEXT_NOUNS = new Set(["מכירה", "מכירות", "סניף", "חנות", "אתר", "אינסטגרם", "פייסבוק", "טיקטוק", "וואטסאפ", "סטורי", "פוסט", "תערוכה", "יריד", "שוק", "אירוע", "הופעה", "קבוצה", "מבצע", "פרסומת", "ניוזלטר"]);
const talkWord = (w: string) => { const l = w.toLowerCase(); return TALK_WORDS.has(l) || (/^[הושל][\u0590-\u05FF]{2,}$/u.test(l) && TALK_WORDS.has(l.slice(1))) || (/^ש[\u0590-\u05FF]{3,}$/u.test(l) && (TALK_WORDS.has(l.slice(1)) || /^ש(?:מוצר|הוא|היא|זה)/u.test(l))); };
const COLOUR_WORD = /^(?:שחור|שחורה|שחורים|לבן|לבנה|לבנים|אדום|אדומה|כחול|כחולה|כחולים|ירוק|ירוקה|צהוב|צהובה|ורוד|ורודה|אפור|אפורה|חום|חומה|סגול|סגולה|כתום|כתומה|זהב|זהוב|כסף|כסוף|בז'|בורדו|תכלת|נייבי|black|white|red|blue|green|yellow|pink|grey|gray|brown|purple|orange|gold|silver|beige|navy)$/iu;
/** A describing word: a colour, or an adjective-shaped word ("חגיגי", "חגיגית", "קלילה" is not one). */
export const describingWord = (w: string) => COLOUR_WORD.test(w) || /^[\u0590-\u05FF]{3,}(?:י|ית|יות|יים)$/u.test(w);
/**
 * The customer's product words for a store search: the question, the conversation and the ask words off, four at
 * most; null with no letter word left, or for an ask no product search answers (her order, shipping, a business fact,
 * a coupon, a payment problem, a status ask). A name beside a greeting ("יערה שלום") and a ב-phrase that opens
 * context ("במכירה בחריש") are no product words; a ב on a colour comes off; a ב-word after a product noun stays
 * ("משטחי במבוק"). `substring`: the store matches inside titles (WooCommerce), so one prefix letter (ה before 4+, ו or ל
 * before 5+; never ב, never on a verb) comes off: the shorter form is a substring of the word as written.
 */
export function storeQueryOf(incoming: string, opts: { substring?: boolean } = {}): string | null {
  let t = normalizeQuotes(String(incoming ?? ""));
  if (nonProductAsk(t)) return null;
  // A name beside a greeting at the start: "יערה שלום.", "היי יערה,".
  t = t.replace(/^\s*[\p{L}]+\s+שלום\s*[,.!]?/u, " ").replace(/^\s*(?:היי|הי|שלום|hi|hey|hello)\s+[\p{L}]+\s*[,!.]/iu, " ");
  const tokens = (t.match(/[\p{L}\p{N}]+(?:['"״][\p{L}]+)*'?/gu) ?? []) as string[];
  const isContent = (w: string) => !queryStop(w) && !talkWord(w) && !ASK_WORDS.has(w.toLowerCase()) && (w.length >= 2 || /^\d$/.test(w));
  // A size and its value are never title text: "מידה 38" goes, and the ב comes off the word after it ("בנעל").
  const sized = new Set<number>();
  // The value: a number, a size letter ("L", "XL") or a size adjective ("מידה גדולה"); the size word goes with it.
  const SIZE_VALUE = /^(?:\d+|xxs|xs|s|m|l|xl|xxl|xxxl|גדולה|גדול|גדולות|קטנה|קטן|קטנות|בינונית|בינוני|large|small|medium)$/iu;
  tokens.forEach((w, i) => {
    if (!/^(?:מידה|מידות|size)$/iu.test(w) || !SIZE_VALUE.test(tokens[i + 1] ?? "")) return;
    sized.add(i); sized.add(i + 1);
    // The ב comes off the word after them, an apostrophe word too ("בקפוצ'ון").
    if (/^ב[\u0590-\u05FF]{2,}(?:['"״][\u0590-\u05FF]+)*$/u.test(tokens[i + 2] ?? "") && tokens[i + 2].replace(/['"״]/g, "").length >= 4) tokens[i + 2] = tokens[i + 2].slice(1);
  });
  const kept: string[] = [];
  let afterContext = false;
  tokens.forEach((w0, i) => {
    const wasAfter = afterContext;
    afterContext = false;
    if (sized.has(i) || !isContent(w0) || attributeUse(tokens, i, isContent)) return;
    let w = w0;
    // A ב-word: a colour stays bare ("בכחול"); a context noun ("במכירה", "באינסטגרם") and the place right after it
    // ("בחריש") are no product words. Any other ב-word is a word of its own ("בגדי", "במבוק", "בובה").
    if (/^ב[\u0590-\u05FF]{3,}/u.test(w) && !attributeForm(w)) {
      const bare = w.slice(1).replace(/^ה/u, "");
      if (COLOUR_WORD.test(w.slice(1))) w = w.slice(1);
      else if (CONTEXT_NOUNS.has(bare)) { afterContext = true; return; }
      else if (wasAfter) return;
    }
    kept.push(w);
  });
  // The article off on a substring search, never on a verb ("הייתה").
  const stripped = kept.filter((w) => w.length >= 2 || /^\d$/.test(w)).map((w) => (opts.substring && ((/^ה[\u0590-\u05FF]{3,}$/u.test(w) && !/(?:תה|ו)$/u.test(w)) || /^[ול][\u0590-\u05FF]{4,}$/u.test(w)) ? w.slice(1) : w));
  // One form of a word ("חגיגי" and "חגיגית").
  const seen = new Set<string>();
  const content = stripped.filter((w) => { const k = w.replace(/^[הולב]/u, "").slice(0, 4); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!content.some((w) => /\p{L}{2,}/u.test(w))) return null;
  return content.slice(0, 4).join(" ");
}
/** Describing only: colours, plain adjectives and adjective shapes ("חגיגי כחול"). */
const allDescribing = (q: string) => q.split(/\s+/).every((w) => COLOUR_WORD.test(w) || PLAIN_ADJECTIVES.has(w) || /^[\u0590-\u05FF]{3,}(?:י|ית|יות|יים)$/u.test(w));
const nounWord = (w: string) => /\p{L}{3,}/u.test(w) && !COLOUR_WORD.test(w) && !PLAIN_ADJECTIVES.has(w) && !/^[\u0590-\u05FF]{3,}(?:י|ית|יות|יים)$/u.test(w) && !talkWord(w) && !queryStop(w);
// A message about a product thing: a have/was/want/seen verb governing the noun ("הייתה מטפחת", "יש לכם X", "מחפשת X").
const PRODUCT_CONTEXT = /(?<![\u0590-\u05FF])(?:הייתה|היתה|היה|היו|יש\s+לכם|יש\s+לך|יש|מחפש|מחפשת|מחפשים|לחפש|למצוא|רוצה|רוצים|ראיתי|קניתי|הזמנתי)\s+(?:(?:אצלכם|אצלך|באתר|בחנות|פה|כאן|בסטורי|באינסטגרם|בפייסבוק)\s+)?(?:את\s+)?([\u0590-\u05FF]{3,}(?:['"״][\u0590-\u05FF]+)?)/gu;
// Never the governed noun (the 7a3bc2a3 probe on 26 real intents): a frame or abstract word, an adverb, an infinitive.
const NOT_LENT = new Set(["אפשר", "אפשרויות", "נקודת", "נקודות", "נקודה", "סניף", "סניפים", "שיטה", "שיטות", "שיטת", "דרך", "דרכים", "המלצה", "חלופה", "מידע", "קישור", "מענה", "אפשרות", "שם", "מידות", "מידה", "גוון", "צבע", "הבדל", "מועד", "קוד", "תפקיד", "אופן", "שקיפות", "קושי", "סף", "כתובת", "עלות", "משלוח", "התיחסות", "התייחסות", "עזרה", "תשובה", "עדכון", "הודעה", "פרטים", "זיכוי", "החלפה", "החזרה", "בעיה", "שאלה", "מחיר", "הנחה", "קופון", "כרגע", "עכשיו", "היום", "מחר", "עוד", "גם", "מוצר", "דגם", "פריט", "משהו", "בעצם", "הרבה", "מספיק", "אחריות", "החזרות", "שירות", "מבצעים"]);
// In the governed slot a word ending in י is a construct noun ("למצוא משטחי הזזה"), never an adjective.
// A governed word that opens a clause ("ראיתי אצלכם שאפשר לשלם בביט") is no noun.
const CLAUSE_OPENER = /^ש(?:אפשר|יש|אין|צריך|כדאי|אני|את|אתם|אתן|הוא|היא|זה|אתה|לא|כבר|עדיין)/u;
const lendable = (w: string) => { const bare = w.replace(/^ה(?=[\u0590-\u05FF]{3,})/u, ""); return !CLAUSE_OPENER.test(w) && /\p{L}{3,}/u.test(w) && !COLOUR_WORD.test(bare) && !PLAIN_ADJECTIVES.has(bare) && !talkWord(w) && !queryStop(w) && !/^ל[\u0590-\u05FF]{2,}/u.test(w) && !NOT_LENT.has(bare) && !NOT_LENT.has(w); };
// A word every title shares lends only as a real noun: no ל form of a longer phrase ("לפנים", "למכונת"), no colour
// or material ("זהב", "Black"), no function word ("with") (the Supervisor's probe of cb151923).
const EN_NOT_NOUN = /^(?:with|and|for|the|of|in|on|by|set|pack|black|white|red|blue|navy|green|grey|gray|pink|brown|beige|gold|silver|cream|ivory|charcoal|leather|cotton|wool|linen|denim|steel|wood|wooden|bamboo|large|small|medium|mini|new|classic|premium|men|women|kids)$/i;
const MATERIAL_HE = new Set(["עור", "כותנה", "צמר", "פשתן", "משי", "עץ", "במבוק", "נירוסטה", "פלדה", "זכוכית", "קרמיקה", "פלסטיק", "סיליקון", "זהב", "כסף"]);
export const sharedTitleNounOk = (w: string) => /\p{L}{3,}/u.test(w) && !EN_NOT_NOUN.test(w) && !MATERIAL_HE.has(bareNoun(w)) && lendable(w) && nounWord(bareNoun(w));
/** The noun lent bare: never with its article ("המטפחת" lends "מטפחת"). */
const bareNoun = (w: string) => w.replace(/^ה(?=[\u0590-\u05FF]{3,})/u, "");
/** The noun a product source lends: a title or the intent (its first noun), or a message only by its product context or a title word. */
function lentNoun(text: string, kind: "focus" | "message", titles: string[]): string | null {
  // A product title lends its first noun; anything else (the intent, a message) only by a product context or a title word.
  if (kind === "focus") { const n = (storeQueryOf(text) ?? "").split(/\s+/).find((w) => nounWord(w) && !NOT_LENT.has(bareNoun(w))); return n ? bareNoun(n) : null; }
  for (const m of String(text ?? "").matchAll(PRODUCT_CONTEXT)) if (lendable(m[1])) return bareNoun(m[1]);
  // A title word, with up to two prefix letters off ("והמטפחת" lends "מטפחת").
  const t = titles.join(" ").toLowerCase();
  for (const w of (storeQueryOf(text) ?? "").split(/\s+/)) {
    if (!nounWord(w) || NOT_LENT.has(bareNoun(w))) continue;
    const forms = [w, w.replace(/^[והלבשמ]/u, ""), w.replace(/^[והלבשמ]{2}/u, "")].filter((x) => x.length >= 3);
    const hit = forms.find((x) => new RegExp(`(?<![\\p{L}])${x.toLowerCase()}(?![\\p{L}])`, "u").test(t));
    if (hit) return hit;
  }
  return null;
}
/** Describing words alone take a noun from the product in focus (for the early lookup). */
export function withFocusNoun(q: string | null, focus: string | null | undefined): string | null {
  if (!q || !allDescribing(q) || !String(focus ?? "").trim()) return q;
  const noun = lentNoun(String(focus), "focus", []);
  return noun ? [noun, ...q.split(/\s+/)].slice(0, 4).join(" ") : q;
}
/**
 * The fallback search's query: her product words; when they are only describing words ("חגיגי כחול"), a noun lent
 * by a source about a product goes in front: the product in focus, the intent, then an earlier message (newest
 * first) only by its product context ("הייתה מטפחת") or a title word; a first-person state ("אני לא טובה ב...",
 * "בדקתי", "נראה לי ש...") lends nothing. Nothing lent: null, no search, never a garbage query.
 */
export function fallbackQueryOf(incoming: string, earlierInbound: string[], intent: string | null | undefined, opts: { substring?: boolean } = {}, extra: { focus?: string | null; titles?: string[] } = {}): string | null {
  const q = storeQueryOf(incoming, opts);
  if (!q) return null;
  if (!allDescribing(q)) return q;
  // The intent lends like a message: its first word is a verb or a gerund (לברר, מחפשת, בירור), never the noun.
  const sources: Array<[string, "focus" | "message"]> = [[String(extra.focus ?? ""), "focus"], [String(intent ?? ""), "message"], ...earlierInbound.map((m) => [m, "message"] as [string, "message"])];
  for (const [text, kind] of sources) {
    if (!text.trim()) continue;
    const noun = lentNoun(text, kind, extra.titles ?? []);
    if (noun) return [noun, ...q.split(/\s+/)].slice(0, 4).join(" ");
  }
  return null;
}
// An explanation asked, no product wanted: "how do I know", "what is", "what's the difference" (the knowledge answers it).
const EXPLAIN_ASK = /(?<![\u0590-\u05FF])(?:איך\s+(?:אני\s+)?(?:אדע|נדע|יודעים|לדעת|מבדילים|בוחרים|מתאימים)|מה\s+(?:זה|זאת|ההבדל|הכוונה|המשמעות)|מה\s+ה[\u0590-\u05FF]{2,}\s+(?:שלי|שלך)|מהו|מהי)(?![\u0590-\u05FF])|\b(?:how (?:do|can) (?:i|we|you) (?:know|tell|choose|pick)|what(?:'s| is) the difference|what (?:is|does) .{1,30} mean)\b/iu;
/** An explanation or a how-to the store's search cannot answer: no product named for purchase. */
export function explanationAsk(incoming: string): boolean {
  const t = normalizeQuotes(incoming ?? "");
  return (EXPLAIN_ASK.test(t) || HOW_TO.test(t)) && !PURCHASE.test(t) && !NAMES_A_PRODUCT.test(t) && !/(?<![\u0590-\u05FF])(?:יש\s+לכם|מחפש|מחפשת|רוצה\s+(?:לקנות|להזמין))(?![\u0590-\u05FF])|\b(?:do you have|looking for)\b/iu.test(t);
}

/**
 * The lookups a rewrite needs that the engine can make itself, with no model
 * round: the customer's own words in the store (an absence, a photo asked
 * instead of a search, a search that gave up), or in the knowledge (a business
 * fact). Two at most. Product and order reads need the model (which product,
 * which order) and are not here.
 */
export function autoLookups(problems: ClaimProblem[], incoming: string, toolsOffered: string[], done: ToolRunRecord[], subject: string | null = null, queryOverride: string | null = null): Array<{ id: string; function: { name: string; arguments: string } }> {
  const out: Array<{ id: string; function: { name: string; arguments: string } }> = [];
  const words = String(incoming ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!words) return out;
  // The store is searched by the product words only, and never for an explanation (the knowledge is).
  const explain = explanationAsk(words);
  // No product word of her own ("אשמח לסרטון הדרכה"): the product the conversation is about (prod replay on
  // 1b35c535, NE'A: the literal sentence lost the marker in focus).
  const substring = toolsOffered.some((n) => /^woocommerce\.(?:list_products|search_products)$/.test(n));
  // Describing words alone take the focus product's noun ("חגיגי כחול" -> "מטפחת חגיגי כחול", the 7100b0b6 probe).
  // The engine's query when it has one (the noun lent by the conversation, rating of dcf2158e: the scarf turns).
  const query = queryOverride ?? withFocusNoun(storeQueryOf(words, { substring }), subject) ?? (String(subject ?? "").trim().slice(0, 80) || null);
  // An explanation about a product she names searches its page too (rating of dcf2158e, NE'A: "קניתי טוש למילוי גבות,
  // אשמח להסבר /סרטון" lost the page with the usage tip and the video); one about no product (התת גוון) never does.
  const productNoun = !!query && query.split(/\s+/).some((w) => { const b = w.replace(/^ה(?=[\u0590-\u05FF]{2,})/u, ""); return lendable(w) && !NOT_PRODUCT_SUBJECT.has(b) && !ATTRIBUTE_WORDS.has(b); });
  const store = !query || (explain && !productNoun) ? undefined : toolsOffered.find((n) => /(?:^|\.)(?:list_products|search_products)$/.test(n));
  const has = (k: ClaimProblem["kind"]) => problems.some((p) => p.kind === k);
  // Each store's own page-size argument (Shopify parity: its search takes "limit").
  // Each store's own page-size argument; Shopify's search is in stock only unless told otherwise,
  // and an absence is checked against everything the store sells.
  const shopifyLike = !!store && /(?:^|\.)search_products$/.test(store) && !/^woocommerce\./.test(store);
  const few = shopifyLike ? { limit: 5 } : { per_page: 5 };
  const absence = problems.find((p) => p.kind === "ungrounded_absence") as { claims: string[] } | undefined;
  // The category alone: a word of the absence claim that the customer's words or an empty search used.
  const broad = (() => {
    // Only after a store search came back empty (narrower than the claim): with none run yet,
    // the customer's own words are the search ("יש משטחי במבוק?" keeps the bamboo).
    if (!absence || !done.some((t) => PRODUCT_TOOL.test(t.tool) && (t.outcome === "empty" || t.outcome === "ok"))) return null;
    const claimTerms = absence.claims.flatMap((c) => termsOf(String(c ?? "").split(/,|;|\s+(?:אבל|אך|but)\s+/iu)[0] ?? ""));
    const asked = termsOf(incoming);
    const searched = done.filter((t) => PRODUCT_TOOL.test(t.tool)).flatMap((t) => termsOf(String((t.args as any)?.query ?? "")));
    const near = (w: string, l: string[]) => l.some((x) => x.includes(w) || w.includes(x));
    // The claim's word the search used; else the search's word the customer used; else the claim's word they used.
    const pick = claimTerms.find((w) => near(w, searched)) ?? searched.find((w) => near(w, asked)) ?? claimTerms.find((w) => near(w, asked)) ?? null;
    if (!pick) return null;
    // The word as the customer or the search wrote it (the stem drops a prefix letter).
    // As the search or the customer wrote it (a stem drops a prefix letter; a claim may be plural).
    const written = [...done.flatMap((t) => String((t.args as any)?.query ?? "").split(/\s+/)), ...String(incoming ?? "").split(/\s+/)].map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, "")).filter(Boolean);
    return written.find((w) => { const x = unfinal(w.toLowerCase()); return x.includes(pick) || (x.length >= 3 && pick.includes(x)); }) ?? pick;
  })();
  const orderOnly = !!absence && absence.claims.every((c) => ORDER_ABSENCE.test(c)) && !has("no_search");
  // After a store search timed out, no second store try when the knowledge answers (rating of b3d2bbf3: "מתי יתחדש
  // המלאי" took 20s and more, two store tries, and the customer got the team line only).
  const storeTimedOut = done.some((t) => PRODUCT_TOOL.test(t.tool) && t.outcome === "timeout");
  if (storeTimedOut && has("knowledge_has_it")) return out;
  if (store && !orderOnly && (has("ungrounded_absence") || has("no_search"))) {
    out.push({ id: "auto_store_1", function: { name: store, arguments: JSON.stringify({ query: broad ?? (has("unread_product") && String(subject ?? "").trim() ? String(subject).trim().slice(0, 80) : query), ...few, ...(shopifyLike && has("ungrounded_absence") ? { in_stock_only: false } : {}) }) } });
  } else if (store && problems.some((p: any) => p.kind === "style" && p.codes?.includes("internal_reasoning")) && !done.some((t) => t.tool === store && String((t.args as any)?.query ?? "") === query)) {
    // The model turned the results down in its own words: search with the customer's own product words.
    out.push({ id: "auto_store_1", function: { name: store, arguments: JSON.stringify({ query, ...few }) } });
  } else if (store && has("unread_product") && !done.some((t) => PRODUCT_TOOL.test(t.tool))) {
    // A question about the product itself with nothing read (prod replay on 1b35c535, Smoovee: a stopper question
    // went to the team): the product the conversation is about, by its name, else the customer's product words.
    // "מאיזה בד הוא עשוי?" with several products and none in focus: "it" names no product, so no store search
    // (the model asks which one), never a search for the attribute word.
    // Decided by what is left of her words: attribute and question words alone are no product (storeQueryOf null).
    const q = String(subject ?? "").trim().slice(0, 80) || query;
    if (q) out.push({ id: "auto_store_1", function: { name: store, arguments: JSON.stringify({ query: q, ...few }) } });
  } else if (store && has("unknown_product") && asksAboutProduct(incoming) && !done.some((t) => PRODUCT_TOOL.test(t.tool))) {
    // Products named with no store read this turn (rating of b3d2bbf3, NE'A: "קניתי טוש למילוי גבות, אשמח להסבר
    // /סרטון" answered from the knowledge with "no video"; the product page had the tip and the video): her product
    // words, else the product the conversation is about.
    const q = query ?? (String(subject ?? "").trim().slice(0, 80) || null);
    if (q) out.push({ id: "auto_store_1", function: { name: store, arguments: JSON.stringify({ query: q, ...few }) } });
  } else if (store && has("gave_up_search")) {
    const last = [...done].reverse().find((t) => t.tool === store && t.outcome === "timeout");
    const narrow = String((last?.args as any)?.query ?? words).split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
    out.push({ id: "auto_store_1", function: { name: store, arguments: JSON.stringify({ query: narrow, ...few }) } });
  }
  // An option claim with the product known (its read this turn) and a variations tool offered: its variations are read
  // before any cut (dev live round on dcf2158e: "בשחור יש את ה-Heavyweight Hoodie" was true, the next turn showed it).
  const variationTool = toolsOffered.find((n) => /(?:^|\.)list_product_variations$/.test(n));
  const optionClaim = problems.find((p) => p.kind === "option_without_variation") as { claims?: string[] } | undefined;
  if (optionClaim && variationTool && !done.some((t) => VARIATION_TOOL.test(t.tool))) {
    const reads = done.filter((t) => /get_product$/.test(t.tool) && t.outcome === "ok");
    const nameOf = (t: ToolRunRecord) => String(/"(?:name|title)"\s*:\s*"([^"]+)"/.exec(String(t.content ?? ""))?.[1] ?? "").toLowerCase();
    const said = (optionClaim.claims ?? []).join(" ").toLowerCase();
    const pick = reads.find((t) => { const n = nameOf(t); return !!n && (said.includes(n) || n.split(/\s+/).filter((w) => w.length >= 4).some((w) => said.includes(w))); }) ?? (reads.length === 1 ? reads[0] : null);
    const id = (pick?.args as any)?.product_id ?? (pick?.args as any)?.id;
    if (id != null) out.unshift({ id: "auto_variations_1", function: { name: variationTool, arguments: JSON.stringify({ product_id: String(id) }) } });
  }
  // An order said to be missing: the customer's own orders, by the identity the channel proves (no selector).
  const ownOrders = toolsOffered.find((n) => /(?:list_customer_orders|get_customer_orders|find_latest_order)$/.test(n));
  if (ownOrders && absence && absence.claims.some((c) => ORDER_ABSENCE.test(c)) && !done.some((t) => ORDER_LOOKUP_TOOL.test(t.tool))) {
    out.unshift({ id: "auto_orders_1", function: { name: ownOrders, arguments: JSON.stringify({}) } });
  }
  // An explanation the model answered without a lookup: the knowledge, by the customer's words.
  if (explain && (has("no_search") || has("ungrounded_absence") || has("gave_up_search")) && !has("unread_knowledge") && toolsOffered.includes("search_knowledge") && !done.some((t) => t.tool === "search_knowledge")) {
    out.push({ id: "auto_knowledge_1", function: { name: "search_knowledge", arguments: JSON.stringify({ query: words }) } });
  } else if ((has("unread_knowledge") || has("unread_product")) && toolsOffered.includes("search_knowledge") && !(has("unread_product") && done.some((t) => t.tool === "search_knowledge"))) {
    out.push({ id: "auto_knowledge_1", function: { name: "search_knowledge", arguments: JSON.stringify({ query: words }) } });
  } else if (problems.some((p: any) => p.kind === "gave_up_search" && p.fromKnowledge) && toolsOffered.includes("search_knowledge") && !done.some((t) => t.tool === "search_knowledge")) {
    // The store timed out and the knowledge speaks of it: the business's own tables answer it (prod rating 2026-11-17).
    out.push({ id: "auto_knowledge_1", function: { name: "search_knowledge", arguments: JSON.stringify({ query: words }) } });
  }
  return out.slice(0, 2);
}

/**
 * Deterministic cleanup of a reply whose remaining problems are style only: what
 * code can fix safely is fixed, the rest is sent as written. An empty result means
 * nothing is left to say.
 */
export function cleanStyle(reply: string, codes: string[], previousBotReplies: string[] = [], allowedScripts = "", incoming = "", titles: string[] = [], employeeName: string | null = null): string {
  const c = new Set(codes);
  let s = normalizeQuotes(String(reply ?? ""));
  if (c.has("repeated_sentence")) {
    const again = new Set(repeatedSentences(s, previousBotReplies));
    s = (s.match(SENTENCES) ?? [s]).filter((x) => !again.has(x.trim())).reduce(joinKept, "").trim();
  }
  if (c.has("repeated_advice")) {
    const again = new Set(repeatedAdvice(s, previousBotReplies, incoming));
    s = (s.match(SENTENCES) ?? [s]).filter((x) => !again.has(x.trim())).reduce(joinKept, "").trim();
  }
  if (c.has("gendered_address")) s = neutralSecondPerson(s);
  // "שים לב," before a fact: the fact alone (dev round k5 on 0b5f2b46: the clean left it in).
  if (c.has("imperative_notice")) s = s.replace(/(?<![\u0590-\u05FF])(?:שים|שימי)\s+לב(?:\s+ש)?\s*[,:]?\s*/gu, "");
  if (c.has("wrong_identity")) { const bad = wrongSelfName(s, employeeName); if (bad) s = (s.match(SENTENCES) ?? [s]).filter((x) => wrongSelfName(x, employeeName) == null).reduce(joinKept, "").trim(); }
  if (c.has("mixed_language")) { const en = new Set(foreignLanguageSentences(s, titles)); s = (s.match(SENTENCES) ?? [s]).filter((x) => !en.has(x.trim())).reduce(joinKept, "").trim(); }
  if (c.has("familiar_address")) s = s
    .replace(/(?<![֐-׿])((?:כן|היי|הי|אהלן|תודה|בטח|סבבה|שלום|וואו))\s+(?:אחי|אחותי|אחיי|גבר|מותק|נשמה|חמוד|חמודה|מלך|מלכה|בובה|יקירי|יקירתי)(?=\s*[,!.?]|\s*$)/gu, "$1")
    .replace(/,\s*(?:אחי|אחותי|אחיי|גבר|מותק|נשמה|חמוד|חמודה|מלך|מלכה|בובה|יקירי|יקירתי)(?=\s*[,!.?]|\s*$)/gu, "")
    .replace(/(^|[.!?]\s*)(?:אחי|אחותי|אחיי|גבר|מותק|נשמה|חמוד|חמודה|מלך|מלכה|בובה|יקירי|יקירתי)\s*,\s*/gu, "$1");
  if (c.has("nameless_self") && employeeName) s = s.replace(NAMELESS_SELF_G, (_m, lead) => `${lead} ${employeeName} מ-`).replace(/\b(this is|i'?m|i am)\s+(?:the\s+|your\s+)?(?:ai\s+|virtual\s+|digital\s+)?assistant\s+(?:of|from|at)\s+/giu, (_m, lead) => `${lead} ${employeeName} from `);
  if (c.has("asks_known")) { const known = new Set(asksKnown(s, incoming)); s = (s.match(SENTENCES) ?? [s]).filter((x) => !known.has(x.trim())).reduce(joinKept, "").trim(); }
  if (c.has("order_number_differs")) { const bad = new Set(orderNumberDiffers(s, incoming)); s = (s.match(SENTENCES) ?? [s]).filter((x) => !bad.has(x.trim().slice(0, 120))).reduce(joinKept, "").trim(); }
  if (c.has("returns_work")) s = dropSentences(s, RETURNS_WORK);
  if (c.has("terms_refusal")) s = dropSentences(s, TERMS_REFUSAL);
  if (c.has("simulation_leak")) s = dropSentences(s, SIMULATION_LEAK);
  if (c.has("repeated_team_line")) s = dropSentences(s, TEAM_LINE);
  // "מצאתי כמה אפשרויות" -> "יש כמה אפשרויות"; "לא מצאתי" is left alone (the ban skips it too).
  if (c.has("found_narration")) s = s.replace(/(?<![֐-׿])(?<!לא\s)((?:ו|ש)?)מצאתי(?![֐-׿])/gu, "$1יש");
  if (c.has("self_gendered")) s = neutralFirstPerson(s);
  if (c.has("foreign_script")) s = stripForeignScript(s, allowedScripts);
  if (c.has("internal_jargon")) s = dropSentences(dropSentences(s.replace(PROCESS_CLAUSE, ""), INTERNAL_JARGON), PROCESS_TALK);
  if (c.has("internal_reasoning")) s = dropSentences(s, INTERNAL_REASONING);
  if (c.has("tool_talk")) s = dropSentences(s, TOOL_TALK);
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

const words = (s: string) => (String(s ?? "").match(/[\p{L}\p{N}]+/gu) ?? []).length;
const QUESTION = /\?|(?<![\u0590-\u05FF])(?:מה|איך|איפה|מתי|כמה|למה|האם|יש|אפשר|מאיזה|איזה|אילו)(?![\u0590-\u05FF])|\b(?:what|how|where|when|which|do you|can i|is there)\b/iu;
const PRODUCT_ASK = /(?<![\u0590-\u05FF])(?:מחפש|מחפשת|מחפשים|יש לכם|יש לך|אפשר לקבל|ממליצים|תמליצו|המלצה|צריך|צריכה|רוצה|רוצים|בא לי|מעוניין|מעוניינת|מה יש|מה מתאים|איזה|אילו|בגוון|בצבע)(?![\u0590-\u05FF])|\b(?:looking for|do you have|recommend|i need|i want|something (?:in|for))\b/iu;
/**
 * A reply that does not answer: cut to a word or two by the cleanup while the
 * customer asked something, or (prod replay 4, Tehila: "ברור, דווקא חגיגית ובגווני
 * כחול.") a product ask met with no product, no price and no question.
 */
// Only an apology or an acknowledgement (prod replay 2026-11-17: "מצטערים על הבלבול." alone to a
// customer charged with no order): on a support case that answers nothing.
const ACK_ONLY = /^(?:\s*(?:מצטערים|מצטערת|מצטער|סליחה|מתנצלים|מבינים|אנחנו\s+מבינים|תודה|תודה\s+רבה|sorry|we(?:'re| are) sorry|apologies|we understand|thanks|thank you)[^.!?\n]*[.!?]*\s*)+$/iu;
export const ackOnly = (reply: string) => ACK_ONLY.test(String(reply ?? "").trim());
export function tooThin(cleaned: string, original: string, incoming: string, shown: { cards?: string[]; titles?: string[] } = {}): boolean {
  const supportCase = PAY_PROBLEM.test(normalizeQuotes(incoming ?? "")) || STRONG_CASE.test(incoming ?? "") || MY_ORDER.test(incoming ?? "");
  if (supportCase && ackOnly(cleaned)) return true;
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
    if (p.kind === "ungrounded_absence" && p.claims.some((c) => ORDER_ABSENCE.test(c))) lines.push("- You said there is no order, or it cannot be located, without looking: the customer's own orders (by the number they write from) were looked up now; answer from what came back, and ask for the order number only if nothing did.");
    if (p.kind === "ungrounded_absence") lines.push(`- You said we do not have or sell something (${p.claims.join("; ")}), but no search as broad as that claim ran this turn (an empty search for more words proves nothing about the category), or it returned them. Look at what the broader search returned and show those products; if truly nothing, say you did not find it by that name and ask.`);
    if (p.kind === "no_search") lines.push("- The customer told you what they want (a category, a colour, a size). Search the store with their words now and show what fits; ask at most one short question, never for a photo you already asked for.");
    if (p.kind === "unsafe_tip") lines.push(`- This is a safety conversation: give no usage tip the business's knowledge does not state (${p.claims.join("; ")}). Say to stop using it until a person from the team checks, and that a person will continue here.`);
    if (p.kind === "coupon_source") lines.push("- The customer asks where to GET it, not where or how to use it. Say how it is obtained if the knowledge or the business details say; otherwise put the question in team_question. Do not repeat how to use it.");
    if (p.kind === "knowledge_has_it") lines.push("- The store search did not answer, but the business's knowledge above already answers this (a compatibility or size table): answer from it, and do not send it to the team.");
    if (p.kind === "echoed_size") lines.push(`- A product's size comes from the product data, never from the number the customer typed (${p.claims.join("; ")}). State the size the search returned, or that it is not listed.`);
    if (p.kind === "ungrounded_number") lines.push(`- These numbers are in no tool result, the knowledge or the business details (${p.claims.join("; ")}). State only numbers a tool or the knowledge gives; otherwise leave the number out or say you will check.`);
    if (p.kind === "ungrounded_payment") lines.push(`- You stated a payment or charge status (${p.claims.join("; ")}) that no tool result this turn shows. ${p.teamOpen ? "The team is already checking the payment: say it is being checked and the answer will come here." : "Read the order (its payment data) first, or say the team will check it; never say it was or was not charged, or that they can order again, without that."}`);
    if (p.kind === "inactive_order_unlabelled") lines.push(`- An order you mention is cancelled, failed or refunded (${p.claims.join("; ")}): say so with its number; never give it as their order as if it were active.`);
    if ((p.kind as string) === "derived_measure") lines.push(`- You worked out a measurement the data does not give (${(p as any).claims.join("; ")}). Give only the sizes the product data states; never compute a side, a diagonal or a folded size.`);
    if ((p.kind as string) === "ungrounded_attribute") lines.push(`- You stated a property nothing in the data states (${(p as any).claims.join("; ")}). Say a product is transparent, a colour, resistant or anti-slip only when its own text or the knowledge says so; otherwise say you do not have that detail.`);
    if ((p.kind as string) === "price_of_other_product") lines.push(`- A price is not the price of the product you named (${(p as any).claims.join("; ")}). Give each product its own price from its own data.`);
    if (p.kind === "ungrounded_positive_fit") lines.push(`- You said a product fits a device with nothing showing it (${p.claims.join("; ")}). Say it fits only when the product's own text or the business's device table names that device, or its size takes the customer's base. Never reason from a similar or other model.`);
    if (p.kind === "ungrounded_negative_fit") lines.push(`- You said a product does not fit with nothing showing it (${p.claims.join("; ")}). Say it does not fit only when its own text says so or its size is smaller than the customer's base.${(p as any).fits?.length ? ` By size, these take the customer's base: ${(p as any).fits.join(", ")}.` : ""}`);
    if (p.kind === "device_mismatch") lines.push(`- You offered a product for another device than the customer's (${p.claims.join("; ")}). Offer only what fits their own device, from the search or the knowledge's device table; if nothing does, say so and ask.`);
    if (p.kind === "claims_attachment") lines.push("- No photo, video or file came from the customer in their last messages: do not say one was received. Answer what they wrote.");
    if (p.kind === "ungrounded_source") lines.push(`- You said where it is obtained (${p.claims.join("; ")}), and the knowledge does not say so. Say it is not known here and put the question in team_question; never guess a source.`);
    if (p.kind === "price_against_store") lines.push(`- A product's price comes from the store's own data, not a document (${p.claims.join("; ")}). Read the product (search or get_product) and give the store's price.`);
    if (p.kind === "order_state_unread") lines.push(`- The order lookup failed this turn, so its state is not known (${p.claims.join("; ")}). Say it is being checked and put it in team_question (or hand over if the customer is upset); never state the order's state.`);
    if (p.kind === "option_without_variation") lines.push(`- You stated stock or a price for one option (a colour, a size, a model) from the parent product only (${p.claims.join("; ")}). Read that option's own data first (the product's variations or variants) and answer from it; if you cannot, say what the product page shows in general and that the option itself will be checked.`);
    if (p.kind === "not_narrowed") lines.push(`- The customer gave a detail that only some of the products match. Name only the ones that match it, one or two, and leave out ${p.extra.map((t) => `"${t}"`).join(", ")}.`);
    if (p.kind === "partial_return_policy") lines.push("- The business has both returns and exchanges: give both, each with its time limit, from the knowledge.");
    if (p.kind === "unnamed_recommendation") lines.push("- You recommend a product without naming it. Name it in the text first, then its key details and price (\"<name>: <details>, <price>\").");
    if (p.kind === "near_name") lines.push(`- The customer named "${p.asked}"; the product you name ("${p.shown}") is another model with a similar name. Say you did not find "${p.asked}" by that name, and offer the other only as a different, close option.`);
    if (p.kind === "dangling_reference") lines.push(`- These sentences point at a list or cards that this message does not carry (${p.claims.join("; ")}). Name the items themselves in the text, or leave the pointer out.`);
    if (p.kind === "no_recommendation") lines.push("- The customer asked you to recommend. Pick one or two of the products the search returned and say why, from their own data (price, size, level, features); or, if you truly cannot choose, ask ONE question that decides it. Never neither.");
    if (p.kind === "card_reference") lines.push("- No picture or card goes out with this reply: do not refer to one (\"בתמונה\", \"מצורף\"). Name the product instead.");
    if (p.kind === "nameless_products") lines.push("- You present products without naming any. Name one to three of the products the search returned, each with its price, or put their keys in cards.");
    if (p.kind === "ignored_yes") lines.push("- The customer said yes to your own offer of a person (or that it is urgent). Hand over now: set handoff, and say a person from the team will continue here.");
    if (p.kind === "gave_up_search") lines.push("- The store search took too long. Answer from the business's knowledge first (a device, size or compatibility table answers it; name the fitting products from it). Else call the search once more with a narrower query (one or two words, per_page 5). Never say you could not check, and do not send it to the team.");
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
      if (c.has("odd_hedge")) lines.push("- No hedge that predicts a fault the data does not state (\"ייתכן שהמוצר יזוז\", \"it might break\").");
      if (c.has("broken_hebrew")) lines.push("- \"מה לא היה בסדר\" (or \"מה לא עבד\"), not \"מה לא מרוצה\".");
      if (c.has("internal_reasoning")) lines.push("- Never narrate your own choice (\"they don't match what you described, so I won't offer them\"). Search again with the customer's own words for the item; show what fits, or ask one question about what they want.");
      if (c.has("internal_jargon")) lines.push("- Do not explain how the system works (linked details, identity, access) and never mention sources or documents (\"another source says\"): when the business's texts disagree, give the more specific policy's rule and put the conflict in team_question.");
      if (c.has("mixed_language")) lines.push("- Write the whole reply in the customer's language: one sentence is in another language.");
      if (c.has("familiar_address")) lines.push("- Do not call the customer \"אחי\", \"מותק\", \"נשמה\" or the like: friendly, not familiar.");
      if (c.has("wrong_identity")) lines.push("- You are this business's assistant under your own configured name only: never present yourself as another person or by a team member's name.");
      if (c.has("terms_refusal")) lines.push("- Never give the terms as the reason not to help: look it up (the customer's own order lookup, the knowledge) or say what the team will do.");
      if (c.has("nameless_self")) lines.push("- When you introduce yourself, use your own name (Name above), not \"the assistant\".");
      if (c.has("wrong_product_type")) lines.push("- The customer named the kind of product they want. Name and show only products of that kind; the others are not what they asked for.");
      if (c.has("unanswered_items")) lines.push("- The customer asked about several items and your reply skips some of them. Answer every item they named, or say which ones you are still checking.");
      if (c.has("asks_known")) lines.push("- Do not ask about a detail the customer already gave in their message; use it.");
      if (c.has("order_number_differs")) lines.push("- The order you found has another number than the one the customer typed. Say which order you found (its number and date) and ask whether that is the one they mean; never call it their order or their previous order.");
      if (c.has("returns_work")) lines.push("- Never hand the work back to the customer (\"try another name\", \"check the website\"): search again yourself, narrower, or answer from what the business's knowledge lists, and ask at most one question about what they need.");
      if (c.has("repeated_advice")) lines.push("- You already gave this advice or warning in this conversation: do not give it again unless the customer asks about it; answer the new message.");
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
/** Her message names a model: a digit, quotes (a geresh inside a word is none), or a Latin word in a Hebrew message;
 *  in an English one a capitalised word after the first ("do you have the Zip Hoodie?"). */
export function namesAModel(incoming: string): boolean {
  const t = String(incoming ?? "");
  if (/\d/.test(t) || /(?<!\p{L})["״'׳][^"״'׳]{2,}["״'׳](?!\p{L})/u.test(t)) return true;
  if (/[\u0590-\u05FF]/.test(t)) return /[A-Za-z]{2,}/.test(t);
  return t.trim().split(/\s+/).slice(1).some((w) => /^[A-Z][A-Za-z]+/.test(w) && w !== "I");
}
export function notFoundReply(locale: "he" | "en", incoming = ""): string {
  // A kind of product with no name ("יש לכם ג'ינס שחור?", dev round on 6320af2f) is no "model by that name".
  if (!namesAModel(incoming)) return locale === "he" ? "לא מצאתי את זה בקטלוג כרגע. מה חשוב לך בו? כך נוכל להציע משהו מתאים." : "I couldn't find that in the catalogue right now. What matters to you in it? Then we can suggest something that fits.";
  // Asks what the customer needs, never hands the search back to them (prod replay 2026-11-17).
  return locale === "he" ? "לא מצאתי דגם בשם הזה. בשביל מה זה נחוץ לך? כך נוכל להציע את המתאים." : "I didn't find a model by that name. What do you need it for? Then we can suggest what fits.";
}

/** The canned team lines (both forms), to know one was already sent. */
export function isCannedTeamLine(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  // The engine's own team lines, the fallbacks and the ones its final passes add, alone or ending a reply.
  const lines = [safeFallback("he"), safeFallback("he", true), safeFallback("en"), safeFallback("en", true), "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "I've passed this to the team, and the answer will come here in the chat."];
  return !!t && lines.some((l) => t === l);
}
/** A reply that ends with one of the engine's own team lines. */
export function endsWithCannedTeamLine(text: string | null | undefined): string | null {
  const t = String(text ?? "").trim();
  const lines = [safeFallback("he"), safeFallback("en"), "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "I've passed this to the team, and the answer will come here in the chat.", "העברתי לצוות את הבקשה לשיחה, והתשובה תגיע כאן בצ'אט."];
  return lines.find((l) => t.endsWith(l)) ?? null;
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
  // "שמתאים" asserts a fit nothing checked (rating 83086356: a lip tint "that fits" an under-eye ask).
  if (cards) return locale === "he" ? "הנה כמה אפשרויות." : "Here are some options.";
  const cur = (c: string | null | undefined) => (c === "ILS" || !c ? "₪" : `${c} `);
  const line = (c: (typeof shown)[number]) => (c.price != null && !c.priceOnSite ? `${c.title}, ${cur(c.currency)}${c.price}` : c.title);
  return (locale === "he" ? "הנה כמה אפשרויות:\n" : "Here are some options:\n") + shown.map((c) => `• ${line(c)}`).join("\n");
}


/**
 * The customer typed one order number and the reply states another as theirs (prod rating 2026-11-17:
 * "9664" asked, "ההזמנה הקודמת שלך היא 96664"). Sentences that assert a different number as the order.
 */
export function orderNumberDiffers(reply: string, incoming: string): string[] {
  const typed: string[] = [...(String(incoming ?? "").match(/(?<!\d)\d{4,8}(?!\d)/g) ?? [])];
  if (!typed.length) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => {
    if (/\?\s*$/.test(x)) return false;
    if (!/(?<![֐-׿])[והשב]?(?:הזמנה|ההזמנה|הזמנתך)|\border\b/iu.test(x)) return false;
    const nums = x.match(/(?<!\d)\d{4,8}(?!\d)/g) ?? [];
    return nums.length > 0 && nums.every((n) => !typed.includes(n));
  }).map((x) => x.trim().slice(0, 120));
}

/** The card protocol's lines, never for the customer (prod rating 2026-11-17, Tehila: "SHOW: בובון שטוח"). */
export function stripDirectives(text: string): string {
  return String(text ?? "")
    .replace(/^[ \t]*(?:SHOW|CARDS?)[ \t]*:.*$/gim, "")
    .replace(/[ \t]*\b(?:SHOW|CARDS?)[ \t]*:[ \t]*PRODUCT_\d+(?:[ \t]*,[ \t]*PRODUCT_\d+)*[ \t]*/g, " ")
    .replace(/^[ \t]*PRODUCT_\d+(?:[ \t]*,[ \t]*PRODUCT_\d+)*[ \t]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A price sentence left with a bare pronoun for its subject after a cleanup took the product out (prod rating
 * 2026-11-17: "הוא במבצע ב-₪165.06"). Dropped when nothing before it names one of the products.
 */
const PRONOUN_LEAD = /^\s*(?:[וש]?(?:הוא|היא|הם|הן|זה|זו|זאת)|it|this|they|these)(?=[\s,]|$)/iu;
const HAS_PRICE = /₪|ש["״']?ח|\d+(?:\.\d+)?\s?(?:NIS|ILS)|\$\s?\d/i;
export function dropDanglingPrice(text: string, titles: string[]): string {
  // A decimal point is not a sentence end ("₪165.06").
  const parts = String(text ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*\s*|\n+/g) ?? [String(text ?? "")];
  const names = titles.map((t) => String(t ?? "").trim().toLowerCase()).filter((t) => t.length >= 3);
  const firstWords = names.map((t) => t.split(/\s+/).slice(0, 2).join(" "));
  let before = "";
  const out: string[] = [];
  for (const x of parts) {
    if (PRONOUN_LEAD.test(x) && HAS_PRICE.test(x)) {
      const low = before.toLowerCase();
      if (!firstWords.some((w) => w && low.includes(w))) continue;
    }
    out.push(x);
    before += x;
  }
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A product's title as the store writes it, when the reply bends one of its words (prod rating 2026-11-17:
 * "קיטור פודרה" for "קיט פודרה"). Only a run that matches the title's first two or more words, each exactly
 * or as the word plus up to two letters, with at least one word exact; a prefix letter (ה, ב, ל, ו, ש, מ) stays.
 */
export function fixNearTitles(text: string, titles: string[]): string {
  let s = String(text ?? "");
  for (const title of titles) {
    const words = String(title ?? "").trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) continue;
    const head = words.slice(0, Math.min(3, words.length));
    if (s.includes(head.join(" "))) continue;
    const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^\\p{L}])([הבלושמ]?)(${head.map((w) => `(${esc(w)})(\\p{L}{0,2})`).join("\\s+")})(?![\\p{L}])`, "gu");
    s = s.replace(re, (m, lead, prefix, _run, ...g) => {
      const extras = head.map((_, i) => String(g[i * 2 + 1] ?? ""));
      if (!extras.some((e) => e === "") || extras.every((e) => e === "")) return m;
      return `${lead}${prefix}${head.join(" ")}`;
    });
  }
  return s;
}


/**
 * Holding mode (prod rating 2026-11-17: every run invented another story for one disputed charge, "the Visa
 * approval may be temporary", "the check of the duplicate order"). While a sensitive team item is open
 * (payment, charge, refund; damage; safety), the reply says nothing of that subject's state, cause or likely
 * outcome: only a fixed acknowledgement of new details and the holding line. Other questions are answered.
 */
// Held kinds ONLY: payment (a refund included), damage and safety; a return request has its own path (C pinned rating, Tehila: an open shipping question held
// "מאיזה חומר עשויות השרשראות?" behind "המשלוח עדיין בבדיקה"). Weak words that also name shipping or stock
// ("paid", "double", "כפול", "כרטיס") no longer make an item held on their own: a double charge says "חויב" too.
const SENSITIVE_ITEM = /(?<![֐-׿])[והשבל]?(?:חיוב|חויב|חויבתי|חויבה|חיובים|תשלום|שילמתי|זיכוי|החזר|אשראי|פגום|פגומה|פגומים|שבור|שבורה|נזק|נפגע|נפגעה|כוויה|אלרגיה|תגובה\s+אלרגית)(?![֐-׿])|\b(?:charge[ds]?|payment|refund|credit card|damaged?|broken|injur\w*|burn\w*|allerg\w*)\b/iu;
const HOLD_SUBJECT = /(?<![֐-׿])[והשבלמ]?(?:חיוב|חויב|חויבתי|חיובים|תשלום|התשלום|שילמת|שילמתי|זיכוי|החזר|כרטיס|אשראי|ויזה|סליקה|ספק|אישור|עסקה|כפול|כפילות|זמני|זמנית|הזמנה|ההזמנה|הזמנתך|בדיקה|הבדיקה|נבדק|נבדקת|בודקים|פגום|פגומה|שבור|נזק|החלפה|כוויה|אלרגיה)(?![֐-׿])|\b(?:charge[ds]?|payment|paid|refund|card|visa|authori[sz]ation|provider|duplicate|double|pending|temporary|order|damage[ds]?|broken|replacement|check(?:ing|ed)?)\b/iu;
export const HOLD_ACK_HE = "קיבלתי, הוספתי את זה לבדיקה.";
export const HOLD_ACK_EN = "Got it, I've added that to the check.";
/**
 * "להיות שקטה" is peace of mind, never "stay quiet" (prod replay on 1b35c535, both Smoovee runs: "כן מעדיפה להיות
 * שקטה" in a hold was read as a wish for silence). With a "yes" to the bot's own urgency question it is the same
 * answer: it matters to her, the team should know. Fixed wording; the note goes to the open item.
 */
const PEACE_OF_MIND = /(?<![\u0590-\u05FF])(?:(?:להיות|שאהיה|אהיה|להרגיש|נהיה)\s+(?:יותר\s+)?(?:שקטה|שקט|שקטים|רגועה|רגוע|רגועים)|ראש\s+שקט|לישון\s+בשקט|שיהיה\s+לי\s+שקט|שקט\s+נפשי|לב\s+שקט)(?![\u0590-\u05FF])|\bpeace of mind\b/iu;
const URGENCY_Q = /(?<![\u0590-\u05FF])[וש]?(?:דחוף|דחופה|חשוב\s+(?:לך|לכם)|בעדיפות|בהקדם|מהר)(?![\u0590-\u05FF])|\b(?:urgent|a priority|asap|as soon as possible)\b/iu;
export function wantsItSettled(incoming: string, lastBotReply: string | null | undefined): boolean {
  const t = normalizeQuotes(String(incoming ?? ""));
  if (PEACE_OF_MIND.test(t)) return true;
  const askedUrgency = (String(lastBotReply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n])+\?/g) ?? []).some((q) => URGENCY_Q.test(q));
  return askedUrgency && /^\s*(?:כן|כן\s+בבקשה|כן\s+דחוף|דחוף|מאוד|ברור|בטח|בהחלט|yes|yeah|yep|very|sure)(?:[\s,.!]|$)/iu.test(t);
}
export const HOLD_SETTLED_HE = "רשמנו שזה חשוב לך, והצוות יחזור עם תשובה כאן בצ'אט.";
export const HOLD_SETTLED_EN = "We've noted that this matters to you, and the team will come back to you here in the chat.";
export const SETTLED_NOTE = "the customer says it is urgent";
/** The open item that puts the conversation in holding mode, or null. */
/** A text about the held subject (payment, the order, the check, damage). */
export const aboutHeld = (text: string) => HOLD_SUBJECT.test(String(text ?? "")) || SENSITIVE_ITEM.test(String(text ?? ""));
export function holdingItem(openItems: string[]): string | null {
  return openItems.find((t) => SENSITIVE_ITEM.test(String(t ?? ""))) ?? null;
}
/** New details for the item: digits (a card's last four, an order number) or an attachment. */
export function bringsDetails(incoming: string, attachment = false): boolean {
  return attachment || /(?<!\d)\d{4,}(?!\d)/.test(String(incoming ?? ""));
}
/**
 * The reply in holding mode: every sentence about the held subject is cut, whatever it says; the fixed
 * acknowledgement (when the customer brought details) and the holding line take their place. Sentences on
 * anything else stay.
 */
/**
 * A question on another topic during a hold is answered (C pinned rating, Tehila): only the sentences on the held
 * subject itself (its payment, damage, safety or return words) and team lines go; order and check words alone
 * ("הזמנה", "בדיקה") do not. Empty when nothing else is left.
 */
export function offTopicHoldReply(reply: string): string {
  const parts = (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*\s*|\n+/g) ?? []);
  return parts.filter((x) => x.trim() && !SENSITIVE_ITEM.test(x) && !TEAM_PASS_ANY.test(x) && !TEAM_LINE.test(x) && !STILL_CHECKING.test(x)).join("").replace(/\s{2,}/g, " ").trim();
}
const STILL_CHECKING = /(?<![\u0590-\u05FF])(?:עדיין\s+(?:בבדיקה|נבדק|נבדקת|בודקים)|הצוות\s+(?:עדיין\s+)?בודק)|\bstill being checked\b/iu;
export function holdReply(reply: string, holdingLine: string, opts: { details: boolean; locale: "he" | "en"; procedural?: boolean; keepOther?: boolean }): string {
  const parts = (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*\s*|\n+/g) ?? []);
  // A hedge hints at findings ("לכאורה"): never in holding mode (rating 7af7c6d7).
  const kept = parts.filter((x) => x.trim() && !HOLD_SUBJECT.test(x) && !TEAM_PASS_ANY.test(x) && !TEAM_LINE.test(x) && !/(?<![\u0590-\u05FF])(?:לכאורה|כביכול)(?![\u0590-\u05FF])|\bsupposedly\b|\bapparently\b/iu.test(x)).map((x) => x.trim());
  const lines = [opts.details ? (opts.locale === "en" ? HOLD_ACK_EN : HOLD_ACK_HE) : null, opts.procedural ? (opts.locale === "en" ? HOLD_ADVICE_EN : HOLD_ADVICE_HE) : null, holdingLine, ...(opts.keepOther === false ? [] : kept)].filter(Boolean) as string[];
  return lines.join(" ").replace(/\s{2,}/g, " ").trim();
}

/**
 * A first name the customer never gave (prod rating 2026-11-17: "היי אלה", "בשמחה, רחל"). A name the reply
 * addresses after a greeting is kept only when the profile has it or the customer signed it.
 */
const ADDRESS = /^(\s*(?:היי|הי|שלום|אהלן|בשמחה|תודה(?:\s+רבה)?|בוקר\s+טוב|ערב\s+טוב|hi|hey|hello|thanks|thank you|sure)),?\s+(\p{L}{2,})(?=[,!.]|\s*$)/iu;
const NOT_NAMES = new Set(["רבה", "לך", "לכם", "לכן", "מאוד", "שוב", "גם", "על", "you", "so", "again", "there", "all", "everyone"]);
/** A first name the customer signed a message with: the FIRST word of a short last line, never the second. */
export function signedNames(inbound: string[]): string[] {
  const out: string[] = [];
  for (const m of inbound) {
    const last = String(m ?? "").trim().split("\n").pop()?.trim() ?? "";
    if (/^\p{L}{2,}(?:\s+\p{L}{2,})?$/u.test(last) && String(m).includes("\n")) out.push(last.split(/\s+/)[0]);
  }
  return out;
}
export function dropUnaskedName(reply: string, allowed: Array<string | null | undefined>): string {
  const m = ADDRESS.exec(String(reply ?? ""));
  if (!m) return reply;
  const name = m[2];
  if (NOT_NAMES.has(name.toLowerCase())) return reply;
  const ok = allowed.filter(Boolean).map((a) => String(a).toLowerCase());
  if (ok.includes(name.toLowerCase())) return reply;
  return String(reply).replace(ADDRESS, (_x, lead) => lead).trim();
}


/** The customer only acknowledges ("תודה", "אוקיי", "סבבה"): nothing to answer (prod rating 2026-11-18). */
const CUSTOMER_ACK = /^[\s"'“”]*(?:תודה(?:\s+רבה)?(?:\s+לך|\s+לכם)?|אוקיי?|אוקי|אוקיי?\s+תודה|סבבה|מעולה|בסדר|יופי|נהדר|ok(?:ay)?|thanks?(?:\s+you)?|thank you|great|cool|perfect)[\s!.,🙏👍❤️😊]*$/iu;
// Filler around a thanks ("שיהיה תודה", "יאללה תודה", "אז אוקיי"), and a ש/ו prefix on the thanks itself.
const ACK_FILLER = new Set(["שיהיה", "יאללה", "אז", "טוב", "וואו", "ממש", "אחלה", "סבבה", "עוד", "שוב", "יופי", "בסדר", "so", "well", "ok", "okay", "many", "again"]);
export const customerAck = (incoming: string) => {
  const t = String(incoming ?? "").trim();
  if (CUSTOMER_ACK.test(t)) return true;
  const words = t.replace(/[!.,?🙏👍❤️😊]+/gu, " ").split(/\s+/).filter(Boolean).map((w) => w.replace(/^[וש](?=תודה|אוקי)/u, ""));
  const core = words.filter((w) => !ACK_FILLER.has(w.toLowerCase()));
  return words.length <= 5 && core.length >= 1 && CUSTOMER_ACK.test(core.join(" ")) || (words.length <= 5 && core.length === 0 && words.length > 0);
};

/**
 * A "what should I do now" ask on a held subject (prod rating 2026-11-18: "if I re-order, will there be a
 * duplicate?"). Answered with fixed procedural advice, never with the payment's or order's state.
 */
const PROCEDURAL_ASK = /(?<![֐-׿])(?:(?:אם|אז)\s+(?:אזמין|נזמין|אני\s+אזמין)|להזמין\s+(?:שוב|מחדש|עוד\s+פעם)|לבצע\s+(?:שוב|מחדש)|לשלם\s+(?:שוב|מחדש)|מה\s+(?:אני\s+)?(?:צריך|צריכה|צריכים)\s+לעשות|מה\s+לעשות|מה\s+עושים|לחכות|כדאי\s+ל)|\b(?:(?:should|can) i (?:re-?order|order again|pay again|wait)|what (?:should|do) i do|order again|re-?order)\b/iu;
// Any wording of "will it double if I order or pay again" (rating 7af7c6d7: "אם הזמין שנית שלא יהיה כפילות").
const AGAIN_WORDS = /(?<![֐-׿])[וש]?(?:כפילות|כפול|כפולה|שוב|שנית|מחדש|עוד\s+פעם|פעם\s+נוספת)(?![֐-׿])|\b(?:again|twice|double|duplicate)\b/iu;
const ORDER_PAY_WORDS = /(?<![֐-׿])[והשבל]?(?:הזמנה|להזמין|הזמין|אזמין|נזמין|יזמין|תזמין|הזמנתי|לשלם|לשלם|אשלם|נשלם|תשלום|שילמתי|לקנות|אקנה)(?![֐-׿])|\b(?:order|re-?order|pay|payment|buy)\b/iu;
export const proceduralAsk = (incoming: string) => { const t = String(incoming ?? ""); return PROCEDURAL_ASK.test(t) || (AGAIN_WORDS.test(t) && ORDER_PAY_WORDS.test(t)); };
export const HOLD_ADVICE_HE = "כדאי לא להזמין או לשלם שוב, ולשמור את אישור התשלום, עד שהצוות יחזור אלייך כאן.";
export const HOLD_ADVICE_EN = "It is best not to order or pay again, and to keep the payment confirmation, until the team gets back to you here.";
export const THANKS_REPLY_HE = "בשמחה!";
export const THANKS_REPLY_EN = "You're welcome!";

/**
 * A write tool (an order note, a change, a cancellation, a message) runs only on an explicit ask (prod
 * rating 2026-11-18: an add_order_note on a cancelled order on a closing turn, unasked). Never on an
 * acknowledgement or a closing turn, and only when the message asks for something.
 */
// Record writes only: cards, booking and the team handoff have their own flows and checks.
const WRITE_TOOL = /(?:^|\.)(?:add|create|update|edit|cancel|delete|remove|refund|set|apply|change|mark|close)_[a-z_]+$/i;
const OWN_FLOW = /(?:^|\.)(?:send_product_card|escalate_to_human|schedule_meeting|check_availability|close_conversation|schedule_followup|link_identifier|integration_create_lead|create_lead|create_contact)$/i;
const REQUEST_WORDS = /(?<![֐-׿])(?:תוסיפו|תוסיפי|תוסיף|להוסיף|תשנו|תשני|תשנה|לשנות|תבטלו|תבטלי|תבטל|לבטל|תעדכנו|תעדכני|לעדכן|תרשמו|תרשמי|לרשום|תשלחו|תשלחי|לשלוח|תקבעו|לקבוע|אפשר|אפשרי|רוצה|רוצים|מבקש|מבקשת|בבקשה|תעשו|תחזירו|להחזיר|לזכות)(?![֐-׿])|\b(?:please|can you|could you|i want|i'd like|cancel|change|add|update|book|schedule|refund)\b/iu;
export function refuseWrite(toolName: string, incoming: string): string | null {
  if (!WRITE_TOOL.test(String(toolName ?? "")) || OWN_FLOW.test(String(toolName ?? ""))) return null;
  const t = String(incoming ?? "");
  if (customerAck(t)) return "not_asked: the customer only acknowledged; nothing is written on this turn";
  if (!REQUEST_WORDS.test(t) && !/[?؟]/.test(t)) return "not_asked: the customer did not ask for this change; do not write anything they did not ask for";
  return null;
}

/** A payment method that failed (prod rating 2026-11-18, BuyMe): a support case for the team, never a guess. */
const PAY_METHOD = /(?<![֐-׿])[בושה]?(?:ביימי|באיימי|ביט|פייבוקס|פייפאל|אשראי|כרטיס|תשלום|התשלום|שובר|גיפט\s*קארד|כרטיס\s+מתנה|קופון)(?![֐-׿])|\b(?:buyme|bit|paybox|paypal|credit card|card|payment|voucher|gift ?card|coupon)\b/iu;
const FAILED = /(?<![֐-׿])(?:נכשל|נכשלה|נכשלו|לא\s+עבר|לא\s+עברה|לא\s+עובר|לא\s+עובד|לא\s+עובדת|לא\s+הצליח|לא\s+הצליחה|לא\s+מצליח|לא\s+מצליחה|נדחה|נדחתה|שגיאה|תקוע|נתקע)(?![֐-׿])|\b(?:failed|declined|rejected|doesn'?t work|isn'?t working|not working|error|won'?t go through|didn'?t go through)\b/iu;
export const paymentMethodFailure = (incoming: string) => { const t = String(incoming ?? ""); return PAY_METHOD.test(t) && FAILED.test(t); };
/** The reply's sentences about the failed payment (its method, the failure, a guess at why), cut whole. */
export function cutPaymentFailure(reply: string): string {
  return ((String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"\'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*\s*|\n+/g) ?? []).filter((x) => x.trim() && !PAY_METHOD.test(x) && !FAILED.test(x) && !aboutHeld(x)).map((x) => x.trim())).join(" ").trim();
}


/**
 * A count that disagrees with the list after it (rating d7782dd2, NE'A: "3 גוונים: Sand, Medium ו-Hony,
 * Medium Dark", four names). The number is set to the list's own count; a number word becomes the digit.
 */
const COUNT_WORDS: Record<string, number> = { "שני": 2, "שתי": 2, "שניים": 2, "שתיים": 2, "שלושה": 3, "שלוש": 3, "ארבעה": 4, "ארבע": 4, "חמישה": 5, "חמש": 5, "two": 2, "three": 3, "four": 4, "five": 5 };
const COUNTED_LIST = /(^|[^\p{L}\p{N}])(\d|שני|שתי|שניים|שתיים|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש|two|three|four|five)(\s+[\p{L}'"״-]{2,}(?:\s+[\p{L}'"״-]{2,})?\s*:\s*)([^.!?\n]+)/giu;
export function fixListCount(text: string): string {
  return String(text ?? "").replace(COUNTED_LIST, (m, lead, num, mid, list) => {
    const items = String(list).split(/\s*,\s*|\s+(?:ו-?|and\s+|or\s+|או\s+)(?=\S)/iu).map((x) => x.trim()).filter((x) => x && !/^(?:ו|and|or|או)$/i.test(x));
    const said = /^\d$/.test(num) ? Number(num) : COUNT_WORDS[String(num).toLowerCase()];
    if (items.length < 2 || !said || said === items.length) return m;
    return `${lead}${items.length}${mid}${list}`;
  });
}


/**
 * Every URL in the reply as a source has it (rating 052f53ad, NE'A: "%d7%ה%d7%9e", a Hebrew letter inside the
 * percent-encoding). One that is not verbatim in a source is replaced by the source URL it starts like (same
 * host and the longest shared path), else its sentence goes. Run last, on the final text.
 */
// A raw Hebrew letter ends a URL: "https://smoovee-ltd.העברתי" is a cut link with a line glued on (prod 2026-11-18).
const URL_RE = /https?:\/\/[^\s<>"'״)\]\u05D0-\u05EA]+[^\s<>"'״)\].,;:!?\u05D0-\u05EA]/giu;
const URL_SENTENCES = /(?:https?:\/\/[^\s<>"'״)\]\u05D0-\u05EA]*[^\s<>"'״)\].,;:!?\u05D0-\u05EA]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*\s*|\n+/gu;
export function repairUrls(text: string, sources: string): { text: string; fixed: number; dropped: number } {
  const known = [...new Set(String(sources ?? "").match(URL_RE) ?? [])];
  let fixed = 0, dropped = 0;
  const bad = new Set<string>();
  let out = String(text ?? "").replace(URL_RE, (u) => {
    if (known.includes(u)) return u;
    // The store's home on a known host ("https://shop.co.il/") is no corruption.
    try { const h = new URL(u).host; if (/^https?:\/\/[^/]+\/?$/i.test(u) && known.some((k) => { try { return new URL(k).host === h; } catch { return false; } })) return u; } catch { /* not a URL */ }
    let host = "";
    try { host = new URL(u.replace(/%(?![0-9a-f]{2})/gi, "%25")).host; } catch { host = ""; }
    const same = known.filter((k) => { try { return new URL(k).host === host; } catch { return false; } });
    let best = "", len = 0;
    for (const k of same) { let i = 0; while (i < k.length && i < u.length && k[i] === u[i]) i++; if (i > len) { len = i; best = k; } }
    // Shares its host and at least the start of the path: the source's own URL.
    if (best && len > `https://${host}/`.length) { fixed++; return best; }
    // Cut short ("https://smoovee-ltd" of "https://smoovee-ltd.com/..."): the one source URL it begins.
    const longer = known.filter((k) => k.startsWith(u) && k.length > u.length);
    if (longer.length === 1) { fixed++; return longer[0]; }
    bad.add(u);
    return u;
  });
  if (bad.size) {
    const parts = out.match(URL_SENTENCES) ?? [out];
    out = parts.filter((x) => { const hit = [...bad].some((b) => x.includes(b)); if (hit) dropped++; return !hit; }).reduce(joinKept, "").trim();
  }
  return { text: out, fixed, dropped };
}

/**
 * A sentence end followed straight by a Hebrew letter gets a space (prod 2026-11-18, Smoovee: a fixed team line
 * glued to a cut link, ".העברתי"). URLs are left as they are.
 */
export function spaceSentences(text: string): string {
  const t = String(text ?? "");
  const urls = t.match(URL_RE) ?? [];
  const parts = t.split(URL_RE);
  return parts.map((x, i) => x.replace(/([.!?])(?=[\u05D0-\u05EA])/gu, "$1 ") + (urls[i] ?? "")).join("");
}


/** Kept sentences joined back: a space between two that touch (prod 2026-11-18: ".העברתי" after a cut). */
export function joinKept(a: string, x: string): string {
  // A number the splitters cut at its decimal point ("158." + "76 ₪") is one number again, never "158. 76"
  // (prod 2026-11-18, Smoovee a08a83: a regression of the space this join adds).
  if (/\d[.,]$/.test(a) && /^\d/.test(x)) return a + x;
  return a && x && !/\s$/.test(a) && !/^\s/.test(x) ? `${a} ${x}` : a + x;
}


// ── Returns and failures (prod 2026-11-18, Smoovee 376b13: "לא הצלחתי לבדוק את פרטי העסקה", then the reason asked
// again, then "החיוב עדיין בבדיקה" on a return) ──

/** A return, refund or exchange the customer ASKS FOR (not a policy question): a wish, or an order to act on. */
const RETURN_WISH = /(?<![\u0590-\u05FF])(?:רוצה|רוצים|ארצה|אבקש|מבקשת|מבקש|מבקשים|צריכה|צריך|אפשר\s+בבקשה|הייתי\s+רוצה|אשמח|נא|תבטלו|בטלו|תחזירו)(?![\u0590-\u05FF])|\b(?:i want|i'?d like|i need|please|cancel my)\b/iu;
const RETURN_ACT = /(?<![\u0590-\u05FF])[וש]?(?:להחזיר|אחזיר|החזרה|החזר|זיכוי|להחליף|החלפה|לבטל|ביטול)(?![\u0590-\u05FF])|\b(?:return|refund|exchange|cancel)\b/iu;
export const returnRequest = (incoming: string) => {
  const t = String(incoming ?? "");
  return RETURN_ACT.test(t) && (RETURN_WISH.test(t) || /(?<!\d)\d{4,}(?!\d)/.test(t));
};
/** "I couldn't check / find / access": a failure told to the customer. It becomes a team item instead. */
export const FAILURE_TOLD = /(?<![\u0590-\u05FF])(?:לא\s+(?:הצלחתי|הצלחנו|הצליח)\s+(?:לבדוק|למצוא|לגשת|לאתר|לקבל|לטעון|להגיע|לראות|לשלוף)|נתקלתי\s+(?:ב)?בעיה|(?:יש|הייתה|קרתה)\s+(?:לי\s+)?תקלה|(?:אין|לא\s+הייתה)\s+לי\s+גישה)(?![\u0590-\u05FF])|\b(?:i (?:couldn'?t|could not|wasn'?t able to|was unable to) (?:check|find|access|load|look up|retrieve)|ran into (?:a|an) (?:problem|issue|error))\b/iu;
/** A question for the reason of a return. */
const ASKS_REASON = /(?<![\u0590-\u05FF])(?:מה\s+(?:ה)?סיבת|מה\s+הסיבה|למה\s+(?:את|אתה|אתם)?\s*(?:רוצה|רוצים|מבקשת|מבקש)|מה\s+לא\s+(?:התאים|היה\s+בסדר|מתאים))[^.!?\n]*\?|\b(?:what(?:'s| is) the reason|why (?:do|would) you (?:want|like))[^.!?\n]*\?/iu;
/** The customer already said why ("כי", "לא מתאים", "פגום", "קטן מדי", "גדול", "טעיתי"). */
const GAVE_REASON = /(?<![\u0590-\u05FF])(?:כי|מפני\s+ש|בגלל|לא\s+(?:מתאים|מתאימה|התאים|התאימה|אהבתי|עובד|עובדת|נכנס|נכנסת)|פגום|פגומה|שבור|שבורה|קטן|קטנה|גדול|גדולה|טעיתי|הזמנתי\s+בטעות|הגיע\s+(?:לא|אחר)|לא\s+מה\s+שהזמנתי)(?![\u0590-\u05FF])|\b(?:because|doesn'?t fit|too (?:small|big|large)|broken|damaged|wrong (?:item|size|colou?r)|by mistake)\b/iu;
export const gaveReason = (inbound: string[]) => inbound.some((m) => GAVE_REASON.test(String(m ?? "")));
export const dropSentencesMatching = (s: string, re: RegExp) => dropSentences(String(s ?? ""), re);
export const asksReasonRe = ASKS_REASON;


// ── Attributes and the named product's price (prod 2026-11-18, Smoovee) ──

/**
 * An attribute the reply states needs its own word in the product data or the knowledge (cbajlg: "המשטחים
 * מפרספקס שקוף" from "בסיס: פרספקס"; the team: "אין לנו שקוף"). Transparency, colours and material properties.
 * A sentence that says it does not know, or denies, is no claim.
 */
const ATTRIBUTES: RegExp[] = [
  /(?<![\u0590-\u05FF])[הוב]?שקופ|\b(?:transparent|see-through|clear acrylic)\b/iu,
  /(?<![\u0590-\u05FF])[הוב]?(?:עמיד|עמידה|עמידים|עמידות)\s+(?:ב)?(?:מים|חום|שריטות|שבירה)|\b(?:waterproof|water-resistant|heat-resistant|scratch-resistant|shatterproof)\b/iu,
  /(?<![\u0590-\u05FF])(?:נגד\s+החלקה|מונע\s+החלקה|מונעת\s+החלקה|אנטי[-\s]?סליפ)|\b(?:non-slip|anti-slip)\b/iu,
  /(?<![\u0590-\u05FF])[הוב]?(?:מתקפל|מתקפלת|מתקפלים)|\bfoldable\b/iu,
  /(?<![\u0590-\u05FF])[הוב]?(?:מדיח|למדיח)|\bdishwasher\b/iu,
];
const COLOURS = ["תכלת", "שחור", "לבן", "אדום", "כחול", "ירוק", "צהוב", "ורוד", "אפור", "חום", "סגול", "כתום", "זהב", "כסף", "בז'", "black", "white", "red", "blue", "green", "yellow", "pink", "grey", "gray", "brown", "purple", "orange", "gold", "silver", "beige"];
const COLOUR_RE = (c: string) => new RegExp(/^[a-z]/i.test(c) ? `\\b${c}\\b` : `(?<![\\u0590-\\u05FF])[הובמ]?${c.replace("'", "['׳]")}(?:ה|ים|ות)?(?![\\u0590-\\u05FF])`, "iu");
const NOT_A_CLAIM = /(?<![\u0590-\u05FF])(?:לא|אין|אינו|אינה|אינם|ללא)(?![\u0590-\u05FF])|\b(?:not|no|without)\b|\?\s*$/iu;
const PRODUCT_COLOUR_SAID = /(?<![\u0590-\u05FF])[וש]?(?:מגיע|מגיעה|מגיעים|מגיעות|קיים|קיימת|קיימים|קיימות|יש|זמין|זמינה|זמינים|זמינות|נמכר|נמכרת|מוצע|מוצעת)(?![\u0590-\u05FF])[^.!?\n]{0,30}(?<![\u0590-\u05FF])(?:גם\s+)?(?:ב[\u0590-\u05FF]{2,}|גוון|צבע)|\b(?:comes? in|available in|also in)\b/iu;
/**
 * The sentence is said of a product by NAME (the 92486ac8 probe: any knowledge word was "a product"): a candidate
 * title or a distinctive word of one; a Latin name the evidence also has ("Cover me"); or a definite product noun
 * opening the sentence that the evidence names ("המייקאפ ..."), never a body, skin or attribute word.
 */
const NOT_PRODUCT_SUBJECT = new Set(["עור", "גוון", "צבע", "גוונים", "צבעים", "ורידים", "וורידים", "ורידים", "יד", "פנים", "שיער", "עיניים", "תת", "מידה", "מידות", "גודל", "בד", "חומר"]);
function productSubject(sentence: string, evidence: string, titles: string[]): boolean {
  const x = String(sentence ?? "").toLowerCase();
  const ev = String(evidence ?? "").toLowerCase();
  if (titles.some((t) => { const tt = String(t ?? "").toLowerCase().trim(); return tt.length >= 3 && (x.includes(tt) || (tt.match(/[\p{L}]{4,}/gu) ?? []).some((w) => !COLOURS.includes(w) && x.includes(w))); })) return true;
  const latin = (String(sentence ?? "").match(/[A-Za-z][A-Za-z'-]{2,}(?:\s+[A-Za-z][A-Za-z'-]*)*/g) ?? []).filter((w) => !COLOURS.includes(w.toLowerCase()));
  if (latin.some((w) => ev.includes(w.toLowerCase()))) return true;
  const first = (String(sentence ?? "").match(/[\p{L}]+/gu) ?? [])[0] ?? "";
  const bare = first.replace(/^ה/u, "");
  return first !== bare && bare.length >= 3 && !NOT_PRODUCT_SUBJECT.has(bare) && new RegExp(`(?<![\\p{L}])${bare}(?![\\p{L}])`, "u").test(ev);
}
// A Hebrew colour is grounded by its English name in an English catalogue ("תכלת" by "Light Blue", "כחול-לבן" by "Blue
// Stripe ... blue-and-white", dev round on 51d0273e).
const COLOUR_EN: Record<string, string[]> = { שחור: ["black"], לבן: ["white", "ivory", "cream"], אדום: ["red", "burgundy"], כחול: ["blue", "navy", "denim"], ירוק: ["green", "olive", "khaki"], צהוב: ["yellow", "mustard"], ורוד: ["pink", "rose", "blush"], אפור: ["grey", "gray", "charcoal", "melange"], חום: ["brown", "tan", "camel", "chocolate"], סגול: ["purple", "lilac", "violet"], כתום: ["orange", "rust"], זהב: ["gold"], כסף: ["silver"], "בז'": ["beige", "sand", "nude"], תכלת: ["light blue", "sky blue", "baby blue"] };
function colourInEvidence(c: string, evidence: string): boolean {
  if (COLOUR_RE(c).test(evidence)) return true;
  const ev = evidence.toLowerCase();
  return (COLOUR_EN[c] ?? []).some((en) => new RegExp(`\\b${en}\\b`, "i").test(ev));
}
export function ungroundedAttribute(reply: string, evidence: string, incoming = "", titles: string[] = []): string[] {
  const ev = unfinal(String(evidence ?? "").toLowerCase());
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => {
    if (NOT_A_CLAIM.test(x) || NO_INFO.test(x)) return false;
    const t = unfinal(x.toLowerCase());
    if (ATTRIBUTES.some((re) => { const u = new RegExp(unfinal(re.source), re.flags); return u.test(t) && !u.test(ev); })) return true;
    // A colour the data does not give. In a general explanation a colour that is said of no product passes ("איך אדע
    // מה התת גוון": the veins' colours); one said of a product ("מגיע/קיים/יש ... בגוון", a product's name) never does.
    // Checked only in the clause that says it OF a product (d2f10620 queue: "כדי לבחור גוון מייקאפ אפשר לבדוק את
    // הוורידים: כחולים..." names the product in another clause).
    if (explanationAsk(incoming)) {
      const said = x.split(/[:;,]|\s-\s/u).filter((c) => PRODUCT_COLOUR_SAID.test(c) || productSubject(c, String(evidence ?? ""), titles));
      return said.some((c) => COLOURS.some((col) => COLOUR_RE(col).test(c) && !colourInEvidence(col, String(evidence ?? ""))));
    }
    return COLOURS.some((c) => COLOUR_RE(c).test(x) && !colourInEvidence(c, String(evidence ?? "")));
  }).map((x) => x.trim().slice(0, 120));
}

/**
 * A price next to a product must be THAT product's (a08a83: "סמובי אלכסה... במחיר 158.76 ₪", Ariel's price;
 * Alexa is 227). A sentence naming exactly one product, with a price that is none of its own (its price, or the
 * sale's before and after), is a claim.
 */
const NAMED_PRICE = /(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:₪|ש["״']?ח|ils|nis)|(?:₪|ils\s*|nis\s*)(\d{1,5}(?:[.,]\d{1,2})?)/giu;
export function namedOnce(sentence: string, candidates: Array<{ title?: string }>): number {
  const t = String(sentence ?? "").toLowerCase();
  const bare = (x: string) => x.toLowerCase().replace(/\s*\d{2,3}(?:\.\d)?\s*[x×*]\s*\d{2,3}(?:\.\d)?.*$/u, "").trim();
  const hits = candidates.map((c, i) => ({ i, title: String(c?.title ?? "") })).filter((c) => c.title && (t.includes(c.title.toLowerCase()) || (bare(c.title).length >= 4 && t.includes(bare(c.title)))));
  // The longest match wins over a shorter title it contains ("סמובי אליס" inside "סמובי אליס XL").
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.title.length > h.title.length && o.title.toLowerCase().includes(h.title.toLowerCase())));
  return kept.length === 1 ? kept[0].i : -1;
}
export function priceOfOtherProduct(reply: string, candidates: Array<{ title?: string; price?: unknown; discount?: { was?: unknown; now?: unknown } | null }>): string[] {
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => {
    const i = namedOnce(x, candidates);
    if (i < 0) return false;
    const c = candidates[i];
    const own = [c.price, c.discount?.was, c.discount?.now].map((v) => Number(String(v ?? "").replace(",", "."))).filter((v) => v > 0);
    if (!own.length) return false;
    const said = [...x.matchAll(NAMED_PRICE)].map((m) => Number(String(m[1] ?? m[2]).replace(",", ".")));
    return said.some((v) => !own.some((o) => Math.abs(o - v) < 0.011));
  }).map((x) => x.trim().slice(0, 120));
}

/** The message also asks about something other than the held subject (a question clause not about it). */
export function asksOtherTopic(incoming: string): boolean {
  return String(incoming ?? "").split(/(?<=[?؟.!\n])\s*/u).some((c) => c.trim() && /[?؟]|^(?:מה|איך|יש|האם|מתי|איפה|כמה|אפשר|how|what|is|are|do|can)\b/iu.test(c.trim()) && !aboutHeld(c) && !statusAsk(c));
}


/**
 * A fit denied with nothing behind it (rating 657e5f85: "סמובי אליס מתאים... לא לקריספי", "למיקסר לא
 * התקבלה התאמה לפי המידות", both wrong). Kept only when the product's own text says it does not fit, or the
 * customer's base is bigger than the pad on an axis (pad >= base on both, either way round).
 */
const NEG_FIT = /(?:מתאים|מתאימה|מתאימים|מתאימות)[^.!?\n]{0,60}[,\s]\s*(?:אבל\s+|ו)?לא\s+ל[\u0590-\u05FF'"״]{3,}|(?<![֐-׿])(?:לא\s+(?:מתאים|מתאימה|מתאימים|מתאימות|יתאים|תתאים|מתאים\s+ל)|(?:אין|(?:לא|טרם)\s+(?:התקבלה|נמצאה|קיימת|עלתה|עלו|נמצאו|נקבעה|נקבעו|נבדקה|ידועה))\s+(?:לנו\s+)?התאמה)(?![֐-׿])|\b(?:(?:does|do|will)n'?t fit|(?:is|are) not compatible|no (?:matching|suitable) (?:pad|size|product))\b/iu;
const SIZE_PAIR = /(\d{2,3}(?:\.\d)?)\s*(?:[x×*]|על)\s*(\d{2,3}(?:\.\d)?)/iu;
export const sizePair = (t: string): [number, number] | null => { const m = SIZE_PAIR.exec(String(t ?? "")); return m ? [Number(m[1]), Number(m[2])] : null; };
export const padFits = (pad: [number, number], base: [number, number]) => { const [a, b] = [...pad].sort((x, y) => x - y), [c, d] = [...base].sort((x, y) => x - y); return a >= c && b >= d; };
export function ungroundedNegativeFit(reply: string, incoming: string, titles: string[], grounding: string): string[] {
  const base = sizePair(incoming);
  const groundedNo = NEG_FIT.test(String(grounding ?? ""));
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => {
    if (!NEG_FIT.test(x)) return false;
    if (groundedNo) return false;
    // The sentence's product, by its title, and its size from the title.
    const t = titles.find((title) => title && x.toLowerCase().includes(String(title).toLowerCase().split(/\s+/).slice(0, 2).join(" ")));
    const pad = t ? sizePair(t) : null;
    // A size comparison proves the misfit: the claim stands.
    if (base && pad && !padFits(pad, base)) return false;
    return true;
  }).map((x) => x.trim().slice(0, 120));
}
/** The products whose size (from the title) takes the customer's base: for the correction note, store titles only. */
export function fittingBySize(incoming: string, titles: string[]): string[] {
  const base = sizePair(incoming);
  if (!base) return [];
  return titles.filter((t) => { const pad = sizePair(t); return !!pad && padFits(pad, base); });
}

/**
 * Several items in one ask (rating 657e5f85: a mixer, a toaster and a blender, two left unanswered). The short
 * items joined by commas or "ו", each named by its first content word; those the reply never names.
 */
export function unansweredItems(reply: string, incoming: string): string[] {
  const parts = String(incoming ?? "").split(/\s*,\s*|\s+(?:ו(?=[\u0590-\u05FF]{3,})|and\s+|או\s+)/u).map((x) => x.replace(/[?!.]/g, "").trim()).filter(Boolean);
  // A list: the first part may be the ask ("יש לכם משטח למיקסר"), each part after it is a short item.
  if (parts.length < 2 || parts.slice(1).some((x) => x.split(/\s+/).length > 2)) return [];
  const content = (x: string) => (x.match(/\p{L}{3,}/gu) ?? []).filter((w) => !ASK_STOP.has(w.toLowerCase()) && !STEM_STOP.has(w.toLowerCase()));
  const heads = [content(parts[0]).at(-1), ...parts.slice(1).map((x) => content(x)[0])].filter(Boolean) as string[];
  if (heads.length < 2) return [];
  const r = String(reply ?? "").toLowerCase();
  return heads.filter((w) => !nounKeys(w).some((k) => r.includes(k)));
}

/** The customer's head noun: the first content word of the ask ("מטפחת" in "מטפחת חגיגית בגווני כחול"). */
export function headNoun(incoming: string): string | null {
  // A joined "ו" is no noun of its own ("ומה עם מטפחת": rating 052f53ad read "ומה").
  const stop = (w: string) => ASK_STOP.has(w) || STEM_STOP.has(w);
  return (String(incoming ?? "").match(/\p{L}{3,}/gu) ?? []).find((w) => { const l = w.toLowerCase(); return !stop(l) && !(/^ו[\u0590-\u05FF]{2,}/u.test(l) && stop(l.slice(1))); }) ?? null;
}
/**
 * Is the product of the customer's noun's kind? Its title, category or own text holds the noun. A product is
 * ruled out only with evidence it is another kind: a category in the noun's own script that does not hold it
 * (a Latin "Canvas Tote" for "תיק" is not ruled out; a "קשתות" arch for "מטפחת" is).
 */
export function ofNoun(c: { title?: string; attributes?: Record<string, unknown>; details?: string }, noun: string): boolean {
  const hebrew = /[\u0590-\u05FF]/;
  const hay = `${c?.title ?? ""} ${String(c?.attributes?.category ?? "")} ${c?.details ?? ""}`.toLowerCase();
  if (nounKeys(noun).some((k) => hay.includes(k))) return true;
  const cat = String(c?.attributes?.category ?? "");
  return !(cat && hebrew.test(cat) === hebrew.test(noun));
}
/** A noun's match keys: its first four letters, with and without a possible prefix letter ("מטפחת" keeps its מ). */
export function nounKeys(noun: string): string[] {
  const full = String(noun ?? "").toLowerCase();
  const bare = full.replace(/^[הובלמש](?=[\u0590-\u05FF]{3,})/u, "");
  return [...new Set([full, bare].map((x) => (x.length >= 5 ? x.slice(0, 4) : x)))];
}


/**
 * "<product> fits <device>" with nothing behind it (rating ed780586: "סמובי אסף מתאים גם לנינג'ה קריספי...
 * מופיע במפרט כמתאים לנינג'ה גריל XL", reasoning from another model). Kept when the device's own words are in
 * the product data or the knowledge, or a size comparison takes the customer's base; "similar model"
 * reasoning is cut.
 */
const SIMILAR_MODEL = /(?<![֐-׿])[לבכמוה]?(?:דגם\s+דומה|בדומה\s+ל|דומה\s+ל(?:דגם|מכשיר)|מכשיר\s+דומה|כמו\s+(?:ה)?דגם)(?![֐-׿])|\b(?:a similar model|similar to the|like the .{1,30} model)\b/iu;
const FIT_CLAIM = /(?<![֐-׿])[שו]?(?:מתאים|מתאימה|מתאימים|יתאים|תתאים)\s+(?:גם\s+)?ל(?!כם|ך|י\b)([֐-׿'"״A-Za-z0-9 -]{3,40})/u;
// The device first: "לנינג'ה קריספי מתאים סמובי אליס", "לנינג'ה קריספי מופיעים כמתאימים ..." (rating ed780586, B).
const FIT_CLAIM_REV = /(?<![\u0590-\u05FF])ו?ל(?!כם|ך|י\b)([\u0590-\u05FF'"״A-Za-z0-9 -]{3,40}?)\s+(?:מתאים|מתאימה|מתאימים|מתאימות|יתאים|(?:מופיע|מופיעה|מופיעים|מופיעות)\s+כ(?:מתאים|מתאימה|מתאימים|מתאימות))(?![\u0590-\u05FF])/u;
const ALT_OFFER = /(?<![\u0590-\u05FF])(?:או|לחלופין|אפשר\s+גם|כאלטרנטיבה|כחלופה|במקום\s+זה)(?![\u0590-\u05FF])|\b(?:alternatively|instead|or you could|as an alternative)\b/iu;
const USE_WORDS = new Set(["כיסוי", "שימוש", "יום", "יומיום", "ערב", "ערבים", "אירוע", "אירועים", "חג", "חגים", "קיץ", "חורף", "אביב", "סתיו", "עבודה", "משרד", "ים", "חוף", "טיול", "טיולים", "שיער", "עור", "פנים", "גוף", "ילדים", "ילדות", "נשים", "גברים", "מתנה", "מתנות", "קשירה", "חתונה", "שבת", "ספורט", "כל", "רוב", "מראה", "סגנון", "use", "everyday", "daily", "evening", "summer", "winter", "work", "office", "travel", "beach", "hair", "skin", "kids", "gift", "gifts", "weddings", "wedding", "sport", "sports"]);
const FIT_VERB = /(?<![\u0590-\u05FF])[שו]?(?:מתאים|מתאימה|מתאימים|מתאימות|יתאים|יתאימו|תתאים)(?![\u0590-\u05FF])/u;
// "לא/אינו" right before the fit verb (one word between at most, never across a comma); or "לא/אין (לנו) מצוין/כתוב/ידוע/
// אישור/מידע/מופיע/בטוח/ברור ש..." with the fit verb inside that same ש clause (the 92486ac8 probe: "אין מידע על שינוי,
// X מתאים", "אין לנו מידע שסותר את זה: X מתאים").
const NEG_DIRECT = /(?<![\u0590-\u05FF])ו?(?:לא|אינו|אינה|אינם|אינן)\s+(?:[\u0590-\u05FF]+\s+)?(?:מתאים|מתאימה|מתאימים|מתאימות|יתאים|יתאימו|תתאים)(?![\u0590-\u05FF])/u;
const NEG_THAT = /(?<![\u0590-\u05FF])ו?(?:לא|אין)\s+(?:(?:לנו|לי|כרגע|בכלל)\s+)*(?:מצוין|מצוינת|כתוב|כתובה|ידוע|ידועה|אישור|מידע|מופיע|מופיעה|בטוח|בטוחה|ברור)\s+(?:(?:לנו|לי|כרגע|בכלל)\s+)*ש([^,.:;!?\n]*)/gu;
const NEG_GOVERNS_FIT = { test: (x: string) => NEG_DIRECT.test(x) || [...String(x).matchAll(NEG_THAT)].some((m) => FIT_VERB.test(String(m[1]).split(/\s(?=ו[\u0590-\u05FF])/u)[0])) };
const NEG_GOVERNS_FIT_EN = /\b(?:does ?n[o']t|won'?t|will not|is ?n[o']t|not)\s+(?:fit|suit|work with)|\bno (?:confirmation|information|indication|record)\b[^,.!?\n]{0,30}\bthat\b|\bnot (?:stated|listed|confirmed)\b[^,.!?\n]{0,10}\bthat\b/iu;
export function ungroundedPositiveFit(reply: string, incoming: string, titles: string[], grounding: string, knowledge: string): string[] {
  const proofText = `${grounding ?? ""}\n${knowledge ?? ""}`;
  const lines = proofText.split(/\n|;|(?<=\.)\s+/).map((l) => l.toLowerCase()).filter(Boolean);
  const base = sizePair(incoming);
  const whole = String(reply ?? "").toLowerCase();
  const FILL = new Set(["שלך", "שלכם", "שלכן", "שלי", "שלו", "שלה", "הזה", "הזו", "הזאת", "ביותר", "מאוד", "לגמרי", "בדיוק", "your", "yours", "mine", "exactly"]);
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => {
    if (SIMILAR_MODEL.test(x)) return true;
    if (NEG_FIT.test(x)) return false;
    // "ולא מצוין שהוא מתאים למתחת לעיניים" says the fit is NOT known (prod replay of b369e939, NE'A): no claim.
    // Only a negation that governs the fit verb: right before it, or through "מצוין/כתוב/ידוע/אישור/מידע ... ש"; never a
    // set phrase across a comma ("אין בעיה, X מתאים", "ללא ספק X מתאים", "לא רק זה": the 48f3a261 probe).
    if (NEG_GOVERNS_FIT.test(x) || NEG_GOVERNS_FIT_EN.test(x)) return false;
    const m = FIT_CLAIM_REV.exec(x) ?? FIT_CLAIM.exec(x);
    if (!m) return false;
    const named = namedTitles(x, titles);
    if (!named.length) return false;
    const target = (m[1].match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !ASK_STOP.has(w.toLowerCase()) && !STEM_STOP.has(w.toLowerCase()) && !FILL.has(w.toLowerCase()));
    if (!target.length) return false;
    // A use, never a device: "מתאימה גם לכיסוי מלא", "מתאים לשימוש יומיומי", "לקיץ" (prod replay of 9480dfb2,
    // Tehila: the recommendation sentence was cut as an unbacked device fit).
    if (USE_WORDS.has(target[0].toLowerCase())) return false;
    // Offered as an ALTERNATIVE for her device while it fits another one (rating 1771ba14: "או לראות את סמובי
    // כריסטינה שמתאימה לנינג'ה סלושי" to a Crispy owner): cut, whatever proves the other fit.
    const asked = String(incoming ?? "").toLowerCase();
    // Every word of the device it fits must be hers: "נינג'ה" alone is shared by her Crispy and the Slushi.
    if (ALT_OFFER.test(x) && !target.every((w) => nounKeys(w).some((k) => asked.includes(k)))) return true;
    // Each product the sentence claims needs its own proof (rating ed780586: Alice is right, Assaf and
    // Christina were added).
    return named.some((title) => {
      const pad = sizePair(title);
      if (base && pad && padFits(pad, base)) return false;
      const own = (title.toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter((w) => titles.length < 2 || !titles.every((t) => t.toLowerCase().includes(w)));
      const ofIt = lines.filter((l) => own.some((w) => l.includes(w)));
      // The device's own words in a line about this product (its fit list, the device table).
      if (ofIt.some((l) => target.every((w) => nounKeys(w).some((k) => l.includes(k))))) return false;
      // A table CATEGORY the reply names ("סיר טיגון ללא שמן נינג'ה: סמובי אליס"): the model mapped her model
      // to its category, and says so.
      const byCategory = ofIt.some((l) => {
        // A table line: the category before the colon, this product after it (not "<product> מתאים ל: ...").
        const [cat0, ...after] = l.includes(":") ? l.split(":") : [""];
        const cat = own.some((w) => cat0.includes(w)) || !own.some((w) => after.join(":").includes(w)) ? "" : cat0.trim();
        const words = (cat.match(/\p{L}{3,}/gu) ?? []).filter((w) => !STEM_STOP.has(w));
        return words.length >= 2 && words.filter((w) => whole.includes(w)).length >= Math.min(2, words.length);
      });
      return !byCategory;
    });
  }).map((x) => x.trim().slice(0, 120));
}

/** A restock or availability-date ask ("מתי יחזור למלאי", "when is it back in stock"). */
export const restockAsk = (incoming: string) => /(?<![֐-׿])(?:מתי\s+(?:י|ת)?(?:חזור|חזרו|תחדש|גיע|גיעו|יהיה|תהיה)|(?:יחזור|תחזור|יחזרו|יתחדש|יתמלא)\s+(?:ל)?(?:ה)?מלאי|חידוש\s+(?:ה)?מלאי|חזרה\s+למלאי|ייכנס\s+למלאי)(?![֐-׿])|\b(?:restock|back in stock|in stock again|when will .{1,30} (?:be )?(?:available|back))\b/iu.test(String(incoming ?? ""));

/** The same clarifying question asked again (rating ed780586: "על מה מדובר" twice in a row). */
export function repeatsQuestion(reply: string, lastBotReply: string): boolean {
  const q = (t: string) => (String(t ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n])+\?/g) ?? []).map((x) => x.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase()).filter((x) => x.length >= 4);
  const mine = q(reply), before = new Set(q(lastBotReply));
  return mine.length > 0 && mine.some((x) => before.has(x));
}

/** The customer named the product kind in so many words ("טינט", "בובון"): the products that are that kind. */
export function productsOfNoun<T extends { title?: string }>(candidates: T[], incoming: string): T[] | null {
  const noun = headNoun(incoming);
  if (!noun) return null;
  const keys = nounKeys(noun);
  const hit = candidates.filter((c) => keys.some((k) => String(c?.title ?? "").toLowerCase().includes(k)));
  return hit.length ? hit : null;
}
/** The reply names a product of another kind while some products ARE her noun (rating ed780586, NE'A: a freckle pen for "טינט"). */
export function wrongProductType(reply: string, incoming: string, titles: string[]): boolean {
  const mine = productsOfNoun(titles.map((title) => ({ title })), incoming);
  if (!mine) return false;
  const ofHers = new Set(mine.map((m) => m.title));
  const others = titles.filter((t) => !ofHers.has(t));
  return others.some((t) => namesCandidate(reply, [t])) && !mine.some((m) => namesCandidate(reply, [String(m.title)]));
}

/** "אם זה דגם אחר..." left after a cut took the model it was about (rating ed780586). */
const OTHER_MODEL_IF = /^\s*(?:ו?אם\s+(?:זה|מדובר\s+ב|יש\s+לך)\s*(?:ה)?(?:דגם|מכשיר|גודל)\s+(?:אחר|שונה)|if (?:it'?s|you have) a different (?:model|device|size))/iu;
export function dropOrphanConditional(text: string, titles: string[]): string {
  const parts = String(text ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*\s*|\n+/g) ?? [String(text ?? "")];
  let before = "";
  const out: string[] = [];
  for (const x of parts) {
    if (OTHER_MODEL_IF.test(x) && !namesCandidate(before, titles) && !/\d/.test(before)) continue;
    out.push(x); before += x;
  }
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/** For the engine's own cuts (restock, payment): the same patterns the checks use. */
export const RETURNS_WORK_RE = RETURNS_WORK;
export const NO_INFO_RE = NO_INFO;
export const dropSentencesBy = (s: string, re: RegExp) => dropSentences(s, re);


/** A request made as an imperative, with no "?" ("תעדכנו בבקשה ושלחו לי מספר הזמנה"): a direct ask. */
const IMPERATIVE_ASK = /(?<![֐-׿])[ו]?(?:שלחו|תשלחו|שלחי|תשלחי|שלח|תשלח|עדכנו|תעדכנו|עדכני|תעדכני|עדכן|תעדכן|תבדקו|תבדקי|תגידו|תגידי|תחזרו|תחזרי|תסבירו|תסבירי|תכתבו|תכתבי|תודיעו|תודיעי)(?![֐-׿])|\b(?:please (?:send|update|tell|check|let me know)|send me|let me know|tell me)\b/iu;
export const imperativeAsk = (incoming: string) => IMPERATIVE_ASK.test(String(incoming ?? ""));

/** A claim that something was added or passed on ("הוספתי את זה לבדיקה", "עדכנתי את הצוות"). */
export const ADDED_CLAIM = /(?<![֐-׿])(?:הוספתי|הוספנו|צירפתי|צירפנו|עדכנתי|עדכנו)\s+(?:את\s+)?(?:זה|הפרטים|המידע|המספר|הצוות|לבדיקה|לתיק|לפנייה)|\b(?:i(?:'ve| have) (?:added|attached|updated) (?:it|this|the (?:details|team)))\b/iu;

/** Each item the customer gave with its base size: "<words> 28x18" (x, ×, *), commas or not. */
export function sizedItems(incoming: string): Array<{ size: [number, number]; at: number; name: string }> {
  const t = String(incoming ?? "");
  const out: Array<{ size: [number, number]; at: number; name: string }> = [];
  let from = 0;
  for (const m of t.matchAll(/(\d{2,3}(?:\.\d)?)\s*[x×*X]\s*(\d{2,3}(?:\.\d)?)/gu)) {
    const at = m.index ?? 0;
    // The item's name: the last two words before its size ("נינג׳ה קרמה 28x18", "סודה 18x14").
    const words = (t.slice(from, at).match(/[\p{L}'׳"]{2,}/gu) ?? []).filter((w) => !ASK_STOP.has(w.toLowerCase()) && !STEM_STOP.has(w.toLowerCase()));
    out.push({ size: [Number(m[1]), Number(m[2])], at, name: words.slice(-2).join(" ") });
    from = at + m[0].length;
  }
  return out;
}
/** The reply already answers this item by its device name ("לסודה: גפן"). */
export function namesItem(reply: string, name: string, otherNames: string[] = []): boolean {
  const r = String(reply ?? "").toLowerCase();
  // A word another item shares (the brand "נינג׳ה" of two Ninja devices) tells neither apart.
  const others = otherNames.flatMap((n) => String(n ?? "").match(/[\p{L}]{3,}/gu) ?? []).flatMap((w) => nounKeys(w));
  return (String(name ?? "").match(/[\p{L}]{3,}/gu) ?? []).filter((w) => !nounKeys(w).some((k) => others.includes(k))).some((w) => nounKeys(w).some((k) => r.includes(k)));
}
/** The smallest pad (by area) whose size takes the base, either way round; null when none does. */
export function smallestFitting(base: [number, number], titles: string[]): string | null {
  const fits = titles.map((t) => ({ t, pad: sizePair(t) })).filter((x): x is { t: string; pad: [number, number] } => !!x.pad && padFits(x.pad, base));
  fits.sort((a, b) => a.pad[0] * a.pad[1] - b.pad[0] * b.pad[1]);
  return fits[0]?.t ?? null;
}

/** An apology or thanks alone, a "you're right" in front allowed ("נכון, סליחה על הבלבול."). */
export const apologyOnly = (text: string) => ackOnly(String(text ?? "").replace(/^\s*(?:נכון|אכן|צודקת|צודק|צודקים|you'?re right|right|true)[,!.]?\s*/iu, ""));

/** Pads named with their size in the business's texts ("סמובי אליס 31*41"), as "<name> <WxD>" titles. */
const SIZE_WORDS = new Set(["מידות", "מידה", "גודל", "גדלים", "בגודל", "במידה", "במידות", "size", "sizes", "cm", "סמ", "ס\"מ", "x"]);
export function padsFromText(text: string): string[] {
  // A name that is a real word, not "מידות" or another size (rating 052f53ad: lines named only sizes).
  return sizedItems(text).filter((x) => x.name && x.name.split(/\s+/).some((w) => /\p{L}{2,}/u.test(w) && !SIZE_WORDS.has(w.toLowerCase()))).map((x) => `${x.name} ${x.size[0]}*${x.size[1]}`);
}



/**
 * The link for a how-to or video ask, from the business's own texts (C pinned rating, NE'A: "אשמח לסרטון הדרכה"
 * about an eyebrow pen got the first link in the knowledge, a mascara's page). A line with a link that shares a
 * product word of the subject (her messages first, then the bot's last ones) wins, a video line first among
 * equals; else the one video link the texts have; else none, and the turn goes to the team.
 */
const HOWTO_WORDS = new Set(["איך", "משתמשים", "שימוש", "להשתמש", "סרטון", "לסרטון", "סרטונים", "הדרכה", "מדריך", "קישור", "לינק", "אשמח", "תודה", "אפשר", "לקבל", "תשלחי", "תשלחו", "שלחי", "video", "link", "tutorial", "how", "use"]);
const VIDEO_LINE = /סרטון|הדרכה|מדריך|video|youtu|vimeo/iu;
// A media file is never "the link" (prod replay of 9480dfb2, NE'A: a product's .webp sent as the video).
const MEDIA_FILE = /\.(?:webp|jpe?g|png|gif|svg|bmp|avif|ico|heic|tiff?)(?:[?#]|$)|\/wp-content\/uploads\/(?!.*\.(?:mp4|mov|webm|m4v)(?:[?#]|$))/i;
const PDF_FILE = /\.pdf(?:[?#]|$)/i;
const VIDEO_URL = /youtu\.?be|vimeo\.com|\.(?:mp4|mov|webm|m4v)(?:[?#]|$)/i;
/** The ask wants a video (סרטון, הדרכה, video, tutorial), not only a link. */
// A video ask, broadly; only a video word that qualifies another noun is none (the 92486ac8 probe: a lead-word list
// missed real phrasing): a plural or construct form after a ל-noun or "של" ("מעמד לצילום סרטונים"), or one that
// carries the ל itself ("לסרטונים", "לסרטוני טיקטוק").
const VIDEO_ANY = /(?<![\u0590-\u05FF])([והל]{0,2})(סרטון|סרטונים|סרטוני|הדרכה|הסבר)(?![\u0590-\u05FF])|\b(?:video|videos|tutorial|tutorials)\b/giu;
export const videoAsk = (incoming: string) => {
  const t = String(incoming ?? "");
  for (const m of t.matchAll(VIDEO_ANY)) {
    if (!m[2]) return true;
    const plural = /^(?:סרטונים|סרטוני)$/u.test(m[2]);
    if (!plural) { if (m[2] !== "הסבר") return true; continue; }
    const before = t.slice(0, m.index).trim().split(/\s+/).pop() ?? "";
    // "יש לכם סרטונים?", "אפשר לקבל סרטונים?": a pronoun or an infinitive before it is no noun it qualifies.
    const pronounOrVerb = /^(?:לכם|לך|לי|לנו|להם|להן|לקבל|לשלוח|לראות|לצפות|למצוא|להוריד|לשתף)$/u.test(before);
    const qualifies = /ל/u.test(m[1] ?? "") || (/^ל[\u0590-\u05FF]{2,}$/u.test(before) && !pronounOrVerb) || before === "של";
    if (!qualifies) return true;
  }
  return false;
};
export function howToLink(kb: string, subjects: string[], video = false): string | null {
  // Media files out; for a video ask, a video link only (a host or a video file), never a page that merely mentions one.
  // An instructions PDF is a fine answer to a plain how-to ask (never to a video ask).
  const usable = (u: string) => (!MEDIA_FILE.test(u) || (!video && PDF_FILE.test(u))) && (!video || VIDEO_URL.test(u));
  const lines = String(kb ?? "").split(/\n+/).filter((l) => (l.match(URL_RE) ?? []).some(usable));
  if (!lines.length) return null;
  const firstUrl = (l: string) => { const us = (l.match(URL_RE) ?? []).filter(usable); return us.find((u) => VIDEO_URL.test(u)) ?? us[0] ?? null; };
  for (const subject of subjects) {
    const keys = [...new Set((String(subject ?? "").toLowerCase().match(/[\p{L}]{3,}/gu) ?? []).filter((w) => !ASK_STOP.has(w) && !STEM_STOP.has(w) && !HOWTO_WORDS.has(w) && !HOWTO_WORDS.has(w.replace(/^[הולבמש]/u, ""))).flatMap((w) => nounKeys(w)))];
    if (!keys.length) continue;
    const scored = lines.map((l) => { const text = l.replace(URL_RE, " ").toLowerCase(); return { l, s: keys.filter((k) => text.includes(k)).length + (VIDEO_LINE.test(l) ? 0.5 : 0) }; }).filter((x) => x.s >= 1);
    if (scored.length) return firstUrl(scored.sort((a, b) => b.s - a.s)[0].l);
  }
  const videos = [...new Set(lines.flatMap((l) => (l.match(URL_RE) ?? []).filter((u) => usable(u) && VIDEO_URL.test(u))))];
  return videos.length === 1 ? videos[0] : null;
}

/** "No link" while the business's data has one (rating 052f53ad: youtu.be in the product data). */
export function deniesKnownLink(reply: string, sources: string): string[] {
  if (!(String(sources ?? "").match(URL_RE) ?? []).length) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => DENIES_LINK.test(x)).map((x) => x.trim().slice(0, 120));
}

/** "No information" in a how-to answer: "אין לי כאן הנחיה", besides the general no-info forms. */
export const noHowToInfo = (reply: string) => noInfo(reply) || /(?<![\u0590-\u05FF])(?:אין\s+(?:לי|לנו)\s+(?:(?:כרגע|כאן)\s+)*(?:הנחיה|הנחיות|הוראות|מידע|פרטים)|לא\s+(?:מצאתי|מצאנו)\s+(?:הנחיה|הוראות|מידע))(?![\u0590-\u05FF])|\b(?:no (?:instructions|guidance|information)|(?:don'?t|do not) have (?:instructions|guidance|information))\b/iu.test(String(reply ?? ""));

/** A how-to or safety question about the product in use ("התהפך", "נופל", "מעצור", "בטוח"). */
export const howToSafetyAsk = (incoming: string) => /(?<![֐-׿])[והש]?(?:התהפך|מתהפך|מתהפכת|התהפכה|נופל|נופלת|נפל|נפלה|מחליק|מחליקה|זז|זזה|מעצור|מעצורים|המעצור|המעצורים|בטוח|בטוחה|בטיחות|יציב|יציבה|איך\s+(?:מתקינים|מניחים|שמים|משתמשים|מחברים))(?![֐-׿])|\b(?:safe|safety|tip(?:s|ped)? over|falls?|slides?|stopper|stable|how (?:do i|to) (?:install|place|use|attach))\b/iu.test(String(incoming ?? ""));

/** A pad's name for the reply: its title without the size ("סמובי אליס 31*41" -> "סמובי אליס"). */
/**
 * The pad's distinguishing name for a size line (rating 1771ba14: "למידה 32×22: משטח הזזה." three times). Its
 * title without the size, unless that leaves only words every pad shares ("משטח הזזה"): then the knowledge name of
 * the pad of the same size ("סמובי אליס"), else the whole title with its size. Never a generic noun alone.
 */
export function padName(pad: string, allPads: string[], kbPads: string[] = []): string {
  const words = (t: string): string[] => (padLabel(t).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) as string[];
  const others = allPads.filter((t) => t !== pad);
  const generic = (t: string) => {
    const w = words(t);
    if (!w.length) return true;
    // Another pad has the same name without its size: the name tells nothing apart (the knowledge's pads are in the
    // list too, so "half of the others" alone missed two store pads both "משטח הזזה").
    const key = [...new Set(w)].sort().join(" ");
    if (others.some((o) => [...new Set(words(o))].sort().join(" ") === key)) return true;
    // Every word of it is in at least half of the other pads' names: nothing tells it apart.
    return others.length > 0 && w.every((x) => others.filter((o) => words(o).includes(x)).length >= Math.max(1, Math.ceil(others.length / 2)));
  };
  if (!generic(pad)) return padLabel(pad);
  const size = sizePair(pad);
  const same = size ? kbPads.find((k) => { const z = sizePair(k); return !!z && ((z[0] === size[0] && z[1] === size[1]) || (z[0] === size[1] && z[1] === size[0])); }) : undefined;
  if (same && words(same).length && !words(same).every((x) => words(pad).includes(x))) return padLabel(same);
  return String(pad ?? "").trim();
}

export const padLabel = (title: string) => String(title ?? "").replace(/\s*\d{2,3}(?:\.\d)?\s*[x×*X]\s*\d{2,3}(?:\.\d)?\s*(?:ס["״]?מ|cm)?/giu, "").replace(/\s{2,}/g, " ").trim() || String(title ?? "");


/**
 * A sentence with an unbalanced bracket is a fragment a cut left behind (rating 1771ba14: "...פמילי ושבת. [אלכסה
 * מתאים לתמי 4"): it goes. Brackets inside a URL do not count. Run last, on the final text.
 */
export function dropBrokenFragments(text: string): { text: string; dropped: number } {
  const parts = String(text ?? "").match(URL_SENTENCES) ?? [String(text ?? "")];
  let dropped = 0;
  const kept = parts.filter((x) => {
    const t = x.replace(URL_RE, " ");
    const bad = (t.match(/\[/g) ?? []).length !== (t.match(/\]/g) ?? []).length || (t.match(/\(/g) ?? []).length !== (t.match(/\)/g) ?? []).length;
    if (bad) dropped++;
    return !bad;
  });
  if (!dropped) return { text: String(text ?? ""), dropped: 0 };
  const out = kept.join("").replace(/[ \t]{2,}/g, " ").trim();
  // Nothing left: the reply keeps its words without the stray brackets, never goes empty.
  return { text: out || String(text ?? "").replace(/[\[\]()]/g, "").replace(/\s{2,}/g, " ").trim(), dropped };
}


/**
 * "No model by that name" when she named none (rating 1771ba14: "לא מצאתי דגם בשם הזה" to "אפשר המלצה?"). A
 * sentence about a name not found, while the message holds no name: no digit, no Latin word, no quoted name, and
 * a request for a recommendation or a short ask.
 */
const NAME_MISS = /(?<![\u0590-\u05FF])(?:לא\s+(?:מצאתי|מצאנו|מצאתי\s+אצלנו)|אין\s+(?:לי|לנו))\s+(?:\S+\s+){0,2}(?:בשם\s+(?:הזה|הזאת|הזו|כזה|כזאת)|(?:דגם|מוצר|מכשיר)\s+(?:כזה|כזאת|בשם|שנקרא))|\b(?:(?:couldn'?t|could not|didn'?t) find (?:a |any )?(?:model|product) (?:by|with|called) (?:that|this) name)\b/iu;
export function nameMissUnasked(reply: string, incoming: string): string[] {
  const inc = String(incoming ?? "");
  const named = /\d|[A-Za-z]{2,}|["״'׳][^"״'׳]{2,}["״'׳]/.test(inc);
  if (named) return [];
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter((x) => NAME_MISS.test(x)).map((x) => x.trim().slice(0, 120));
}


/** A promise to go quiet ("נשאיר את זה בשקט ולא נשלח הודעה נוספת"): never in holding mode, where the team holds it. */
export const SILENCE_PROMISE = /(?<![\u0590-\u05FF])(?:נשאיר\s+(?:את\s+זה\s+)?בשקט|לא\s+(?:נשלח|אשלח|נכתוב|אכתוב)\s+(?:לך\s+)?(?:עוד\s+)?(?:הודעה|הודעות)(?:\s+נוספת|\s+נוספות)?|לא\s+(?:נטריד|אטריד)|נחכה\s+בשקט)(?![\u0590-\u05FF])|\b(?:(?:we|i)(?:'ll| will) (?:stay quiet|not (?:send|message) (?:you )?(?:again|any more|anymore))|won'?t (?:bother|message) you)\b/iu;

/**
 * A measurement the reply derives rather than reads (rating 1771ba14, Tehila: "כל צלע של המשולש היא בערך 70 ס"מ"
 * for a 70x70 square folded diagonally, about 99 in truth). A sentence with a measure and a shape word or an
 * approximation that no source states is cut.
 */
const MEASURE = /(\d+(?:[.,]\d+)?)\s*(?:ס["״']?מ|מ["״']?מ|מטר|ק["״']?ג|גרם|ליטר|cm|mm|kg|g\b|m\b|inch|")/giu;
const DERIVING = /(?<![\u0590-\u05FF])[וה]?(?:בערך|בקירוב|כ־|כ-|צלע|צלעות|אלכסון|היקף|שטח|קוטר|רדיוס|משולש|לאחר\s+קיפול|כשמקפלים|מקופל)(?![\u0590-\u05FF])|\b(?:about|approximately|roughly|side|diagonal|perimeter|area|diameter|radius|triangle|folded)\b/iu;
const CLAUSES = /\s*[,;]\s*|\s+(?=ו?(?:כל\s+צלע|כלומר)(?![\u0590-\u05FF]))|\s+(?=(?:so|which means|that is)\b)/iu;
const SHAPE_WORD = /(?<![\u0590-\u05FF])[וה]?(?:צלע|צלעות|אלכסון|היקף|שטח|קוטר|רדיוס|משולש|לאחר\s+קיפול|כשמקפלים|מקופל)(?![\u0590-\u05FF])|\b(?:side|diagonal|perimeter|area|diameter|radius|triangle|folded)\b/iu;
function inSource(m: RegExpMatchArray, src: string): boolean {
  const n = Number(String(m[1]).replace(",", "."));
  const unit = String(m[0]).slice(String(m[1]).length).trim().toLowerCase();
  const forms = new Set([String(m[1]), String(n)]);
  if (/^(?:מטר|m)$/u.test(unit)) forms.add(String(Math.round(n * 100)));
  if (/^(?:ס["״']?מ|cm)$/u.test(unit) && n >= 100) forms.add(String(n / 100));
  return [...forms].some((f) => new RegExp(`(?<![\\d.,])${f.replace(".", "\\.")}(?![\\d])`).test(src));
}
export function derivedMeasure(reply: string, sources: string): string[] {
  const src = String(sources ?? "");
  const derived = (x: string) => {
    if (!DERIVING.test(x)) return false;
    const ms = [...x.matchAll(MEASURE)];
    if (!ms.length) return false;
    // An approximation of a measure the source gives, with no shape word, is no derivation (prod replay of 9480dfb2,
    // Tehila: "70 ס"מ על כ-2 מטר" for a 70x200 scarf was cut). The number as written, or in cm or m.
    if (!SHAPE_WORD.test(x) && ms.every((m) => inSource(m, src))) return false;
    // The sentence as a source states it is no derivation; a number with a shape word that the source never
    // pairs with the shape word is.
    const shape = (x.match(DERIVING) ?? [""])[0];
    return !src.split(/\n|(?<=[.!?])\s+/).some((l) => DERIVING.test(l) && l.includes(shape.replace(/^[וה]/, "")) && ms.every((m) => l.includes(m[1])));
  };
  // The derived clause itself when the sentence has one (the stated measure beside it stays); else the sentence.
  return (String(reply ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).filter(derived).flatMap((x) => {
    const parts = x.replace(/[.!?]+\s*$/, "").split(CLAUSES).filter((c) => derived(c));
    return parts.length && parts.length < x.split(CLAUSES).length ? parts : [x];
  }).map((x) => x.trim().slice(0, 120));
}


/** A sentence without the named clauses; "" when fewer than three words are left. */
export function withoutClauses(sentence: string, marks: string[]): string {
  const x = String(sentence ?? "");
  const end = (/[.!?]+\s*$/.exec(x)?.[0] ?? "").trim() || ".";
  const clauses = x.replace(/[.!?]+\s*$/, "").split(CLAUSES);
  const kept = clauses.filter((c) => !marks.some((m) => c.trim().includes(m) || (c.trim().length >= 3 && m.includes(c.trim()))));
  if (kept.length === clauses.length) return "";
  const text = kept.join(", ").trim();
  // What is left opens with a connector or a subordinate ("וכשמקפלים אותה מתקבל משולש"): the whole sentence goes.
  if (/^\s*(?:ו?כש[\u0590-\u05FF]+|ו(?:גם|לכן|אז|אבל|כך|אם)(?![\u0590-\u05FF])|(?:אבל|אז|לכן|כי|and|but|so|which|when)\b)/iu.test(text)) return "";
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 3 ? `${text}${end} ` : "";
}

/**
 * A held RETURN and a how-to ask ("מה לעשות? איך להחזיר את המוצר ולהזדכות?", 87076cab replay, 97837): the
 * return steps from the business's own texts (window, condition, address or pickup, fee), then the team's part.
 * Never silent. Up to four lines of the knowledge about returns with a detail in them; else the model's own
 * sentences about returns that carry a number; the credit is the team's.
 */
const RETURN_TOPIC = /(?<![\u0590-\u05FF])[והלבש]?(?:החזרה|החזרת|להחזיר|החזר|החזרות|זיכוי|להזדכות|החלפה|להחליף|ביטול|לבטל)(?![\u0590-\u05FF])|\b(?:returns?|refunds?|exchanges?|cancel)\b/iu;
const RETURN_DETAIL = /\d|(?<![\u0590-\u05FF])(?:ימים|יום|ימי|מצב|אריזה|תווית|כתובת|איסוף|שליח|סניף|דמי|עלות|טופס|קבלה|חשבונית)(?![\u0590-\u05FF])|\b(?:days?|condition|packag\w*|address|pickup|courier|fee|form|receipt)\b/iu;
export const returnHowToAsk = (incoming: string) => /(?<![\u0590-\u05FF])(?:איך|כיצד|מה\s+(?:לעשות|עושים|אני\s+צריכה?)|מה\s+הדרך|איפה\s+(?:מחזירים|להחזיר))(?![\u0590-\u05FF])|\b(?:how (?:do|can|to)|what do i do|what should i do)\b/iu.test(String(incoming ?? "")) && RETURN_TOPIC.test(String(incoming ?? "")) || /(?<![\u0590-\u05FF])מה\s+לעשות(?![\u0590-\u05FF])/u.test(String(incoming ?? ""));
export const isReturnSubject = (t: string) => RETURN_TOPIC.test(String(t ?? ""));
export function returnSteps(knowledge: string, modelText: string, locale: "he" | "en"): string {
  const lines = String(knowledge ?? "").split(/\n+|(?<=[.!?])\s+/).map((l) => l.trim()).filter((l) => l.length >= 12 && l.length <= 260 && RETURN_TOPIC.test(l) && RETURN_DETAIL.test(l));
  const fromModel = (String(modelText ?? "").match(/(?:https?:\/\/[^\s]*[^\s.!?,;:)\]"'״]|[^.!?\n]|(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])|(?<=[\u0590-\u05FF0-9])\.(?=[\u0590-\u05FF0-9]))+[.!?]*/g) ?? []).map((x) => x.trim()).filter((x) => RETURN_TOPIC.test(x) && /\d/.test(x));
  const steps = [...new Set(lines.length ? lines : fromModel)].slice(0, 4);
  const team = locale === "en" ? "The team will confirm the refund details here." : "את פרטי הזיכוי הצוות יאשר כאן.";
  return [...steps, team].join(" ").replace(/\s{2,}/g, " ").trim();
}

/**
 * A size line with no product named (prod replay on 1b35c535, Smoovee: "40x50 ס"מ" listed with no tray names): the
 * one product whose own size (title, fit or text) is that pair gets its name in front. Unchanged when none or
 * several have it.
 */
export function nameSizeLines(reply: string, candidates: Array<{ title?: string; fit?: string; details?: string }>): string {
  const titles = candidates.map((c) => String(c?.title ?? "")).filter(Boolean);
  if (!titles.length) return reply;
  const same = (a: [number, number] | null, b: [number, number] | null) => !!a && !!b && ((a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]));
  return String(reply ?? "").split("\n").map((line) => {
    const pair = sizePair(line);
    if (!pair || namesCandidate(line, titles)) return line;
    const owners = candidates.filter((c) => c?.title && [c.title, c.fit ?? "", c.details ?? ""].some((t) => same(sizePair(String(t)), pair)));
    if (owners.length !== 1) return line;
    const m = /^(\s*(?:[-*•]|\d+[.)])?\s*)(.*)$/u.exec(line)!;
    return `${m[1]}${owners[0].title}: ${m[2]}`;
  }).join("\n");
}

/**
 * "יש כמה צבעים" with no colour named (prod replay on 1b35c535): the colours the product's own data lists are added.
 * The product the reply names, else the only one shown; unchanged when its data names no colours.
 */
const SEVERAL_COLOURS = /(?<![֐-׿])(?:(?:יש|מגיע|מגיעה|מגיעים|קיים|קיימת|זמין|זמינה)\s+(?:גם\s+)?(?:ב)?(?:כמה|מספר|מגוון|כמה\s+וכמה)\s+(?:צבעים|גוונים)|(?:ב)?(?:כמה|מספר|מגוון)\s+(?:צבעים|גוונים))(?![֐-׿])|\b(?:(?:several|multiple|a few|various|a range of|many) colou?rs)\b/iu;
const COLOUR_FACT = /(?:^|\||\n|\s)(?:צבע|צבעים|גוון|גוונים|colou?rs?)\s*:\s*([^|\n.]+)/iu;
export function colourList(reply: string, candidates: Array<{ title?: string; details?: string; attributes?: Record<string, unknown> }>, locale: "he" | "en"): string {
  const text = String(reply ?? "");
  if (!SEVERAL_COLOURS.test(text)) return text;
  const named = candidates.filter((c) => c?.title && namesCandidate(text, [String(c.title)]));
  const c = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : null;
  if (!c) return text;
  const raw = String((c.attributes as any)?.color ?? (c.attributes as any)?.colour ?? COLOUR_FACT.exec(String(c.details ?? ""))?.[1] ?? "");
  const colours = raw.split(/\s*,\s*|\s+\/\s+/).map((x) => x.trim()).filter((x) => x && x.length <= 30).slice(0, 12);
  if (colours.length < 2 || colours.some((x) => text.includes(x))) return text;
  return `${text.trim()} ${locale === "en" ? `The colours: ${colours.join(", ")}.` : `הצבעים: ${colours.join(", ")}.`}`;
}


/**
 * The products a reply refers to without their exact catalogue title (dev live round on 9480dfb2: "קפוצ'ון שחור
 * בגזרה כבדה" for "Heavyweight Hoodie", so nothing was in focus for the next turn's "מאיזה בד הוא עשוי?"). The
 * title without its variant part, or a distinctive word of it (not shared by every product found), in the reply
 * or in the model's own intent; or the only product found, when the reply is about a product at all.
 */
const TIME_WORDS = new Set(["יום", "לילה", "ערב", "בוקר", "צהריים", "שבוע", "חודש", "שנה", "day", "night", "evening", "morning", "week", "month", "year"]);
const CHOICE_WORDS = new Set(["לבחור", "בחרו", "בחרי", "בוחרים", "ממליצים", "ממליצה", "ממליץ", "מומלץ", "מומלצת", "נמליץ", "recommend", "choose", "pick", "try"]);
const NEAR_FILLER = new Set(["שלך", "שלכם", "שלי", "שלנו", "מתאים", "מתאימה", "מתאימים", "מתאימות", "your", "fits", "fit"]);
const GREETINGS = new Set(["שלום", "היי", "הי", "hi", "hello", "hey"]);
const TITLE_STOP = new Set(["the", "and", "for", "with", "new", "set", "pro", "one", "של", "עם", "את", "לכל", "כל", "סט", "חדש", "חדשה"]);
const VARIANT_WORDS = new Set(["black", "white", "grey", "gray", "red", "blue", "green", "pink", "navy", "beige", "brown", "sand", "cream", "charcoal", "melange", "olive", "yellow", "orange", "purple", "silver", "gold", "small", "medium", "large", "xlarge", "size", "שחור", "שחורה", "לבן", "לבנה", "אפור", "אפורה", "אדום", "אדומה", "כחול", "כחולה", "ירוק", "ירוקה", "ורוד", "ורודה", "בז'", "חום", "חומה", "קרם", "זהב", "כסף", "צהוב", "כתום", "סגול", "קטן", "קטנה", "בינוני", "בינונית", "גדול", "גדולה", "מידה"]);
export function referredCandidates(candidates: Array<{ title?: string }>, reply: string, intent: string, contactNames: Array<string | null | undefined> = []): number[] {
  // One apostrophe form, kept inside a word ("ג'יני" is one word, never "יני").
  const apos = (x: string) => x.replace(/[׳’`]/g, "'");
  const hay = apos(`${String(reply ?? "")}\n${String(intent ?? "")}`.toLowerCase());
  const titles = candidates.map((c) => apos(String(c?.title ?? "").trim()));
  const hayTokens = (hay.match(/[\p{L}\p{N}]+(?:'[\p{L}]+)*/gu) ?? []) as string[];
  const wordsOf = (t: string) => ((t.toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)*/gu) ?? []) as string[]).filter((w) => w.replace(/'/g, "").length >= 3);
  // A word counts only when exactly one found title has it (the Supervisor's probe: "למכונות" in two of three titles
  // marked both).
  const bases = titles.map((t) => t.replace(/\s*[(\[][^)\]]*[)\]]\s*$/u, "").replace(/\s+[-|:]\s+.*$/u, "").trim().toLowerCase());
  const owners = (w: string) => bases.filter((b) => wordsOf(b).includes(w)).length;
  const out: number[] = [];
  titles.forEach((t, i) => {
    if (!t) return;
    const base = t.replace(/\s*[(\[][^)\]]*[)\]]\s*$/u, "").replace(/\s+[-|:]\s+.*$/u, "").trim().toLowerCase();
    // From the title without its variant part, and never a colour or size word ("Black" in "Heavyweight Hoodie
    // (Black)" is not that hoodie when the reply speaks of another product in black).
    // Unique to this title, 3+ letters (Smoovee's names: "גפן", "אסף"), whole word with up to two Hebrew prefix
    // letters ("לגפן", "בגפן", "וגפן", "ובאריאל").
    const names = new Set(contactNames.map((n) => String(n ?? "").trim().toLowerCase()).filter(Boolean));
    const distinct = wordsOf(base).filter((w) => owners(w) === 1 && !/^\d+$/.test(w) && !VARIANT_WORDS.has(w) && !TITLE_STOP.has(w) && !names.has(w));
    // Never right after a greeting ("שלום אריאל": a person, not the mat).
    const said = (w: string) => new RegExp(`(?<!(?:שלום|היי|הי|hi|hello|hey)[,!\\s]+)(?<![\\p{L}])${/[\u0590-\u05FF]/.test(w) ? "[הולבמשכ]{0,2}" : ""}${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").test(hay);
    // Near, never anywhere (the Supervisor's probe on f0986322: "תוך יום עסקים נשלח את הקרם" marked "קרם יום").
    // A title word's places in the reply: whole word, up to two Hebrew prefix letters, never right after a greeting.
    const at = (w: string) => hayTokens.flatMap((tok, p) => {
      const hit = tok === w || (/[\u0590-\u05FF]/.test(w) && ((/^[הולבמשכ]/u.test(tok) && tok.slice(1) === w) || (/^[הולבמשכ]{2}/u.test(tok) && tok.slice(2) === w)));
      return hit && !(p > 0 && GREETINGS.has(hayTokens[p - 1])) ? [p] : [];
    });
    // A companion: another word of the same title within three words, by its first four letters ("משטח גפן", "קרם
    // יום", "למכונה" for "למכונות"); a colour or size word of the title may be one, never the distinctive word.
    // Distance in words that carry content: a possessive or the fit verb between them does not count ("למכונה שלך
    // מתאים משטח גפן"); "הקרם שומר על לחות" is three words apart, too far.
    const dist = (a: number, b: number) => { const [lo, hi] = a < b ? [a, b] : [b, a]; let d = 0; for (let k = lo + 1; k <= hi; k++) if (!NEAR_FILLER.has(hayTokens[k])) d++; return d; };
    const companion = (w: string) => at(w).some((p) => wordsOf(base).filter((x) => x !== w && !TITLE_STOP.has(x)).some((x) => {
      const key = x.slice(0, 4);
      return hayTokens.some((h, q) => q !== p && dist(p, q) <= 2 && [h, h.slice(1), h.slice(2)].some((v) => v.length >= Math.min(3, key.length) && v.startsWith(key)));
    }));
    // A unique word under 5 letters counts only with a companion ("תוך יום עסקים" is no "קרם יום").
    // Or a name by its place: right after a choice word ("כדאי לבחור בגפן", "ממליצים על אסף"), or joined by ו to
    // another found product's own name ("בגפן ובאריאל").
    const otherNames = new Set(bases.flatMap((b, k) => (k === i ? [] : wordsOf(b).filter((x) => owners(x) === 1 && !VARIANT_WORDS.has(x) && !TIME_WORDS.has(x) && !TITLE_STOP.has(x)))));
    // Never an everyday word by place: a time word, a colour or size word, a word two found titles share; those mark
    // only through the all-words and companion rules ("כדאי לבחור ביום אחר למשלוח" is no "קרם יום").
    const placeName = (w: string) => !TIME_WORDS.has(w) && !VARIANT_WORDS.has(w) && owners(w) === 1;
    // A word an adjective follows is a common noun ("כדאי לבחור בלחות גבוהה"), never a name.
    // Indefinite only: "גפן הקטנה" (a definite adjective) IS the name; "לחות גבוהה" is a common noun.
    const adjectiveAfter = (p: number) => { const n = hayTokens[p + 1] ?? ""; return /^[\u0590-\u05FF]{3,}(?:ה|ית|ים|ות)$/u.test(n) && !/^[ולבה]/u.test(n) && !bases.some((b) => wordsOf(b).includes(n)); };
    const byPlace = (w: string) => placeName(w) && at(w).some((p) => {
      if (adjectiveAfter(p)) return false;
      const prev = hayTokens[p - 1] ?? "", prev2 = hayTokens[p - 2] ?? "";
      if (CHOICE_WORDS.has(prev) || (prev === "על" && CHOICE_WORDS.has(prev2))) return true;
      const strip = (t: string) => t.replace(/^ו/u, "").replace(/^[הולבמשכ]{0,1}/u, "");
      const next = hayTokens[p + 1] ?? "";
      const joined = (t: string, viaVav: boolean) => !!t && (viaVav ? /^ו/u.test(t) : true) && [...otherNames].some((n) => [t, t.slice(1), t.slice(2)].includes(n) || strip(t) === n);
      return joined(next, true) || (/^ו/u.test(hayTokens[p] ?? "") && joined(prev, false));
    });
    const counts = (w: string) => said(w) && (w.length >= 5 || companion(w) || byPlace(w));
    // Two sizes or colours of one name ("מלאני גדולה" / "מלאני קטנה"): the variant word with a word of its title beside it.
    const variantOnly = wordsOf(base).filter((w) => owners(w) === 1 && VARIANT_WORDS.has(w));
    const variantSaid = !distinct.length && variantOnly.some((w) => said(w) && companion(w));
    // Every word of the title within a run of (its word count + 1) reply words: "הבובון השטוח", "קרם הלחות שלנו",
    // "הבובון שלנו שטוח"; never "הקרם שומר על לחות".
    const all = wordsOf(base).filter((w) => !TITLE_STOP.has(w));
    const places = all.map(at);
    const allSaid = all.length >= 2 && places.every((ps) => ps.length) && places[0].some((p0) => {
      for (let st = Math.max(0, p0 - all.length); st <= p0; st++) if (places.every((ps) => ps.some((p) => p >= st && p <= st + all.length))) return true;
      return false;
    });
    if ((base.length >= 4 && hay.includes(base)) || allSaid || distinct.some(counts) || variantSaid) out.push(i);
  });
  // A title inside a longer one that is also said: only the longer counts ("Classic Tee Long Sleeve", never also
  // "Classic Tee"); the same words (one base, two variants) keep both.
  const setOf = (i: number) => new Set(wordsOf(bases[i]));
  const inside = (a: Set<string>, b: Set<string>) => [...a].every((w) => b.has(w)) && b.size > a.size;
  const kept = out.filter((i) => !out.some((j) => j !== i && inside(setOf(i), setOf(j))));
  out.splice(0, out.length, ...kept);
  if (!out.length && titles.filter(Boolean).length === 1 && !TEAM_LINE.test(reply ?? "") && !NO_INFO.test(reply ?? "")) out.push(titles.findIndex(Boolean));
  return out;
}

/**
 * The product the conversation is about, for a lookup the engine makes itself: the last lookup's product the model's
 * intent names, else the last one shown or named, else the last lookup's only product.
 */
export function focusTitle(focusTitles: string[], intent: string | null | undefined, lastOffered: string | null | undefined): string | null {
  const named = referredCandidates(focusTitles.map((title) => ({ title })), "", String(intent ?? "")).filter((i) => i >= 0);
  if (named.length === 1) return focusTitles[named[0]];
  // Two or more named (a comparison): no single focus, the model asks which one.
  if (named.length > 1) return null;
  if (String(lastOffered ?? "").trim()) return String(lastOffered).trim();
  return focusTitles.length === 1 ? focusTitles[0] : null;
}


/**
 * A counted offer that is not what is shown: "הנה 4 הצעות" with two cards (prod replay of 9480dfb2, Tehila). The
 * number becomes the cards' count; nothing else changes.
 */
const COUNT_WORD: Record<string, number> = { שתי: 2, שני: 2, שלוש: 3, שלושה: 3, ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5, two: 2, three: 3, four: 4, five: 5 };
const OFFER_COUNT = /(?<![\p{L}\d])(\d|שתי|שני|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה|two|three|four|five)\s+(הצעות|אפשרויות|מוצרים|דגמים|פריטים|options|suggestions|products|ideas|picks)(?![\p{L}])/iu;
export function fixCardCount(reply: string, cards: number): string {
  const m = OFFER_COUNT.exec(String(reply ?? ""));
  // One card: "1 הצעות" is no Hebrew; the count is left alone.
  if (!m || cards < 2) return reply;
  const said = /^\d$/.test(m[1]) ? Number(m[1]) : COUNT_WORD[m[1].toLowerCase()];
  if (!said || said === cards) return reply;
  return String(reply).replace(m[0], `${cards} ${m[2]}`);
}

/** "גם כן" / "as well" closing a sentence after a cut took what it pointed back to. */
export function dropOrphanAlso(reply: string): string {
  return String(reply ?? "").replace(/\s+(?:גם\s+כן|גם\s+היא|גם\s+הוא)(?=\s*[.!?]|\s*$)/gu, "").replace(/,?\s+(?:as well|too)(?=\s*[.!?]|\s*$)/giu, "");
}


/** A question about a product's own attribute (material, stopper, size, care), no product wanted: no list for it. */
export function attributeOnlyAsk(incoming: string): boolean {
  const t = normalizeQuotes(String(incoming ?? ""));
  // The question sentence decides (L224: "אני רוצה להזמין..." then "האם יש מעצור לכל מתקן?"): its want-word, never one
  // elsewhere in the message.
  const sentences = (t.match(/[^.!?\n]+[.!?]*/g) ?? [t]).map((x) => x.trim()).filter(Boolean);
  const asked = sentences.filter((x) => /\?/.test(x));
  const decide = asked.length ? asked : sentences.slice(-1);
  const attr = (x: string) => ATTRIBUTE_ASK.test(x) || MATERIAL_ASK.test(x) || /(?<![\u0590-\u05FF])[הל]?(?:פקק|מכסה|ידית|מעצור|מעצורים|רגליות)(?![\u0590-\u05FF])/u.test(x);
  const want = (x: string) => /(?<![\u0590-\u05FF])(?:מחפש|מחפשת|מחפשים|רוצה|רוצים|יש\s+לכם|יש\s+לך|המלצה|ממליצים|תמליצו|אפשר\s+לקבל|מה\s+יש)(?![\u0590-\u05FF])|\b(?:looking for|do you have|recommend|i want|i need)\b/iu.test(x);
  return decide.some((x) => attr(x) && !want(x));
}


/** Her message is about a product: a product ask, or a have/was/want verb governing a product noun ("הייתה מטפחת..."). */
export function asksAboutProduct(incoming: string): boolean {
  const t = normalizeQuotes(String(incoming ?? ""));
  if (productAskNow(t)) return true;
  for (const m of t.matchAll(PRODUCT_CONTEXT)) if (lendable(m[1])) return true;
  return false;
}
// "יש כמה מטפחות", "יש מגוון תיקים": several products exist; never the bare "יש לנו" (policy answers: "יש לנו
// משלוח חינם", "יש לנו אחריות לשנה", the pre-check of 51d0273e).
const PRODUCTS_EXIST = /(?<![\u0590-\u05FF])(?:יש\s+(?:(?:לנו|אצלנו|באתר|בחנות|כאן|במלאי)\s+)?(?:כמה|מגוון|מספר)|קיימות|קיימים)\s+([\u0590-\u05FF]{3,})|\b(?:we have (?:a few|several|some)|there are (?:a few|several|some))\s+(\w{3,})/iu;
const SEARCH_PROMISE = /(?<![\u0590-\u05FF])[וש]?(?:נחפש|אחפש|נבדוק\s+(?:אם\s+)?(?:יש|במלאי|בקטלוג)|אבדוק\s+(?:אם\s+)?(?:יש|במלאי|בקטלוג)|נמצא\s+לך)(?![\u0590-\u05FF])|\b(?:(?:i|we)(?:'ll| will) (?:search|look (?:for|it up)|check (?:the )?(?:stock|catalog(?:ue)?)))\b/iu;
/** A product claim or a promise to search, with a store offered and no store read this turn, on a message about a product. */
export function claimsOrPromisesUnsearched(reply: string, incoming: string, tools: ToolRunRecord[], toolsOffered: string[], evidence: { grounding?: string; knowledge?: string } = {}): boolean {
  if (!toolsOffered.some((n) => /(?:^|\.)(?:list_products|search_products)$/.test(n))) return false;
  if (tools.some((t) => /list_products|search_products|get_product/i.test(t.tool))) return false;
  const r = String(reply ?? "");
  // The claimed noun is no policy word (משלוח, אחריות...).
  const m = PRODUCTS_EXIST.exec(r);
  const claim = !!m && !NOT_LENT.has(bareNoun(String(m[1] ?? m[2] ?? "")));
  // "אין מידע מאומת על ... המלאי" with the store offered and nothing read: an unsearched answer too.
  const noInfo = /(?<![\u0590-\u05FF])(?:אין\s+(?:לי\s+|לנו\s+)?(?:כרגע\s+)?מידע(?:\s+מאומת)?\s+(?:על|לגבי)[^.!?\n]{0,40}(?:מלאי|צבע|גוון|גווני|מידה|מידות|זמינות)|לא\s+(?:בדקתי|בדקנו)\s+(?:את\s+)?(?:ה)?מלאי)(?![\u0590-\u05FF])|\b(?:no (?:verified )?(?:information|info) (?:on|about) (?:the )?(?:stock|colou?rs?|sizes?|availability))\b/iu.test(r);
  // "המידע שיש לנו מתאר את הטוש ... אבל לא כולל הוראות או סרטון": what the information lacks about a product needs its
  // store read first (rating of b3d2bbf3, NE'A).
  const infoLacks = /(?<![\u0590-\u05FF])(?:ה)?(?:מידע|תיאור|פרטים|הפרטים)(?:\s+[\u0590-\u05FF,]+){0,10}?\s+(?:לא|אינו|אינם)\s+(?:כולל|כוללים|כוללת|מציין|מציינים|מפרט|מפרטים|מזכיר|מתאר)(?![\u0590-\u05FF])|\b(?:the (?:information|description|details) (?:we have )?(?:does not|doesn't|do not|don't) (?:include|mention|say))\b/iu.test(r);
  // A product with its price, named with no store read (dev round k5 on 0b5f2b46: two hoodies and their prices from a
  // knowledge snapshot, on a cards channel).
  // Only a sentence that names the product she asked about ("יש קפוצ'ון קצר ב-299"), never a policy price.
  const herNouns = (storeQueryOf(incoming) ?? "").split(/\s+/).filter((w) => w.length >= 3).map((w) => normalizeQuotes(w).replace(/^ה(?=[\u0590-\u05FF]{3,})/u, "").slice(0, 4));
  // A price the store gave (in the grounding, not from the knowledge) is no unsearched one.
  const fromStore = (p: string) => String(evidence.grounding ?? "").includes(p) && !String(evidence.knowledge ?? "").includes(p);
  const pricesIn = (x: string) => [...x.matchAll(/(\d{2,5}(?:[.,]\d{1,2})?)\s*(?:₪|ש["״]ח|שקל|ILS|NIS)|₪\s*(\d{2,5}(?:[.,]\d{1,2})?)/gu)].map((m) => String(m[1] ?? m[2]));
  const priced = herNouns.length > 0 && (r.match(/[^.!?\n]+[.!?]*/g) ?? []).some((x) => pricesIn(x).some((p) => !fromStore(p)) && herNouns.some((n) => normalizeQuotes(x).includes(n)));
  return (claim || SEARCH_PROMISE.test(r) || noInfo || infoLacks || priced) && asksAboutProduct(incoming);
}

/**
 * A dangling pointer loses only its pointing words ("השרשראות שמופיעות כאן עשויות מפלדת" -> "השרשראות עשויות מפלדת"),
 * never the sentence, when what is left still reads as one (rating of dcf2158e: the material answer was cut).
 */
const POINTER = /\s*(?:(?<![\u0590-\u05FF])(?:שמופיע|שמופיעה|שמופיעים|שמופיעות|המופיעים|המופיעות)\s+(?:כאן|למטה|בהמשך)|(?<![\u0590-\u05FF])(?:כאן\s+)?למטה|\b(?:listed|shown) (?:below|here)\b|\bbelow\b)(?![\u0590-\u05FF])/giu;
export function withoutPointer(sentence: string): string {
  const out = String(sentence ?? "").replace(POINTER, "").replace(/\s{2,}/g, " ").trim();
  return (out.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 3 && !DANGLING.test(out) ? out : "";
}
/** Words a store query never holds (a question word, a stop or talk word, an ask word); a model's query is cleaned too. */
export function cleanStoreQuery(query: string): string {
  return storeQueryWords(query) ?? String(query ?? "");
}
/** The product words of a store query; null when none is left ("להזמין", "אילו"): such a query is never run. */
export function storeQueryWords(query: string): string | null {
  // One apostrophe form, kept inside and at the end of a word ("נינג׳ה", "קפוצ׳ון", "בז'").
  const words = (normalizeQuotes(String(query ?? "")).match(/[\p{L}\p{N}]+(?:['"][\p{L}]+)*'?/gu) ?? []) as string[];
  const kept = words.filter((w) => !queryStop(w) && !talkWord(w) && !ASK_WORDS.has(w.toLowerCase()) && !ASKS_ABOUT.has(w.toLowerCase()));
  return kept.length ? kept.join(" ") : null;
}
