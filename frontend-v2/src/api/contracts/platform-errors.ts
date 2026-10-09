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
