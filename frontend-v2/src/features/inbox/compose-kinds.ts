/**
 * 02's three composer chips, in its order. Kept out of `compose-actions.ts`
 * because a `'use server'` module may export only async functions.
 */
export const COMPOSE_KINDS = ['rewrite', 'shorter', 'translate'] as const;
export type ComposeKind = (typeof COMPOSE_KINDS)[number];
