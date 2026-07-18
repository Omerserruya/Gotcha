import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifyWebhookSignature, verifySharedSecretToken, timingSafeEqualStr } from "../webhook-verify";

const secret = "test-webhook-secret";
const hmac = (body: Buffer, s = secret) => crypto.createHmac("sha256", s).update(body).digest("hex");
const verify = (s: string, b: Buffer, sig: string) => timingSafeEqualStr(hmac(b, s), sig);

describe("verifyWebhookSignature (fail-closed)", () => {
  const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));

  it("accepts a valid signature", () => {
    const r = verifyWebhookSignature({ secret, rawBody, signature: hmac(rawBody), verify });
    expect(r.ok).toBe(true);
  });

  it("rejects when the signature header is missing (the original bypass)", () => {
    const r = verifyWebhookSignature({ secret, rawBody, signature: undefined, verify });
    expect(r.ok).toBe(false);
  });

  it("rejects when the secret is not configured", () => {
    const r = verifyWebhookSignature({ secret: undefined, rawBody, signature: hmac(rawBody), verify });
    expect(r.ok).toBe(false);
  });

  it("rejects when the raw body is unavailable", () => {
    const r = verifyWebhookSignature({ secret, rawBody: undefined, signature: hmac(rawBody), verify });
    expect(r.ok).toBe(false);
  });

  it("rejects a wrong signature", () => {
    const r = verifyWebhookSignature({ secret, rawBody, signature: hmac(rawBody, "attacker"), verify });
    expect(r.ok).toBe(false);
  });

  it("rejects a forged body", () => {
    const good = hmac(rawBody);
    const forged = Buffer.from(JSON.stringify({ hello: "evil" }));
    const r = verifyWebhookSignature({ secret, rawBody: forged, signature: good, verify });
    expect(r.ok).toBe(false);
  });

  it("never throws even if the verify fn throws", () => {
    const r = verifyWebhookSignature({
      secret, rawBody, signature: "x",
      verify: () => { throw new Error("boom"); },
    });
    expect(r.ok).toBe(false);
  });
});

describe("verifySharedSecretToken", () => {
  it("accepts a matching token", () => {
    expect(verifySharedSecretToken({ expected: "abc", provided: "abc", isProduction: true, label: "t" }).ok).toBe(true);
  });
  it("rejects a mismatched token", () => {
    expect(verifySharedSecretToken({ expected: "abc", provided: "xyz", isProduction: true, label: "t" }).ok).toBe(false);
  });
  it("fails closed in production when unconfigured", () => {
    expect(verifySharedSecretToken({ expected: undefined, provided: "x", isProduction: true, label: "t" }).ok).toBe(false);
  });
  it("allows in non-production when unconfigured (dev ergonomics)", () => {
    expect(verifySharedSecretToken({ expected: undefined, provided: undefined, isProduction: false, label: "t" }).ok).toBe(true);
  });
});

describe("timingSafeEqualStr", () => {
  it("true for equal strings", () => expect(timingSafeEqualStr("aaaa", "aaaa")).toBe(true));
  it("false for different strings", () => expect(timingSafeEqualStr("aaaa", "bbbb")).toBe(false));
  it("false for different lengths", () => expect(timingSafeEqualStr("aa", "aaaa")).toBe(false));
  it("false when either is empty/undefined", () => {
    expect(timingSafeEqualStr("", "a")).toBe(false);
    expect(timingSafeEqualStr(undefined, "a")).toBe(false);
    expect(timingSafeEqualStr("a", null)).toBe(false);
  });
});
