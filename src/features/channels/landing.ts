import type { ChannelType } from '@/api/contracts/channels';

/**
 * The way back from a channel's provider (backend ecd64c4d), read off the URL:
 *   `?connected=<platform>&count=N[&pending=1]`
 *   `?platform=<platform>&error=<code>`
 * Pure, so the server page can call it - a client module's helper cannot be.
 */
export const CHANNEL_CONNECT_FAILURES = [
  'denied',
  'token_exchange_failed',
  'state_already_used',
  'invalid_state',
  'not_configured',
  'already_connected',
  'gmail_no_email',
  'outlook_no_email',
  'no_pages',
  'no_instagram_account',
  'no_whatsapp_numbers',
  'slack_no_team',
  'callback_error',
] as const;

const PLATFORM_CHANNEL: Record<string, ChannelType> = {
  instagram: 'INSTAGRAM',
  messenger: 'MESSENGER',
  gmail: 'GMAIL',
  outlook: 'OUTLOOK',
  slack: 'SLACK',
  whatsapp: 'WHATSAPP',
};

export type ChannelLanding =
  | {
      readonly channel: ChannelType;
      readonly outcome: 'connected';
      readonly count: number | null;
      readonly pending: boolean;
    }
  | {
      readonly channel: ChannelType;
      readonly outcome: (typeof CHANNEL_CONNECT_FAILURES)[number] | 'other';
    };

export function channelLandingOf(params: {
  readonly connected?: string;
  readonly count?: string;
  readonly pending?: string;
  readonly platform?: string;
  readonly error?: string;
}): ChannelLanding | null {
  if (params.connected) {
    const channel = PLATFORM_CHANNEL[params.connected];
    if (!channel) return null;
    const n = Number(params.count);
    return {
      channel,
      outcome: 'connected',
      count: Number.isInteger(n) && n >= 0 ? n : null,
      pending: params.pending === '1',
    };
  }
  if (params.platform && params.error) {
    const channel = PLATFORM_CHANNEL[params.platform];
    if (!channel) return null;
    return {
      channel,
      outcome: (CHANNEL_CONNECT_FAILURES as readonly string[]).includes(params.error)
        ? (params.error as (typeof CHANNEL_CONNECT_FAILURES)[number])
        : 'other',
    };
  }
  return null;
}
