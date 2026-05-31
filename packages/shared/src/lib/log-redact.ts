/**
 * Log-redaction helper. Mask high-value tokens and PII before they hit
 * stdout/stderr. Use in every `console.error("…", err)` that touches
 * OAuth, HTTP responses from third parties, or anything that might
 * include an Authorization header.
 *
 * Design notes:
 *   - Pure function. No I/O.
 *   - Works on strings, plain objects (recursively), and Error values.
 *   - Preserves the structure so log readers still get diagnostic value;
 *     just the secret material is replaced with a fixed `[REDACTED]`
 *     placeholder.
 *   - Never throws. On unknown shapes it returns `String(value)`.
 *
 * Patterns covered:
 *   - JWT (`eyJ` … 3 base64url segments)
 *   - `Bearer <token>`
 *   - `Authorization: Bearer <token>`
 *   - `access_token=…`, `refresh_token=…`, `client_secret=…`
 *   - Email addresses (loose RFC pattern)
 *   - E.164-ish phone numbers
 *   - Common header names when used as object keys
 */

const PLACEHOLDER = "[REDACTED]";

const STRING_PATTERNS: Array<{ name: string; re: RegExp; replace: string }> = [
  // JWTs — three base64url segments separated by dots. The first must
  // start with "eyJ" which is `{"` base64url-encoded.
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: PLACEHOLDER,
  },
  // Authorization headers
  {
    name: "authorization",
    re: /\bAuthorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
    replace: `Authorization: Bearer ${PLACEHOLDER}`,
  },
  {
    name: "bearer",
    re: /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/g,
    replace: `Bearer ${PLACEHOLDER}`,
  },
  // OAuth params in query strings or JSON-stringified bodies
  {
    name: "access_token",
    re: /\b(access_token|refresh_token|id_token|client_secret|api_key|apikey)\s*[:=]\s*"?[A-Za-z0-9._\-+/=]+"?/gi,
    replace: `$1=${PLACEHOLDER}`,
  },
  // Email — masked to the first char of local + domain only
  {
    name: "email",
    re: /\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    replace: "$1***@$2",
  },
  // E.164 phone
  {
    name: "phone",
    re: /\+?\d[\d\s().-]{6,}\d/g,
    replace: PLACEHOLDER,
  },
];

const SENSITIVE_KEYS = new Set<string>([
  "authorization",
  "auth",
  "token",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "client_secret",
  "clientsecret",
  "api_key",
  "apikey",
  "password",
  "secret",
  "private_key",
  "privatekey",
  "set-cookie",
  "cookie",
  "x-api-key",
]);

export interface RedactOpts {
  /** Recursive depth cap; defaults to 5. */
  maxDepth?: number;
  /** Max string length before truncation; defaults to 2000. */
  maxLength?: number;
}

/**
 * Mask secrets in any value. Returns a structurally similar value with
 * sensitive substrings replaced by `[REDACTED]`. Safe to pass directly
 * to `console.error(...)`.
 */
export function redact(value: unknown, opts: RedactOpts = {}): unknown {
  return redactInner(value, 0, opts.maxDepth ?? 5, opts.maxLength ?? 2000);
}

function redactInner(value: unknown, depth: number, maxDepth: number, maxLength: number): unknown {
  if (value === null || value === undefined) return value;
  if (depth > maxDepth) return "[truncated]";
  const t = typeof value;
  if (t === "string") return redactString(value as string, maxLength);
  if (t === "number" || t === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message || "", maxLength),
      // Stack frames sometimes include URLs with tokens — redact too.
      stack: value.stack ? redactString(value.stack, maxLength) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, depth + 1, maxDepth, maxLength));
  }
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = PLACEHOLDER;
      } else {
        out[k] = redactInner(v, depth + 1, maxDepth, maxLength);
      }
    }
    return out;
  }
  return String(value);
}

function redactString(s: string, maxLength: number): string {
  let out = s;
  for (const p of STRING_PATTERNS) {
    out = out.replace(p.re, p.replace);
  }
  if (out.length > maxLength) {
    out = out.slice(0, maxLength) + " …[truncated]";
  }
  return out;
}

/**
 * Convenience: log helpers that auto-redact. Use these from noisy
 * call sites instead of bare `console.error`.
 */
export const safeLogger = {
  error: (msg: string, payload?: unknown): void => {
    if (payload === undefined) {
      console.error(redactString(msg, 2000));
    } else {
      console.error(redactString(msg, 2000), redact(payload));
    }
  },
  warn: (msg: string, payload?: unknown): void => {
    if (payload === undefined) {
      console.warn(redactString(msg, 2000));
    } else {
      console.warn(redactString(msg, 2000), redact(payload));
    }
  },
  info: (msg: string, payload?: unknown): void => {
    if (payload === undefined) {
      console.log(redactString(msg, 2000));
    } else {
      console.log(redactString(msg, 2000), redact(payload));
    }
  },
};
