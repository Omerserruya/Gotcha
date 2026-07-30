/**
 * Employee tuning chat (Onboarding Movement 8 - "chat with the employee before
 * deploy"). The owner talks to the recommended AI employee BEFORE it is
 * activated; the employee replies in its own voice AND, when the owner asks it
 * to change how it works ("be friendlier", "focus more on sales"), returns an
 * updated persona that is applied to the real agent at deploy time.
 *
 * New LLM call → lives in services/ai (per CLAUDE.md).
 */

import { generateResponse, getDefaultModel } from "./ai.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "./knowledge.service";

export type EmployeeTone = "professional" | "friendly" | "casual" | "formal";

export interface EmployeePersona {
  tone?: EmployeeTone;
  personality?: string;      // short human description of how it comes across
  focus?: string;            // what it prioritises (e.g. "sales", "support")
  goal?: string;             // the employee's mandate, verified/edited in the chat
  successCriteria?: string[];// what "doing this job well" looks like (owner-confirmed)
  instructions?: string[];   // accumulated owner tuning asks → deployed as system rules
}

export interface TuneChatInput {
  tenantId: string;
  locale?: string;
  name: string;
  role: string;
  context?: { business?: string; industry?: string; summary?: string; brandVoice?: string; goal?: string };
  persona: EmployeePersona;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface TuneChatResult {
  reply: string;
  persona: EmployeePersona;
}

const LOCALE_NAMES: Record<string, string> = { en: "English", he: "Hebrew", ar: "Arabic" };
const VALID_TONES = new Set<EmployeeTone>(["professional", "friendly", "casual", "formal"]);

function stripFences(s: string): string { return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim(); }

/**
 * Last line of defence against the option-menu reply.
 *
 * The prompt used to ask for "2-4 success criteria", and the model learned to
 * answer the owner with a numbered menu - which reads as "here are three
 * possible replies" rather than an employee talking. The instruction is gone,
 * but a model under pressure still reaches for a list, so a reply that opens
 * with an option preamble is trimmed back to its first real sentence.
 *
 * Deliberately conservative: it only fires when a preamble is IMMEDIATELY
 * followed by enumerated items, so an ordinary reply that happens to contain
 * the word "options" is left alone.
 */
const OPTION_MENU_RE =
  /(here are|here's|i could|i can offer|a few (?:ways|options)|some options|אפשרויות|כמה דרכים|הנה כמה)[^\n]{0,80}[:：]\s*(?:\n|$)(?=(?:\s*(?:[-*•]|\d+[.)])\s+\S))/i;

export function stripOptionMenu(reply: string): string {
  const s = String(reply || "").trim();
  if (!OPTION_MENU_RE.test(s)) return s;
  // Keep the first enumerated item as the actual answer - it is the model's
  // own best option - and drop the menu framing plus the alternatives.
  const items = s.split(/\n+/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l));
  const first = items[0]?.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
  return first || s.split(/\n/)[0]!.replace(OPTION_MENU_RE, "").trim() || s;
}
function str(v: unknown): string | undefined { return typeof v === "string" && v.trim() ? v.trim() : undefined; }

function systemPrompt(input: TuneChatInput, lang: string, kbBlock: string | null): string {
  const c = input.context || {};
  const p = input.persona || {};
  return [
    `You are ${input.name}, the ${input.role.replace(/_/g, " ")} AI employee about to join ${c.business || "this business"}.`,
    c.industry ? `Industry: ${c.industry}.` : "",
    c.summary ? `Business: ${c.summary}` : "",
    c.brandVoice ? `Brand voice you should adopt: ${c.brandVoice}.` : "",
    `Current persona - tone: ${p.tone || "professional"}; personality: ${p.personality || "-"}; focus: ${p.focus || "-"}.`,
    `The job I was set up for (goal): ${p.goal || c.goal || "not yet confirmed"}.`,
    (p.successCriteria && p.successCriteria.length) ? `Current success criteria: ${p.successCriteria.join("; ")}.` : "",
    "",
    "This is a CONVERSATIONAL BUILD: the business owner is setting you up by talking to you BEFORE you start working. Walk them through it naturally, ONE step at a time. Cover, roughly in this order, adapting to what they say:",
    "1. Briefly introduce yourself and state, in one line, the JOB you understand you're here to do (your goal). Ask the owner to confirm or adjust it.",
    "2. Once the goal is settled, say in one sentence what you think doing this job well looks like, and ask whether that matches what they expect.",
    "3. Invite the owner to add any rules, do's & don'ts, or preferences (e.g. 'always offer the callback option', 'never promise discounts').",
    "",
    "# How to reply (this is not optional)",
    "- Give ONE natural answer, the way a new colleague would talk. Answer the question you were actually asked.",
    "- NEVER offer the owner a menu of possible replies, numbered options, or 'here are a few ways I could…'. You are the one talking, not a tool suggesting what someone else might say. If you need a decision, ask for it in a single plain question.",
    "- Do not enumerate lists unless the owner explicitly asks you to list something.",
    "- First person, as this employee. 1-3 sentences. At most ONE question per reply.",
    "- Answer in the language the owner writes in.",
    "- Use the business knowledge below. If they ask something about their own business that the knowledge does not cover, say plainly that you don't have it yet and offer to be taught, rather than guessing.",
    "",
    "Capture the owner's decisions into the persona as you go:",
    "- goal: the confirmed one-line mandate (update it the moment the owner adjusts it).",
    "- successCriteria: the confirmed list of what success looks like.",
    "- instructions: the running list of every explicit rule / tuning ask the owner gives you - these are applied to you as SYSTEM-LEVEL instructions when you deploy, so capture them faithfully (append new ones, keep prior ones). Quick asks like 'be more concise' or 'be friendlier' also go here AND adjust tone/personality/focus.",
    "",
    // The business knowledge the scan and the owner's answers produced. Before
    // this existed the tuning chat knew only a one-line summary, so any question
    // about the owner's own business got a generic answer - the "it doesn't
    // understand my business" complaint. It reads the same knowledge base the
    // deployed employee will read.
    kbBlock ? `\n# What you already know about this business\n${kbBlock}` : "",
    "",
    `Write the reply in ${lang}.`,
    "Respond ONLY with a JSON object (no fences, no prose outside it):",
    '{ "reply": string, "persona": { "tone": "professional"|"friendly"|"casual"|"formal", "personality": string, "focus": string, "goal": string, "successCriteria": string[], "instructions": string[] } }',
    "- persona MUST carry forward the current persona, modified only by what the owner said in the latest message.",
    "- If the owner only chatted (no change requested), return the persona unchanged.",
  ].filter(Boolean).join("\n");
}

export async function tuneEmployeeChat(input: TuneChatInput): Promise<TuneChatResult> {
  const lang = LOCALE_NAMES[input.locale || "en"] || "English";
  const prior: EmployeePersona = {
    tone: input.persona.tone && VALID_TONES.has(input.persona.tone) ? input.persona.tone : "professional",
    personality: input.persona.personality,
    focus: input.persona.focus,
    goal: input.persona.goal || input.context?.goal,
    successCriteria: Array.isArray(input.persona.successCriteria) ? input.persona.successCriteria.slice(0, 8) : [],
    instructions: Array.isArray(input.persona.instructions) ? input.persona.instructions.slice(0, 20) : [],
  };

  // Retrieve against the owner's latest message so the employee can actually
  // answer questions about the business it is about to work for. Failure is
  // non-fatal: the interview still works, it just knows less.
  let kbBlock: string | null = null;
  const lastOwnerMessage = [...input.messages].reverse().find((m) => m.role === "user")?.content;
  if (lastOwnerMessage) {
    try {
      const chunks = await retrieveRelevantChunks(input.tenantId, lastOwnerMessage, 4);
      kbBlock = chunks.length ? buildKnowledgeContext(chunks) || null : null;
    } catch (err: any) {
      console.warn("[employee-tuning] knowledge retrieval failed:", err?.message);
    }
  }

  try {
    const resp = await generateResponse({
      tenantId: input.tenantId,
      model: getDefaultModel(),
      temperature: 0.5,
      maxTokens: 700,
      responseFormat: { type: "json_object" },
      metadata: { type: "onboarding_employee_tuning" },
      messages: [
        { role: "system", content: systemPrompt(input, lang, kbBlock) },
        ...input.messages.slice(-10),
      ],
    });

    let parsed: any;
    try { parsed = JSON.parse(stripFences(resp.content ?? "")); } catch { parsed = null; }
    const rawReply = str(parsed?.reply) || (lang === "Hebrew" ? "בסדר גמור, עדכנתי את עצמי." : "Got it, I've updated myself.");
    const reply = stripOptionMenu(rawReply);
    const p = parsed?.persona || {};
    const tone = str(p.tone) as EmployeeTone | undefined;
    const persona: EmployeePersona = {
      tone: tone && VALID_TONES.has(tone) ? tone : prior.tone,
      personality: str(p.personality) || prior.personality,
      focus: str(p.focus) || prior.focus,
      goal: str(p.goal) || prior.goal,
      successCriteria: Array.isArray(p.successCriteria)
        ? p.successCriteria.filter((x: unknown): x is string => typeof x === "string" && !!x.trim()).map((s: string) => s.trim()).slice(0, 8)
        : prior.successCriteria,
      instructions: Array.isArray(p.instructions)
        ? p.instructions.filter((x: unknown): x is string => typeof x === "string" && !!x.trim()).map((s: string) => s.trim()).slice(0, 20)
        : prior.instructions,
    };
    return { reply, persona };
  } catch (err: any) {
    console.warn("[employee-tuning] chat failed:", err?.message);
    return { reply: lang === "Hebrew" ? "סליחה, לא הצלחתי להגיב כרגע." : "Sorry, I couldn't respond just now.", persona: prior };
  }
}
