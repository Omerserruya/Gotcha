/**
 * A machine code beside a connection's lastError, with no migration.
 *
 * lastError is free English, and the interface matched it by regex, so a
 * reworded sentence fell back silently to the generic line (2026-10-08). A
 * writer that knows WHY now stores "[CODE] text"; every read splits it into
 * { lastError: text, lastErrorCode: CODE }. The code rides inside the same
 * string on purpose: any writer that replaces lastError (a reconnect clears
 * it, a later failure overwrites it) drops the code with it, so a code can
 * never outlive its error. Rows written before the codes are recognised by
 * their exact old sentence.
 *
 * The twin of services/auth/src/lib/error-code.ts (the channels reads); keep
 * the two in step.
 */
export const ERROR_CODES_KNOWN = {
  SHOPIFY_APP_UNINSTALLED: "The GOTCHA Shopify app was uninstalled from this store.",
  SHOPIFY_CHAT_UNINSTALLED: "Shopify Chat app was uninstalled from the store.",
  // Connect-time probe verdicts (services/connect-probe, 2026-10-09).
  CREDENTIALS_INVALID: "The system rejected these credentials.",
  CONNECTION_FAILED: "The system could not be reached.",
  // A token refresh that failed for another reason (2026-10-11).
  TOKEN_REFRESH_FAILED: "The connection's sign-in could not be renewed.",
} as const;
export type KnownErrorCode = keyof typeof ERROR_CODES_KNOWN;

const PREFIXED = /^\[([A-Z][A-Z0-9_]{2,63})\] ([\s\S]*)$/;

/** What a writer stores: the code, then the sentence. */
export function withErrorCode(code: KnownErrorCode): string {
  return `[${code}] ${ERROR_CODES_KNOWN[code]}`;
}

const MARKUP = /<!doctype|<\/?(?:html|head|body|title|meta|div|p|h1|pre)\b/i;

/**
 * A stored error that is a provider's HTML page (rows written before
 * 2026-10-11 stored Shopify's whole 401 page) is never served as text: it
 * becomes the sentence for its cause, with that code.
 */
function markupError(stored: string): { lastError: string; lastErrorCode: string | null } | null {
  if (!MARKUP.test(stored)) return null;
  const code: KnownErrorCode | null =
    /(?:\b|_)40[13]\b|unauthori[sz]ed|invalid_grant|invalid_token|invalid_request|invalid_client/i.test(stored) ? "CREDENTIALS_INVALID"
    : /(?:\b|_)5\d\d\b/.test(stored) ? "CONNECTION_FAILED"
    : /token_refresh_failed/i.test(stored) ? "TOKEN_REFRESH_FAILED"
    : null;
  return code
    ? { lastError: ERROR_CODES_KNOWN[code], lastErrorCode: code }
    : { lastError: "The system answered with an error page.", lastErrorCode: null };
}

/** What a read serves: the sentence alone, and its code when there is one. */
export function splitErrorCode(stored: string | null | undefined): { lastError: string | null; lastErrorCode: string | null } {
  if (typeof stored !== "string" || !stored) return { lastError: stored ?? null, lastErrorCode: null };
  const m = PREFIXED.exec(stored);
  if (m) return { lastError: m[2]!, lastErrorCode: m[1]! };
  const page = markupError(stored);
  if (page) return page;
  const legacy = (Object.entries(ERROR_CODES_KNOWN) as Array<[string, string]>).find(([, text]) => text === stored.trim());
  return { lastError: stored, lastErrorCode: legacy ? legacy[0] : null };
}
