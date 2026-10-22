import { disclosesAi, type Employee } from '@/api/contracts/employees';

/**
 * The employee page's Profile tab - what it can change, and the body Save
 * sends. Each field is one of `PATCH /api/ai-agents/:id`'s, under its own
 * name (read in `services/ai/src/routes/ai-agents.ts`):
 *
 *   responsibility   `identity.responsibility` - the whole `identity` is
 *                    sent back, since PATCH replaces the object
 *   tone             `tone`
 *   disclosesAi      `disclosesAi` - a boolean the route keeps inside
 *                    `persona` (Backend 28a9c3b6); 400 INVALID_DISCLOSES_AI
 *                    for anything else
 *   handover         `escalationRules` - the WHOLE array, every rule as read
 *                    (`type` and `value` included), as edited: added,
 *                    reworded, switched, removed. At most 50, each label
 *                    1-300 characters (400 INVALID_ESCALATION_RULES)
 *   access           `integrationAccess` - the business systems it may use,
 *                    the WHOLE list (Backend 00c6c229)
 *   limits           `customGuardrails` - its own rules in the owner's words,
 *                    the WHOLE list (E4, Backend c0cd7fbc): at most 20, each
 *                    at most 280 characters; trimmed and repeats dropped by
 *                    the route, and over a limit 400 GUARDRAILS_INVALID
 *                    {reason, max, index}, never cut
 *
 * No languages: it always answers in the customer's language, by rule, so
 * nothing here writes `languages` (Omer, 2026-10-13, E6). No sign-off: no
 * field ever held one.
 */

/** The route's bounds on `escalationRules`. */
export const MAX_RULES = 50;
export const MAX_RULE_LABEL = 300;

/** The route's bounds on `customGuardrails` (E4). */
export const MAX_LIMITS = 20;
export const MAX_LIMIT_LENGTH = 280;

/** One handover condition: its words and whether it is on; the rest as read. */
export type DraftRule = Readonly<Record<string, unknown>> & {
  readonly label: string;
  readonly enabled: boolean;
};

export type ProfileDraft = {
  readonly responsibility: string;
  readonly tone: string;
  readonly disclosesAi: boolean;
  /** The handover conditions, in order. */
  readonly rules: readonly DraftRule[];
  /** The systems it may use; `null` when they could not be read (then never sent). */
  readonly access: readonly string[] | null;
  /**
   * E4: its own rules, in order; `null` when they could not be read - then
   * never sent, since the list replaces what is stored.
   */
  readonly limits: readonly string[] | null;
};

export type ProfileField =
  'responsibility' | 'tone' | 'disclosesAi' | 'handover' | 'access' | 'limits';

/** `access`: the employee's allowlist as read (`GET /:id/integration-access`), or `null`. */
export function draftOf(employee: Employee, access: readonly string[] | null = null): ProfileDraft {
  return {
    access,
    responsibility: employee.identity?.responsibility ?? '',
    tone: employee.tone,
    disclosesAi: disclosesAi(employee),
    rules: employee.escalationRules.map((rule) => ({ ...rule })),
    limits: employee.customGuardrails === null ? null : [...employee.customGuardrails],
  };
}

/** A new condition: words to write, on. */
export function newRule(): DraftRule {
  return { label: '', enabled: true };
}

/**
 * `escalationRules` as the route takes it: every condition, in order, its
 * words trimmed, everything else as read. The page's Save and the hire send
 * this same body.
 */
export function rulesBody(rules: readonly DraftRule[]): Record<string, unknown>[] {
  return rules.map((rule) => ({ ...rule, label: rule.label.trim() }));
}

/**
 * Why the conditions cannot be saved as they are, or `null`: a condition
 * with no words (the route refuses an empty label), or more than it keeps.
 */
export function rulesProblem(rules: readonly DraftRule[]): 'empty' | 'tooMany' | null {
  if (rules.some((rule) => rule.label.trim() === '')) return 'empty';
  if (rules.length > MAX_RULES) return 'tooMany';
  return null;
}

/**
 * Why its own rules cannot be saved as they are, or `null`: a rule with no
 * words, one over the route's length, or more than it keeps.
 */
export function limitsProblem(
  limits: readonly string[] | null,
): 'empty' | 'tooLong' | 'tooMany' | null {
  if (limits === null) return null;
  if (limits.some((rule) => rule.trim() === '')) return 'empty';
  if (limits.some((rule) => rule.trim().length > MAX_LIMIT_LENGTH)) return 'tooLong';
  if (limits.length > MAX_LIMITS) return 'tooMany';
  return null;
}

/** The fields the draft changes, in the page's order. */
export function changesIn(
  employee: Employee,
  draft: ProfileDraft,
  storedAccess: readonly string[] | null = null,
): readonly ProfileField[] {
  const stored = draftOf(employee, storedAccess);
  const changed: ProfileField[] = [];
  if (draft.responsibility.trim() !== stored.responsibility.trim()) changed.push('responsibility');
  if (draft.tone !== stored.tone) changed.push('tone');
  if (draft.disclosesAi !== stored.disclosesAi) changed.push('disclosesAi');
  if (!sameRules(draft.rules, stored.rules)) changed.push('handover');
  if (draft.access !== null && stored.access !== null && !sameSet(draft.access, stored.access)) {
    changed.push('access');
  }
  if (draft.limits !== null && stored.limits !== null && !sameList(draft.limits, stored.limits)) {
    changed.push('limits');
  }
  return changed;
}

/** The PATCH body: only what changed, each under the route's own name. */
export function editPatch(
  employee: Employee,
  draft: ProfileDraft,
  storedAccess: readonly string[] | null = null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of changesIn(employee, draft, storedAccess)) {
    if (field === 'responsibility') {
      patch.identity = { ...employee.identity, responsibility: draft.responsibility.trim() };
    } else if (field === 'tone') {
      patch.tone = draft.tone;
    } else if (field === 'disclosesAi') {
      patch.disclosesAi = draft.disclosesAi;
    } else if (field === 'access') {
      patch.integrationAccess = [...(draft.access ?? [])].sort();
    } else if (field === 'limits') {
      // The whole list: a rule left out is removed; `[]` clears them.
      patch.customGuardrails = (draft.limits ?? []).map((rule) => rule.trim());
    } else {
      // The whole array: PATCH replaces it, so a rule left out is removed.
      patch.escalationRules = rulesBody(draft.rules);
    }
  }
  return patch;
}

function sameRules(a: readonly DraftRule[], b: readonly DraftRule[]): boolean {
  return (
    a.length === b.length &&
    a.every((rule, i) => rule.label.trim() === b[i]!.label.trim() && rule.enabled === b[i]!.enabled)
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((rule, i) => rule.trim() === b[i]!.trim());
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}
