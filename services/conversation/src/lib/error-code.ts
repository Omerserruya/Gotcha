/**
 * A machine code beside a voice channel's lastError, with no migration.
 *
 * Twin of services/auth/src/lib/error-code.ts (and the ai one); keep the
 * three in step. A writer stores "[CODE] sentence"; every read splits it into
 * { lastError: sentence, lastErrorCode: CODE }. The code rides inside the same
 * string so a code can never outlive the error it explains (2026-10-09).
 */
export const ERROR_CODES_KNOWN = {
  TWILIO_CREDENTIALS_INVALID: "Twilio rejected the saved Account SID or Auth Token.",
  TWILIO_ACCOUNT_UNREACHABLE: "The Twilio account could not be reached.",
  TWILIO_NUMBER_NOT_FOUND: "This phone number was not found on the Twilio account.",
  TWILIO_WEBHOOK_UPDATE_FAILED: "Twilio did not accept the new call address for this number.",
  VOICE_PUBLIC_URL_MISSING:
    "The server has no valid public voice address (VOICE_PUBLIC_URL), so the number cannot be pointed at GOTCHA.",
} as const;
export type KnownErrorCode = keyof typeof ERROR_CODES_KNOWN;

const PREFIXED = /^\[([A-Z][A-Z0-9_]{2,63})\] ([\s\S]*)$/;

/** What a writer stores: the code, then the sentence. */
export function withErrorCode(code: KnownErrorCode): string {
  return `[${code}] ${ERROR_CODES_KNOWN[code]}`;
}

/** What a read serves: the sentence alone, and its code when there is one. */
export function splitErrorCode(stored: string | null | undefined): { lastError: string | null; lastErrorCode: string | null } {
  if (typeof stored !== "string" || !stored) return { lastError: stored ?? null, lastErrorCode: null };
  const m = PREFIXED.exec(stored);
  if (m) return { lastError: m[2]!, lastErrorCode: m[1]! };
  const legacy = (Object.entries(ERROR_CODES_KNOWN) as Array<[string, string]>).find(([, text]) => text === stored.trim());
  return { lastError: stored, lastErrorCode: legacy ? legacy[0] : null };
}
