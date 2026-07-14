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
function str(v: unknown): string | undefined { return typeof v === "string" && v.trim() ? v.trim() : undefined; }

function systemPrompt(input: TuneChatInput, lang: string): string {
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
    "This is a CONVERSATIONAL BUILD: the business owner is setting you up by talking to you BEFORE you start working. Walk them through it naturally, one short step at a time (don't dump everything at once). Cover, roughly in this order, adapting to what they say:",
    "1. Briefly introduce yourself and state, in one line, the JOB you understand you're here to do (your goal). Ask the owner to confirm or adjust it.",
    "2. Once the goal is settled, propose 2-4 concrete SUCCESS CRITERIA (what doing this job well looks like) and ask if those are right.",
    "3. Invite the owner to brainstorm and add any rules, do's & don'ts, or preferences (e.g. 'always offer the callback option', 'never promise discounts').",
    "Throughout: reply briefly and warmly, IN YOUR OWN VOICE as this employee (first person), 1-3 sentences, ending with a question that moves the build forward until everything is settled.",
    "",
    "Capture the owner's decisions into the persona as you go:",
    "- goal: the confirmed one-line mandate (update it the moment the owner adjusts it).",
    "- successCriteria: the confirmed list of what success looks like.",
    "- instructions: the running list of every explicit rule / tuning ask the owner gives you - these are applied to you as SYSTEM-LEVEL instructions when you deploy, so capture them faithfully (append new ones, keep prior ones). Quick asks like 'be more concise' or 'be friendlier' also go here AND adjust tone/personality/focus.",
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

  try {
    const resp = await generateResponse({
      tenantId: input.tenantId,
      model: getDefaultModel(),
      temperature: 0.5,
      maxTokens: 700,
      responseFormat: { type: "json_object" },
      metadata: { type: "onboarding_employee_tuning" },
      messages: [
        { role: "system", content: systemPrompt(input, lang) },
        ...input.messages.slice(-10),
      ],
    });

    let parsed: any;
    try { parsed = JSON.parse(stripFences(resp.content ?? "")); } catch { parsed = null; }
    const reply = str(parsed?.reply) || (lang === "Hebrew" ? "בסדר גמור - עדכנתי את עצמי." : "Got it - I've updated myself.");
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
