/**
 * ★ The page context a widget sends (2026-10-14): a Shopify handle or a
 * WooCommerce slug (often Hebrew, percent-encoded) and Woo's numeric product
 * id, as lookup keys only. Hebrew slugs used to be dropped.
 */
import { describe, it, expect } from "vitest";
import { normalizeStorefrontContext } from "../shopify-live-chat";

describe("★ normalizeStorefrontContext", () => {
  it("a percent-encoded Hebrew Woo slug is decoded and kept; a Shopify handle as before", () => {
    const enc = encodeURIComponent("מעיל-טרנץ-כותנה");
    expect(normalizeStorefrontContext({ pageType: "product", productHandle: enc }).productHandle).toBe("מעיל-טרנץ-כותנה");
    expect(normalizeStorefrontContext({ productHandle: "מעיל_חורף" }).productHandle).toBe("מעיל_חורף");
    expect(normalizeStorefrontContext({ productHandle: "Oak-Lamp" }).productHandle).toBe("oak-lamp");
  });

  it("Woo's numeric product id (postid-<id>) as a string; anything else dropped", () => {
    expect(normalizeStorefrontContext({ productId: "425" }).productId).toBe("425");
    expect(normalizeStorefrontContext({ productId: 364 }).productId).toBe("364");
    for (const v of ["42a", "-1", "1".repeat(13), "", null, {}]) expect(normalizeStorefrontContext({ productId: v }).productId).toBeNull();
  });

  it("★ the same strictness: no query, no markup, no path separators, no broken encoding, nothing else kept", () => {
    for (const v of ["oak?x=1", "<script>", "a/b", "%E0%A4%A", "with space", "-starts-with-dash"]) {
      expect(normalizeStorefrontContext({ productHandle: v }).productHandle, v).toBeNull();
    }
    const c: any = normalizeStorefrontContext({ productHandle: "oak", productId: "1", price: 99, email: "x@y.z" });
    expect(Object.keys(c).sort()).toEqual(["cartItemCount", "collectionHandle", "currency", "locale", "pageType", "path", "productHandle", "productId"].sort());
  });
});
