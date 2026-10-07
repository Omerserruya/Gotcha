const WIDE_DASH_RE = /[–—―]/g;

/**
 * Every string in a value, at any depth, with the em-dash, en-dash and
 * horizontal bar replaced by a regular hyphen. Keys, numbers and booleans
 * are left alone. Omer's rule: no wide dash in anything the product shows,
 * model output included. For text an operator reads; customer replies have
 * their own rule in reply-style.ts (a comma, never a spaced hyphen).
 */
export function withoutWideDashes<T>(value: T): T {
  if (typeof value === "string") return value.replace(WIDE_DASH_RE, "-") as unknown as T;
  if (Array.isArray(value)) return value.map((v) => withoutWideDashes(v)) as unknown as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = withoutWideDashes(v);
    return out as T;
  }
  return value;
}
