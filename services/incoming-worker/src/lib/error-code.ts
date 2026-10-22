/**
 * A machine code beside a connection's lastError, with no migration
 * (2026-10-09). The stored form is "[CODE] sentence"; auth's channels reads
 * split it back into { lastError, lastErrorCode } so the screen can say why
 * in the reader's language.
 *
 * The twin of services/auth/src/lib/error-code.ts, holding ONLY the codes the
 * channel health worker writes. A test reads this output back through auth's
 * splitErrorCode, so the two formats cannot drift apart.
 */
export const ERROR_CODES_KNOWN = {
  // Messenger Page (or Instagram account) not subscribed to our app: connected, but messages cannot arrive.
  SUBSCRIBE_FAILED: "Connected, but messages cannot arrive: GOTCHA is not subscribed to this account's messages.",
  // Gmail watch missing or expired, or no Pub/Sub topic to watch on.
  WATCH_FAILED: "Connected, but new mail cannot arrive: the Gmail watch is missing or expired.",
  // Graph mail subscription missing or could not be renewed.
  OUTLOOK_SUBSCRIPTION_FAILED: "Connected, but new mail cannot arrive: the Outlook mail subscription is missing or could not be renewed.",
} as const;
export type KnownErrorCode = keyof typeof ERROR_CODES_KNOWN;

const PREFIXED = /^\[([A-Z][A-Z0-9_]{2,63})\] /;

/** What a writer stores: the code, then the sentence (the code's own when none is given). */
export function withErrorCode(code: KnownErrorCode, sentence?: string): string {
  return `[${code}] ${sentence?.trim() || ERROR_CODES_KNOWN[code]}`;
}

/** The code a stored lastError carries, or null for free text and empty values. */
export function errorCodeOf(stored: string | null | undefined): string | null {
  if (typeof stored !== "string") return null;
  return PREFIXED.exec(stored)?.[1] ?? null;
}

/**
 * The lastError a passing check leaves behind. A check may clear free text
 * (the old uncoded writes were all this worker's) and its OWN code, never a
 * code another writer stored: that writer knows something this check did not
 * look at.
 */
export function clearOwnError(stored: string | null | undefined, own: KnownErrorCode): string | null {
  const code = errorCodeOf(stored);
  return code && code !== own ? (stored as string) : null;
}
