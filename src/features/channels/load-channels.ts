import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { channelsSchema, type Channel } from '@/api/contracts/channels';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * How far back the volume figure looks.
 *
 * The design says "this week". A literal trailing week is empty on any tenant
 * that has been quiet for eight days — including this one, where nothing is
 * newer than 2026-09-08, and where a trailing week is measurably 0 on every
 * channel. A health check whose every number is zero proves nothing.
 *
 * So the window is wider AND the row says so. It never prints "this week" over
 * a longer figure, and it never falls back silently between windows: that
 * would make one number mean two things, which is the mistake the Home channel
 * bar made before it was labelled.
 */
export const VOLUME_WINDOW_DAYS = 30;

/**
 * What screen 13 shows.
 *
 * ONE read. `GET /api/channels?from=&to=` carries identity, connection state,
 * the platform's own error text, the open count and the window count together.
 *
 * It was briefly two — the window figure came from
 * `/api/analytics/channel-performance` — and that was worse in three ways: it
 * grouped by channel TYPE rather than account, it needed a second permission
 * the list does not, and it returned volume for channels with no account at
 * all. Reading both numbers from the accounts removes all three.
 *
 * `null` means the call failed, and is never conflated with empty: a tenant
 * with nothing connected is the day-one state this screen exists to fix, and a
 * tenant whose channels would not load must not be told it has none.
 */
export interface ChannelsData {
  readonly channels: readonly Channel[] | null;
  readonly windowDays: number;
}

export async function loadChannels(now: Date = new Date()): Promise<ChannelsData> {
  const to = now.toISOString();
  const from = new Date(now.getTime() - VOLUME_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    const channels = await serverApi().get({
      endpoint: channelEndpoints.list(),
      payload: channelsSchema,
      query: { from, to },
    });
    return { channels, windowDays: VOLUME_WINDOW_DAYS };
  } catch (cause) {
    logger.warn('channels.list_failed', { cause });
    return { channels: null, windowDays: VOLUME_WINDOW_DAYS };
  }
}
