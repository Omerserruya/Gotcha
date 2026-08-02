/**
 * Payment-token encryption boundary.
 *
 * A stored card token is a bearer instrument, so these test the properties that
 * would be a breach if they regressed: unreadable at rest, unreadable with the
 * wrong key, and never silently replaced when it cannot be read.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  encryptPaymentToken,
  decryptPaymentToken,
  isEncryptedPaymentToken,
  paymentTokenEncryptionConfigured,
  assertPaymentTokenKey,
  PaymentTokenKeyMissingError,
  PaymentTokenUndecryptableError,
  CURRENT_PAYMENT_TOKEN_KEY_VERSION,
} from "../payment-token-crypto";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const TOKEN = "ictok_live_9f2c4a7e11";

const ORIGINAL = { ...process.env };
beforeEach(() => {
  process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY = KEY_A;
  delete process.env.BILLING_PAYMENT_TOKEN_DECRYPTION_KEYS;
});
afterAll(() => {
  process.env = ORIGINAL;
});

describe("encryption at rest", () => {
  it("the stored value does not contain the token", () => {
    const { ciphertext } = encryptPaymentToken(TOKEN);
    expect(ciphertext).not.toContain(TOKEN);
    expect(ciphertext).not.toContain("ictok");
    expect(isEncryptedPaymentToken(ciphertext)).toBe(true);
  });

  it("records the key version, so rotation does not orphan rows", () => {
    const sealed = encryptPaymentToken(TOKEN);
    expect(sealed.keyVersion).toBe(CURRENT_PAYMENT_TOKEN_KEY_VERSION);
    // The version also travels inside the value itself.
    expect(sealed.ciphertext.startsWith(`ptok.${CURRENT_PAYMENT_TOKEN_KEY_VERSION}.`)).toBe(true);
  });

  it("is non-deterministic, so equal tokens do not produce equal ciphertext", () => {
    expect(encryptPaymentToken(TOKEN).ciphertext).not.toBe(encryptPaymentToken(TOKEN).ciphertext);
  });

  it("round-trips inside the provider boundary", () => {
    expect(decryptPaymentToken(encryptPaymentToken(TOKEN).ciphertext)).toBe(TOKEN);
  });
});

describe("fails closed", () => {
  it("refuses the wrong key rather than returning garbage", () => {
    const { ciphertext } = encryptPaymentToken(TOKEN);
    process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY = KEY_B;
    expect(() => decryptPaymentToken(ciphertext)).toThrow(PaymentTokenUndecryptableError);
  });

  it("refuses tampered ciphertext (GCM auth tag)", () => {
    const { ciphertext } = encryptPaymentToken(TOKEN);
    const tampered = ciphertext.slice(0, -4) + "AAAA";
    expect(() => decryptPaymentToken(tampered)).toThrow(PaymentTokenUndecryptableError);
  });

  it("refuses a plaintext token sitting in the column", () => {
    // Data-integrity problem, not something to pass through to a charge.
    expect(() => decryptPaymentToken(TOKEN)).toThrow(PaymentTokenUndecryptableError);
  });

  it("refuses an unknown key version instead of guessing", () => {
    const { ciphertext } = encryptPaymentToken(TOKEN);
    const relabelled = ciphertext.replace(`ptok.${CURRENT_PAYMENT_TOKEN_KEY_VERSION}.`, "ptok.v99.");
    expect(() => decryptPaymentToken(relabelled)).toThrow(/v99/);
  });

  it("never silently discards or replaces an unreadable token", () => {
    const { ciphertext } = encryptPaymentToken(TOKEN);
    process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY = KEY_B;
    // It throws - it does not return "" or null, which would look like
    // "customer has no card" and turn a key problem into a failed renewal.
    let returned: unknown = "sentinel";
    try {
      returned = decryptPaymentToken(ciphertext);
    } catch {
      returned = "threw";
    }
    expect(returned).toBe("threw");
  });
});

describe("dedicated key, no fallback", () => {
  it("uses its own variable and never a shared application secret", () => {
    delete process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY;
    process.env.CHANNEL_ENCRYPTION_KEY = KEY_A;
    process.env.SESSION_ENCRYPTION_KEY = KEY_A;
    expect(paymentTokenEncryptionConfigured()).toBe(false);
    expect(() => encryptPaymentToken(TOKEN)).toThrow(PaymentTokenKeyMissingError);
    expect(() => assertPaymentTokenKey()).toThrow(/no fallback/);
    delete process.env.CHANNEL_ENCRYPTION_KEY;
    delete process.env.SESSION_ENCRYPTION_KEY;
  });

  it("mock and CI stay usable when no token is ever stored", () => {
    delete process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY;
    // Nothing throws on import or on the configuration probe; only actual token
    // handling requires the key.
    expect(paymentTokenEncryptionConfigured()).toBe(false);
  });

  it("decrypts with a retired key during rotation", () => {
    const { ciphertext } = encryptPaymentToken(TOKEN);
    const old = ciphertext.replace(`ptok.${CURRENT_PAYMENT_TOKEN_KEY_VERSION}.`, "ptok.v0.");
    process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY = KEY_B;
    process.env.BILLING_PAYMENT_TOKEN_DECRYPTION_KEYS = `v0:${KEY_A}`;
    expect(decryptPaymentToken(old)).toBe(TOKEN);
  });
});

describe("the token does not leak", () => {
  it("is absent from a serialized object holding the sealed value", () => {
    const { ciphertext, keyVersion } = encryptPaymentToken(TOKEN);
    const dto = { id: "pm_1", brand: "visa", last4: "4242", token: ciphertext, tokenKeyVersion: keyVersion };
    expect(JSON.stringify(dto)).not.toContain(TOKEN);
  });

  it("is absent from the error thrown when it cannot be read", () => {
    const { ciphertext } = encryptPaymentToken(TOKEN);
    process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY = KEY_B;
    try {
      decryptPaymentToken(ciphertext);
      throw new Error("should have thrown");
    } catch (err: any) {
      const serialized = `${err.message}\n${err.stack ?? ""}\n${JSON.stringify(err)}`;
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain(KEY_A);
      expect(serialized).not.toContain(KEY_B);
    }
  });
});
