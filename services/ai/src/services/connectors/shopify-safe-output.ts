/**
 * Shopify data that must never reach the model or the customer.
 *
 * Found live in Part 4: `get_order` returned the raw payload into the prompt,
 * carrying `browser_ip`, `checkout_token`, the order `token` and an
 * `order_status_url` with a live `authenticate?key=` in it. That was fixed at
 * the point it was noticed - `projectOrderForAgent` now picks fields rather
 * than passing the object through - but picking fields is a whitelist that has
 * to be maintained, and every new tool is a new chance to forget.
 *
 * This is the belt to that pair of braces: a redactor applied to EVERY Shopify
 * result on its way out of the adapter, so a field nobody thought about cannot
 * carry a credential into a prompt. A model that can see a token can repeat
 * one, and `order_status_url` is worse than it looks - the key in it is a
 * bearer credential for that customer's order page, so pasting it into a chat
 * hands it to anyone who later reads the transcript.
 *
 * The order-status page is genuinely useful to a customer, which is exactly the
 * trap. The answer is not to send the authenticated URL; it is to say the
 * order status in words, or to give the carrier's own tracking link, which
 * authenticates nobody.
 */

/** Keys whose VALUE is a credential or an internal detail, wherever they appear. */
const REDACT_KEYS = new Set([
  "token",
  "checkout_token",
  "cart_token",
  "checkout_id",
  "browser_ip",
  "order_status_url",
  "landing_site",
  "landing_site_ref",
  "referring_site",
  "client_details",
  "customer_locale",
  "confirmation_number",
]);

/**
 * String shapes that are credentials or private surfaces regardless of the key
 * they arrive under. A tool that returns a free-text note containing an admin
 * link is exactly as dangerous as a field named `order_status_url`.
 */
const REDACT_VALUE_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s"']*\/admin(?:\/|\?|$)[^\s"']*/gi,        // Shopify admin, any shop
  /https?:\/\/[^\s"']*authenticate\?key=[^\s"']*/gi,        // order-status bearer link
  /https?:\/\/[^\s"']*\/checkouts\/[^\s"']*/gi,             // live checkout session
  /\bshpat_[A-Za-z0-9]{8,}/g,                               // Admin API access token
  /\bshpca_[A-Za-z0-9]{8,}/g,
  /\bshpss_[A-Za-z0-9]{8,}/g,
];

export const REDACTED = "[redacted]";

/**
 * Deep-redact any value. Structure is preserved so a caller reading
 * `result.name` still gets a name; only the dangerous leaves change.
 *
 * Depth-limited because Shopify payloads nest and a cycle - which should not
 * happen through JSON, but this also runs on adapter-built objects - must not
 * take a turn down with it.
 */
export function redactPrivateShopifyData<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (value == null) return value;

  if (typeof value === "string") {
    return redactString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactPrivateShopifyData(v, depth + 1)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k)) {
        // Dropped, not blanked. A `null` here reads as "this order has no
        // status URL", which is a different false statement.
        continue;
      }
      out[k] = redactPrivateShopifyData(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

export function redactString(s: string): string {
  let out = s;
  for (const re of REDACT_VALUE_PATTERNS) {
    // `lastIndex` survives between calls on a /g regex, so a shared literal
    // silently skips matches on every other invocation. Reset before use.
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Does this text contain something a customer must never be sent?
 *
 * Used by the outbound guard as an assertion rather than a cleanup: if a reply
 * reaches this check still holding a credential, something upstream failed and
 * the interesting fact is which reply it was.
 */
export function containsPrivateShopifyData(s: string | null | undefined): boolean {
  if (!s) return false;
  return REDACT_VALUE_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(s);
  });
}
