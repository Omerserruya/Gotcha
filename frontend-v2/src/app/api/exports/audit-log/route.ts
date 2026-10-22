import { createTranslator } from 'next-intl';
import { NextResponse, type NextRequest } from 'next/server';

import { refuseOnCredentialSurface } from '@/api/client/credential-surface';
import { platformHeaders, serverApi } from '@/api/client/server-api';
import { membersSchema } from '@/api/contracts/people';
import { permissionEndpoints } from '@/api/endpoints/registry';
import { serverEnv } from '@/config/env.server';
import { auditCsv, parseCsvLine } from '@/features/security/audit-csv';
import { loadMessages } from '@/i18n/load-messages';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/locales';
import { logger } from '@/observability/logger';

/** The app's time zone - the one the screen writes its times in (i18n/request.ts). */
const TIME_ZONE = 'Asia/Jerusalem';

/**
 * 16's export, in the reader's words: `GET /api/exports/audit-log?locale=`.
 *
 * The platform's `GET /api/audit-logs/export` (ADMIN or
 * settings:workspace:update, its workspace's rows only) streams raw keys;
 * the words for them live here, with the screen. So the file is read as it
 * streams and written a line at a time, each led by the screen's columns
 * (audit-csv.ts) - never 8,000 rows held in memory.
 *
 * Authenticated as every server call is (`platformHeaders`): no session, 401.
 * A refusal upstream (403) is passed on as its status, never as a file.
 */
export async function GET(request: NextRequest) {
  const notHere = refuseOnCredentialSurface(request);
  if (notHere) return notHere;

  const asked = request.nextUrl.searchParams.get('locale');
  const locale = isLocale(asked) ? asked : DEFAULT_LOCALE;
  const headers = await platformHeaders();
  if (!headers.authorization && !headers.cookie) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(new URL('/api/audit-logs/export', serverEnv().API_BASE_URL), {
      headers,
      cache: 'no-store',
      signal: request.signal,
    });
  } catch (cause) {
    logger.error('audit_export.upstream_unreachable', { cause });
    return NextResponse.json({ error: 'Upstream request failed.' }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'Export refused.' }, { status: upstream.status || 502 });
  }

  // One team read for the names behind "by" - none (not an admin, or down): the actor's word.
  const names = new Map(
    (
      await serverApi()
        .get({ endpoint: permissionEndpoints.users(), payload: membersSchema })
        .catch(() => [])
    ).flatMap((m) => {
      const name = m.name?.trim() || m.email?.trim();
      return name ? [[m.id, name] as const] : [];
    }),
  );
  const messages = await loadMessages(locale, ['security']);
  const t = createTranslator({ locale, messages, namespace: 'security' }) as unknown as Parameters<
    typeof auditCsv
  >[0]['t'];
  const csv = auditCsv({ t, locale, timeZone: TIME_ZONE, names });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let pending = '';
  let seenHeader = false;
  const lineOut = (line: string): string | null => {
    const clean = line.replace(/^\uFEFF/, '').replace(/\r$/, '');
    if (!seenHeader) {
      seenHeader = true;
      return null; // the platform's header; ours went first
    }
    return clean.trim() === '' ? null : csv.row(parseCsvLine(clean));
  };

  const body = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        // The BOM is what makes a spreadsheet read Hebrew as UTF-8.
        controller.enqueue(encoder.encode(`\uFEFF${csv.header()}\n`));
      },
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        const out = lines.map(lineOut).filter((l): l is string => l !== null);
        if (out.length) controller.enqueue(encoder.encode(out.join('\n') + '\n'));
      },
      flush(controller) {
        pending += decoder.decode();
        const last = pending ? lineOut(pending) : null;
        if (last) controller.enqueue(encoder.encode(last + '\n'));
      },
    }),
  );

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-log-${stamp}.csv"`,
      'cache-control': 'no-store, private',
    },
  });
}
