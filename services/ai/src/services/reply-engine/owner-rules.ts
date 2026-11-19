/**
 * The business owner's own instructions, as the reply engine reads them (2026-11-19, Omer: what the owner
 * wrote must arrive). Three stores, each written by an owner screen and bounded where it is written:
 *  - AIAgent.customGuardrails: the employee's rules (20 at most, 280 characters each; shared lib guardrails).
 *  - AIAgent.escalationRules: when a person takes over (50 at most, a label of 300 characters). Enabled ones only.
 *  - BusinessPolicy.data.blockedTopics: what is never said (50 at most, 200 characters each).
 * Nothing is shortened below those limits: what the screen accepts is what the employee is given.
 */
import { readGuardrails, MAX_RULES, MAX_RULE_LEN } from "@chatcenter/shared";

export interface OwnerRules {
  /** The owner's rules, in the owner's words. */
  rules: string[];
  /** When the conversation goes to a person. Its order is the numbering the model cites (1-based). */
  handover: string[];
  /** What is never said or brought up. */
  never: string[];
}

// The limits of the screens that write them (ai-agents.ts escalationRules; workspace-policy.ts validateStringList).
const MAX_HANDOVER = 50;
const MAX_HANDOVER_LEN = 300;
const MAX_NEVER = 50;
const MAX_NEVER_LEN = 200;

const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** One hand-over rule as the owner wrote it: the label (its type when there is none), with its value when one is set. */
function handoverText(r: any): string {
  const label = oneLine(typeof r?.label === "string" && r.label.trim() ? r.label : typeof r?.type === "string" ? r.type : "").slice(0, MAX_HANDOVER_LEN);
  if (!label) return "";
  const value = r?.value == null || typeof r.value === "object" ? "" : oneLine(r.value).slice(0, 80);
  return value ? `${label} (value: ${value})` : label;
}

/** The rules of this turn, from the agent row and the business policy's data. A rule switched off is not read. */
export function readOwnerRules(agent: { customGuardrails?: unknown; escalationRules?: unknown } | null | undefined, policyData: unknown): OwnerRules {
  const rules = readGuardrails(agent?.customGuardrails).map((r) => oneLine(r).slice(0, MAX_RULE_LEN)).filter(Boolean).slice(0, MAX_RULES);
  const handover = (Array.isArray(agent?.escalationRules) ? (agent!.escalationRules as any[]) : [])
    .filter((r) => r && typeof r === "object" && r.enabled !== false)
    .map(handoverText)
    .filter(Boolean)
    .slice(0, MAX_HANDOVER);
  const topics = policyData && typeof policyData === "object" ? (policyData as any).blockedTopics : null;
  const never = (Array.isArray(topics) ? topics : [])
    .filter((t: unknown): t is string => typeof t === "string")
    .map((t: string) => oneLine(t).slice(0, MAX_NEVER_LEN))
    .filter(Boolean)
    .slice(0, MAX_NEVER);
  return { rules, handover, never };
}

export const ownerRuleCounts = (r: OwnerRules | null | undefined) => ({ rules: r?.rules.length ?? 0, handover: r?.handover.length ?? 0, never: r?.never.length ?? 0 });
export const hasOwnerRules = (r: OwnerRules | null | undefined) => !!r && r.rules.length + r.handover.length + r.never.length > 0;

/**
 * A hand-over that names one of the owner's hand-over rules loaded this turn: the number is in range.
 * Never read from the reply's text: no number, no exemption.
 */
export function citesOwnerHandover(rule: unknown, loaded: number | null | undefined): boolean {
  return typeof rule === "number" && Number.isInteger(rule) && rule >= 1 && rule <= (loaded ?? 0);
}

export const OWNER_RULES_HEADING = "# The business's own rules (written by the business owner)";
/** Who wins: the owner over playbook steps and style, never over grounding or safety. */
export const OWNER_RULES_PRECEDENCE =
  "These are this business's instructions to you, in the owner's own words. Follow every one of them in every reply, a rewritten reply included. " +
  "Where one of them differs from a playbook step, a skill or a style rule above, the business's rule wins. " +
  "They never change these: a fact, a price or a link comes only from a tool result or the knowledge, the safety rules stand, and nothing is said to be done that was not done.";
export const OWNER_HANDOVER_HOW =
  "These are added to the \"Handing over\" list above. When one of them is the reason, set respond.handoff (a short reason) and respond.handoff_rule to that rule's number, and tell the customer a person from the team will continue here. When none of them is the reason, handoff_rule is null.";

/** The block the stable prefix ends with, or null when the owner wrote nothing. */
export function renderOwnerRules(r: OwnerRules | null | undefined): string | null {
  if (!r || !hasOwnerRules(r)) return null;
  const out: string[] = [OWNER_RULES_HEADING, OWNER_RULES_PRECEDENCE];
  if (r.rules.length) out.push(`## Rules\n${r.rules.map((x) => `- ${x}`).join("\n")}`);
  if (r.handover.length) out.push(`## Hand the conversation to a person when\n${r.handover.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n${OWNER_HANDOVER_HOW}`);
  if (r.never.length) out.push(`## Never say or bring up\n${r.never.map((x) => `- ${x}`).join("\n")}`);
  return out.join("\n\n");
}

// The particles Hebrew attaches to a word ("הזול", "בזול", "ולזול"): it is still the owner's word.
const HE_ATTACHED = "ו?[הבל]?";
const plainQuotes = (s: string) => s.replace(/[\u05F4\u201C\u201D\u201E]/g, '"').replace(/[\u05F3\u2018\u2019]/g, "'");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The never-list entries a text says (2026-11-19: never = ["זול"], and "הכי זול שמצאנו הוא ..." went out).
 * As a whole word: no letter or digit on either side ("זולת" is not "זול"); a Hebrew entry of three letters or more
 * also with an attached particle. Who used the word first does not matter: the customer's own quote excuses nothing.
 */
export function neverSaid(text: unknown, never: string[] | null | undefined): string[] {
  const t = plainQuotes(String(text ?? ""));
  if (!t.trim()) return [];
  return (never ?? []).filter((entry) => {
    const words = plainQuotes(oneLine(entry)).split(" ").filter(Boolean);
    // One letter is no entry ("a" would match every English reply).
    if ((words.join("").match(/[\p{L}\p{N}]/gu) ?? []).length < 2) return false;
    const attached = /^[\u05D0-\u05EA]{3,}/.test(words[0]) ? HE_ATTACHED : "";
    return new RegExp(`(?<![\\p{L}\\p{N}])${attached}${words.map(escapeRe).join("\\s+")}(?![\\p{L}\\p{N}])`, "iu").test(t);
  });
}

/** What the rewrite is told when the draft said a never-list entry: the entry by name, and that no one's use of it allows it. */
export const neverSaidNote = (entries: string[]) =>
  `- The business never says this: ${entries.map((e) => `"${e}"`).join(", ")}. Your reply says it. Write the reply again without ${entries.length > 1 ? "those words" : "that word or phrase"}, in other words; the customer using it does not make it yours to use.`;

/** The line the rewrite's correction ends with when the owner has rules: they hold for the rewritten reply too. */
export const OWNER_RULES_REWRITE_LINE = "The business's own rules (the last section of your instructions) still apply to the rewritten reply.";
