/**
 * The Shopify entitlement gate runs for a workspace that HAS Shopify (2026-11-02:
 * a WooCommerce-only workspace logged "shopify access denied" on every turn).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ row: null as any, funded: false, checks: 0 }));
vi.mock("@chatcenter/shared", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  isShopifyAuthorized: async () => { H.checks++; return H.funded; },
  decryptCredentials: () => ({ accessToken: "x" }),
  prisma: { tenantIntegration: { findFirst: async () => H.row } },
}));

import { loadConnection } from "../services/connectors/integration-framework";

beforeEach(() => { H.row = null; H.funded = false; H.checks = 0; });

describe("loadConnection for Shopify data", () => {
  it("no Shopify connection: null, quietly, without asking about funding", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await loadConnection({ tenantId: "T", slug: "shopify", capability: "shopify_order_read" as any })).toBeNull();
    expect(H.checks).toBe(0);
    expect(info.mock.calls.flat().join(" ")).not.toMatch(/access denied/);
    info.mockRestore();
  });

  it("connected but not funded: still denied", async () => {
    H.row = { id: "ti1", status: "CONNECTED", credentials: "enc", config: {} };
    expect(await loadConnection({ tenantId: "T", slug: "shopify", capability: "shopify_order_read" as any })).toBeNull();
    expect(H.checks).toBe(1);
  });

  it("connected and funded: loaded", async () => {
    H.row = { id: "ti1", status: "CONNECTED", credentials: "enc", config: {} };
    H.funded = true;
    expect(await loadConnection({ tenantId: "T", slug: "shopify", capability: "shopify_order_read" as any })).toMatchObject({ tenantIntegrationId: "ti1" });
  });

  it("no capability named: denied even when connected", async () => {
    H.row = { id: "ti1", status: "CONNECTED", credentials: "enc", config: {} };
    H.funded = true;
    expect(await loadConnection({ tenantId: "T", slug: "shopify" })).toBeNull();
  });
});
