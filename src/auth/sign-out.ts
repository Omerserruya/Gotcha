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
/**
 * How long to wait for the popup to run the invalidation flow.
 *
 * ★ Generous, because the cost of waiting is a second on a screen the person
 *   is leaving, and the cost of being impatient is landing them on `/` with a
 *   live provider session.
 */
/**
 * Where signing out lands.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ A HARD-CODED PRODUCTION URL, ON PURPOSE. IT IS NOT THE MOUNT-POINT BUG.
 * ════════════════════════════════════════════════════════════════════════════
 * Omer: "not `/` — I mean jump to `gotcha.co.il/`, not `app.gotcha.co.il/`",
 * and asked whether a DEV sign-out landing on the PRODUCTION marketing site
 * was acceptable: **"signing out to production is fine with me."**
 *
 * ★ So there is deliberately no environment variable. This will look exactly
 *   like the absolute-path defects this repository has had four times — a URL
 *   correct in one deployment and wrong in another — which is why the ruling
 *   is written here rather than left for someone to "fix".
 *
 * ★ The apex, not `www.`: `www.gotcha.co.il` does not resolve. Measured.
 *
 * ⚠ It never reaches the identity provider. The popup performs the
 *   invalidation; this is where OUR tab goes afterwards, so it needs no
 *   `post_logout_redirect_uri` entry and no allow-list change — which is also
 *   why it does not matter that the provider's allow-list has no entry for it.
 */
const SIGNED_OUT_URL = 'https://gotcha.co.il/';

const INVALIDATION_TIMEOUT_MS = 8000;
const POLL_MS = 150;

export async function signOut(): Promise<void> {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * ★★ THE WINDOW IS OPENED BEFORE THE FETCH, AND THAT IS THE WHOLE TRICK
   * ════════════════════════════════════════════════════════════════════════
   * `window.open` after an `await` has lost the user gesture and browsers
   * block it. So the window is opened on `about:blank` while the click is
   * still on the stack, and its location is set once the route answers —
   * which keeps the URL coming from the server and the gesture intact.
   *
   * ⚠ This is the detail most likely to break, and it would look like an
   *   INTERMITTENT failure rather than a bug: blocked for some people, some
   *   of the time, depending on browser settings.
   *
   * ★ Why a popup at all: Authentik's invalidation requires a TOP-LEVEL
   *   browsing context. Measured — a fetch does not invalidate, an iframe
   *   does not invalidate at 3s or 20s (it is a NESTED context), a popup
   *   does. It is not about being seen; it is about the kind of context.
   */
  const invalidation = window.open('about:blank', 'gotcha-sign-out', 'width=420,height=320');

  const response = await fetch(appPath('/api/auth/logout'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
  });

  const { redirectTo } = (await response.json()) as { redirectTo: string };

  /*
   * ⚠⚠ BLOCKED, OR CLOSED EARLY: NAVIGATE TOP-LEVEL INSTEAD.
   *
   * That is today's behaviour — the provider's page, and a session that
   * genuinely dies. **It must never fall through to our own page**, which
   * would be the fourth clean-looking sign-out that does not sign out.
   */
  if (!invalidation) {
    window.location.assign(redirectTo);
    return;
  }

  invalidation.location.replace(redirectTo);

  const ran = await waitForInvalidation(invalidation);
  invalidation.close();

  if (!ran) {
    window.location.assign(redirectTo);
    return;
  }

  /*
   * ★ The person never left this page, and the session on both sides is now
   *   gone. `assign`, not `replace`: back from here should return to a
   *   signed-out product, which bounces to sign-in, rather than silently
   *   re-entering history before the sign-out.
   */
  window.location.assign(SIGNED_OUT_URL);
}

/**
 * Waits for the popup to reach the provider's invalidation flow.
 *
 * ⚠⚠ CROSS-ORIGIN, SO ALMOST NOTHING IS READABLE. `popup.location.href`
 *    throws once it navigates to the provider, and that THROW is the signal:
 *    it means the window went somewhere we do not own, which is where the
 *    flow lives. A readable `about:blank` means it has not moved yet.
 *
 * ★ `closed` is readable cross-origin and is checked first: a person who
 *   shuts the window has not completed anything, and that is reported as
 *   unconfirmed rather than waited out.
 */
async function waitForInvalidation(popup: Window): Promise<boolean> {
  const deadline = Date.now() + INVALIDATION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (popup.closed) return false;

    try {
      /*
       * Still same-origin: `about:blank` or our own origin. Not there yet.
       * Reading `href` is what throws once it is cross-origin.
       */
      const here = popup.location.href;
      if (here !== 'about:blank' && here !== '') {
        /* Navigated, and still readable: it never left our origin. */
        return false;
      }
    } catch {
      /*
       * ★ A cross-origin window: the popup reached the provider. That is the
       *   only thing this function can observe, and the only thing that
       *   matters, because the invalidation happens as that page loads.
       *
       * ⚠ One more wait before answering, so the load has a moment to
       *   complete. Reaching the URL is not the same as the flow having run,
       *   and this is the closest observable we have to the difference.
       */
      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  return false;
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
