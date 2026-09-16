import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  channelsSchema,
  voiceChannelsSchema,
  type Channel,
  type VoiceChannel,
} from '@/api/contracts/channels';
import { channelEndpoints, voiceChannelEndpoints } from '@/api/endpoints/registry';
import { isApiError } from '@/api/client/api-error';
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
 * Two reads, of two genuinely different resources.
 *
 * `GET /api/channels?from=&to=` carries identity, connection state, the
 * platform's own error text, the open count and the window count together.
 * The window figure briefly came from `/api/analytics/channel-performance`
 * instead, which was worse in three ways: it grouped by channel TYPE rather
 * than account, it needed a second permission the list does not, and it
 * returned volume for channels with no account at all. Reading both numbers
 * from the accounts removed all three.
 *
 * `GET /api/voice-channels` is the second, and it is not a variant of the
 * first: voice lives on `CommunicationChannel` → `VoiceChannel`, in another
 * service, with its own status enum and its own connect mechanism.
 *
 * `null` means the call failed, and is never conflated with empty: a tenant
 * with nothing connected is the day-one state this screen exists to fix, and a
 * tenant whose channels would not load must not be told it has none.
 *
 * Voice is the second read, and its absence has THREE meanings that must not
 * collapse into one — see `voiceOffered`.
 */
export interface ChannelsData {
  readonly channels: readonly Channel[] | null;
  /** Connected voice channels. Empty when voice is offered but unconnected. */
  readonly voice: readonly VoiceChannel[];
  /**
   * Whether this tenant is offered voice at all.
   *
   * `false` ONLY on a 404, which the voice router returns deliberately when
   * `Tenant.voiceCopilotEnabled` is off: it means "this does not exist for
   * you", not "you may not look". So the Phone calls row appears when the
   * PRODUCT says voice exists here, rather than when we assume it does.
   *
   * A 500, a timeout or a 403 leaves this `true` with an empty list — we
   * could not ask, which is not the same as being told no, and the row should
   * not disappear because a service was briefly down.
   */
  readonly voiceOffered: boolean;
  readonly windowDays: number;
}

export async function loadChannels(now: Date = new Date()): Promise<ChannelsData> {
  const to = now.toISOString();
  const from = new Date(now.getTime() - VOLUME_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const api = serverApi();

  const [channels, voiceResult] = await Promise.all([
    api
      .get({ endpoint: channelEndpoints.list(), payload: channelsSchema, query: { from, to } })
      .catch((cause: unknown) => {
        logger.warn('channels.list_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: voiceChannelEndpoints.list(), payload: voiceChannelsSchema })
      .then((voice) => ({ voice, offered: true }))
      .catch((cause: unknown) => {
        // The one status that is an ANSWER rather than a fault.
        if (isApiError(cause) && cause.status === 404) {
          return { voice: [] as VoiceChannel[], offered: false };
        }
        logger.warn('channels.voice_failed', { cause });
        return { voice: [] as VoiceChannel[], offered: true };
      }),
  ]);

  return {
    channels,
    voice: voiceResult.voice,
    voiceOffered: voiceResult.offered,
    windowDays: VOLUME_WINDOW_DAYS,
  };
}
