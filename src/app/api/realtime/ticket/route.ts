import { NextResponse, type NextRequest } from 'next/server';

import { assertSameOrigin } from '@/api/client/csrf';
import { realtimeTicketSchema } from '@/api/contracts/presence';
import { realtimeEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';
import { refuseOnCredentialSurface } from '@/api/client/credential-surface';

/**
 * Mints a socket handshake ticket for the browser.
 *
 * This exists rather than the page calling the platform through the BFF
 * because a ticket is a credential: it is minted, handed over once, and spent
 * immediately. Routing it through its own endpoint keeps that lifecycle
 * visible and keeps the ticket out of any cached response.
 *
 * `no-store` is not decoration. A ticket is single-use and lives 60 seconds; a
 * cached one is either already spent or about to expire, and either way the
 * socket fails in a way that looks like a network fault.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  /*
   * ★★ NOT REACHABLE ON THE SIGN-IN ORIGIN. The middleware's refusal cannot
   * see this file — its matcher excludes `/api` — so this route was covered
   * there by the gateway allowlist and by nothing else, while every page route
   * had two independent refusals.
   */
  const notHere = refuseOnCredentialSurface(request);
  if (notHere) return notHere;

  const originError = assertSameOrigin(request);
  if (originError) return originError;

  try {
    const ticket = await serverApi().post({
      endpoint: realtimeEndpoints.ticket(),
      payload: realtimeTicketSchema,
      raw: true,
    });

    return NextResponse.json(ticket, {
      headers: { 'cache-control': 'no-store, private' },
    });
  } catch (cause) {
    logger.warn('realtime.ticket_failed', { cause });
    return NextResponse.json({ error: 'ticket_unavailable' }, { status: 502 });
  }
}
