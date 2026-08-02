import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  shopifyApiVersion,
  reportShopifyApiVersion,
  checkShopifyResponseVersion,
  SHOPIFY_API_VERSION_REVIEW_BY,
  __resetShopifyApiVersionCache,
} from "../shopify-api-version";

beforeEach(() => __resetShopifyApiVersionCache());
afterEach(() => vi.restoreAllMocks());

describe("the version is decided in exactly one place", () => {
  it("defaults to a RELEASED, supported version - not an expired or future one", () => {
    const v = shopifyApiVersion({} as NodeJS.ProcessEnv);
    // 2024-04 was the bug: ~15 months past end of support. 2026-10 / 2027-01
    // are announced but unreleased - pinning forward is the same mistake.
    expect(v).toBe("2026-07");
    expect(v).not.toBe("2024-04");
  });

  it("accepts a well-formed operator override so a bump needs no deploy", () => {
    expect(shopifyApiVersion({ SHOPIFY_API_VERSION: "2026-04" } as any)).toBe("2026-04");
  });

  it("THROWS on a malformed override instead of silently using the default", () => {
    // Falling back quietly would recreate the invisible-drift problem this
    // module exists to end: the operator would believe the override applied.
    for (const bad of ["2026-13", "26-07", "2026/07", "latest", "2026-7"]) {
      __resetShopifyApiVersionCache();
      expect(() => shopifyApiVersion({ SHOPIFY_API_VERSION: bad } as any)).toThrow(/not a valid Shopify API version/);
    }
  });

  it("carries a review date so the pin cannot rot unnoticed", () => {
    expect(SHOPIFY_API_VERSION_REVIEW_BY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Must be before 2026-07's end of support (2027-07-16), so the review
    // happens while a newer version still overlaps.
    expect(new Date(SHOPIFY_API_VERSION_REVIEW_BY) < new Date("2027-07-16")).toBe(true);
  });
});

describe("Shopify's silent fall-forward is made visible", () => {
  it("passes when the served version matches what was requested", () => {
    const r = checkShopifyResponseVersion({ requested: "2026-07", headerValue: "2026-07" });
    expect(r.ok).toBe(true);
    expect(r.served).toBe("2026-07");
    expect(r.reason).toBeUndefined();
  });

  it("DETECTS the drift that made the original defect invisible", () => {
    // The real production shape: we ask for an inaccessible version, Shopify
    // serves its oldest accessible one, everything "works".
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = checkShopifyResponseVersion({
      requested: "2024-04", headerValue: "2025-10", surface: "REST", shop: "acme.myshopify.com",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("version_mismatch");
    expect(r.served).toBe("2025-10");
    expect(err).toHaveBeenCalled();
    const msg = String(err.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("VERSION DRIFT");
    expect(msg).toContain("requested=2024-04");
    expect(msg).toContain("served=2025-10");
  });

  it("reports a missing header rather than assuming agreement", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = checkShopifyResponseVersion({ requested: "2026-07", headerValue: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_header");
    expect(warn).toHaveBeenCalled();
  });

  it("never throws - a header disagreement must not fail a customer request", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      checkShopifyResponseVersion({ requested: "2026-07", headerValue: "2025-10" }),
    ).not.toThrow();
  });

  it("logs the shop HOST only, never a path that could carry customer ids", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    checkShopifyResponseVersion({
      requested: "2026-07", headerValue: "2025-10", shop: "acme.myshopify.com",
    });
    const msg = String(err.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("acme.myshopify.com");
    expect(msg).not.toMatch(/customers\/\d|orders\/\d/);
  });
});

describe("startup reporting", () => {
  it("announces the version so it is visible without reading adapter source", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(reportShopifyApiVersion({} as any)).toBe("2026-07");
    expect(String(log.mock.calls[0]?.[0] ?? "")).toContain("version=2026-07");
  });

  it("warns - but does NOT refuse to boot - on a valid version it does not recognise", () => {
    // A future Shopify quarterly release is well-formed and legitimate.
    // Refusing to start would turn a routine upgrade into an outage.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => reportShopifyApiVersion({ SHOPIFY_API_VERSION: "2027-04" } as any)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
