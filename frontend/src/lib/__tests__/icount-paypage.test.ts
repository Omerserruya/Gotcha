import { describe, it, expect } from "vitest";
import { payPageOrigin, parsePayPageMessage, isTrustedPayPageEvent } from "../icount-paypage";

// The browser side of secure card capture: an untrusted postMessage is
// accepted ONLY from the exact PayPage origin and ONLY in the expected shape.
// Everything else must be silently ignored (returns null/false, never throws).

describe("icount-paypage: payPageOrigin", () => {
  it("derives the exact origin from the configured PayPage URL", () => {
    expect(payPageOrigin("https://pay.icount.co.il/paypage/abc?x=1")).toBe("https://pay.icount.co.il");
    expect(payPageOrigin("https://sandbox.icount.co.il:8443/p/1")).toBe("https://sandbox.icount.co.il:8443");
  });

  it("returns null for missing or unparseable URLs (→ no message is ever trusted)", () => {
    expect(payPageOrigin(undefined)).toBeNull();
    expect(payPageOrigin(null)).toBeNull();
    expect(payPageOrigin("")).toBeNull();
    expect(payPageOrigin("not a url")).toBeNull();
  });
});

describe("icount-paypage: parsePayPageMessage", () => {
  it("accepts exactly the expected shape and returns the token", () => {
    expect(parsePayPageMessage({ type: "icount:paypage", pageToken: "pt_12345" })).toBe("pt_12345");
    expect(parsePayPageMessage({ type: "icount:paypage", pageToken: "  pt_x1  " })).toBe("pt_x1");
  });

  it("rejects malformed payloads without throwing", () => {
    expect(parsePayPageMessage(null)).toBeNull();
    expect(parsePayPageMessage(undefined)).toBeNull();
    expect(parsePayPageMessage("pt_raw_string")).toBeNull();
    expect(parsePayPageMessage(42)).toBeNull();
    expect(parsePayPageMessage({})).toBeNull();
    expect(parsePayPageMessage({ type: "other", pageToken: "pt_1234" })).toBeNull();
    expect(parsePayPageMessage({ type: "icount:paypage" })).toBeNull();
    expect(parsePayPageMessage({ type: "icount:paypage", pageToken: 123 })).toBeNull();
  });

  it("rejects out-of-bounds tokens (too short / absurdly long)", () => {
    expect(parsePayPageMessage({ type: "icount:paypage", pageToken: "ab" })).toBeNull();
    expect(parsePayPageMessage({ type: "icount:paypage", pageToken: "x".repeat(513) })).toBeNull();
  });
});

describe("icount-paypage: isTrustedPayPageEvent", () => {
  it("accepts only an exact origin match", () => {
    expect(isTrustedPayPageEvent("https://pay.icount.co.il", "https://pay.icount.co.il")).toBe(true);
  });

  it("rejects other origins, subdomain tricks, and scheme downgrades", () => {
    const expected = "https://pay.icount.co.il";
    expect(isTrustedPayPageEvent("https://evil.example.com", expected)).toBe(false);
    expect(isTrustedPayPageEvent("https://pay.icount.co.il.evil.com", expected)).toBe(false);
    expect(isTrustedPayPageEvent("http://pay.icount.co.il", expected)).toBe(false);
    expect(isTrustedPayPageEvent("https://sub.pay.icount.co.il", expected)).toBe(false);
  });

  it("rejects EVERYTHING when no expected origin is configured", () => {
    expect(isTrustedPayPageEvent("https://pay.icount.co.il", null)).toBe(false);
  });
});
