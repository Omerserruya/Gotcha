import 'server-only';

import { serverEnv } from '@/config/env.server';

/**
 * Is the inbox's relevance view on for this deployment? `INBOX_RELEVANCE=on`
 * only (env.server.ts). Read by the layouts (the rail's view) and the inbox
 * pages (the lists, the tags, the override).
 */
export function inboxRelevanceOn(): boolean {
  try {
    return serverEnv().INBOX_RELEVANCE === 'on';
  } catch {
    // An environment that does not parse fails elsewhere, loudly; here it is off.
    return false;
  }
}
