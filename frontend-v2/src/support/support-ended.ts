import 'server-only';

import { cache } from 'react';

/**
 * ★★ "The platform ended the SUPPORT session", for the rest of this request.
 *
 * A 401 `support_expired` / `support_session_invalid` is not the admin
 * signed out: their own sign-in is fine, only the session inside the
 * workspace is over. `serverApi` marks it here instead of "session
 * rejected", and `signInHere` - the one place every 401 is sent - answers
 * the way back to the console instead of sign-in.
 */
const ended = cache(() => ({ value: false }));

export function markSupportEnded(): void {
  ended().value = true;
}

export function supportEnded(): boolean {
  return ended().value;
}
