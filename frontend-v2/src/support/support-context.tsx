'use client';

import { createContext, useContext, type ReactNode } from 'react';

import type { SupportDenyKind } from './support-codes';

/** What the banner draws, from the platform's `current` (`load-support.ts`). */
export interface SupportView {
  /** The workspace's name; `null` when it could not be read. */
  readonly tenantName: string | null;
  readonly reason: string | null;
  /**
   * When it ends, as the time of day in the workspace's zone ("16:40"),
   * formatted on the server so the browser's ICU cannot redraw it (#418);
   * `null` when the session could not be read.
   */
  readonly endsAt: string | null;
}

interface SupportContextValue {
  /** The live support session, or `null` outside support mode. */
  readonly session: SupportView | null;
}

const SupportContext = createContext<SupportContextValue>({ session: null });

/** Provided once, from the layout's read: the first paint already knows. */
export function SupportProvider({
  session,
  children,
}: {
  readonly session: SupportView | null;
  readonly children: ReactNode;
}) {
  return <SupportContext.Provider value={{ session }}>{children}</SupportContext.Provider>;
}

/**
 * Support mode, for a control that decides whether it may act.
 *
 * `refuses(kind)` is true in support mode for each of the platform's four
 * refusals - billing, delete, ownership, secrets (Omer, 2026-11-01). The
 * platform refuses them anyway (403 `support_denied:*`); the control is
 * drawn refused first so the admin is never offered a click that cannot
 * work. Outside support mode it is always false.
 */
export function useSupport(): {
  readonly active: boolean;
  readonly session: SupportView | null;
  readonly refuses: (kind: SupportDenyKind) => boolean;
} {
  const { session } = useContext(SupportContext);
  const active = session !== null;
  return { active, session, refuses: () => active };
}
