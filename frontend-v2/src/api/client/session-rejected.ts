import 'server-only';

import { cache } from 'react';

/**
 * ★★ "The platform refused this session", for the rest of THIS request
 * (supervisor, 2026-10-07). A section streamed after the layout cannot
 * redirect from a loader: every loader catches its failure and returns
 * "unread", which swallows a redirect too, so a session that ended showed
 * "couldn't read". `serverApi` marks the 401 here; a streamed section, after
 * its reads, asks - and renders `SessionEnded`, which hands the browser to
 * the one client handler (`SessionExpiryWatcher`): sign-in, "Your session
 * ended".
 *
 * `cache` is per request in a Server Component render.
 */
const rejected = cache(() => ({ value: false }));

export function markSessionRejected(): void {
  rejected().value = true;
}

export function sessionRejected(): boolean {
  return rejected().value;
}
