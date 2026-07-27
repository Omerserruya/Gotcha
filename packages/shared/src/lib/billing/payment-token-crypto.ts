/**
 * Encryption for reusable provider card tokens.
 *
 * A stored card token is a bearer instrument: anyone holding it can charge the
 * customer through our merchant account. It therefore gets its OWN key, not a
 * shared application secret.
 *
 * Deliberately NOT reused here:
 *   CHANNEL_ENCRYPTION_KEY   - channel credentials, different blast radius
 *   SESSION_ENCRYPTION_KEY   - session tokens, rotated on a different schedule
 *   any general application secret
 *
 * Sharing a key means a compromise or a rotation of one subsystem silently
 * becomes an incident in the other. There is no fallback to any of them; a
 * missing payment-token key is a hard failure at the point of use.
 *
 * Wire format is self-describing:
 *
 *     ptok.<keyVersion>.<base64(iv | authTag | ciphertext)>
 *
 * The version travels WITH the value, so a row can still be decrypted even if
 * its `tokenKeyVersion` column is lost, and rotation can decrypt old values
 * while writing new ones.
 */
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const PREFIX = "ptok";

/** The version new values are written with. */
export const CURRENT_PAYMENT_TOKEN_KEY_VERSION = "v1";

export class PaymentTokenKeyMissingError extends Error {
  constructor() {
    super(
      "BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY is not configured - refusing to handle a provider card token (there is deliberately no fallback to CHANNEL_ENCRYPTION_KEY or any session/auth key)",
    );
    this.name = "PaymentTokenKeyMissingError";
  }
}

/**
 * A stored token could not be decrypted.
 *
 * Thrown, never swallowed. Silently discarding or replacing an unreadable token
 * would turn a key problem into a lost payment method and, later, a failed
 * renewal that looks like a customer's card being declined.
 */
export class PaymentTokenUndecryptableError extends Error {
  constructor(readonly keyVersion: string | null) {
    super(`stored payment token could not be decrypted (key version: ${keyVersion ?? "unknown"})`);
    this.name = "PaymentTokenUndecryptableError";
  }
}

function toKey(raw: string): Buffer {
  return raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)
    ? Buffer.from(raw, "hex")
    : crypto.createHash("sha256").update(raw).digest();
}

/** Whether a key is configured at all. Lets mock/CI skip token storage cleanly. */
export function paymentTokenEncryptionConfigured(): boolean {
  return Boolean((process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY || "").trim());
}

/**
 * Validate configuration.
 *
 * Called only where a token is actually stored or a real provider operation
 * runs - NOT at startup - so a development stack or CI run that never touches a
 * stored token needs no key.
 */
export function assertPaymentTokenKey(): void {
  if (!paymentTokenEncryptionConfigured()) throw new PaymentTokenKeyMissingError();
}

function currentKey(): Buffer {
  const raw = (process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY || "").trim();
  if (!raw) throw new PaymentTokenKeyMissingError();
  return toKey(raw);
}

/**
 * Decrypt-only keys retained for rotation, as "version:key" pairs:
 *
 *     BILLING_PAYMENT_TOKEN_DECRYPTION_KEYS="v0:abc...,vprev:def..."
 */
function retiredKeys(): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const raw = (process.env.BILLING_PAYMENT_TOKEN_DECRYPTION_KEYS || "").trim();
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf(":");
    if (idx <= 0) continue;
    const version = pair.slice(0, idx).trim();
    const key = pair.slice(idx + 1).trim();
    if (version && key) out.set(version, toKey(key));
  }
  return out;
}

export interface EncryptedPaymentToken {
  ciphertext: string;
  keyVersion: string;
}

/** Encrypt a provider card token for storage. */
export function encryptPaymentToken(plaintext: string): EncryptedPaymentToken {
  if (!plaintext) throw new Error("refusing to encrypt an empty payment token");
  const key = currentKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = Buffer.concat([iv, tag, encrypted]).toString("base64");
  return {
    ciphertext: `${PREFIX}.${CURRENT_PAYMENT_TOKEN_KEY_VERSION}.${body}`,
    keyVersion: CURRENT_PAYMENT_TOKEN_KEY_VERSION,
  };
}

/** True for a value produced by encryptPaymentToken. */
export function isEncryptedPaymentToken(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(`${PREFIX}.`);
}

/**
 * Decrypt a stored token. Fails closed.
 *
 * Never returns a partial or empty result: either the real token, or a throw.
 */
export function decryptPaymentToken(stored: string): string {
  if (!isEncryptedPaymentToken(stored)) {
    // A plaintext token in the column is a data-integrity problem, not
    // something to quietly pass through to a charge.
    throw new PaymentTokenUndecryptableError(null);
  }
  const parts = stored.split(".");
  if (parts.length !== 3) throw new PaymentTokenUndecryptableError(null);
  const [, version, body] = parts;

  const candidate =
    version === CURRENT_PAYMENT_TOKEN_KEY_VERSION ? currentKey() : retiredKeys().get(version);
  if (!candidate) throw new PaymentTokenUndecryptableError(version);

  try {
    const buffer = Buffer.from(body, "base64");
    const iv = buffer.subarray(0, IV_LENGTH);
    const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = buffer.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, candidate, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (!plain) throw new PaymentTokenUndecryptableError(version);
    return plain;
  } catch (err) {
    if (err instanceof PaymentTokenUndecryptableError) throw err;
    // Wrong key, tampered ciphertext, or a failed auth tag all land here. The
    // original error is dropped: it can carry key material in some runtimes.
    throw new PaymentTokenUndecryptableError(version);
  }
}
