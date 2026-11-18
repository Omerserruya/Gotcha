/**
 * Conversation relevance (Omer, 2026-11-17): is this conversation the business's own work? Generic by
 * design: no per-tenant keyword lists. It is judged against the business's own profile (what it sells,
 * who its customers are) and the conversation's shape (who wrote first, the channel, the last messages).
 *
 *   business          a customer or lead asking about, ordering or getting service for what the business does
 *   reply_to_outbound a reply to something the business sent first (a supplier, a hotel, an outreach reply)
 *   personal          a private chat (a friend, a partner, family), not about the business
 *   notice            invoices and receipts from vendors, system notices, resets, login alerts, the
 *                     business's OWN purchase shipping notices
 *   marketing         newsletters, promotions, ads, cold sales pitches TO the business
 *   auto_reply        another business's automated greeting or away message (bot-to-bot loops otherwise)
 *   internal          the tenant's own team (a user's phone or email, the team's email domain)
 *   unclear           the model's real uncertainty
 *
 * A cheap deterministic fast path first (bulk headers, no-reply senders, our own notification senders:
 * the reply engine's automatedInbound), then ONE small model call with a short generic rubric and JSON
 * out. Platform-paid ("conversation_classify": the "_classify" usage suffix, outside every tenant budget).
 */
import { automatedInbound } from "./reply-engine/gates";
import { generateResponse, getDefaultModel, platformPaidScope } from "./ai.service";

export type RelevanceCategory = "business" | "reply_to_outbound" | "personal" | "notice" | "marketing" | "auto_reply" | "internal" | "unclear";
export const RELEVANCE_CATEGORIES: readonly RelevanceCategory[] = ["business", "reply_to_outbound", "personal", "notice", "marketing", "auto_reply", "internal", "unclear"];
/** The labels that keep the AI out of a conversation (unclear never does: it answers as today). */
export const SILENCING: ReadonlySet<RelevanceCategory> = new Set<RelevanceCategory>(["personal", "notice", "marketing", "auto_reply", "internal"]);

export interface Relevance {
  category: RelevanceCategory;
  confidence: number;
  reason: string;
  source: "fast" | "model";
  classifiedAt: string;
}

export interface RelevanceProfile {
  organizationName?: string | null;
  industry?: string | null;
  businessDescription?: string | null;
  websiteDomain?: string | null;
  /** What the business sells, when its AI employee says so (salesContext.whatWeSell). */
  whatWeSell?: string | null;
}

export interface RelevanceMessage {
  direction: "INBOUND" | "OUTBOUND" | string;
  body?: string | null;
  createdAt?: Date | string | null;
  messageType?: string | null;
  metadata?: any;
}

/** The tenant's own team, for the internal label: users' phones (last 9 digits), emails and company email domains. */
export interface TeamIdentity { phones: string[]; emails: string[]; domains: string[] }

export interface RelevanceInput {
  channel: string;
  team?: TeamIdentity | null;
  customerExternalId?: string | null;
  /** Who wrote first in the whole conversation. */
  firstDirection: "INBOUND" | "OUTBOUND" | null;
  /** The last messages, oldest first. */
  messages: RelevanceMessage[];
  /** An email's subject, when the channel is email. */
  subject?: string | null;
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const realMessages = (m: RelevanceMessage[]) => m.filter((x) => x.messageType !== "system" && clip(x.body, 1).length > 0);

// Free mail providers: a shared domain says nothing about who someone works for.
const PUBLIC_MAIL = /^(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|yandex|zoho|walla|bezeqint|012|netvision|inter)\./i;
const emailOf = (v: unknown) => /[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/i.exec(String(v ?? ""))?.[0]?.toLowerCase() ?? null;

/** The tenant's team from its users (phones and emails; a company domain only when it is not a free mail provider). */
export function teamIdentityOf(users: Array<{ email?: string | null; phoneNumber?: string | null }>): TeamIdentity {
  const emails = [...new Set(users.map((u) => emailOf(u.email)).filter((e): e is string => !!e))];
  const domains = [...new Set(emails.map((e) => e.split("@")[1]).filter((d) => d && !PUBLIC_MAIL.test(d)))];
  const phones = [...new Set(users.map((u) => String(u.phoneNumber ?? "").replace(/\D/g, "")).filter((d) => d.length >= 9).map((d) => d.slice(-9)))];
  return { phones, emails, domains };
}

/** Is this sender one of the team: the conversation's contact, or the From of an inbound email. */
export function teamSender(c: RelevanceInput): boolean {
  const t = c.team;
  if (!t) return false;
  const senders = [c.customerExternalId, ...c.messages.filter((m) => m.direction === "INBOUND").map((m) => m.metadata?.email?.from ?? m.metadata?.from)];
  return senders.some((raw) => {
    const email = emailOf(raw);
    if (email) return t.emails.includes(email) || t.domains.includes(email.split("@")[1]);
    const digits = String(raw ?? "").replace(/\D/g, "");
    return digits.length >= 9 && t.phones.includes(digits.slice(-9));
  });
}

/**
 * Another business's automated greeting or away message (dry run 2026-11-17: four auto-replies to GOTCHA's
 * outreach were labelled business). The cost is one-sided (dev relevance test 2026-11-18): answering an away
 * message wastes one reply, silencing a customer loses the customer. So only the business's OWN voice counts
 * ("תודה שפניתם אלינו", "פנייתך התקבלה", "נחזור אליכם", "אנחנו לא זמינים כרגע", out of office), never a topic
 * word a customer also uses ("שעות הפעילות", "תודה על ההודעה"); and any sign of a person wins.
 */
const BUSINESS_VOICE = /(?<![\u0590-\u05FF])(?:תודה(?:\s+רבה)?\s+(?:ש(?:פנית|פניתם|פנית\s+אלינו|פניתם\s+אלינו|יצרת|יצרתם)(?:\s+(?:אלינו|קשר))?|על\s+(?:פנייתך|פנייתכם|הפנייה|פנייתך\s+אלינו))|(?:פנייתך|פנייתכם|הפנייה|ההודעה\s+שלך|הודעתך)\s+(?:התקבלה|נקלטה|הגיעה\s+אלינו)|נחזור\s+(?:אליך|אלייך|אליכם)|(?:נציג|נציגה|נציגינו)\s+(?:יחזור|תחזור|יחזרו|יחזרו\s+אליך)|(?:כרגע|כעת|ברגע\s+זה)\s+(?:אנחנו\s+|אנו\s+)?(?:לא|אינם|איננו)\s+(?:פנויים|זמינים)|(?:אנחנו|אנו)\s+(?:לא|אינם)\s+(?:פנויים|זמינים)\s+(?:כרגע|כעת)|הגעתם\s+ל|שעות\s+(?:ה)?פעילות\s+שלנו|(?:זוהי\s+)?הודעה\s+אוטומטית|מענה\s+אוטומטי)(?![\u0590-\u05FF])|\b(?:thank(?:s| you) for (?:contacting us|reaching out(?: to us)?|your (?:message|email|inquiry))|we(?:'ll| will) get back to you|out of (?:the )?office|our (?:business|opening) hours|we are currently (?:unavailable|away|closed)|auto(?:matic|mated)?[- ]reply|this is an automated)\b/iu;
/** A person speaking: a question, a question word, the business addressed, or an intent. In doubt, a person. */
const PERSON_SIGNAL = /[?؟]|(?<![\u0590-\u05FF])[וש]?(?:מה|מתי|איך|האם|אפשר|כמה|איפה|למה|מי|איזה|איזו|שלכם|אתם|אצלכם|לכם|רוצה|רוצים|ארצה|להזמין|הזמנתי|מחיר|מעוניין|מעוניינת|מעוניינים|לקנות|קניתי|מחפש|מחפשת|צריך|צריכה|אשמח|תשלחו|שלחו)(?![\u0590-\u05FF])|\b(?:what|when|how|can|could|would|do you|does|is there|are you|where|why|which|who|want|wanna|order|buy|price|interested|looking for|need|i'?d like)\b/iu;
/**
 * The first person singular is a person: a machine speaks as "we", a customer as "I" (R3 round 3: "פניתי אליכם
 * אתמול ואמרו לי נחזור אליך ואף אחד לא חזר" quoted the business's promise back). A first person past verb is a
 * word of 4+ letters ending in "תי" (פניתי, הזמנתי, קיבלתי, התקשרתי; "אמיתי" too, which is fine: in doubt a
 * person). "אליכם" counts unless it is the machine's own "נחזור אליכם".
 */
const FIRST_PERSON = /(?<![\u0590-\u05FF])[וש]?(?:אני|לי|אליי|אותי|שלי|איתי|אמרתם|עדיין)(?![\u0590-\u05FF])|(?<![\u0590-\u05FF])[\u0590-\u05FF]{2,}תי(?![\u0590-\u05FF])|(?<![\u0590-\u05FF])(?<!(?:נחזור|יחזור|יחזרו|נשוב|תחזור)\s+)אליכם(?![\u0590-\u05FF])|(?<![\u0590-\u05FF])אף\s+אחד(?![\u0590-\u05FF])|\b(?:i|my|me|i've|i'm|nobody|no one|still|you said|you told)\b/iu;
export const machineVoice = (body: unknown) => { const b = String(body ?? ""); return BUSINESS_VOICE.test(b) && !PERSON_SIGNAL.test(b) && !FIRST_PERSON.test(b); };

export function autoReply(c: RelevanceInput): boolean {
  // Every message the contact sent in view must be the machine's: one person's line and it is a person.
  const ins = c.messages.filter((m) => m.direction === "INBOUND" && clip(m.body, 1));
  if (!ins.length || !ins.every((m) => machineVoice(m.body))) return false;
  // The business wrote first: the other side's machine answering our opener.
  if (c.firstDirection === "OUTBOUND") return true;
  // The contact wrote first with a machine's greeting (dry run 2, ALEA): a statement of some length.
  return String(ins[0].body ?? "").trim().split(/\s+/).length >= 6;
}

/**
 * A one-time code (dev relevance test 2026-11-18: a verification code got "חשוב לא לשתף קודי אימות" from the
 * engine and no label). A code phrase and a 4 to 8 digit number, with no complaint or question ("קוד האימות
 * 123456 לא עובד" is a customer).
 */
const OTP_PHRASE = /(?<![\u0590-\u05FF])(?:קוד\s+(?:ה)?(?:אימות|כניסה|אבטחה|גישה)|קוד\s+חד[-\s]?פעמי|סיסמה\s+חד[-\s]?פעמית|הקוד\s+שלך)(?![\u0590-\u05FF])|\b(?:verification code|one[-\s]?time (?:pass(?:word|code)?|code)|security code|login code|sign[-\s]?in code|OTP|your code is)\b/iu;
const OTP_NOT = /(?<![\u0590-\u05FF])(?:לא|לא\s+עובד|קיבלתי|מקבלת|מקבל|עזרה)(?![\u0590-\u05FF])|\b(?:didn'?t|doesn'?t|not|help|isn'?t)\b|\?/iu;
export function oneTimeCode(body: unknown): boolean {
  const b = String(body ?? "");
  return OTP_PHRASE.test(b) && /(?<!\d)\d{4,8}(?!\d)/.test(b) && !OTP_NOT.test(b);
}

/**
 * A seller's pitch TO the business (replay d on dev, Messenger: "שלום, אנחנו מציעים שירותי בניית אתרים במחיר מבצע,
 * רוצים הצעת מחיר?" went to the product search and "לא מצאתי דגם"). The offering voice (we offer, we provide, I
 * wanted to offer you) AND a service word; never with a word of her own order or purchase. In doubt, a customer.
 */
const OFFER_VOICE = /(?<![\u0590-\u05FF])(?:(?:אנחנו|אנו)\s+(?:\S+\s+)?(?:מציעים|מספקים|מתמחים|מקדמים|בונים|מעניקים)|(?:נשמח|אשמח)\s+להציע\s+(?:לכם|לך|לעסק)|(?:רצינו|רציתי)\s+להציע\s+(?:לכם|לך|לעסק))(?![\u0590-\u05FF])|\b(?:we (?:offer|provide|specialize in|help businesses)|(?:i|we) (?:would like|wanted) to offer you|our (?:agency|company) (?:offers|provides))\b/iu;
const SERVICE_WORD = /(?<![\u0590-\u05FF])[ול]?(?:שירות|שירותי|בניית\s+אתרים|אתרים|קידום|שיווק|פרסום|לידים|עיצוב|פיתוח|ניהול\s+(?:רשתות|סושיאל|קמפיינים)|אריזות|הלוואות|מימון)(?![\u0590-\u05FF])|\b(?:services?|seo|marketing|websites?|web design|leads|advertising|development|social media|packaging|financing|loans)\b/iu;
const OWN_PURCHASE = /(?<![\u0590-\u05FF])[וש]?(?:הזמנתי|ההזמנה\s+שלי|קניתי|רכשתי|המשלוח\s+שלי|הזמנה\s+מספר|להחזיר|החזרה)(?![\u0590-\u05FF])|\b(?:my order|i (?:bought|ordered|purchased)|order (?:number|#))\b/iu;
/**
 * A buyer introducing their own business ("אנחנו מספקים שירותי קייטרינג ורוצים להזמין מכם 50 משטחים"): an intent
 * to order, buy or get a price FROM the business. A wholesale lead is never a pitch. "רוצים הצעת מחיר?" offered TO
 * the business is not this.
 */
const BUYING = /(?<![\u0590-\u05FF])[וש]?(?:להזמין|לקנות|לרכוש|מכם|אצלכם|מעוניינים\s+ב|מעוניין\s+ב|מעוניינת\s+ב|ספק\s+(?:של\s+)?(?:\S+\s+)?(?:משטחים|מוצרים|ל)|מחפשים\s+ספק|מחיר\s+(?:לכמות|לסיטונאי|ל-?\d)|הנחת\s+כמות|כמות\s+גדולה)(?![\u0590-\u05FF])|\b(?:(?:want|would like|looking|need) to (?:order|buy|purchase)|from you|bulk|wholesale|price for \d|quote for \d|looking for a supplier)\b/iu;
export function sellerPitch(body: unknown): boolean {
  const b = String(body ?? "");
  return OFFER_VOICE.test(b) && SERVICE_WORD.test(b) && !OWN_PURCHASE.test(b) && !BUYING.test(b);
}
/** An Instagram story mention with nothing written: it asks nothing (replay d, Smoovee A: "[Story mention]" got a question). */
export const storyMentionOnly = (body: unknown) => /^\s*\[(?:story[ _]mention|story mention reply|אזכור\s+בסטורי|תיוג\s+בסטורי)\]\s*$/iu.test(String(body ?? ""));

/** The fast path: mail no person wrote, decided with no model call. Null when it does not apply. */
export function fastRelevance(c: RelevanceInput, now = new Date()): Relevance | null {
  const at = now.toISOString();
  if (teamSender(c)) return { category: "internal", confidence: 0.95, reason: "a member of the team", source: "fast", classifiedAt: at };
  if (autoReply(c)) return { category: "auto_reply", confidence: 0.9, reason: "an automated greeting or away message", source: "fast", classifiedAt: at };
  const lastIn = [...c.messages].reverse().find((m) => m.direction === "INBOUND");
  if (!lastIn) return null;
  if (oneTimeCode(lastIn.body)) return { category: "notice", confidence: 0.95, reason: "a one-time code", source: "fast", classifiedAt: at };
  if (sellerPitch(lastIn.body)) return { category: "marketing", confidence: 0.9, reason: "a seller's offer to the business", source: "fast", classifiedAt: at };
  const why = automatedInbound({ channel: c.channel, sender: c.customerExternalId, body: lastIn.body, metadata: lastIn.metadata });
  if (!why) return null;
  // A list or a sending subdomain is marketing; a no-reply or system sender, or a notice's footer, is a notice.
  const marketingText = /\b(?:unsubscribe|newsletter|sale|% off|discount|promo|offer|deal|webinar|new features?)\b|(?:להסרה מרשימת|מבצע|הנחה|ניוזלטר)/iu.test(String(lastIn.body ?? ""));
  const category: RelevanceCategory = why === "ingest_list" || why === "bulk_domain" || (why === "bulk_footer" && marketingText) ? "marketing" : "notice";
  return { category, confidence: 0.95, reason: `automated mail (${why})`, source: "fast", classifiedAt: now.toISOString() };
}

const RUBRIC = `You label ONE conversation of a business's inbox. Decide who it is with and what it is about, judged against the business below. Categories:
- business: a customer or a lead asking about, buying, or getting service for what THIS business sells or does.
- reply_to_outbound: the business wrote first and this is the other side answering (a supplier, a hotel, a partner, someone the business reached out to), not a customer of the business.
- personal: a private chat (a friend, a partner, family) that is not about the business.
- notice: an automatic or vendor message to the business: an invoice or receipt, a system notification, a password reset, a login alert, shipping of something the business itself bought.
- marketing: a newsletter, a promotion, an ad, or a cold sales pitch TO the business.
- auto_reply: another business's automated message: a thanks-for-contacting greeting, opening hours, an away or out-of-office notice.
- unclear: you truly cannot tell.
HARD RULE: when the business wrote first, the answer is reply_to_outbound (or auto_reply), unless a later message from the contact raises a NEW request about what this business sells or does (a price question, buying, support for its product); only then is it business.
A message that asks about the business's products or services, its orders, prices or opening hours is business, even when it is short or informal. Do not guess from the language or the name alone.
Answer with JSON only: {"category": "...", "confidence": 0.0-1.0, "reason": "at most 15 words"}.`;

/** The model's messages for one conversation: the rubric, the business, and the conversation's shape. */
export function relevancePrompt(profile: RelevanceProfile | null, c: RelevanceInput): Array<{ role: "system" | "user"; content: string }> {
  const biz = profile
    ? [
        `Business: ${clip(profile.organizationName, 80) || "(no name)"}${profile.industry ? ` (${clip(profile.industry, 60)})` : ""}${profile.websiteDomain ? `, ${clip(profile.websiteDomain, 60)}` : ""}.`,
        profile.businessDescription ? `What it does: ${clip(profile.businessDescription, 400)}` : "",
        profile.whatWeSell ? `What it sells: ${clip(profile.whatWeSell, 200)}` : "",
      ].filter(Boolean).join("\n")
    : "Business: (no profile)";
  const lines = realMessages(c.messages).slice(-8).map((m) => `[${m.direction === "OUTBOUND" ? "business" : "contact"}] ${clip(m.body, 300)}`);
  const email = /^(?:EMAIL|GMAIL|OUTLOOK)$/i.test(c.channel) ? `\nEmail from: ${clip(c.customerExternalId, 80)}${c.subject ? `\nSubject: ${clip(c.subject, 120)}` : ""}` : "";
  const user = `${biz}\n\nChannel: ${c.channel}\nWho wrote first: ${c.firstDirection === "OUTBOUND" ? "the business" : c.firstDirection === "INBOUND" ? "the contact (so NOT reply_to_outbound: the business answering the contact's opener never makes it one)" : "unknown"}${email}\n\nLast messages (oldest first):\n${lines.join("\n") || "(none)"}`;
  return [{ role: "system", content: RUBRIC }, { role: "user", content: user }];
}

/** The model's JSON, read defensively: anything unreadable is unclear with no confidence. */
export function parseRelevance(text: string | null | undefined): { category: RelevanceCategory; confidence: number; reason: string } {
  let v: any = null;
  try { v = JSON.parse(String(text ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { v = null; }
  const category = RELEVANCE_CATEGORIES.includes(v?.category) ? (v.category as RelevanceCategory) : "unclear";
  const n = Number(v?.confidence);
  const confidence = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  return { category, confidence: category === "unclear" && !RELEVANCE_CATEGORIES.includes(v?.category) ? 0 : confidence, reason: clip(v?.reason, 120) };
}

export interface ClassifyDeps {
  generate?: typeof generateResponse;
  model?: string;
  now?: () => Date;
}

/**
 * The first-mover rule, checked after the model (dry run 2026-11-17): the business wrote first and the model is
 * not sure the contact raised a new request of their own, so it is a reply to the business's message.
 */
/** A model label under this is not a decision: unclear, which never silences (dry run 2: auto_reply at 0.45). */
export const MIN_MODEL_CONFIDENCE = 0.6;
export function lowConfidence(p: { category: RelevanceCategory; confidence: number; reason: string }) {
  return p.confidence < MIN_MODEL_CONFIDENCE && p.category !== "unclear" ? { ...p, category: "unclear" as const, reason: `unsure: ${p.category} (${p.reason})`.slice(0, 120) } : p;
}

/**
 * reply_to_outbound only when the conversation's FIRST message is the business's own (a person, a broadcast, a
 * campaign). A reply, the bot's or a person's, to the contact's opener never makes it one (dev relevance test
 * 2026-11-18: a cold SEOBoost pitch became reply_to_outbound 0.99 once the bot answered it). Decided here from
 * the first message's direction, never by the model: otherwise unclear, which never silences.
 */
export function onlyAfterOwnOutbound(p: { category: RelevanceCategory; confidence: number; reason: string }, c: RelevanceInput) {
  if (p.category === "reply_to_outbound" && c.firstDirection !== "OUTBOUND") {
    return { category: "unclear" as const, confidence: 0, reason: `the contact wrote first (${p.reason})`.slice(0, 120) };
  }
  return p;
}

export function firstMover(p: { category: RelevanceCategory; confidence: number; reason: string }, c: RelevanceInput) {
  if (c.firstDirection === "OUTBOUND" && p.category === "business" && p.confidence < 0.9) {
    return { category: "reply_to_outbound" as const, confidence: p.confidence, reason: `the business wrote first (${p.reason})`.slice(0, 120) };
  }
  return p;
}

/** One conversation's relevance: the fast path, else one small platform-paid model call. */
export async function classifyConversation(tenantId: string, profile: RelevanceProfile | null, c: RelevanceInput, deps: ClassifyDeps = {}): Promise<Relevance> {
  const now = deps.now?.() ?? new Date();
  const fast = fastRelevance(c, now);
  if (fast) return fast;
  // No customer message yet: nothing to judge.
  if (!realMessages(c.messages).some((m) => m.direction === "INBOUND")) return { category: "unclear", confidence: 0, reason: "no inbound message", source: "model", classifiedAt: now.toISOString() };
  const gen = deps.generate ?? generateResponse;
  const r = await platformPaidScope.run({ reason: "conversation_classify" }, () => gen({
    tenantId,
    model: deps.model ?? getDefaultModel(),
    messages: relevancePrompt(profile, c),
    responseFormat: { type: "json_object" },
    // Room for a reasoning model's thinking before the short JSON.
    maxTokens: 400,
    reasoningEffort: "minimal",
    metadata: { type: "conversation_relevance" },
  }));
  const parsed = lowConfidence(onlyAfterOwnOutbound(firstMover(parseRelevance((r as any)?.content ?? (r as any)?.text ?? ""), c), c));
  return { ...parsed, source: "model", classifiedAt: now.toISOString() };
}

/** Re-run when a new inbound came after the last label AND the label is old or was unsure; never over an override. */
export function shouldReclassify(prev: { classifiedAt?: string | null; confidence?: number | null; overriddenBy?: string | null } | null, lastInboundAt: Date | null, now = new Date(), maxAgeMs = 6 * 60 * 60_000): boolean {
  if (prev?.overriddenBy) return false;
  if (!prev?.classifiedAt) return true;
  const at = Date.parse(prev.classifiedAt);
  if (!lastInboundAt || lastInboundAt.getTime() <= at) return false;
  return now.getTime() - at > maxAgeMs || Number(prev.confidence ?? 0) < 0.7;
}
