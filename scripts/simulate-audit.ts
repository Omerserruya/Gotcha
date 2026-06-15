/**
 * Behavioral simulation audit. For each scenario, runs a real multi-turn
 * conversation: the AGENT side uses the actual production assembled prompt
 * (computeBehaviorState → buildAgentPrompt, recomputed every turn) + gpt-4o-mini;
 * the CUSTOMER side is a second gpt-4o-mini role-playing a realistic persona.
 *
 * Emits per-turn state/strategy/relationship traces + transcripts + automated
 * heuristic flags to /app/audit-out.json. Run in the ai container.
 */
import { prisma } from "@chatcenter/shared";
import { buildAgentPrompt } from "/app/services/ai/src/services/prompt-builder.service";
import { computeBehaviorState } from "/app/services/ai/src/services/behavior-engine.service";

const AGENT_ID = "cmnvsm2ao0003eioazm6qbg8c";
const TURNS = 10;
const KEY = process.env.OPENAI_API_KEY!;

async function chat(messages: any[], temperature: number): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages, temperature, max_tokens: 320 }),
      });
      const j = await r.json();
      if (j.choices?.[0]?.message?.content) return j.choices[0].message.content.trim();
      if (j.error) throw new Error(j.error.message);
    } catch (e: any) { if (attempt === 2) return `[[LLM_ERROR: ${e.message}]]`; }
  }
  return "[[LLM_ERROR]]";
}

interface Scenario {
  id: string; locale: "he" | "en"; lifecycle: string | null; prior: number;
  crm?: string; firstMsg: string; persona: string;
}

const SCENARIOS: Scenario[] = [
  { id: "01_newlead_he", locale: "he", lifecycle: null, prior: 0, firstMsg: "היי",
    persona: "אתה בעל עסק קטן בישראל (גבר) שכרגע פנה בוואטסאפ לפלטפורמת תקשורת ללקוחות. סקרן אבל מעורפל בהתחלה. ענה בעברית, קצר וטבעי, משפט-שניים." },
  { id: "02_newlead_en", locale: "en", lifecycle: null, prior: 0, firstMsg: "hi",
    persona: "You're a US small-business owner (man) who just messaged a customer-comms SaaS on WhatsApp. Curious but vague at first. Reply in English, short and natural." },
  { id: "03_returning_lead", locale: "he", lifecycle: "lead", prior: 2, firstMsg: "היי, דיברנו לפני כמה ימים",
    persona: "אתה ליד חוזר (גבר) ששוחח איתם בעבר. חזרת עם עוד שאלות על המוצר. עברית, טבעי." },
  { id: "04_interested_buyer", locale: "he", lifecycle: "lead", prior: 1, firstMsg: "אהבתי מה שראיתי, איך מתחילים?",
    persona: "אתה קונה מעוניין (גבר) שמוכן להתקדם. שואל איך להתחיל, מבקש דמו. עברית, ענייני." },
  { id: "05_objection", locale: "he", lifecycle: "lead", prior: 1, firstMsg: "נראה מעניין אבל אני חושש שזה יקר",
    persona: "אתה ליד (גבר) עם התנגדות מחיר. מנדנד שזה יקר מדי, מבקש הצדקה. עברית." },
  { id: "06_pricing", locale: "en", lifecycle: "lead", prior: 0, firstMsg: "how much does this cost?",
    persona: "You (man) keep pressing on exact pricing and won't easily accept 'depends'. English." },
  { id: "07_technical", locale: "he", lifecycle: "lead", prior: 0, firstMsg: "איך ההעברה בין ערוצים עובדת טכנית?",
    persona: "אתה מנהל טכני (גבר) ששואל שאלות טכניות מפורטות על אינטגרציות, API, וובהוקים. עברית." },
  { id: "08_frustrated", locale: "he", lifecycle: "customer", prior: 3, firstMsg: "שלחתי הודעה ואף אחד לא ענה",
    persona: "אתה לקוח (גבר) שמתחיל ניטרלי ואז מתוסכל ועצבני כי לא קיבל מענה. תשובות קצרות וחדות. עברית." },
  { id: "09_reopen_days", locale: "he", lifecycle: "lead", prior: 1, firstMsg: "היי, חזרתי אחרי שבוע, רוצה להמשיך מאיפה שעצרנו",
    persona: "אתה ליד (גבר) שחוזר אחרי שבוע להמשיך שיחה קודמת. עברית." },
  { id: "10_known_crm", locale: "he", lifecycle: "lead", prior: 1,
    crm: "- Customer Name: <<NAME>>\n- Company: <<AGENCY>> (marketing agency)\n- Team size: 25\n- Channels: WhatsApp, Instagram",
    firstMsg: "היי, רוצה לשמוע עוד",
    persona: "אתה מנהל סוכנות שיווק (גבר) עם צוות 25. אתה מעורפל בכוונה כדי לבדוק אם הסוכן משתמש במה שהוא כבר יודע עליך. עברית." },
  { id: "11_female_he", locale: "he", lifecycle: null, prior: 0, firstMsg: "היי, אני מחפשת פתרון לעסק שלי",
    persona: "את אישה בעלת עסק. השתמשי בלשון נקבה עקבית: 'אני מחפשת', 'הייתי רוצה', 'בטוחה'. עברית, טבעי." },
  { id: "12_male_he", locale: "he", lifecycle: null, prior: 0, firstMsg: "היי, אני מחפש פתרון לעסק שלי",
    persona: "אתה גבר בעל עסק. לשון זכר עקבית: 'אני מחפש', 'הייתי רוצה'. עברית." },
  { id: "13_gender_unclear", locale: "he", lifecycle: null, prior: 0, firstMsg: "היי, מה אתם מציעים?",
    persona: "את/ה לקוח/ה שמנסח/ת בצורה ניטרלית בלי לחשוף מגדר (שמות עצם, אינפיניטיב). אחרי כ-5 הודעות חשוף/י שאת אישה ('האמת שאני מחפשת'). עברית." },
  { id: "14_oneword", locale: "he", lifecycle: null, prior: 0, firstMsg: "מידע",
    persona: "אתה לקוח (גבר) שעונה במילה-שתיים בלבד, יבש. 'כן', 'כמה', 'לא יודע'. עברית." },
  { id: "15_verbose", locale: "en", lifecycle: "lead", prior: 0, firstMsg: "Hi, let me explain our whole situation in detail...",
    persona: "You (man) reply in long, detailed multi-sentence paragraphs about your business, history, and needs. English." },
];

function buildAgentConfig(config: any) {
  return {
    name: config.name, role: config.role, tone: config.tone, style: config.style,
    identity: config.identity, goals: config.goals, toneConfig: config.toneConfig,
    behavioral: config.behavioral, persona: config.persona,
    conversationFlow: config.conversationFlow, customGuardrails: config.customGuardrails,
    escalationRules: config.escalationRules, behavioralAnchors: config.behavioralAnchors,
  };
}

function firstWords(s: string, n = 3) { return s.replace(/[^\p{L}\s]/gu, "").trim().split(/\s+/).slice(0, n).join(" ").toLowerCase(); }
const BANNED_CLOSERS = ["אני כאן בשבילך", "אני כאן לעזור", "אם יש שאלות נוספות אני כאן", "i'm here to help", "feel free to reach out", "anything else"];

async function runScenario(s: Scenario, config: any) {
  const customerSys = `${s.persona}\nYou are the CUSTOMER in a WhatsApp chat with a sales rep named Rotem. Stay in character. Never break character or mention you are an AI. Keep each message realistic in length for your persona.`;
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  const trace: any[] = [];
  let customerMsg = s.firstMsg;
  const agentOpeners: string[] = [];

  for (let turn = 1; turn <= TURNS; turn++) {
    history.push({ role: "user", content: customerMsg });
    const inboundTexts = history.filter(m => m.role === "user").map(m => m.content);
    const bs = computeBehaviorState({
      mode: "agent",
      identity: { hasContact: s.prior > 0 || !!s.crm, contactLifecycle: s.lifecycle as any, priorConversationCount: s.prior },
      request: { lastMessage: customerMsg, messageCount: history.length, recentDirections: history.slice(-5).map(m => m.role === "user" ? "INBOUND" : "OUTBOUND") as any, recentInboundTexts: inboundTexts },
    });
    const customerBlock = s.crm ? `## Customer & Conversation Info\n${s.crm}\n- Channel: WHATSAPP` : undefined;
    const sys = buildAgentPrompt({ behaviorState: bs, agent: buildAgentConfig(config), context: { customerBlock, locale: s.locale }, knowledge: { block: undefined } });

    const agentReply = await chat([{ role: "system", content: sys }, ...history], config.temperature ?? 0.7);
    history.push({ role: "assistant", content: agentReply });

    // automated flags
    const opener = firstWords(agentReply);
    const repeatedOpener = agentOpeners.includes(opener) && opener.length > 0;
    agentOpeners.push(opener);
    const bannedCloser = BANNED_CLOSERS.find(c => agentReply.toLowerCase().includes(c.toLowerCase())) || null;
    const exclaims = (agentReply.match(/!/g) || []).length;

    trace.push({
      turn, strategy: bs.strategy, stage: bs.conversationStage, relationship: bs.relationshipStrength.level,
      trust: bs.customerTrust.level, friction: bs.customerFriction.level,
      allowedActions: bs.allowedActions, customer: customerMsg, agent: agentReply,
      flags: { repeatedOpener: repeatedOpener ? opener : null, bannedCloser, exclaims: exclaims > 1 ? exclaims : 0 },
    });

    // customer responds (assistant<->user inverted from customer POV)
    const custTurn = history.map(m => ({ role: m.role === "user" ? "assistant" : "user", content: m.content }));
    customerMsg = await chat([{ role: "system", content: customerSys }, ...custTurn], 0.85);
    if (customerMsg.startsWith("[[LLM_ERROR")) break;
  }
  return { scenario: s.id, locale: s.locale, trace };
}

async function main() {
  const config = await prisma.aIAgent.findUnique({ where: { id: AGENT_ID } });
  if (!config) throw new Error("agent not found");
  const FILTER = (process.env.SCEN || "").split(",").filter(Boolean);
  const RUN = FILTER.length ? SCENARIOS.filter((s) => FILTER.some((f) => s.id.includes(f))) : SCENARIOS;
  const results: any[] = [];
  for (const s of RUN) {
    console.log(`[sim] ${s.id} …`);
    results.push(await runScenario(s, config));
  }
  const fs = await import("fs");
  fs.writeFileSync(`/app/audit-out-${process.env.TAG || "v1"}.json`, JSON.stringify(results, null, 2));
  console.log(`[sim] done — ${results.length} scenarios → /app/audit-out.json`);
  await prisma.$disconnect();
  process.exit(0);
}
main().catch(async (e) => { console.error("SIM ERROR:", e.stack || e.message); await prisma.$disconnect(); process.exit(1); });
