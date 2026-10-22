/**
 * Keys whose values must never leave the browser or reach a log sink.
 *
 * GOTCHA handles customer conversations. A stack trace with a message body or
 * a phone number in it is a data-protection incident, not a debugging aid, so
 * redaction is applied at the boundary rather than left to each caller.
 */
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|cookie|session|apikey|api_key|credential|signature|otp|pin|ssn|card|cvv|iban|body|message|content|text|transcript|note|comment|email|phone|address|name)/i;

const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 10;
const MAX_STRING_LENGTH = 512;

export const REDACTED = '[redacted]';

/**
 * Recursively replaces sensitive values with a marker.
 *
 * Deliberately over-broad: it is far cheaper to lose a field from a log line
 * than to leak one. Anything a developer genuinely needs should be added to
 * the event as an explicit, named, non-sensitive property.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    /*
     * ═════════════════════════════════════════════════════════════════════════
     * ⚠⚠ THE ONE PATH WITH NO LENGTH CAP WAS THE ONE MOST LIKELY TO CARRY A
     *    RESPONSE BODY
     * ═════════════════════════════════════════════════════════════════════════
     * `message` was returned raw while every other string in the tree is capped
     * at `MAX_STRING_LENGTH`. Measured: a 2,000-character field came back 513
     * characters, the same text as an `Error` came back 2,000.
     *
     * An upstream failure is exactly where a whole response body ends up, and
     * `cause` is logged at 900+ call sites. It goes through the same handling
     * now - one rule for strings, not two.
     *
     * ★★ THE CONTENT IS NOT REDACTED, AND THAT IS NOW A RULING RATHER THAN AN
     *    OPEN QUESTION. Decided 2026-09-30: **cap it, keep the beginning.**
     *
     *   `message` is in `SENSITIVE_KEY_PATTERN`, so `{ message }` as a FIELD
     *   becomes `[redacted]` while an `Error`'s message survives - two rules
     *   for one word, both tested. That asymmetry stands on purpose. The
     *   argument for keeping it was that an error reading `[redacted]` is
     *   useless; the argument against was this module's own principle, that it
     *   is cheaper to lose a field than to leak one, and `error.tsx` records
     *   that in this product an error message **can quote customer data**.
     *
     * ★ The cap is what satisfies both: a whole response body cannot reach a
     *   log sink, and the first 512 characters - which is where the cause is
     *   - survive for whoever has to read it.
     *
     * ⚠ BOTH DIRECTIONS ARE ASSERTED, and the second is the one that matters.
     *   A cap that deleted everything would pass "nothing leaked" perfectly
     *   and make every log line useless. That is the shape of a guard that
     *   holds by refusing to do its job.
     */
    return { name: value.name, message: redact(value.message, depth) };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1));
    return value.length > MAX_ARRAY_ITEMS
      ? [...items, `…${value.length - MAX_ARRAY_ITEMS} more`]
      : items;
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(item, depth + 1);
    }
    return output;
  }
  return '[unserialisable]';
}
