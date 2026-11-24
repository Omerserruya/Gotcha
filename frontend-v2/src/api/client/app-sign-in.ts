'use client';

import { appPath } from '@/lib/base-path';

/**
 * The app's Google handoff, from the WebView: the code from gotcha://auth/done
 * and the verifier that only the app holds, traded for the session cookies
 * (`app/api/bff/app-sign-in/redeem`, `auth/app-handoff.ts`).
 *
 * ★ A client for this app's own route, outside `HttpClient`: the answer is
 *   the cookies it sets, not a body to parse. Same-origin, so the browser
 *   sends the Origin header the route checks.
 */
export async function redeemAppSignIn(code: string, verifier: string): Promise<boolean> {
  try {
    const response = await fetch(appPath('/api/bff/app-sign-in/redeem'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code, verifier }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
