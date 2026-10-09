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
} as const;
export type PlatformErrorReason =
  (typeof PLATFORM_ERROR_CODES)[keyof typeof PLATFORM_ERROR_CODES] | 'unknown';

const PREFIX = /^\[([A-Z][A-Z0-9_]*)\]\s*/;

/** Rows written before codes: the exact sentence each one stored. */
const OLD_SENTENCES: readonly [RegExp, PlatformErrorReason][] = [
  [/^Shopify Chat app was uninstalled from the store\.?$/i, 'shopify_chat_uninstalled'],
  [/^The GOTCHA Shopify app was uninstalled from this store\.?$/i, 'shopify_app_uninstalled'],
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
 *
 * A failed check outranks the outbound flag. A health text this build does
 * not know is `unknown` - said generically, never printed.
 */
export type VoiceErrorReason =
  | 'voice_credentials_unreadable'
  | 'voice_credentials_rejected'
  | 'voice_twilio_unreachable'
  | 'voice_outbound_not_set_up';
export type ChannelErrorReason = PlatformErrorReason | VoiceErrorReason;

export function voiceErrorReason(
  healthStatus: string | null | undefined,
  outboundProvisioningFailed: boolean,
): ChannelErrorReason | null {
  const health = healthStatus?.trim();
  if (health && health !== 'ok') {
    if (health === 'decryption_failed') return 'voice_credentials_unreadable';
    if (/^twilio_api_40[13]\b/.test(health)) return 'voice_credentials_rejected';
    if (health === 'account_unreachable' || health === 'failed') return 'voice_twilio_unreachable';
    return 'unknown';
  }
  return outboundProvisioningFailed ? 'voice_outbound_not_set_up' : null;
}
