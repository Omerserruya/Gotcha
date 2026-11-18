'use client';

import { createContext, useContext, type ReactNode } from 'react';

const InboxRelevanceContext = createContext(false);

/**
 * Is the inbox's "personal and not relevant" view on (`INBOX_RELEVANCE`)?
 * Read by the layout on the server and handed down, like `soleHuman`, so the
 * rail's first render already has the view or does not.
 *
 * ★ The default is `false`: outside the provider, the inbox is today's.
 */
export function InboxRelevanceProvider({
  on,
  children,
}: {
  readonly on: boolean;
  readonly children: ReactNode;
}) {
  return <InboxRelevanceContext.Provider value={on}>{children}</InboxRelevanceContext.Provider>;
}

export function useInboxRelevance(): boolean {
  return useContext(InboxRelevanceContext);
}
