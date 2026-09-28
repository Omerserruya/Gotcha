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
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THIS WAS UNPREFIXED, AND IT IS THE THIRD TIME IN THIS APP
 * ═════════════════════════════════════════════════════════════════════════════
 * `window.location.assign` is a plain web API: an absolute path resolves
 * against the ORIGIN, not against where this app is mounted. Under `/v2` it
 * sent the browser to `https://host/api/auth/login` — which, beside the legacy
 * product, is not a 404. It is **the other application's login route.**
 *
 * So a session expiring mid-work handed the person to a different product's
 * sign-in, carrying our `returnTo` on the query, and nothing on the way looked
 * wrong.
 *
 * ★ THE SWEEP THAT SHOULD HAVE CAUGHT IT LOOKED AT THE WRONG GRANULARITY.
 *   When the sign-in anchor was fixed, the note recorded that "every other one
 *   — `sign-out.ts`, `browser-api.ts`, `login-state.ts`,
 *   `realtime-provider.tsx` — already calls `appPath`". **It does, in
 *   `signOut` directly above.** A file can satisfy a check and still hold a
 *   second call site that does not, and a sweep organised by FILE cannot see
 *   it. Nor could one shaped like "a fetch with a root path": this is neither
 *   a fetch nor an `href`, which is the third distinct spelling of the same
 *   defect.
 */
export function startSignIn(returnTo: string): void {
  /*
   * eslint-disable-next-line @next/next/no-location-assign-relative-destination --
   * `/api/auth/login` is a route handler, not a page: it answers with a 302 to
   * Authentik. `router.push()` would try to render it as a route and fail.
   */
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`${appPath('/api/auth/login')}?returnTo=${encodeURIComponent(returnTo)}`);
}
