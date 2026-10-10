import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import {
  signMediaUrl, verifyMediaSignature, mediaSignatureShapeOk, presentMediaUrl, storedUploadName, signedMediaPath,
} from "../media-url";

/**
 * ★ Stored uploads leave the service only as a logged-in per-message URL or a
 * short-lived signed link (2026-10-10, uploads plan steps 1-3).
 */
const NAME = "123e4567-e89b-12d3-a456-426614174000.jpg";
const NOW = 1_800_000_000_000;
let saved: string | undefined;

beforeEach(() => { saved = process.env.CHANNEL_ENCRYPTION_KEY; process.env.CHANNEL_ENCRYPTION_KEY = "test-channel-key"; });
afterEach(() => { if (saved === undefined) delete process.env.CHANNEL_ENCRYPTION_KEY; else process.env.CHANNEL_ENCRYPTION_KEY = saved; });

const sign = (o: Partial<{ messageId: string; tenantId: string; ttlSeconds: number; now: number }> = {}) =>
  signMediaUrl({ messageId: "m1", tenantId: "T1", ttlSeconds: 900, now: NOW, ...o });

describe("★ signMediaUrl / verifyMediaSignature", () => {
  it("a fresh signature verifies for exactly its message and tenant", () => {
    const s = sign();
    expect(s.exp).toBe(NOW / 1000 + 900);
    expect(s.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", ...s, now: NOW })).toBe(true);
    // exp arrives as a query string
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", exp: String(s.exp), sig: s.sig, now: NOW })).toBe(true);
  });

  it("is HMAC-SHA256 over media:v1|message|tenant|exp under an HKDF key, not the channel key itself", () => {
    const s = sign();
    const key = Buffer.from(crypto.hkdfSync("sha256", Buffer.from("test-channel-key"), Buffer.alloc(0), "gotcha-media-url-v1", 32));
    const want = crypto.createHmac("sha256", key).update(`media:v1|m1|T1|${s.exp}`).digest("hex");
    expect(s.sig).toBe(want);
    const raw = crypto.createHmac("sha256", "test-channel-key").update(`media:v1|m1|T1|${s.exp}`).digest("hex");
    expect(s.sig).not.toBe(raw);
  });

  it("another message, another tenant, or a moved exp is refused", () => {
    const s = sign();
    expect(verifyMediaSignature({ messageId: "m2", tenantId: "T1", ...s, now: NOW })).toBe(false);
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T2", ...s, now: NOW })).toBe(false);
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", exp: s.exp + 1, sig: s.sig, now: NOW })).toBe(false);
  });

  it("a tampered signature is refused, one hex digit or one byte", () => {
    const s = sign();
    const flip = s.sig.slice(0, -1) + (s.sig.endsWith("0") ? "1" : "0");
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", exp: s.exp, sig: flip, now: NOW })).toBe(false);
    const first = (s.sig[0] === "a" ? "b" : "a") + s.sig.slice(1);
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", exp: s.exp, sig: first, now: NOW })).toBe(false);
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", exp: s.exp, sig: s.sig.toUpperCase(), now: NOW })).toBe(false);
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", exp: s.exp, sig: s.sig.slice(2), now: NOW })).toBe(false);
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", exp: s.exp, sig: "", now: NOW })).toBe(false);
  });

  it("expired is refused, at the second it expires and after", () => {
    const s = sign();
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", ...s, now: s.exp * 1000 - 1 })).toBe(true);
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", ...s, now: s.exp * 1000 })).toBe(false);
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", ...s, now: s.exp * 1000 + 60_000 })).toBe(false);
  });

  it("a different channel key does not verify, and no key verifies nothing", () => {
    const s = sign();
    process.env.CHANNEL_ENCRYPTION_KEY = "rotated";
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", ...s, now: NOW })).toBe(false);
    delete process.env.CHANNEL_ENCRYPTION_KEY;
    expect(verifyMediaSignature({ messageId: "m1", tenantId: "T1", ...s, now: NOW })).toBe(false);
    expect(() => sign()).toThrow(/not configured/);
  });

  it("an id carrying the separator cannot shift the fields", () => {
    expect(() => sign({ messageId: "m1|T1" })).toThrow();
    expect(() => sign({ tenantId: "T1|9" })).toThrow();
    // "m|T1" + "x" and "m" + "T1|x" would MAC the same string.
    const s = sign({ messageId: "m", tenantId: "T1" });
    expect(verifyMediaSignature({ messageId: "m", tenantId: "T1", ...s, now: NOW })).toBe(true);
    expect(verifyMediaSignature({ messageId: "m|T1", tenantId: "T1", ...s, now: NOW })).toBe(false);
    expect(verifyMediaSignature({ messageId: "", tenantId: "T1", ...s, now: NOW })).toBe(false);
  });

  it("refuses a non-positive or fractional ttl", () => {
    for (const ttl of [0, -1, 1.5, Number.NaN]) expect(() => sign({ ttlSeconds: ttl })).toThrow();
  });

  it("mediaSignatureShapeOk refuses garbage before any lookup", () => {
    const s = sign();
    expect(mediaSignatureShapeOk({ ...s, now: NOW })).toBe(true);
    for (const exp of ["", "abc", "-1", "1e12", `${s.exp}.0`, undefined, ["1"]]) {
      expect(mediaSignatureShapeOk({ exp, sig: s.sig, now: NOW }), String(exp)).toBe(false);
    }
    expect(mediaSignatureShapeOk({ exp: s.exp, sig: "z".repeat(64), now: NOW })).toBe(false);
    expect(mediaSignatureShapeOk({ exp: s.exp, sig: [s.sig], now: NOW })).toBe(false);
  });
});

describe("★ presentMediaUrl", () => {
  const ids = { conversationId: "c1", messageId: "m1" };

  it("rewrites a stored upload to the logged-in per-message route, keeping <uuid>.<ext>", () => {
    expect(presentMediaUrl(`/api/uploads/${NAME}`, ids)).toBe(`/api/conversations/c1/messages/m1/media/${NAME}`);
  });

  it("a legacy upper-case extension is still an upload", () => {
    const legacy = NAME.replace(".jpg", ".JPG");
    expect(presentMediaUrl(`/api/uploads/${legacy}`, ids)).toBe(`/api/conversations/c1/messages/m1/media/${legacy}`);
  });

  it("passes a Meta CDN link, an operator's link, null and anything unrecognised through unchanged", () => {
    for (const v of [
      "https://scontent.xx.fbcdn.net/v/t1/abc.jpg?oh=1",
      `https://app.example.com/api/uploads/${NAME}`,
      "/api/uploads/../etc/passwd",
      `/api/uploads/${NAME}/x`,
      `/api/uploads/sub/${NAME}`,
      "/api/uploads/not-a-uuid.jpg",
      `/api/uploads/${NAME.replace(".jpg", ".toolongext")}`,
      `api/uploads/${NAME}`,
      "",
    ]) {
      expect(presentMediaUrl(v, ids), v).toBe(v);
    }
    expect(presentMediaUrl(null, ids)).toBeNull();
    expect(presentMediaUrl(undefined, ids)).toBeUndefined();
  });

  it("without a conversation or message id it stays as stored", () => {
    expect(presentMediaUrl(`/api/uploads/${NAME}`, { conversationId: null, messageId: "m1" })).toBe(`/api/uploads/${NAME}`);
    expect(presentMediaUrl(`/api/uploads/${NAME}`, { conversationId: "c1" })).toBe(`/api/uploads/${NAME}`);
  });

  it("storedUploadName takes only a bare uuid name", () => {
    expect(storedUploadName(`/api/uploads/${NAME}`)).toBe(NAME);
    expect(storedUploadName(`/api/uploads/.${NAME}`)).toBeNull();
    expect(storedUploadName(`/api/uploads/${NAME.replace(".jpg", ".jp/g")}`)).toBeNull();
    expect(storedUploadName(42)).toBeNull();
  });

  it("signedMediaPath carries exp and sig as query", () => {
    expect(signedMediaPath("m1", { exp: 5, sig: "ab" })).toBe("/api/media/s/m1?exp=5&sig=ab");
  });
});
