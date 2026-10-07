'use client';

import { createContext, useContext } from 'react';

/**
 * Home's command box asks through this: the first question turns Home into
 * the conversation. Its own module so the box does not import the whole
 * conversation (its router, its links) to find out whether it is inside one.
 */
export const AskContext = createContext<((question: string) => void) | null>(null);

/** `null` outside Home's conversation (the box then answers in place, as before). */
export function useHomeAsk(): ((question: string) => void) | null {
  return useContext(AskContext);
}
