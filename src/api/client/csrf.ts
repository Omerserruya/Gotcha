import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';

import { serverEnv } from '@/config/env.server';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejects state-changing requests that did not originate from this app.
 *
 * The session cookie is `SameSite=Lax`, which already withholds it from
 * cross-site POSTs in current browsers. This is the second lock: it does not
 * depend on the browser honouring SameSite, and it costs one header read.
 *
 * A missing `Origin` on a state-changing request is treated as hostile - every
 * browser sends it on cross-origin writes, so its absence means the request
 * did not come from a browser page of ours.
 */
export function assertSameOrigin(request: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(request.method)) return null;

  const origin = request.headers.get('origin');
  if (origin && origin === serverEnv().APP_ORIGIN) return null;

  return NextResponse.json({ error: 'Cross-origin request rejected.' }, { status: 403 });
}
