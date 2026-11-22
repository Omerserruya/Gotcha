/**
 * The Shopify gate and a store on a per-merchant custom app (2026-11-22): GOTCHA's grant (source ADDON,
 * reason "shopify_custom_app") opens it, as Shopify's own sources do; no other ADDON row does, and OAuth
 * alone (no row) never does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ rows: [] as any[], where: null as any }));
vi.mock("../lib/prisma", () => ({
  prisma: {
    tenantEntitlement: {
      findMany: async (a: any) => {
        H.where = a.where;
        const ok = (r: any) => a.where.entitlementKey.in.includes(r.entitlementKey) && a.where.OR.some((o: any) =>
          (o.source?.in ? o.source.in.includes(r.source) : o.source === r.source) && (o.reason === undefined || o.reason === r.reason));
        return H.rows.filter((r) => r.tenantId === a.where.tenantId && ok(r));
      },
    },
  },
}));

import { getShopifyAuthorization } from "../lib/billing/shopify-authorization";

const row = (source: string, reason: string | null = null, key = "shopify_catalog_sync") => ({ tenantId: "T", entitlementKey: key, value: true, source, reason, expiresAt: null });

beforeEach(() => { H.rows = []; });

describe("the gate and the custom-app grant", () => {
  it("★ GOTCHA's custom-app grant opens it, reported as GOTCHA_CUSTOM_APP", async () => {
    H.rows = [row("ADDON", "shopify_custom_app")];
    expect(await getShopifyAuthorization("T")).toMatchObject({ authorized: true, source: "GOTCHA_CUSTOM_APP", capabilities: ["shopify_catalog_sync"] });
  });
  it("★ another ADDON row (another reason) does not", async () => {
    H.rows = [row("ADDON", "some promo"), row("ADDON", null)];
    expect(await getShopifyAuthorization("T")).toMatchObject({ authorized: false });
  });
  it("no row (OAuth alone): denied", async () => {
    expect(await getShopifyAuthorization("T")).toMatchObject({ authorized: false, reason: "no_shopify_funded_entitlement" });
  });
  it("Shopify's own sources outrank it when both exist", async () => {
    H.rows = [row("ADDON", "shopify_custom_app"), row("SHOPIFY_SUBSCRIPTION")];
    expect((await getShopifyAuthorization("T")).source).toBe("SHOPIFY_SUBSCRIPTION");
  });
});
