import { describe, it, expect } from "vitest";
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
  isWellFormedTokenHash,
} from "../session-token";

describe("session-token", () => {
  it("generates a well-formed 256-bit base64url identifier", () => {
    const t = generateSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, no padding
    expect(isWellFormedSessionToken(t)).toBe(true);
  });

  it("generates unique high-entropy tokens", () => {
    const set = new Set(Array.from({ length: 2000 }, () => generateSessionToken()));
    expect(set.size).toBe(2000);
  });

  it("hashes deterministically to 64 hex chars, distinct from the raw value", () => {
    const t = generateSessionToken();
    const h = hashSessionToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(isWellFormedTokenHash(h)).toBe(true);
    expect(h).toBe(hashSessionToken(t)); // deterministic
    expect(h).not.toBe(t); // never the raw value
  });

  it("different tokens hash to different values", () => {
    expect(hashSessionToken(generateSessionToken())).not.toBe(hashSessionToken(generateSessionToken()));
  });

  it("refuses to hash a malformed token", () => {
    expect(() => hashSessionToken("short")).toThrow();
    expect(() => hashSessionToken("has spaces and bad!!chars".padEnd(43, "x"))).toThrow();
    expect(isWellFormedSessionToken("nope")).toBe(false);
  });
});
