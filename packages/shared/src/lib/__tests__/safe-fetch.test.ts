import { describe, it, expect } from "vitest";
import { isBlockedIp, assertPublicUrl, SsrfError } from "../safe-fetch";

describe("isBlockedIp - SSRF address classification", () => {
  it("blocks private/loopback/metadata IPv4 in dotted form", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows genuine public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks IPv4-mapped IPv6 in DOTTED form", () => {
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
  });

  // Regression: the original guard only matched the dotted embedded v4, so the
  // hex-colon notation of the same address slipped through (metadata SSRF).
  it("blocks IPv4-mapped IPv6 in HEX-COLON form (regression)", () => {
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isBlockedIp("::ffff:0a00:0001")).toBe(true); // 10.0.0.1
    expect(isBlockedIp("::ffff:c0a8:0101")).toBe(true); // 192.168.1.1
    expect(isBlockedIp("0:0:0:0:0:ffff:a9fe:a9fe")).toBe(true); // fully expanded
  });

  it("blocks NAT64 and IPv4-compatible forms embedding a private v4", () => {
    expect(isBlockedIp("64:ff9b::a9fe:a9fe")).toBe(true); // NAT64 -> metadata
    expect(isBlockedIp("::7f00:1")).toBe(true); // v4-compatible -> 127.0.0.1
  });

  it("blocks loopback/link-local/ULA IPv6 and tolerates brackets", () => {
    for (const ip of ["::1", "fe80::1", "fc00::1", "fd12:3456::1", "[::ffff:a9fe:a9fe]"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("fails safe: an unparseable IP literal is treated as blocked", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("::ffff:zzzz:1")).toBe(true);
  });
});

describe("assertPublicUrl - full path", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("gopher://x/")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects private/metadata IP literals including IPv6-mapped hex", async () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:6379/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[::ffff:7f00:1]:6379/",
      "http://[64:ff9b::a9fe:a9fe]/",
    ]) {
      await expect(assertPublicUrl(u), u).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("rejects credential-smuggled and localhost hostnames", async () => {
    await expect(assertPublicUrl("http://user:pass@127.0.0.1/")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("http://localhost/")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("http://metadata.google.internal/")).rejects.toBeInstanceOf(SsrfError);
  });
});
