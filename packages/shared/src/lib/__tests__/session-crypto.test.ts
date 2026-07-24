import { describe, it, expect } from "vitest";
import {
  sealSessionSecret,
  openSessionSecret,
  loadSessionKeyring,
  assertSessionEncryptionReady,
  SessionCryptoError,
} from "../session-crypto";

const KEY = "0f".repeat(32); // 64 hex = 32 bytes, a clearly-test key
const ALT_KEY = "ab".repeat(32);
const env = (over: Record<string, string | undefined> = {}) =>
  ({ NODE_ENV: "test", SESSION_ENCRYPTION_KEY: KEY, ...over }) as any;
const CTX = { purpose: "session.access", ownerId: "identity_1" };

describe("session-crypto envelope", () => {
  it("round-trips a secret", () => {
    const sealed = sealSessionSecret("access-token-xyz", CTX, env());
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("access-token-xyz");
    expect(openSessionSecret(sealed, CTX, env())).toBe("access-token-xyz");
  });

  it("uses a unique IV per seal (ciphertext differs for identical input)", () => {
    const a = sealSessionSecret("same", CTX, env());
    const b = sealSessionSecret("same", CTX, env());
    expect(a).not.toBe(b);
  });

  it("rejects a tampered ciphertext", () => {
    const sealed = sealSessionSecret("tok", CTX, env());
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[4], "base64url");
    ct[0] ^= 0xff;
    parts[4] = ct.toString("base64url");
    expect(() => openSessionSecret(parts.join("."), CTX, env())).toThrow(SessionCryptoError);
  });

  it("rejects the wrong key", () => {
    const sealed = sealSessionSecret("tok", CTX, env());
    expect(() => openSessionSecret(sealed, CTX, env({ SESSION_ENCRYPTION_KEY: ALT_KEY }))).toThrow(/decrypt_failed|key_unknown/);
  });

  it("rejects the wrong context (moved ciphertext)", () => {
    const sealed = sealSessionSecret("tok", CTX, env());
    expect(() => openSessionSecret(sealed, { purpose: "session.access", ownerId: "identity_2" }, env())).toThrow(SessionCryptoError);
    expect(() => openSessionSecret(sealed, { purpose: "session.refresh", ownerId: "identity_1" }, env())).toThrow(SessionCryptoError);
  });

  it("rejects a malformed envelope", () => {
    for (const bad of ["", "nope", "v1.k1.only", "v9.k1.a.b.c"]) {
      expect(() => openSessionSecret(bad, CTX, env())).toThrow(SessionCryptoError);
    }
  });

  it("supports key rotation via keyId (old key decrypt-only)", () => {
    // Seal under old key id "old".
    const sealedOld = sealSessionSecret("tok", CTX, env({ SESSION_ENCRYPTION_KEY: ALT_KEY, SESSION_ENCRYPTION_KEY_ID: "old" }));
    // New primary "k1" but "old" still available for decryption.
    const rotated = env({ SESSION_ENCRYPTION_KEY: KEY, SESSION_ENCRYPTION_KEY_ID: "k1", SESSION_DECRYPTION_KEYS: `old:${ALT_KEY}` });
    expect(openSessionSecret(sealedOld, CTX, rotated)).toBe("tok");
    // A new seal uses the primary id.
    expect(sealSessionSecret("tok2", CTX, rotated).split(".")[1]).toBe("k1");
  });

  it("throws in production when the key is missing", () => {
    expect(() => assertSessionEncryptionReady({ NODE_ENV: "production" } as any)).toThrow(/key_missing/);
  });

  it("throws in production when the key is malformed/weak", () => {
    expect(() => assertSessionEncryptionReady({ NODE_ENV: "production", SESSION_ENCRYPTION_KEY: "too-short" } as any)).toThrow(SessionCryptoError);
    expect(() => assertSessionEncryptionReady({ NODE_ENV: "production", SESSION_ENCRYPTION_KEY: "change-me-change-me-change-me-change-me-change-me-change-me-1234" } as any)).toThrow(/key_weak/);
  });

  it("never silently reuses CHANNEL_ENCRYPTION_KEY", () => {
    expect(() => loadSessionKeyring(env({ CHANNEL_ENCRYPTION_KEY: KEY }))).toThrow(/key_reuses_channel_key/);
  });
});
