/**
 * Backend 05979604's refusals of an edited amount or percentage: nothing
 * decided, nothing sent.
 *
 * ★ NOT IN `actions.ts`: a `'use server'` file may export only async functions.
 *   A constant there made Next refuse the WHOLE module at runtime — approve,
 *   reject and edit all answered 500 — and vitest, which ignores the
 *   directive, passed. `use-server-exports.test.ts` now guards the rule.
 */
export const EDIT_REFUSALS = [
  'edit_not_allowed',
  'amount_above_original',
  'invalid_amount',
  'edit_requires_original_amount',
  'percentage_above_original',
  'invalid_percentage',
  'edit_requires_original_percentage',
] as const;
export type EditRefusal = (typeof EDIT_REFUSALS)[number];
