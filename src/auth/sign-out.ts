'use client';

import { appPath } from '@/lib/base-path';

/**
 * Ends the session from the browser.
 *
 * Lives in the auth layer rather than in a component for two reasons: the auth
 * endpoints are this layer's to know about, and a full-page navigation is
 * required here. The response points at Authentik's end-session endpoint,
 * which is a different origin - client-side routing cannot go there, and
 * trying would leave the identity provider's session alive while the local one
 * ended, so the next sign-in would silently skip the login screen.
 */
export async function signOut(): Promise<void> {
  /*
   * ★ `fetch` DOES NOT GET THE BASE PATH. `next/link` and `redirect()` do;
   * this is a plain web API and would post to `/api/auth/logout` at the root
   * — which, beside the legacy product, is another application's route rather
   * than a 404.
   */
  const response = await fetch(appPath('/api/auth/logout'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
  });

  const { redirectTo } = (await response.json()) as { redirectTo: string };
  window.location.assign(redirectTo);
}

/**
 * Sends the browser into the sign-in flow, returning afterwards to `returnTo`.
 *
 * Also a full-page navigation, and for the same reason: `/api/auth/login`
 * answers with a redirect to Authentik.
 */
export function startSignIn(returnTo: string): void {
  /*
   * eslint-disable-next-line @next/next/no-location-assign-relative-destination --
   * `/api/auth/login` is a route handler, not a page: it answers with a 302 to
   * Authentik. `router.push()` would try to render it as a route and fail.
   */
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}
