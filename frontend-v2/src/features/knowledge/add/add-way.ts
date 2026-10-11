/*
 * No 'use client' here: the page (a server component) parses `?way=` with
 * `isAddWay`, and a function exported from a client module is a reference
 * the server cannot call - it threw on dev, and vitest, which ignores the
 * directive, passed it.
 */

/**
 * The ways in 08b offers, each the `sourceType` it would write.
 *
 * 02's sixth card, "Your product catalogue", is not here: Omer ruled
 * (2026-09-26) that the catalogue is not a knowledge source - it is 14's
 * part→system mapping.
 */
/*
 * ★ No "from a conversation" (Omer, 2026-10-11): it added nothing - no route
 *   pins one answer - and adding knowledge always teaches something new.
 *   Past conversations come in through the history import on 13.
 */
export const ADD_WAYS = ['document', 'page', 'drive', 'text'] as const;
export type AddWay = (typeof ADD_WAYS)[number];

/** 02's eyebrow over each card. */
export const EYEBROW: Record<AddWay, 'upload' | 'website' | 'drive'> = {
  document: 'upload',
  page: 'website',
  drive: 'drive',
  text: 'upload',
};

export function isAddWay(value: string | undefined): value is AddWay {
  return (ADD_WAYS as readonly string[]).includes(value ?? '');
}

/**
 * Where an added source goes: a knowledge base, `none` yet (one is made
 * first), or `unknown`.
 *
 * ★ `unknown` - the list of bases could not be read - is NOT "none": a failed
 * read must never create a second base. It refuses, and sends nothing.
 */
export type KnowledgeBaseRef = { readonly id: string } | 'none' | 'unknown';

/** The codes the way back can carry (a closed set on the backend). */
export const KNOWLEDGE_CONNECT_FAILURES = [
  'denied',
  'token_exchange_failed',
  'no_accessible_site',
  'callback_error',
] as const;
export type KnowledgeLanding = {
  readonly connector: 'google_drive' | 'confluence';
  readonly outcome: 'connected' | (typeof KNOWLEDGE_CONNECT_FAILURES)[number] | 'other';
};
