/**
 * A connection's last error, as a reason the screen can say in the reader's
 * words - never the platform's raw English (1048bee).
 *
 * The platform stores `[CODE] sentence` and serves `{ lastError, lastErrorCode }`
 * split (ai 272ee282 for integrations; auth e28012b0 for channels, held), so:
 *   1. `lastErrorCode` when it is served;
 *   2. else a `[CODE] ` prefix still on the sentence (a service not yet
 *      rebuilt passes the stored string through);
 *   3. else the exact old sentence, for rows written before codes existed;
 *   4. else `unknown` - said generically, never printed.
 */
export const PLATFORM_ERROR_CODES = {
  SHOPIFY_CHAT_UNINSTALLED: 'shopify_chat_uninstalled',
  SHOPIFY_APP_UNINSTALLED: 'shopify_app_uninstalled',
  /*
   * Connected, but nothing will arrive (auth 4061f669, incoming-worker
   * 25831c9e): Messenger's or Instagram's webhook subscription was refused
   * (the account is PENDING), Gmail's push watch could not be set up, or
   * Outlook's mail subscription could not be made or renewed.
   */
  SUBSCRIBE_FAILED: 'subscribe_failed',
  WATCH_FAILED: 'gmail_watch_failed',
  OUTLOOK_SUBSCRIPTION_FAILED: 'outlook_subscription_failed',
} as const;
export type PlatformErrorReason =
  (typeof PLATFORM_ERROR_CODES)[keyof typeof PLATFORM_ERROR_CODES] | 'unknown';

const PREFIX = /^\[([A-Z][A-Z0-9_]*)\]\s*/;

/** Rows written before codes: the exact sentence each one stored. */
const OLD_SENTENCES: readonly [RegExp, PlatformErrorReason][] = [
  [/^Shopify Chat app was uninstalled from the store\.?$/i, 'shopify_chat_uninstalled'],
  [/^The GOTCHA Shopify app was uninstalled from this store\.?$/i, 'shopify_app_uninstalled'],
];

/** The reasons that say "connected, but messages cannot arrive": connecting again retries. */
export const NOT_RECEIVING_REASONS: readonly PlatformErrorReason[] = [
  'subscribe_failed',
  'gmail_watch_failed',
  'outlook_subscription_failed',
];

/** The sentence without a leading `[CODE] `, trimmed; `null` when nothing is left. */
export function stripErrorCode(error: string | null | undefined): string | null {
  const text = error?.replace(PREFIX, '').trim();
  return text ? text : null;
}

export function platformErrorReason(
  error: string | null | undefined,
  code?: string | null,
): PlatformErrorReason | null {
  const prefixed = error?.trim().match(PREFIX)?.[1];
  const sentence = stripErrorCode(error);
  const known = code?.trim() || prefixed;
  if (!sentence && !known) return null;
  if (known) {
    const reason = (PLATFORM_ERROR_CODES as Record<string, PlatformErrorReason>)[known];
    if (reason) return reason;
  }
  return OLD_SENTENCES.find(([pattern]) => pattern.test(sentence ?? ''))?.[1] ?? 'unknown';
}

/**
 * Voice's health, which is not `lastError` (conversation
 * `routes/voice-channels.ts`). Two things are served on the channel:
 *
 *   - `healthStatus`, written only by `POST /:id/validate`: `ok`,
 *     `decryption_failed`, or the failed account check's error - Twilio's
 *     `twilio_api_<status>: <body>`, else `account_unreachable` / `failed`.
 *   - `config.outboundProvisioningFailed`, set when creating the channel could
 *     not make the API key or TwiML app: calls come in, none go out.
 *   - `lastError` / `lastErrorCode` (conversation 538c0218): the last failed
 *     activation or check, kept as `[CODE] sentence` and served split. Only
 *     the code is read; the sentence is the platform's English.
 *
 * A known code outranks a failed check, which outranks the outbound flag: the
 * code says which step failed (a number Twilio does not have, the server's
 * missing voice address), the health text only that the account check did.
 * A code or a health text this build does not know is `unknown` - said
 * generically, never printed.
 */
export type VoiceErrorReason =
  | 'voice_credentials_unreadable'
  | 'voice_credentials_rejected'
  | 'voice_twilio_unreachable'
  | 'voice_outbound_not_set_up'
  | 'voice_number_not_found'
  | 'voice_webhook_not_updated'
  | 'voice_public_url_missing';
export type ChannelErrorReason = PlatformErrorReason | VoiceErrorReason;

/** The codes voice-channels.ts writes (conversation `lib/error-code.ts`). */
const VOICE_ERROR_CODES: Readonly<Record<string, VoiceErrorReason>> = {
  TWILIO_CREDENTIALS_INVALID: 'voice_credentials_rejected',
  TWILIO_ACCOUNT_UNREACHABLE: 'voice_twilio_unreachable',
  TWILIO_NUMBER_NOT_FOUND: 'voice_number_not_found',
  TWILIO_WEBHOOK_UPDATE_FAILED: 'voice_webhook_not_updated',
  VOICE_PUBLIC_URL_MISSING: 'voice_public_url_missing',
};

export function voiceErrorReason(
  healthStatus: string | null | undefined,
  outboundProvisioningFailed: boolean,
  lastError?: string | null,
  lastErrorCode?: string | null,
): ChannelErrorReason | null {
  const code = lastErrorCode?.trim();
  if (code && Object.hasOwn(VOICE_ERROR_CODES, code)) return VOICE_ERROR_CODES[code]!;
  const health = healthStatus?.trim();
  if (health && health !== 'ok') {
    if (health === 'decryption_failed') return 'voice_credentials_unreadable';
    if (/^twilio_api_40[13]\b/.test(health)) return 'voice_credentials_rejected';
    if (health === 'account_unreachable' || health === 'failed') return 'voice_twilio_unreachable';
    return 'unknown';
  }
  if (code || lastError?.trim()) return 'unknown';
  return outboundProvisioningFailed ? 'voice_outbound_not_set_up' : null;
}
