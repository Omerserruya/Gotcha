import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSocialLinks, safeExternalUrl } from "../social-links";

const KEYS = [
  "NEXT_PUBLIC_SOCIAL_INSTAGRAM_URL",
  "NEXT_PUBLIC_SOCIAL_FACEBOOK_URL",
  "NEXT_PUBLIC_SOCIAL_WHATSAPP_URL",
] as const;

const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    original[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("safeExternalUrl", () => {
  it("accepts http and https", () => {
    expect(safeExternalUrl("https://www.instagram.com/gotcha")).toBe("https://www.instagram.com/gotcha");
    expect(safeExternalUrl("http://example.com/")).toBe("http://example.com/");
  });

  it("rejects a script URL, which would otherwise become a live href", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("JavaScript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("treats empty, whitespace and malformed values as not configured", () => {
    expect(safeExternalUrl(undefined)).toBeNull();
    expect(safeExternalUrl("")).toBeNull();
    expect(safeExternalUrl("   ")).toBeNull();
    expect(safeExternalUrl("instagram.com/gotcha")).toBeNull(); // no scheme
  });
});

describe("getSocialLinks", () => {
  it("returns nothing when no profile is configured", () => {
    expect(getSocialLinks()).toEqual([]);
  });

  it("returns only the profiles that are configured", () => {
    process.env.NEXT_PUBLIC_SOCIAL_INSTAGRAM_URL = "https://www.instagram.com/gotcha";
    process.env.NEXT_PUBLIC_SOCIAL_WHATSAPP_URL = "https://wa.me/972500000000";

    expect(getSocialLinks().map((l) => l.key)).toEqual(["instagram", "whatsapp"]);
  });

  it("keeps a stable display order regardless of which are set", () => {
    for (const k of KEYS) process.env[k] = "https://example.com/x";
    expect(getSocialLinks().map((l) => l.key)).toEqual(["instagram", "facebook", "whatsapp"]);
  });

  it("drops a profile whose URL is unsafe rather than rendering it", () => {
    process.env.NEXT_PUBLIC_SOCIAL_FACEBOOK_URL = "javascript:alert(1)";
    process.env.NEXT_PUBLIC_SOCIAL_INSTAGRAM_URL = "https://www.instagram.com/gotcha";

    expect(getSocialLinks().map((l) => l.key)).toEqual(["instagram"]);
  });
});
