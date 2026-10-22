/**
 * A ChannelAccount as a client may see it (2026-10-10).
 *
 * Connect routes answered with the raw Prisma row, so an email connect sent
 * the encrypted SMTP/IMAP credentials back to the browser. Every route that
 * answers with a row goes through publicChannelAccount, so a new field or a
 * new platformMeta key cannot leak by default.
 */

/** Key names that carry a secret, compared lowercased with separators removed. */
const SECRET_KEY = /token|secret|password|passwd|apikey|clientstate|credential|privatekey|signingkey/;

/** Row fields whose names look secret but are not: the screen shows them. */
const PUBLIC_ROW_KEYS = new Set(["tokenExpiresAt"]);

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

/**
 * platformMeta minus every secret-named key at any depth. Outlook's
 * clientState authenticates Graph's pushes; other writers have kept tokens
 * here too, so the scrub is by name, not by a list of known writers.
 */
export function publicPlatformMeta(meta: unknown): unknown {
  if (Array.isArray(meta)) return meta.map(publicPlatformMeta);
  if (!meta || typeof meta !== "object" || meta instanceof Date) return meta;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (isSecretKey(k)) continue;
    out[k] = publicPlatformMeta(v);
  }
  return out;
}

export type PublicChannelAccount<T> = Omit<T, "credentials">;

/** The row without `credentials` or any other secret-named field, platformMeta scrubbed. */
export function publicChannelAccount<T extends object>(row: T): PublicChannelAccount<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (isSecretKey(k) && !PUBLIC_ROW_KEYS.has(k)) continue;
    out[k] = k === "platformMeta" ? publicPlatformMeta(v) : v;
  }
  return out as PublicChannelAccount<T>;
}
