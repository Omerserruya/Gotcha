import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const ENCODING: BufferEncoding = "base64";

function getKey(): Buffer {
  const key = process.env.CHANNEL_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("CHANNEL_ENCRYPTION_KEY environment variable is required");
  }
  // If key is 64 hex chars, parse as hex; otherwise hash it to 32 bytes
  if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
    return Buffer.from(key, "hex");
  }
  return crypto.createHash("sha256").update(key).digest();
}

/**
 * Encrypt a JSON-serializable value using AES-256-GCM.
 * Returns a base64 string containing iv + authTag + ciphertext.
 */
export function encryptCredentials(data: Record<string, any>): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: iv (16) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString(ENCODING);
}

/**
 * Decrypt a base64 string back to a JSON object.
 * Returns the original credentials object.
 */
export function decryptCredentials(encryptedData: string): Record<string, any> {
  const key = getKey();
  const buffer = Buffer.from(encryptedData, ENCODING);

  const iv = buffer.subarray(0, IV_LENGTH);
  const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

/**
 * Check if a string looks like it's already encrypted (base64 with minimum length).
 */
export function isEncrypted(value: any): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 44) return false; // minimum: 16 iv + 16 tag + some ciphertext in base64
  try {
    const buf = Buffer.from(value, ENCODING);
    return buf.length >= IV_LENGTH + TAG_LENGTH + 1;
  } catch {
    return false;
  }
}

/**
 * Plaintext `credentials` objects that are NOT secrets and must stay readable as
 * objects (found on prod 2026-10-22 by scripts/encrypt-plaintext-credentials.ts):
 * - a WEBCHAT channel account keeps its widget CONFIG in `credentials`, read raw by
 *   normalizeWebchatConfig. Encrypting it turns the object into a string and the
 *   widget silently falls back to the default appearance and behaviour.
 * - the calendar connect writes a marker `{ provider, accountEmail }` on its
 *   tenant integration; the tokens live encrypted on CalendarAccount.
 */
const CALENDAR_MARKER_KEYS = new Set(["provider", "accountEmail"]);
export function plaintextCredentialsNotSecret(
  row: { table: "channel_accounts"; channel: string } | { table: "tenant_integrations" },
  credentials: Record<string, unknown>,
): boolean {
  if (row.table === "channel_accounts") return row.channel === "WEBCHAT";
  const keys = Object.keys(credentials);
  return keys.length > 0 && keys.every((k) => CALENDAR_MARKER_KEYS.has(k));
}
