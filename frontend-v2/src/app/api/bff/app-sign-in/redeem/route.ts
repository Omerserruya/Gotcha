import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { assertSameOrigin } from '@/api/client/csrf';
import { refuseOnCredentialSurface } from '@/api/client/credential-surface';
import { redeemHandoffCode } from '@/auth/app-handoff';
import { TERMS_PENDING_COOKIE, termsPendingCookieOptions } from '@/auth/google-sign-in';
import { idTokenCookieOptions, sessionCookieOptions } from '@/auth/session';
import { logger } from '@/observability/logger';

/**
 * The app's WebView trades the code from gotcha://auth/done for the session
 * the callback put in it (see `auth/app-handoff.ts`): the same three cookies
 * the callback sets on the website - the session, the ID token for sign-out,
 * and the Terms marker - set here, in the WebView's own jar.
 *
 * ★ A POST from our own page (same origin), the code in the body: never in a
 *   query string, so never in a log line.
 * ★ One refusal for every failure (unreadable, expired, wrong verifier).
 */
const bodySchema = z.object({
  code: z.string().min(1).max(16_000),
  verifier: z.string().min(1).max(128),
});

function uncached(response: NextResponse): NextResponse {
  response.headers.set('cache-control', 'no-store');
  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const notHere = refuseOnCredentialSurface(request);
  if (notHere) return notHere;
  const crossOrigin = assertSameOrigin(request);
  if (crossOrigin) return uncached(crossOrigin);

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  const session = body.success ? await redeemHandoffCode(body.data.code, body.data.verifier) : null;
  if (!session) {
    logger.warn('auth.app_handoff.refused');
    return uncached(NextResponse.json({ error: 'invalid_code' }, { status: 400 }));
  }

  const response = NextResponse.json({ ok: true });
  const sessionOptions = sessionCookieOptions();
  response.cookies.set(sessionOptions.name, session.s, sessionOptions);
  if (session.i) {
    const idOptions = idTokenCookieOptions();
    response.cookies.set(idOptions.name, session.i, idOptions);
  }
  if (session.t) {
    const termsOptions = termsPendingCookieOptions();
    response.cookies.set(termsOptions.name, '1', termsOptions);
  } else {
    response.cookies.delete({ name: TERMS_PENDING_COOKIE, path: termsPendingCookieOptions().path });
  }
  logger.info('auth.app_handoff.redeemed');
  return uncached(response);
}
