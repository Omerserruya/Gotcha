import type { HireStep } from './hire-draft';

/**
 * ★★ H-back (Omer, 2026-10-14): each hire step is its own history entry, so
 * the browser's back returns to the step you were on before.
 *
 * The entry a step pushes carries the step it shows and the step it was
 * pushed FROM. "Back" in the sheet means the previous step: it walks history
 * back only when this entry was pushed from that step; otherwise (a reload, a
 * restored draft, a jump from the summary) it replaces, and never leaves the
 * page.
 */
export type HireEntry = { readonly hireStep: HireStep; readonly hireFrom: HireStep };

/** The step an address shows; `null` when it is not the hire at all. */
export function hireStepOf(search: string): HireStep | null {
  const params = new URLSearchParams(search);
  if (params.get('hire') !== '1') return null;
  const step = params.get('step');
  return step === '2' ? 2 : step === '3' ? 3 : step === '4' ? 4 : 1;
}

/**
 * The entry the hire opened on, under the first step's: its door. A back out
 * of the hire lands here first, still in the hire, and the sheet decides -
 * ask, or walk on out. A new object each time: the router writes its own
 * state into the one it is given.
 */
export const hireDoor = () => ({ hireDoor: true as const });

export function isHireDoor(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { hireDoor?: unknown }).hireDoor === true
  );
}

/** Opening on an entry that is neither a step nor the door: make it the door. */
export function openDoor(state: unknown): boolean {
  if (isHireDoor(state)) return false;
  return !(typeof state === 'object' && state !== null && 'hireStep' in state);
}

export const hireUrl = (step: HireStep) => `?hire=1&step=${step}`;

/** Was the entry showing `step` pushed from the step before it? Then back is a history back. */
export function backIsHistory(state: unknown, step: HireStep): boolean {
  if (typeof state !== 'object' || state === null) return false;
  const entry = state as Partial<HireEntry>;
  return entry.hireStep === step && entry.hireFrom === step - 1;
}
