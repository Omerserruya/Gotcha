import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sealSessionSecret, openSessionSecret, SessionCryptoError } from "../session-crypto";

const LIB = join(__dirname, "..");
const FILES = [
  "session-crypto.ts",
  "session-token.ts",
  "session-cookie.ts",
  "app-origins.ts",
  "session-flags.ts",
  "session-store.ts",
];
const SECRET_TOKENS = [
  "encryptedAccessToken",
  "encryptedRefreshToken",
  "csrfSecret",
  "sessionTokenHash",
  "SESSION_ENCRYPTION_KEY",
];

describe("session infra never logs secrets", () => {
  it("no session-infra source file calls console.* at all", () => {
    for (const f of FILES) {
      const src = readFileSync(join(LIB, f), "utf8");
      expect(src, `${f} must not use console.*`).not.toMatch(/\bconsole\s*\./);
    }
  });

  it("no logging/stringify of a secret field name in the session infra", () => {
    for (const f of FILES) {
      const src = readFileSync(join(LIB, f), "utf8");
      for (const secret of SECRET_TOKENS) {
        // The field/const may be referenced, but never inside a log/serialize call.
        const badPatterns = [
          new RegExp(`console\\.[a-z]+\\([^)]*${secret}`),
          new RegExp(`JSON\\.stringify\\([^)]*${secret}`),
        ];
        for (const re of badPatterns) expect(src, `${f}:${secret}`).not.toMatch(re);
      }
    }
  });

  it("crypto errors carry only a code, never plaintext/key/ciphertext", () => {
    const env = { NODE_ENV: "test", SESSION_ENCRYPTION_KEY: "0f".repeat(32) } as any;
    const sealed = sealSessionSecret("super-secret-token", { purpose: "session.access", ownerId: "id" }, env);
    const tampered = sealed.slice(0, -4) + "AAAA";
    try {
      // wrong context -> auth failure
      openSessionSecret(tampered, { purpose: "session.access", ownerId: "other" }, env);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCryptoError);
      expect((e as Error).message).not.toContain("super-secret-token");
      expect((e as Error).message).not.toContain("0f0f");
    }
  });
});
