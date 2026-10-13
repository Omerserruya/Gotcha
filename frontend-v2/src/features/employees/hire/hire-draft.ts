import { MAX_RULE_LABEL, MAX_RULES, type DraftRule } from '../page/profile-plan';
import { HIRE_JOBS, type HirePlan, type HireTool } from './hire-plan';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A HIRE THAT WAS CLOSED CONTINUES WHERE IT STOPPED (Omer, 2026-10-13, H6)
 * ════════════════════════════════════════════════════════════════════════════
 * "X during hiring closes without asking, and reopening starts from zero."
 * The plan is kept per person, in this browser only (`localStorage`, keyed
 * by the viewer's `User.id`, which is per workspace), and read back when the
 * sheet opens again. It is never sent anywhere.
 *
 * Read back with care - the actions and systems may have changed since:
 * a choice is kept only for an action still offered, and only if still
 * allowed; an unreadable or foreign draft is no draft. Storage that throws
 * (a private window, blocked site data) is simply no draft.
 */

export type HireStep = 1 | 2 | 3;

export interface HireDraft {
  readonly step: HireStep;
  readonly plan: HirePlan;
}

const KEY = (userId: string) => `gotcha:hire-draft:v1:${userId}`;

const isString = (v: unknown): v is string => typeof v === 'string';

/** Anything entered beyond where a new hire starts. */
export function hasEntries(plan: HirePlan, fresh: HirePlan): boolean {
  return (
    plan.job !== null ||
    plan.goal.trim() !== '' ||
    plan.name.trim() !== '' ||
    JSON.stringify(plan.choices) !== JSON.stringify(fresh.choices) ||
    JSON.stringify([...plan.access].sort()) !== JSON.stringify([...fresh.access].sort()) ||
    JSON.stringify(plan.rules) !== JSON.stringify(fresh.rules)
  );
}

/** Stored conditions, each made safe: words (at most the route's 300) and a switch; at most 50. */
function readRules(value: unknown): DraftRule[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(
      (r): r is { label: string; enabled?: unknown } =>
        typeof r === 'object' && r !== null && isString((r as { label?: unknown }).label),
    )
    .map((r) => ({ label: r.label.slice(0, MAX_RULE_LABEL), enabled: r.enabled !== false }))
    .slice(0, MAX_RULES);
}

/**
 * The draft as stored, made safe against today's actions; `null` when there
 * is none to use. `fresh`: where a new hire starts, today.
 */
export function readDraft(
  raw: string | null,
  tools: readonly HireTool[],
  fresh: HirePlan,
): HireDraft | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const { step, plan } = data as { step?: unknown; plan?: Record<string, unknown> };
  if (typeof plan !== 'object' || plan === null) return null;
  const job = (HIRE_JOBS as readonly unknown[]).includes(plan.job)
    ? (plan.job as HirePlan['job'])
    : null;
  const stored = typeof plan.choices === 'object' && plan.choices !== null ? plan.choices : {};
  const choices = Object.fromEntries(
    tools.map((tool) => {
      const chosen = (stored as Record<string, unknown>)[tool.toolName];
      return [
        tool.toolName,
        (tool.choices as readonly unknown[]).includes(chosen)
          ? (chosen as HirePlan['choices'][string])
          : fresh.choices[tool.toolName]!,
      ];
    }),
  );
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isString) : null);
  const draft: HirePlan = {
    job,
    goal: isString(plan.goal) ? plan.goal.slice(0, 600) : '',
    name: isString(plan.name) ? plan.name.slice(0, 120) : '',
    choices,
    access: list(plan.access) ?? fresh.access,
    // A draft kept before H3 holds chip keys (`handover`), not conditions: it starts fresh.
    rules: readRules(plan.rules) ?? fresh.rules,
  };
  if (!hasEntries(draft, fresh)) return null;
  // A later step needs step 1 done; otherwise it starts at step 1.
  const at = step === 2 || step === 3 ? step : 1;
  return { step: job === null ? 1 : at, plan: draft };
}

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadDraft(
  userId: string | null,
  tools: readonly HireTool[],
  fresh: HirePlan,
): HireDraft | null {
  if (!userId) return null;
  try {
    return readDraft(store()?.getItem(KEY(userId)) ?? null, tools, fresh);
  } catch {
    return null;
  }
}

export function saveDraft(userId: string | null, draft: HireDraft): void {
  if (!userId) return;
  try {
    store()?.setItem(KEY(userId), JSON.stringify(draft));
  } catch {
    /* No storage: the hire simply is not kept. */
  }
}

export function clearDraft(userId: string | null): void {
  if (!userId) return;
  try {
    store()?.removeItem(KEY(userId));
  } catch {
    /* Nothing to clear. */
  }
}
