import 'server-only';

import { getFormatter } from 'next-intl/server';

import { serverApi } from '@/api/client/server-api';
import { currentSupportSessionSchema } from '@/api/contracts/console';
import { consoleEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { readSupport } from './support-cookie';
import type { SupportView } from './support-context';

/**
 * The support session this page is drawn in, for the banner - or `null`.
 *
 * Read from the platform's `current` (a console route, so it goes out as the
 * admin on every page, the console's included), not from `/me`: one source
 * for the workspace's pages, the console and onboarding alike.
 *
 * ★★ A COOKIE WITH NO READ IS STILL SUPPORT MODE. When `current` cannot be
 *   read, the banner is drawn without its details rather than not at all:
 *   every call on the page still carries the session, and an admin acting
 *   inside a customer's workspace must never see it look like their own.
 *   `current` answering `null` is different - the platform says it is over,
 *   and the page's next call ends it (`support_expired`).
 */
export async function loadSupport(): Promise<SupportView | null> {
  const held = await readSupport();
  if (!held) return null;
  try {
    const session = await serverApi().get({
      endpoint: consoleEndpoints.currentSupportSession(),
      payload: currentSupportSessionSchema,
    });
    if (!session || session.id !== held.id) return null;
    return {
      tenantName: session.tenantName,
      reason: session.reason,
      endsAt: await timeOfDay(session.expiresAt),
    };
  } catch (cause) {
    logger.warn('support.current_unread', { cause });
    return { tenantName: null, reason: null, endsAt: null };
  }
}

/** "16:40" in the workspace's zone (the formatter's, `i18n/request.ts`), or `null`. */
async function timeOfDay(iso: string): Promise<string | null> {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const format = await getFormatter();
  return format.dateTime(at, { hour: '2-digit', minute: '2-digit', hour12: false });
}
