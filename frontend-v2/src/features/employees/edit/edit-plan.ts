import type { Employee } from '@/api/contracts/employees';

/**
 * 07f - what "Edit an employee" can change, and the body Save would send.
 *
 * Each field is one of `PATCH /api/ai-agents/:id`'s allow-list, under its own
 * name:
 *
 *   responsibility   `identity.responsibility` - the whole `identity` is
 *                    sent back, since PATCH replaces the object
 *   tone             `tone`
 *   languages        `languages` - `{ english, hebrew, arabic }`
 *   handover         `escalationRules` - each rule as read (`type` and
 *                    `value` included), with `enabled` as the box says
 *   access           `integrationAccess` - the business systems it may use,
 *                    the WHOLE list (PATCH replaces it; Backend 00c6c229)
 *
 * Save is drawn, not live, until Omer approves editing a working employee.
 * Going live is calling `updateEmployee(id, editPatch(employee, draft))`.
 */

export const EDIT_LANGUAGES = ['english', 'hebrew', 'arabic'] as const;

export type EditDraft = {
  readonly responsibility: string;
  readonly tone: string;
  readonly languages: Readonly<Record<string, boolean>>;
  /** `enabled` per rule, in the stored order. */
  readonly handover: readonly boolean[];
  /** The systems it may use; `null` when they could not be read (then never sent). */
  readonly access: readonly string[] | null;
};

export type EditField = 'responsibility' | 'tone' | 'languages' | 'handover' | 'access';

/** `access`: the employee's allowlist as read (`GET /:id/integration-access`), or `null`. */
export function draftOf(employee: Employee, access: readonly string[] | null = null): EditDraft {
  return {
    access,
    responsibility: employee.identity?.responsibility ?? '',
    tone: employee.tone,
    languages: Object.fromEntries(
      EDIT_LANGUAGES.map((language) => [language, employee.languages[language] === true]),
    ),
    handover: employee.escalationRules.map((rule) => rule.enabled),
  };
}

/** The fields the draft changes, in the sheet's order. */
export function changesIn(
  employee: Employee,
  draft: EditDraft,
  storedAccess: readonly string[] | null = null,
): readonly EditField[] {
  const stored = draftOf(employee, storedAccess);
  const changed: EditField[] = [];
  if (draft.responsibility.trim() !== stored.responsibility.trim()) changed.push('responsibility');
  if (draft.tone !== stored.tone) changed.push('tone');
  if (EDIT_LANGUAGES.some((l) => draft.languages[l] !== stored.languages[l])) {
    changed.push('languages');
  }
  if (draft.handover.some((on, i) => on !== stored.handover[i])) changed.push('handover');
  if (draft.access !== null && stored.access !== null && !sameSet(draft.access, stored.access)) {
    changed.push('access');
  }
  return changed;
}

/** The PATCH body: only what changed, each under the route's own name. */
export function editPatch(
  employee: Employee,
  draft: EditDraft,
  storedAccess: readonly string[] | null = null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of changesIn(employee, draft, storedAccess)) {
    if (field === 'responsibility') {
      patch.identity = { ...employee.identity, responsibility: draft.responsibility.trim() };
    } else if (field === 'tone') {
      patch.tone = draft.tone;
    } else if (field === 'access') {
      patch.integrationAccess = [...(draft.access ?? [])].sort();
    } else if (field === 'languages') {
      // Keys the sheet does not draw keep their stored value.
      patch.languages = { ...employee.languages, ...draft.languages };
    } else {
      patch.escalationRules = employee.escalationRules.map((rule, i) => ({
        ...rule,
        enabled: draft.handover[i] ?? rule.enabled,
      }));
    }
  }
  return patch;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}
