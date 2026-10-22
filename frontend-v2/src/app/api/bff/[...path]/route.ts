import { NextResponse, type NextRequest } from 'next/server';

import { assertSameOrigin } from '@/api/client/csrf';
import { TENANT_HEADER } from '@/tenant/tenant-header';
import { activeSession } from '@/auth/session-store';
import { sessionCookieOptions } from '@/auth/session';
import { serverEnv } from '@/config/env.server';
import { logger } from '@/observability/logger';
import { refuseOnCredentialSurface } from '@/api/client/credential-surface';

/**
 * The browser's only route to the platform API.
 *
 * Two reasons this exists rather than the browser calling the API directly:
 *
 *  1. The platform's CORS policy admits only its own origin. A browser on
 *     `localhost:3000`, or on any future frontend origin, is refused outright.
 *  2. Keeping the access token server-side is the entire point of the session
 *     design. If the browser could attach a bearer token, the token would have
 *     to be readable by scripts, and XSS would become account takeover.
 *
 * So: the browser sends its HttpOnly session cookie to us, we exchange it for
 * a bearer token and a tenant header, and we forward. The token never crosses
 * the network boundary to the client.
 */

/** Headers that belong to one hop and must not be relayed. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  // Never relay the browser's cookies or its own auth header upstream: the
  // only credential the platform should see is the one we attach.
  'cookie',
  'authorization',
  TENANT_HEADER,
]);

/**
 * Response headers worth passing back. Everything else is dropped.
 *
 * ★ All after the first three are a FILE's: a message's photo, voice note
 * or document comes through here since the platform serves it only to a
 * logged-in caller (2026-10-10). Without `content-range` and `accept-ranges`
 * a voice note or a video cannot seek (the browser asks for a Range and must
 * be told what it got); without `content-disposition` a document the
 * platform marks as an attachment would render in the tab; and the
 * platform's `content-security-policy: sandbox` and `nosniff` on an upload
 * are the reason a file that does render can run nothing. `content-length`
 * and `cache-control` are decided separately, below.
 */
const PASS_THROUGH_RESPONSE_HEADERS = [
  'content-type',
  'x-request-id',
  'retry-after',
  'content-range',
  'accept-ranges',
  'content-disposition',
  'etag',
  'last-modified',
  'content-security-policy',
  'x-content-type-options',
];

function upstreamPath(segments: string[]): string | null {
  // Path segments arrive decoded; reject anything that could climb out of the
  // API namespace or smuggle a second request.
  if (
    segments.some(
      (segment) => segment.includes('..') || segment.includes('\\') || segment.includes('\n'),
    )
  ) {
    return null;
  }
  const path = `/${segments.map(encodeURIComponent).join('/')}`;
  return path.startsWith('/api/') ? path : null;
}

async function proxy(request: NextRequest, segments: string[]): Promise<NextResponse> {
  /*
   * ★★ NOT REACHABLE ON THE SIGN-IN ORIGIN. The middleware's refusal cannot
   * see this file - its matcher excludes `/api` - so this route was covered
   * there by the gateway allowlist and by nothing else, while every page route
   * had two independent refusals.
   */
  const notHere = refuseOnCredentialSurface(request);
  if (notHere) return notHere;

  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const path = upstreamPath(segments);
  if (!path) {
    return NextResponse.json({ error: 'Unsupported path.' }, { status: 400 });
  }

  const env = serverEnv();

  /*
   * Two ways to be authenticated, and the platform's own session wins.
   *
   * When this app is served from a host sharing the platform's cookie domain,
   * the browser sends that cookie here too, and forwarding it is strictly
   * better than anything this app can do itself: no token is ever held by the
   * frontend, and revoking the session server-side takes effect immediately
   * rather than whenever a locally-sealed cookie happens to expire.
   *
   * The fallback is this app's own session, used when it is deployed
   * somewhere the platform's cookie cannot reach.
   */
  const platformCookie = env.PLATFORM_SESSION_COOKIE
    ? request.cookies.get(env.PLATFORM_SESSION_COOKIE)
    : undefined;

  const session = platformCookie ? null : await activeSession();

  if (!platformCookie && !session) {
    const response = NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    response.cookies.delete({ name: sessionCookieOptions().name, path: '/' });
    return response;
  }
  const target = new URL(path, env.API_BASE_URL);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  if (platformCookie) {
    // Only the platform's own session cookie is relayed - never this app's,
    // and never anything else the browser happens to be carrying.
    headers.set('cookie', `${platformCookie.name}=${platformCookie.value}`);
  } else if (session) {
    headers.set('authorization', `Bearer ${session.at}`);
    if (session.tid) headers.set(TENANT_HEADER, session.tid);
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  /*
   * ★★ A STREAM'S TIMEOUT ENDS WHEN IT ANSWERS. The timeout's signal governs
   * the BODY too, so `AbortSignal.timeout(20s)` cut every event stream at 20
   * seconds - a Home answer longer than that stopped mid-sentence. For a
   * stream, the timeout covers only the wait for the answer to begin; after
   * that, the stream lives until it ends or the browser goes (`request.signal`
   * - closing the connection here closes it upstream; it does not cancel the
   * run, which has its own route).
   */
  const streaming = (request.headers.get('accept') ?? '').includes('text/event-stream');
  const upstreamAbort = new AbortController();
  const timer = setTimeout(
    () =>
      upstreamAbort.abort(new DOMException('The upstream did not answer in time.', 'TimeoutError')),
    env.API_TIMEOUT_MS,
  );
  request.signal?.addEventListener('abort', () => upstreamAbort.abort(), { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      signal: upstreamAbort.signal,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (cause) {
    clearTimeout(timer);
    logger.error('bff.upstream_unreachable', { method: request.method, path, cause });
    return NextResponse.json({ error: 'Upstream request failed.' }, { status: 502 });
  }
  const contentType = upstream.headers.get('content-type') ?? '';
  if (streaming && contentType.includes('text/event-stream')) {
    clearTimeout(timer);
  }
  /*
   * ★ A FILE'S BODY IS A STREAM TOO. A video or a long voice note read on a
   * slow line takes longer than the timeout to arrive, and the timeout would
   * cut it mid-file exactly as it cut the event streams. Anything a GET
   * answers that is not JSON is a file: its timeout, like a stream's, ends
   * when it answers.
   */
  if (request.method === 'GET' && contentType !== '' && !contentType.includes('json')) {
    clearTimeout(timer);
  }

  const responseHeaders = new Headers();
  for (const header of PASS_THROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }
  /*
   * The length is the upstream's only when the body is passed as it came.
   * `fetch` decodes a compressed body and keeps the compressed length, so a
   * length beside a content-encoding would be a lie that truncates the file.
   */
  const length = upstream.headers.get('content-length');
  if (length && !upstream.headers.has('content-encoding')) {
    responseHeaders.set('content-length', length);
  }
  /*
   * Proxied API data is per-user and per-tenant; it must never be cached by a
   * shared cache or by the browser. The platform's own answer is passed on
   * when it already says `no-store` (a message's file: `private, no-store`);
   * anything else - none, or a route that would allow caching - is replaced,
   * so no upstream route can widen it.
   */
  const upstreamCache = upstream.headers.get('cache-control');
  responseHeaders.set(
    'cache-control',
    upstreamCache && /(^|,)\s*no-store\s*(,|$)/i.test(upstreamCache)
      ? upstreamCache
      : 'no-store, private',
  );

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });

  if (upstream.status === 401) {
    // The platform rejected a token we believed was live. The session is over.
    logger.info('bff.session_rejected_upstream', { path });
    response.cookies.delete({ name: sessionCookieOptions().name, path: '/' });
  }

  return response;
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function PUT(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
