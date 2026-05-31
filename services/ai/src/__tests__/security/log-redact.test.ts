/**
 * Unit tests for `packages/shared/src/lib/log-redact.ts`.
 *
 * Pure function — no mocks required.
 */
import { describe, it, expect } from "vitest";
import { redact } from "@chatcenter/shared";

describe("redact — JWT", () => {
  it("masks a JWT token by prefix", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redact(`Token failure: ${jwt}`);
    expect(typeof out).toBe("string");
    expect(out as string).not.toContain(jwt);
    expect(out as string).toContain("[REDACTED]");
  });

  it("masks an embedded JWT in a longer line", () => {
    // Minimum 10 chars per JWT segment per the regex.
    const out = redact(
      "Calendly OAuth body: {\"access_token\":\"eyJabcdefghijk.eyJbodydefghi.signature12345\"}",
    );
    expect(out as string).not.toContain("eyJabcdefghijk.eyJbodydefghi");
    expect(out as string).toContain("[REDACTED]");
  });
});

describe("redact — Authorization headers", () => {
  it("masks a Bearer token in an Authorization header literal", () => {
    const out = redact("GET /v1/x → 401 Authorization: Bearer abcdef1234567890");
    expect(out as string).toContain("Authorization: Bearer [REDACTED]");
    expect(out as string).not.toContain("abcdef1234567890");
  });

  it("masks a bare Bearer token", () => {
    const out = redact("upstream: Bearer abcdef1234567890");
    expect(out as string).toContain("Bearer [REDACTED]");
  });
});

describe("redact — OAuth params", () => {
  it("masks access_token / refresh_token / client_secret in URL-ish strings", () => {
    const out = redact(
      "POST /token?access_token=abc123&refresh_token=def456&client_secret=ghi789",
    );
    expect(out as string).not.toContain("abc123");
    expect(out as string).not.toContain("def456");
    expect(out as string).not.toContain("ghi789");
  });
});

describe("redact — PII", () => {
  it("masks email addresses to first-char + domain", () => {
    const out = redact("user ada@example.com logged in");
    expect(out as string).not.toContain("ada@example.com");
    expect(out as string).toContain("a***@example.com");
  });

  it("masks E.164-style phone numbers", () => {
    const out = redact("Caller ID +972 50 123 4567");
    expect(out as string).not.toContain("+972 50 123 4567");
    expect(out as string).toContain("[REDACTED]");
  });

  it("masks plain-format Israeli phone numbers", () => {
    const out = redact("call 050-1234567 please");
    expect(out as string).not.toContain("050-1234567");
    expect(out as string).toContain("[REDACTED]");
  });
});

describe("redact — innocuous text", () => {
  it("passes through harmless content unchanged", () => {
    const out = redact("the build succeeded in 12s");
    expect(out).toBe("the build succeeded in 12s");
  });

  it("returns null / undefined unchanged", () => {
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it("returns numbers and booleans unchanged", () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
  });
});

describe("redact — object recursion", () => {
  it("masks sensitive keys at any depth", () => {
    const out = redact({
      url: "/api/x",
      headers: { Authorization: "Bearer xyz" },
      body: { access_token: "abc", nested: { password: "p" } },
    }) as any;
    expect(out.headers.Authorization).toBe("[REDACTED]");
    expect(out.body.access_token).toBe("[REDACTED]");
    expect(out.body.nested.password).toBe("[REDACTED]");
    expect(out.url).toBe("/api/x");
  });

  it("handles Error instances", () => {
    const err = new Error("token=Bearer abcdef1234567890 expired");
    const out = redact(err) as any;
    expect(out.name).toBe("Error");
    expect(out.message).toContain("[REDACTED]");
    expect(out.message).not.toContain("abcdef1234567890");
  });

  it("handles arrays", () => {
    const out = redact([
      "Authorization: Bearer abcdef1234567890",
      { secret: "hidden" },
    ]) as any[];
    expect(out[0]).toContain("[REDACTED]");
    expect(out[1].secret).toBe("[REDACTED]");
  });
});
