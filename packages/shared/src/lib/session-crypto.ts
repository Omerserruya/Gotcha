import crypto from "crypto";

/**
 * Authenticated-encryption envelope for BFF app-session provider tokens.
 *
 * This is DELIBERATELY separate from lib/encryption.ts (channel credentials):
 * a distinct key (SESSION_ENCRYPTION_KEY), a versioned + key-identified envelope,
 * and mandatory context binding (AAD) so a ciphertext cannot be silently moved
 * between records/fields. It never falls back to plaintext and never borrows
 * CHANNEL_ENCRYPTION_KEY.
 *
 * Envelope (all parts base64url, dot-separated):
 *   v1.<keyId>.<iv>.<authTag>.<ciphertext>
 *
 *   v1        format version (rotation-ready: a v2 can change primitive/layout)
 *   keyId     which key sealed it (supports key rotation - old keys stay
 *             decrypt-only in the keyring while new writes use the primary key)
 *   iv        96-bit GCM nonce, random per seal
 *   authTag   128-bit GCM tag
 *   ciphertext AES-256-GCM output over the UTF-8 plaintext, with AAD = context
 *
 * SECURITY: no secret (key, plaintext, ciphertext) ever appears in a thrown
 * error message - callers map failures to a generic outcome.
 */

const VERSION = "v1";
const ALG = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce - the GCM standard
const KEY_BYTES = 32; // AES-256

/** Bound into the AEAD so token ciphertext cannot be relocated unnoticed. */
export interface SessionCryptoContext {
  /** What this ciphertext is, e.g. "session.access" | "session.refresh". */
  purpose: string;
  /** Who owns it (identityId or sessionId). Binds ciphertext to its record. */
  ownerId: string;
}

/** Thrown for any envelope/key/context failure. Message carries NO secrets. */
export class SessionCryptoError extends Error {
  constructor(public readonly code: string) {
    super(`session crypto error: ${code}`);
    this.name = "SessionCryptoError";
  }
}

const b64u = {
  enc: (b: Buffer) => b.toString("base64url"),
  dec: (s: string) => Buffer.from(s, "base64url"),
};

/** A parsed 32-byte key with its identifier. */
interface Keyring {
  primaryKeyId: string;
  keys: Map<string, Buffer>; // keyId -> 32-byte key (primary + decrypt-only olds)
}

function parseHexKey(value: string): Buffer | null {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return null; // exactly 32 bytes, hex only
  return Buffer.from(value, "hex");
}

function looksWeak(value: string): boolean {
  return value.length < 64 || /change-me|placeholder|example|generate-with/i.test(value);
}

/**
 * Build the keyring from the environment. Fails CLOSED: a missing/malformed key
 * throws, and in production a weak key or one equal to CHANNEL_ENCRYPTION_KEY
 * throws too. Test/dev must supply their OWN distinct key (isolation is the
 * caller's responsibility, enforced by the not-equal-to-channel-key check).
 */
export function loadSessionKeyring(env: NodeJS.ProcessEnv = process.env): Keyring {
  const raw = env.SESSION_ENCRYPTION_KEY;
  if (!raw || raw.length === 0) throw new SessionCryptoError("key_missing");

  const isProd = env.NODE_ENV === "production";
  if (isProd && looksWeak(raw)) throw new SessionCryptoError("key_weak");

  // Never silently reuse the channel-credential key.
  if (env.CHANNEL_ENCRYPTION_KEY && raw === env.CHANNEL_ENCRYPTION_KEY) {
    throw new SessionCryptoError("key_reuses_channel_key");
  }

  const primary = parseHexKey(raw);
  if (!primary) throw new SessionCryptoError("key_malformed"); // must be 64 hex chars

  const primaryKeyId = (env.SESSION_ENCRYPTION_KEY_ID || "k1").trim();
  const keys = new Map<string, Buffer>([[primaryKeyId, primary]]);

  // Optional decrypt-only old keys for rotation: "keyId:hex,keyId2:hex".
  const olds = env.SESSION_DECRYPTION_KEYS;
  if (olds) {
    for (const entry of olds.split(",")) {
      const [id, hex] = entry.split(":").map((s) => s?.trim());
      if (!id || !hex) throw new SessionCryptoError("old_key_malformed");
      const k = parseHexKey(hex);
      if (!k) throw new SessionCryptoError("old_key_malformed");
      if (!keys.has(id)) keys.set(id, k);
    }
  }
  return { primaryKeyId, keys };
}

/**
 * Startup guard. Only asserts when session infrastructure is actually enabled
 * (so a deployment that has NOT switched on cookie sessions is unaffected) -
 * but when enabled in production, a missing/malformed/unsafe key stops boot.
 */
export function assertSessionEncryptionReady(
  env: NodeJS.ProcessEnv = process.env,
): void {
  loadSessionKeyring(env); // throws on any problem; discards the ring
}

function aad(ctx: SessionCryptoContext): Buffer {
  if (!ctx?.purpose || !ctx?.ownerId) throw new SessionCryptoError("context_missing");
  // Length-delimited so ("a","bc") and ("ab","c") never collide.
  return Buffer.from(`${ctx.purpose.length}:${ctx.purpose}|${ctx.ownerId}`, "utf8");
}

/** Seal a plaintext secret (an OIDC token) into a versioned envelope. */
export function sealSessionSecret(
  plaintext: string,
  ctx: SessionCryptoContext,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const ring = loadSessionKeyring(env);
  const key = ring.keys.get(ring.primaryKeyId)!;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(ctx));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, ring.primaryKeyId, b64u.enc(iv), b64u.enc(tag), b64u.enc(ct)].join(".");
}

/** Open an envelope. Throws SessionCryptoError on any tamper/mismatch. */
export function openSessionSecret(
  envelope: string,
  ctx: SessionCryptoContext,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof envelope !== "string") throw new SessionCryptoError("envelope_malformed");
  const parts = envelope.split(".");
  if (parts.length !== 5) throw new SessionCryptoError("envelope_malformed");
  const [version, keyId, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) throw new SessionCryptoError("version_unsupported");

  const ring = loadSessionKeyring(env);
  const key = ring.keys.get(keyId);
  if (!key) throw new SessionCryptoError("key_unknown");

  let iv: Buffer, tag: Buffer, ciphertext: Buffer;
  try {
    iv = b64u.dec(ivB64);
    tag = b64u.dec(tagB64);
    ciphertext = b64u.dec(ctB64);
  } catch {
    throw new SessionCryptoError("envelope_malformed");
  }
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new SessionCryptoError("envelope_malformed");
  }

  try {
    const decipher = crypto.createDecipheriv(ALG, key, iv, { authTagLength: 16 });
    decipher.setAAD(aad(ctx));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // Tamper, wrong key, or wrong context all surface here as an auth failure.
    throw new SessionCryptoError("decrypt_failed");
  }
}

export const __SESSION_CRYPTO_INTERNALS__ = { VERSION, KEY_BYTES, IV_BYTES };
