/**
 * An AI employee's own rules (AIAgent.customGuardrails, B4 2026-10-14): a list
 * of free-text rules the prompt renders as "Additional Business Rules".
 *
 * Stored as a JSON array of strings. The prompt reads only that shape
 * (asStringArray), so anything else stored is silently NOT enforced; every
 * writer goes through here so nothing else can be stored.
 *
 * - `normalizeGuardrails` is for a person's edit: over a limit is refused
 *   (GuardrailsError), never cut, so what they see is what the employee follows.
 * - `clampGuardrails` is for rules a system appends (onboarding's "Owner
 *   instruction: ..."), where a refusal would lose the whole step: it keeps
 *   within the same limits and drops what does not fit.
 */
export const MAX_RULE_LEN = 280;
export const MAX_RULES = 20;

export class GuardrailsError extends Error {
  readonly code = "GUARDRAILS_INVALID";
  constructor(message: string, public readonly reason: "not_a_list" | "not_text" | "too_long" | "too_many", public readonly max?: number, public readonly index?: number) {
    super(message);
  }
}

/** Trimmed, empties and exact repeats dropped. Throws GuardrailsError on any other problem. */
export function normalizeGuardrails(input: unknown): string[] {
  if (!Array.isArray(input)) throw new GuardrailsError("rules must be a list of text rules", "not_a_list");
  const out: string[] = [];
  const seen = new Set<string>();
  input.forEach((r, i) => {
    if (typeof r !== "string") throw new GuardrailsError(`rule ${i + 1} is not text`, "not_text", undefined, i);
    const t = r.trim();
    if (!t || seen.has(t)) return;
    if (t.length > MAX_RULE_LEN) throw new GuardrailsError(`rule ${i + 1} is longer than ${MAX_RULE_LEN} characters`, "too_long", MAX_RULE_LEN, i);
    seen.add(t);
    out.push(t);
  });
  if (out.length > MAX_RULES) throw new GuardrailsError(`at most ${MAX_RULES} rules`, "too_many", MAX_RULES);
  return out;
}

/** The stored rules as a list: [] for null, a non-list, or non-text entries. */
export function readGuardrails(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter((r): r is string => typeof r === "string" && !!r.trim()).map((r) => r.trim());
}

/** Within the limits without refusing: long rules cut, the oldest kept first. */
export function clampGuardrails(input: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of readGuardrails(input)) {
    const t = r.slice(0, MAX_RULE_LEN);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length === MAX_RULES) break;
  }
  return out;
}
