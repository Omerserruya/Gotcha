import { NextResponse, type NextRequest } from 'next/server';

import { refuseOnCredentialSurface } from '@/api/client/credential-surface';
import { serverEnv } from '@/config/env.server';
import { appUrl } from '@/lib/base-path';
import { logger } from '@/observability/logger';
import { SUPPORT_COOKIE, supportReturnLocale, supportTenant } from '@/support/support-cookie';

/**
 * Support mode is over: the platform said `support_expired` or
 * `support_session_invalid`, mid-page (`signInHere`) or mid-click (the BFF's
 * 401, `SessionExpiryWatcher`). The admin's own sign-in is untouched.
 *
 * Clears the support cookie - a render cannot - and opens the console's page
 * for that workspace with "Support mode ended" - in the language the admin
 * entered in (the cookie's), since the page it leaves is in the workspace's.
 * A cookie without one: unprefixed, the locale middleware's choice.
 *
 * ★ A GET that changes nothing but this browser's own cookie, and redirects
 *   only into this app: the workspace comes out of the sealed cookie, never
 *   the query, so it cannot be pointed anywhere.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // As every route here: never on the sign-in origin.
  const notHere = refuseOnCredentialSurface(request);
  if (notHere) return notHere;
  const tenantId = await supportTenant();
  const locale = await supportReturnLocale();
  const prefix = locale ? (`/${locale}` as const) : ('' as const);
  const path = tenantId
    ? (`${prefix}/system/tenants/${encodeURIComponent(tenantId)}?support=ended` as const)
    : (`${prefix}/system/tenants?support=ended` as const);
  logger.info('support.ended_redirect', { tenantId });
  const response = NextResponse.redirect(appUrl(path, serverEnv().APP_ORIGIN), 303);
  response.cookies.delete({ name: SUPPORT_COOKIE, path: '/' });
  response.headers.set('cache-control', 'no-store, private');
  return response;
}
