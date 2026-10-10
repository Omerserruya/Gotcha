import type { ChannelType } from '@/api/contracts/channels';

/**
 * The way back from a channel's provider (backend ecd64c4d), read off the URL:
 *   `?connected=<platform>&count=N[&pending=1]`
 *   `?platform=<platform>&error=<code>`
 * Pure, so the server page can call it - a client module's helper cannot be.
 *
 * ★ A pending connect that is not WhatsApp's (2026-10-10): Messenger and
 *   Instagram come back `pending=1&reason=SUBSCRIBE_FAILED` when the
 *   platform refused the webhook subscription - connected, nothing arrives.
 *   The platform may be named by `connected=` or by `platform=`; the reason
 *   is read only from codes this build knows, never printed.
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
  // Backend 0ce84f21: Messenger's connect over the plan's channel limit, and
  // its Page choices that could not be kept for the picker.
  'limit_reached',
  'picker_failed',
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
  // Only Messenger keeps Pages to choose from.
  picker_failed: 'MESSENGER',
};

const PLATFORM_CHANNEL: Record<string, ChannelType> = {
  instagram: 'INSTAGRAM',
  messenger: 'MESSENGER',
  gmail: 'GMAIL',
  outlook: 'OUTLOOK',
  slack: 'SLACK',
  whatsapp: 'WHATSAPP',
};

/** Why a pending connect is pending, by the code the way back carries. */
const PENDING_REASONS = { SUBSCRIBE_FAILED: 'subscribe_failed' } as const;
export type PendingReason = (typeof PENDING_REASONS)[keyof typeof PENDING_REASONS];

export type ChannelLanding =
  | {
      readonly channel: ChannelType;
      readonly outcome: 'connected';
      readonly count: number | null;
      readonly pending: boolean;
      /** A pending connect's known reason; `null` when none, or one unknown here. */
      readonly reason: PendingReason | null;
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
  readonly reason?: string;
}): ChannelLanding | null {
  // `1` is ours; `true` is v1's.
  const pending = params.pending === '1' || params.pending === 'true';
  const connected = params.connected ?? (pending && !params.error ? params.platform : undefined);
  if (connected) {
    const channel = PLATFORM_CHANNEL[connected];
    if (!channel) return null;
    const n = Number(params.count);
    const reason = params.reason ?? '';
    return {
      channel,
      outcome: 'connected',
      count: Number.isInteger(n) && n >= 0 ? n : null,
      pending,
      reason:
        pending && Object.hasOwn(PENDING_REASONS, reason)
          ? PENDING_REASONS[reason as keyof typeof PENDING_REASONS]
          : null,
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

/**
 * Messenger's way back when the sign-in granted two or more Pages (backend
 * 0ce84f21): `?pick=1&platform=messenger&session=<uuid>`. Nothing was
 * connected; the person chooses. Only Messenger has a picker, and the route
 * takes a session of at most 100 characters.
 */
export function messengerPickOf(params: {
  readonly pick?: string;
  readonly platform?: string;
  readonly session?: string;
}): { readonly session: string } | null {
  if (params.pick !== '1' || params.platform !== 'messenger') return null;
  const session = params.session?.trim() ?? '';
  if (!session || session.length > 100) return null;
  return { session };
}
