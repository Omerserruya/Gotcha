import { NextResponse, type NextRequest } from 'next/server';

import { refuseOnCredentialSurface } from '@/api/client/credential-surface';
import {
  apexOf,
  APP_HANDOFF_COOKIE,
  APP_HANDOFF_COOKIE_PATH,
  APP_HANDOFF_MAX_AGE_SECONDS,
  AUTHENTIK_SESSION_COOKIE,
  isChallenge,
  sealHandoffStart,
} from '@/auth/app-handoff';
import { serverEnv } from '@/config/env.server';
import { isLocale } from '@/i18n/locales';
import { appUrl } from '@/lib/base-path';

/**
 * The app's Google sign-in begins here, in the phone's auth browser (see
 * `auth/app-handoff.ts`): the challenge is sealed for the callback, and the
 * browser goes on to our own sign-in with `?google=start` - the website's
 * flow from there on, unchanged.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ AND ANY AUTHENTIK SESSION IN THAT BROWSER ENDS FIRST
 * ════════════════════════════════════════════════════════════════════════════
 * A browser with a live Authentik session that opens the Google source gets
 * that Google account LINKED to whoever is signed in - no flow, no email
 * check (Authentik's flow_manager: "When request is authenticated, always
 * link"). iOS runs ephemeral, so it has none; Android's Custom Tabs share
 * Chrome's cookies, so somebody signed in to GOTCHA in Chrome as one person
 * could tie another person's Google account to them. The provider's session
 * cookie is scoped to the apex (AUTHENTIK_COOKIE_DOMAIN on prod), so this
 * host can expire it. Our own web session cookie in that browser is left as
 * it is.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const notHere = refuseOnCredentialSurface(request);
  if (notHere) return notHere;

  const challenge = request.nextUrl.searchParams.get('challenge');
  if (!isChallenge(challenge)) {
    return NextResponse.json(
      { error: 'invalid_challenge' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const env = serverEnv();
  const asked = request.nextUrl.searchParams.get('locale');
  const locale = isLocale(asked) ? asked : 'he';
  const signIn = new URL(appUrl(`/${locale}/sign-in`, env.APP_ORIGIN));
  signIn.searchParams.set('google', 'start');

  const response = NextResponse.redirect(signIn);
  response.headers.set('cache-control', 'no-store');
  const secure = !env.APP_ORIGIN.startsWith('http://');
  response.cookies.set(APP_HANDOFF_COOKIE, await sealHandoffStart(challenge), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: APP_HANDOFF_COOKIE_PATH,
    maxAge: APP_HANDOFF_MAX_AGE_SECONDS,
  });

  /*
   * Two Set-Cookie lines for one name (the apex, and this host in case it was
   * set host-only), so written by hand: the cookie map keeps one per name.
   */
  const host = new URL(env.APP_ORIGIN).hostname;
  const apex = apexOf(host);
  const expire = (domain: string | null) =>
    [
      `${AUTHENTIK_SESSION_COOKIE}=`,
      'Path=/',
      'Max-Age=0',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ...(domain ? [`Domain=${domain}`] : []),
      ...(secure ? ['Secure'] : []),
      'HttpOnly',
      'SameSite=Lax',
    ].join('; ');
  if (apex) response.headers.append('set-cookie', expire(apex));
  response.headers.append('set-cookie', expire(null));
  return response;
}
