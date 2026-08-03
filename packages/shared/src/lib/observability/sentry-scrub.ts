/**
 * What is allowed to leave this system and reach Sentry.
 *
 * Pure, and separate from the SDK on purpose: this is the part with real
 * consequences if it is wrong, so it has to be testable without a network, a
 * DSN, or an initialised client.
 *
 * The rule is ALLOW-LIST, never deny-list. A deny-list of header names is a
 * promise to remember every future header that carries a credential, and the
 * one nobody remembers is the one that leaks. The same reasoning applies to
 * request bodies: there is no "safe subset" of a customer conversation, an
 * OAuth callback or a webhook payload, so bodies are dropped whole rather than
 * filtered.
 *
 * GOTCHA handles customer messages, provider tokens and tenant data. An
 * exception report is worth having; it is not worth a customer's WhatsApp
 * message or a Shopify access token sitting in a third-party dashboard.
 */

/** Headers that cannot carry a credential or message content. */
const HEADER_ALLOW_LIST = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-length",
  "content-type",
  "user-agent",
  "x-request-id",
  "x-forwarded-proto",
]);

/**
 * Value shapes that are a credential regardless of the key they arrive under.
 *
 * The key-name check below catches `authorization`; this catches the same token
 * pasted into a field called `note`, or embedded in an error message thrown by
 * a provider SDK - which is exactly how tokens usually escape.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi,       // Authorization values
  /\beyJ[A-Za-z0-9._-]{20,}/g,                    // JWTs (header starts with {")
  /\bsk-[A-Za-z0-9]{16,}/g,                       // OpenAI-style secret keys
  /\bshp(at|ca|pa|ss)_[A-Za-z0-9]{16,}/g,         // Shopify access tokens
  /\bSK[0-9a-f]{32}\b/g,                          // Twilio API key SIDs
  /\bAC[0-9a-f]{32}\b/g,                          // Twilio account SIDs
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,             // Slack tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,                // GitHub tokens
];

/** Key names whose VALUE is always removed, wherever they appear. */
const SENSITIVE_KEY = /(?:pass(?:word|phrase)?|secret|token|api[-_]?key|authorization|cookie|session|credential|signature|client[-_]?secret|refresh|private[-_]?key|dsn)/i;

/**
 * Key names whose value is message content or personal data.
 *
 * Not secrets - worse, in a sense. A leaked token can be rotated; a customer's
 * message in someone else's dashboard cannot be taken back.
 */
const CONTENT_KEY = /^(?:body|message|messages|text|content|transcript|prompt|completion|reply|caption|note|notes|email|phone|phone_?number|e164|address|name|full_?name)$/i;

export const REDACTED = "[redacted]";

/** Replace credential-shaped substrings anywhere in a string. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Recursively strip a value of secrets and content.
 *
 * `depth` is bounded because Sentry events can carry deeply nested provider
 * payloads and this runs on every captured error, including inside a process
 * that is already failing.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k) || CONTENT_KEY.test(k)) { out[k] = REDACTED; continue; }
      out[k] = scrubValue(v, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

/** Keep only allow-listed headers, and redact even those. */
export function scrubHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (!HEADER_ALLOW_LIST.has(k.toLowerCase())) continue;
    out[k] = redactSecrets(String(v));
  }
  return out;
}

/**
 * Strip the query string from a URL, keeping the path.
 *
 * The path is the useful part for grouping errors. The query is where `code`,
 * `state`, `access_token` and signed webhook parameters live, and no allow-list
 * of parameter names survives contact with a new provider.
 */
export function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf("?");
  const base = q >= 0 ? url.slice(0, q) : url;
  return redactSecrets(base) + (q >= 0 ? "?[stripped]" : "");
}

/** Minimal shape of the Sentry event fields this touches. */
export interface ScrubbableEvent {
  request?: {
    url?: string;
    query_string?: unknown;
    data?: unknown;
    cookies?: unknown;
    headers?: Record<string, unknown>;
    env?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  user?: Record<string, unknown>;
  message?: string;
  breadcrumbs?: Array<Record<string, unknown>>;
  exception?: { values?: Array<{ value?: string; type?: string }> };
  [k: string]: unknown;
}

/**
 * The single gate every event passes through before leaving the process.
 *
 * Returning `null` drops the event entirely; that is reserved for events we
 * cannot make safe rather than used as a filter.
 */
export function scrubEvent(event: ScrubbableEvent): ScrubbableEvent {
  if (event.request) {
    const r = event.request;
    r.url = scrubUrl(r.url);
    // Bodies are dropped whole - see the file header.
    delete r.data;
    delete r.cookies;
    delete r.env;
    r.query_string = undefined;
    r.headers = scrubHeaders(r.headers);
  }

  if (event.message) event.message = redactSecrets(event.message);

  // Exception messages routinely quote the failing request, including headers
  // a provider SDK helpfully inlined.
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redactSecrets(ex.value);
  }

  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as Record<string, unknown>;

  // Identify the tenant and the actor, never the person. `id` is an opaque
  // internal identifier and is the only field that survives.
  if (event.user) {
    const id = event.user.id;
    event.user = id === undefined ? {} : { id: String(id) };
  }

  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((b) => scrubValue(b) as Record<string, unknown>);
  }

  return event;
}
