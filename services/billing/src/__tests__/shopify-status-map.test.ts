/**
 * Mapping Shopify's statuses into ours.
 *
 * Two of these mappings are the ones that would quietly do damage, and they
 * get a test each rather than being covered by a table sweep.
 */
import { describe, it, expect } from "vitest";
import {
  mapShopifyStatus,
  isTerminalShopifyStatus,
  grantsAccess,
} from "../billing-sources/shopify/status-map";

describe("Shopify AppSubscriptionStatus mapping", () => {
  it("maps every documented value", () => {
    expect(mapShopifyStatus("PENDING")).toBe("PENDING");
    expect(mapShopifyStatus("ACTIVE")).toBe("ACTIVE");
    expect(mapShopifyStatus("DECLINED")).toBe("DECLINED");
    expect(mapShopifyStatus("EXPIRED")).toBe("EXPIRED");
    expect(mapShopifyStatus("FROZEN")).toBe("FROZEN");
    expect(mapShopifyStatus("CANCELLED")).toBe("CANCELLED");
  });

  it("FROZEN stays FROZEN and never becomes our SUSPENDED", () => {
    // Shopify reactivates a frozen subscription itself once payments resume.
    // SUSPENDED is ours for "dunning exhausted, a human must act" - collapsing
    // the two would queue manual work for an account that heals on its own.
    const mapped = mapShopifyStatus("FROZEN");
    expect(mapped).toBe("FROZEN");
    expect(mapped).not.toBe("PAST_DUE");
    // Not terminal: Shopify will move it back by itself.
    expect(isTerminalShopifyStatus(mapped)).toBe(false);
    // But access stops, because the merchant is not currently paying.
    expect(grantsAccess(mapped)).toBe(false);
  });

  it("EXPIRED is told apart from CANCELLED - it is the abandoned plan selection", () => {
    // Shopify expires an unapproved subscription after two days. That is a
    // merchant who never answered, not one who refused and not one who left.
    expect(mapShopifyStatus("EXPIRED")).toBe("EXPIRED");
    expect(mapShopifyStatus("DECLINED")).toBe("DECLINED");
    expect(mapShopifyStatus("CANCELLED")).toBe("CANCELLED");
    for (const s of ["EXPIRED", "DECLINED", "CANCELLED"] as const) {
      expect(isTerminalShopifyStatus(mapShopifyStatus(s))).toBe(true);
    }
  });

  it("an unknown status is REQUIRES_ACTION, never ACTIVE and never CANCELLED", () => {
    // ACTIVE would serve a merchant who may not be paying; CANCELLED would cut
    // off one who is. Neither is a safe guess.
    const mapped = mapShopifyStatus("SOME_NEW_SHOPIFY_STATUS");
    expect(mapped).toBe("REQUIRES_ACTION");
    expect(grantsAccess(mapped)).toBe(false);
    expect(isTerminalShopifyStatus(mapped)).toBe(false);
  });

  it("null and empty are REQUIRES_ACTION too", () => {
    expect(mapShopifyStatus(null)).toBe("REQUIRES_ACTION");
    expect(mapShopifyStatus(undefined)).toBe("REQUIRES_ACTION");
    expect(mapShopifyStatus("")).toBe("REQUIRES_ACTION");
  });

  it("accepts Shopify's deprecated and alternate spellings", () => {
    expect(mapShopifyStatus("ACCEPTED")).toBe("ACTIVE");
    expect(mapShopifyStatus("CANCELED")).toBe("CANCELLED");
    expect(mapShopifyStatus("active")).toBe("ACTIVE");
  });

  it("only ACTIVE and TRIALING grant access", () => {
    expect(grantsAccess("ACTIVE")).toBe(true);
    expect(grantsAccess("TRIALING")).toBe(true);
    for (const s of ["PENDING", "FROZEN", "PAST_DUE", "CANCELLED", "DECLINED", "EXPIRED", "REQUIRES_ACTION"] as const) {
      expect(grantsAccess(s)).toBe(false);
    }
  });
});
