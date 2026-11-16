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
import { ungroundedPrices, checkReplyStyle, type StyleViolationKind } from "../reply-style-check.service";
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
  ["self_gendered", /(?<![\u0590-\u05FF])(?:הייתי\s+(?:הולכת|הולך|לוקחת|לוקח|בוחרת|בוחר|ממליצה|ממליץ)|אני\s+(?:ממליצה|ממליץ|מציעה|מציע|חושבת|חושב|בודקת|בודק|מעבירה|מעביר|יודעת|יודע))(?![\u0590-\u05FF])/u],
];

const ATTRIBUTE_ASK = /(?<![\u0590-\u05FF])(?:מגרד|מגרדת|נעים|נעימה|רך|רכה|עבה|דק|דקה|חומר|בד|מאיזה|עשוי|עשויה|כותנה|צמר|מרינו|פשתן|גזרה|גזרת|מידות|מידה|קטן|גדול|לכבס|כביסה|מכונה|ייבוש|מיוצר|תוצרת|איפה מייצרים|שקוף|נמתח|נמתחת|מחמם|חם|צבע|צבעים|בצבע|באיזה צבע|באילו צבעים|גוון|גוונים)(?![\u0590-\u05FF])|\b(?:colou?rs?|shades?|itch(?:y)?|soft|material|fabric|made of|fit|sizing|runs (?:small|large)|wash|care|origin|made in|warm|stretch)\b/iu;
const NO_INFO = /אין (?:לי|לנו)(?: כאן)? (?:מידע|פרטים)|לא (?:בטוח|בטוחה|יודע|יודעת|ידוע)|(?:לבדוק|אבדוק|נבדוק|בודקים)(?: את זה)? (?:מול|עם) הצוות|\b(?:I don'?t have (?:that |the )?(?:info|information|details)|not sure|check with the team)\b/iu;

// A handoff silences the AI for the rest of the conversation, so it is kept for
// these only (Omer via the Supervisor, 2026-11-16): an explicit ask for a person,
// a strong complaint, a damaged item, a late order. Not for a tool that failed,
// a discount, instalments or care details: those are answered, or checked with
// the team as a question (respond.team_question) while the AI keeps the chat.
const ASKS_FOR_PERSON = /(?<![\u0590-\u05FF])(?:נציג|נציגה|נציגים|בן אדם|בנאדם|אדם אמיתי|מישהו אמיתי|אנושי|אנושית|לדבר עם (?:מישהו|מישהי|מנהל|מנהלת|אחראי)|תעבירו אותי|להעביר אותי|מנהל|מנהלת)(?![\u0590-\u05FF])|\b(?:human|real person|representative|agent|someone real|talk to (?:a|someone)|manager|speak to)\b/iu;
// Damage, prod replay 2026-11-16: "לא מחוברים", "מפורק", "חסר" (a missing part) and
// "הגיע הרוס" were missed, so a damaged delivery was argued out of its handoff
// three times and became team questions. "חסר במלאי" is stock, not damage.
const STRONG_CASE = /(?<![\u0590-\u05FF])(?:[וש]?(?:פגום|פגומה|פגומים|פגומות|שבור|שבורה|שבורים|שבורות|נשבר|נשברה|נשברו|סדוק|סדוקה|נסדק|קרוע|קרועה|נקרע|נקרעה|מפורק|מפורקת|מפורקים|מפורקות|התפרק|התפרקה|התפרקו|לא מחובר|לא מחוברת|לא מחוברים|לא מחוברות|התנתק|התנתקה|התנתקו|לא תקין|לא תקינה|לא עובד|לא עובדת|לא נדלק|חסר(?!\s+(?:במלאי|לכם|לך))|חסרה|חסרים|חסרות|הגיע הרוס|הגיעה הרוסה|הגיעו הרוסים|הגיע פגום|הגיעה פגומה)|נזק|הרוס|הרוסה|לא הגיע|לא הגיעה|עדיין לא קיבלתי|לא קיבלתי|באיחור|איחור|מאחר|תקוע|תקועה|לא מקובל|מחפיר|שערורייה|עורך דין|תביעה|הונאה|נוכלים|רמאים|החזר כספי|כסף בחזרה)(?![\u0590-\u05FF])|\b(?:damaged|broken|torn|defective|cracked|came apart|missing (?:a |the )?(?:part|piece|item)|doesn'?t work|not working|never arrived|hasn'?t arrived|didn'?t arrive|late|lawyer|scam|fraud|chargeback|refund)\b/iu;

const MEDIA_PLACEHOLDER = /^(?:\[(?:Image|Photo|Video|Voice message|Audio|Document|Sticker|File|תמונה|סרטון|הודעה קולית|מסמך)[^\]]*\]|)$/i;

/** A handoff the customer's own words do not call for. */
export function needlessHandoff(handoff: string | null | undefined, recentInbound: string[], toolsAskedPerson: boolean): boolean {
  if (!handoff) return false;
  if (toolsAskedPerson) return false;
  // Photos sent right after the words ("[Image]") must not push them out of the window.
  const recent = recentInbound.filter((m) => !MEDIA_PLACEHOLDER.test(String(m ?? "").trim())).slice(-3).join("\n");
  return !ASKS_FOR_PERSON.test(recent) && !STRONG_CASE.test(recent);
}

/** The customer asked about a product's material, feel, fit, care or origin, and the reply pleads no info without reading the product. */
export function unreadProduct(reply: string, incoming: string, tools: ToolRunRecord[], toolsOffered: string[], teamQuestion = false): boolean {
  if (!ATTRIBUTE_ASK.test(incoming ?? "") || !(teamQuestion || NO_INFO.test(reply ?? ""))) return false;
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

/** A coupon or policy question sent to the team without searching the knowledge. */
export function unreadKnowledge(incoming: string, tools: ToolRunRecord[], toolsOffered: string[], teamQuestion = false): boolean {
  if (!teamQuestion || !COUPON_ASK.test(incoming ?? "")) return false;
  return toolsOffered.includes("search_knowledge") && !tools.some((t) => t.tool === "search_knowledge");
}

// A note meant for the engine (a simulated or test run) must never reach the customer, in any lane.
const SIMULATION_LEAK = /(?:סביבת (?:ה)?(?:בדיקה|בדיקות|ניסוי|טסט)|סימולציה|בסימולציה|לא בוצע(?:ה)? בפועל|שיחת (?:ה)?(?:בדיקה|ניסיון)|הודעת בדיקה)|\b(?:simulat(?:ed|ion)|sandbox|test (?:environment|conversation|mode)|not (?:actually|really) (?:performed|executed|sent))\b/iu;
export const simulationLeak = (reply: string) => SIMULATION_LEAK.test(reply ?? "");

// "I passed it to the team", said again while the team already has it open.
const TEAM_LINE = /(?:העברתי|העברנו|הועבר|הועברה)(?:\s+(?:את\s+)?(?:השאלה|הבקשה|הפנייה|זה|הנושא|הפרטים))?\s+(?:ל|אל\s+)ה?צוות|(?:הצוות|צוות)\s+(?:יבדוק|בודק|יחזור|יעדכן|יענה)|(?:בבדיקה|לבדוק)\s+(?:מול|עם)\s+הצוות|\b(?:passed (?:it|this|your question) (?:on )?to the team|the team (?:will|is) (?:check|look|get back))\b/iu;
const STATUS_ASK = /(?<![\u0590-\u05FF])(?:מה (?:קורה|קרה|המצב|עם זה|נשמע)|יש (?:חדש|חדשות|עדכון|תשובה)|עדכון|עדכנו|נו|כמה זמן|עוד כמה|מתי תהיה תשובה|ענו|הצוות)(?![\u0590-\u05FF])|\b(?:any (?:update|news)|still waiting|heard back)\b/iu;
/** The reply announces the team hand-off again although it is already open and the customer did not ask about it. */
export function repeatedTeamLine(reply: string, incoming: string, teamAlreadyOpen: boolean, newTeamQuestion: boolean): boolean {
  if (!teamAlreadyOpen || newTeamQuestion) return false;
  return TEAM_LINE.test(reply ?? "") && !STATUS_ASK.test(incoming ?? "");
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
  if (!honesty.ok) problems.push({ kind: "unsupported_action", claims: honesty.unsupported.map((u: any) => String(u?.match ?? u?.kind ?? u)) });

  if (unreadProduct(reply, i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion)) problems.push({ kind: "unread_product" });
  else if (unreadOrder(reply, i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion)) problems.push({ kind: "unread_order" });
  else if (unreadKnowledge(i.incomingMessage, i.tools, i.toolsOffered, !!i.teamQuestion)) problems.push({ kind: "unread_knowledge" });
  if (needlessHandoff(i.handoff, i.recentInbound ?? [i.incomingMessage], !!i.toolsNeedPerson)) problems.push({ kind: "needless_handoff" });
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
export const FACTUAL_KINDS: ReadonlySet<ClaimProblem["kind"]> = new Set<ClaimProblem["kind"]>(["ungrounded_price", "unsupported_action", "unknown_product"]);
export const factualProblems = (problems: ClaimProblem[]) => problems.filter((p) => FACTUAL_KINDS.has(p.kind));

const SENTENCES = /[^.!?\n]+[.!?]*\s*/g;
const dropSentences = (s: string, re: RegExp) => (s.match(SENTENCES) ?? [s]).filter((x) => !re.test(x)).join("").trim();

/**
 * Deterministic cleanup of a reply whose remaining problems are style only: what
 * code can fix safely is fixed, the rest is sent as written. An empty result means
 * nothing is left to say.
 */
export function cleanStyle(reply: string, codes: string[]): string {
  const c = new Set(codes);
  let s = String(reply ?? "");
  if (c.has("simulation_leak")) s = dropSentences(s, SIMULATION_LEAK);
  if (c.has("repeated_team_line")) s = dropSentences(s, TEAM_LINE);
  // "מצאתי כמה אפשרויות" -> "יש כמה אפשרויות"; "לא מצאתי" is left alone (the ban skips it too).
  if (c.has("found_narration")) s = s.replace(/(?<![֐-׿])(?<!לא\s)((?:ו|ש)?)מצאתי(?![֐-׿])/gu, "$1יש");
  return s.replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/[ \t]{2,}/g, " ").trim();
}

/** The ONE targeted correction note for the rewrite round. */
export function correctionNote(problems: ClaimProblem[], locale: "he" | "en"): string {
  const lines = ["Your reply cannot be sent as is. Rewrite it once, fixing exactly this, and call respond again:"];
  for (const p of problems) {
    if (p.kind === "ungrounded_price") lines.push(`- These prices are not in any tool result or the knowledge: ${p.prices.join(", ")}. Remove them or state only prices a tool returned.`);
    if (p.kind === "unsupported_action") lines.push(`- You said something was done that no tool did this turn (${p.claims.join("; ")}). Say only what really happened; offer a person if needed.`);
    if (p.kind === "needless_handoff") lines.push("- Do NOT hand this over: a handoff silences you for the rest of the chat, and the customer did not ask for a person. Set handoff to null. Answer from what you know; if the team must answer (a discount, instalments, a detail not in the product text), say you will check with the team and put the question in team_question. A tool that failed is not a reason: say you could not check it right now.");
    if (p.kind === "unread_order") lines.push("- The customer asked about their order or delivery. Look it up first: call the order or tracking tool now (ask for the order number or phone only if you truly need it), answer from what it returns, and only if it cannot tell say the team will check.");
    if (p.kind === "unread_knowledge") lines.push("- The customer asked about a coupon or a policy. Call search_knowledge now and answer from it; only if it has nothing put the question in team_question.");
    if (p.kind === "unread_product") lines.push("- The customer asked about the product itself (material, colours, feel, fit, care, origin). Read it first: call get_product (or the product search) now, answer from its text, and only if the text truly lacks it say you will check.");
    if (p.kind === "unknown_product") lines.push(`- These product keys are not in this turn's results: ${p.names.join("; ")}. Use only the PRODUCT_n keys a tool returned this turn.`);
    if (p.kind === "style") {
      const c = new Set(p.codes);
      if (c.has("gendered_address") || c.has("slash_form")) lines.push(locale === "he" ? "- Address the customer neutrally (לך / אפשר + infinitive), no gendered verbs and no slash forms." : "- Address the customer neutrally.");
      if (c.has("self_gender")) lines.push("- Speak of yourself in your configured gender, or neutrally.");
      if (c.has("banned_phrase") || c.has("self_intro")) lines.push("- Drop stock phrases and self-introductions; answer directly.");
      if (c.has("card_narration")) lines.push("- Do not describe the cards, their pictures or buttons; they are on screen.");
      if (c.has("callback_promise")) lines.push("- No \"נחזור אליך\" or any callback: say the question went to the team and the answer will come here in the chat (\"העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט\").");
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
