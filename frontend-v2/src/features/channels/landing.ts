import type { ChannelType } from '@/api/contracts/channels';

/**
 * The way back from a channel's provider (backend ecd64c4d), read off the URL:
 *   `?connected=<platform>&count=N[&pending=1]`
 *   `?platform=<platform>&error=<code>`
 * Pure, so the server page can call it - a client module's helper cannot be.
 *
 * ★ And v1's way back (2026-10-09: dev's v1 paths now 302 here, so a flow
 *   started in v1 lands on this page): `pending=true` rather than `1`, and
 *   `error=` with NO `platform=` - every v1 failure. It was dropped in
 *   silence. Now the channel comes from the code when the code names one,
 *   and the sentence names no channel when it cannot. v1's renamed codes read
 *   as ours; a code nobody knows (a provider's own text) is "didn't connect" -
 *   the raw text is never shown.
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

/** v1's codes for what ours already say. */
const LEGACY_CODES: Record<
  string,
  { readonly outcome: (typeof CHANNEL_CONNECT_FAILURES)[number]; readonly channel?: ChannelType }
> = {
  access_denied: { outcome: 'denied' },
  missing_params: { outcome: 'callback_error' },
  connection_failed: { outcome: 'callback_error' },
  slack_token_failed: { outcome: 'token_exchange_failed', channel: 'SLACK' },
  gmail_already_connected: { outcome: 'already_connected', channel: 'GMAIL' },
  outlook_already_connected: { outcome: 'already_connected', channel: 'OUTLOOK' },
  slack_already_connected: { outcome: 'already_connected', channel: 'SLACK' },
};

/** The channel a code names on its own, for a way back that carries no `platform`. */
const CODE_CHANNEL: Partial<Record<string, ChannelType>> = {
  gmail_no_email: 'GMAIL',
  outlook_no_email: 'OUTLOOK',
  slack_no_team: 'SLACK',
  no_instagram_account: 'INSTAGRAM',
  no_whatsapp_numbers: 'WHATSAPP',
};

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
      /** `null`: v1's way back named no platform, and the code names none either. */
      readonly channel: ChannelType | null;
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
      // `1` is ours; `true` is v1's.
      pending: params.pending === '1' || params.pending === 'true',
    };
  }
  if (params.error) {
    const legacy = LEGACY_CODES[params.error];
    const outcome = legacy
      ? legacy.outcome
      : (CHANNEL_CONNECT_FAILURES as readonly string[]).includes(params.error)
        ? (params.error as (typeof CHANNEL_CONNECT_FAILURES)[number])
        : 'other';
    const channel =
      (params.platform ? PLATFORM_CHANNEL[params.platform] : undefined) ??
      legacy?.channel ??
      CODE_CHANNEL[params.error] ??
      null;
    return { channel, outcome };
  }
  return null;
}
