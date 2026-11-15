'use client';

import { createContext, useContext, type ReactNode } from 'react';

const SoleHumanContext = createContext(false);

/**
 * Is the workspace one person (`/api/auth/me`'s `workspace.soleHuman`)?
 *
 * Read by the layout on the server and handed down as a prop, like the
 * permissions, so the first render already draws the right inbox views:
 * never three views that collapse to one once something loads.
 *
 * ★ The default is `false`, the team inbox: outside the provider, or when
 *   the flag could not be read, nothing changes from today.
 */
export function SoleHumanProvider({
  soleHuman,
  children,
}: {
  soleHuman: boolean;
  children: ReactNode;
}) {
  return <SoleHumanContext.Provider value={soleHuman}>{children}</SoleHumanContext.Provider>;
}

export function useSoleHuman(): boolean {
  return useContext(SoleHumanContext);
}
