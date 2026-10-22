/**
 * ★ List-Unsubscribe on marketing email (RFC 2369 / 8058).
 *   - the token names tenant, contact and channel; anything altered, or signed
 *     with another key, is not ours
 *   - mailto to the sending mailbox always; the https one-click only with a
 *     public https origin (and then List-Unsubscribe-Post)
 *   - extra headers can never break the header block
 */
import { describe, it, expect, beforeEach } from "vitest";
import { signUnsubscribeToken, verifyUnsubscribeToken, listUnsubscribeHeaders, publicOrigin } from "../list-unsubscribe";
import { threadHeaderLines, safeExtraHeaders } from "../../channels/email-thread";

const S = { tenantId: "cms4ug98n0004chmrp4lv6ujl", contactId: "c_123", channel: "GMAIL" };

beforeEach(() => { process.env.CHANNEL_ENCRYPTION_KEY = "k".repeat(64); });

describe("★ the token", () => {
  it("round-trips; the channel is upper-cased", () => {
    const t = signUnsubscribeToken({ ...S, channel: "gmail" })!;
    expect(verifyUnsubscribeToken(t)).toEqual(S);
  });

  it("★ altered, truncated, re-signed with another key, or junk: not ours", () => {
    const t = signUnsubscribeToken(S)!;
    const [p, mac] = t.split(".");
    const other = Buffer.from(Buffer.from(p!, "base64url").toString().replace("c_123", "c_999")).toString("base64url");
    expect(verifyUnsubscribeToken(`${other}.${mac}`)).toBeNull();
    expect(verifyUnsubscribeToken(t.slice(0, -2))).toBeNull();
    expect(verifyUnsubscribeToken("x")).toBeNull();
    expect(verifyUnsubscribeToken(null)).toBeNull();
    process.env.CHANNEL_ENCRYPTION_KEY = "z".repeat(64);
    expect(verifyUnsubscribeToken(t)).toBeNull();
  });

  it("no key, or ids that cannot be carried: no token", () => {
    expect(signUnsubscribeToken({ ...S, contactId: "a.b" })).toBeNull();
    expect(signUnsubscribeToken({ ...S, channel: "GMAIL\r\nX" })).toBeNull();
    delete process.env.CHANNEL_ENCRYPTION_KEY;
    expect(signUnsubscribeToken(S)).toBeNull();
  });
});

describe("★ the headers", () => {
  it("with a public origin: mailto + https, and one-click", () => {
    const h = listUnsubscribeHeaders({ subject: S, mailbox: "shop@example.com", origin: "https://dev.gotcha.co.il" });
    const t = signUnsubscribeToken(S)!;
    expect(h).toEqual([
      { name: "List-Unsubscribe", value: `<mailto:shop@example.com?subject=unsubscribe&body=unsubscribe>, <https://dev.gotcha.co.il/api/contacts/unsubscribe/${t}>` },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ]);
  });

  it("★ no public origin: mailto only, and NO one-click header", () => {
    expect(listUnsubscribeHeaders({ subject: S, mailbox: "shop@example.com", origin: null })).toEqual([
      { name: "List-Unsubscribe", value: "<mailto:shop@example.com?subject=unsubscribe&body=unsubscribe>" },
    ]);
  });

  it("no usable mailbox and no origin: nothing; a bad mailbox is never written", () => {
    expect(listUnsubscribeHeaders({ subject: S, mailbox: "not an address", origin: null })).toEqual([]);
    expect(listUnsubscribeHeaders({ subject: S, mailbox: "a@b.co>, <https://evil", origin: null })).toEqual([]);
    expect(listUnsubscribeHeaders({ subject: S, mailbox: null, origin: "https://dev.gotcha.co.il" })[0]!.value).toMatch(/^<https:/);
  });

  it("the origin comes from PUBLIC_URL (then APP_PUBLIC_URL, NEXT_PUBLIC_API_URL), https only", () => {
    expect(publicOrigin({ PUBLIC_URL: "https://dev.gotcha.co.il/x" })).toBe("https://dev.gotcha.co.il");
    expect(publicOrigin({ PUBLIC_URL: "http://insecure", APP_PUBLIC_URL: "https://app.gotcha.co.il" })).toBe("https://app.gotcha.co.il");
    expect(publicOrigin({})).toBeNull();
  });

  it("★ extra headers go into the raw header block only when they cannot break it", () => {
    const lines = threadHeaderLines({ subject: "Hi", extraHeaders: [
      { name: "List-Unsubscribe", value: "<mailto:a@b.co>" },
      { name: "Bcc", value: "x@y.z\r\nInjected: 1" },
      { name: "Bad Name", value: "v" },
    ] });
    expect(lines).toEqual(["List-Unsubscribe: <mailto:a@b.co>"]);
    expect(safeExtraHeaders(undefined)).toEqual([]);
  });
});
