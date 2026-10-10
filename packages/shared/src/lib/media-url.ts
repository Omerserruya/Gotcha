import crypto from "crypto";

/**
 * How a stored customer upload is addressed once it leaves the service
 * (2026-10-10, uploads plan steps 1-3).
 *
 * The DB keeps the stored relative "/api/uploads/<uuid>.<ext>". That route is
 * public and unauthenticated, so nothing hands it out any more:
 *   - presentMediaUrl: the inbox gets a logged-in URL scoped to the message's
 *     conversation, which inherits the tenant and visibility checks.
 *   - signMediaUrl / verifyMediaSignature: a provider that fetches with no
 *     login (Meta, Slack) gets a short-lived HMAC link for one message.
 *
 * The signing key is derived from CHANNEL_ENCRYPTION_KEY with HKDF under its
 * own label, so it is never the channel key itself and needs no new secret
 * (owner's decision, 2026-10-10). It is never logged.
 */

const HKDF_INFO = "gotcha-media-url-v1";
const SIGNATURE_VERSION = "media:v1";
const UPLOADS_PREFIX = "/api/uploads/";

/**
 * The bare stored file name: a uuid and a short extension, nothing else.
 * Case-insensitive extension because files stored before 2026-10-09 kept the
 * sender's own, such as ".JPG". No slash and no leading dot can match, so a
 * name that passes cannot walk out of the uploads directory.
 */
export const STORED_UPLOAD_NAME = /^[0-9a-f-]{36}\.[A-Za-z0-9]{1,8}$/;

/** The stored name inside "/api/uploads/<name>", or null for anything else. */
export function storedUploadName(stored: unknown): string | null {
  if (typeof stored !== "string" || !stored.startsWith(UPLOADS_PREFIX)) return null;
  const name = stored.slice(UPLOADS_PREFIX.length);
  return STORED_UPLOAD_NAME.test(name) ? name : null;
}

/**
 * The URL a message's media is shown at. A stored upload becomes the
 * authenticated per-message route; a Meta CDN link, an operator's link, or
 * anything unrecognised passes through untouched.
 */
export function presentMediaUrl<T extends string | null | undefined>(
  stored: T,
  ids: { conversationId?: string | null; messageId?: string | null },
): T | string {
  const name = storedUploadName(stored);
  if (!name || !ids.conversationId || !ids.messageId) return stored;
  return `/api/conversations/${encodeURIComponent(ids.conversationId)}/messages/${encodeURIComponent(ids.messageId)}/media/${name}`;
}

/** The public signed path for one message's media. */
export function signedMediaPath(messageId: string, signed: { exp: number; sig: string }): string {
  return `/api/media/s/${encodeURIComponent(messageId)}?exp=${signed.exp}&sig=${signed.sig}`;
}

function signingKey(): Buffer | null {
  const raw = process.env.CHANNEL_ENCRYPTION_KEY;
  if (!raw) return null;
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.alloc(0), HKDF_INFO, 32));
}

// "|" is the field separator: an id carrying one could shift the fields.
function validId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !v.includes("|");
}

function mac(key: Buffer, messageId: string, tenantId: string, exp: number): string {
  return crypto.createHmac("sha256", key).update(`${SIGNATURE_VERSION}|${messageId}|${tenantId}|${exp}`).digest("hex");
}

/** Sign one message's media for ttlSeconds. Throws without a key. */
export function signMediaUrl(input: { messageId: string; tenantId: string; ttlSeconds: number; now?: number }): { exp: number; sig: string } {
  if (!validId(input.messageId) || !validId(input.tenantId)) throw new Error("signMediaUrl: invalid message or tenant id");
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) throw new Error("signMediaUrl: ttlSeconds must be a positive integer");
  const key = signingKey();
  if (!key) throw new Error("signMediaUrl: CHANNEL_ENCRYPTION_KEY is not configured");
  const exp = Math.floor((input.now ?? Date.now()) / 1000) + input.ttlSeconds;
  return { exp, sig: mac(key, input.messageId, input.tenantId, exp) };
}

/**
 * The cheap half of verification: an unexpired, well-formed exp and sig.
 * Lets a public route refuse garbage before it touches the database.
 */
export function mediaSignatureShapeOk(input: { exp: unknown; sig: unknown; now?: number }): boolean {
  const exp = typeof input.exp === "number" ? String(input.exp) : input.exp;
  if (typeof exp !== "string" || !/^\d{1,12}$/.test(exp)) return false;
  if (typeof input.sig !== "string" || !/^[0-9a-f]{64}$/.test(input.sig)) return false;
  return Number(exp) * 1000 > (input.now ?? Date.now());
}

/** True only for an unexpired signature over exactly this message and tenant. */
export function verifyMediaSignature(input: { messageId: string; tenantId: string; exp: unknown; sig: unknown; now?: number }): boolean {
  if (!validId(input.messageId) || !validId(input.tenantId)) return false;
  if (!mediaSignatureShapeOk(input)) return false;
  const key = signingKey();
  if (!key) return false;
  const expected = Buffer.from(mac(key, input.messageId, input.tenantId, Number(input.exp)), "hex");
  const given = Buffer.from(input.sig as string, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
