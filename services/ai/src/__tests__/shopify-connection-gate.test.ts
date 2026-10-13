/**
 * `loadConnection` is the Shopify credential boundary. This pins its contract:
 *
 *   data access     needs a NAMED capability that Shopify actually funded
 *   install/OAuth   works WITHOUT any entitlement, because Shopify App Review
 *                   requires install and OAuth to complete before a plan is
 *                   chosen on Shopify's hosted pricing page
 *   other providers are untouched
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ funded: new Set<string>(), rows: [] as any[] }));

const prismaMock = vi.hoisted(() => ({
  tenantIntegration: {
    findFirst: vi.fn(async ({ where }: any) => {
      const slug = where?.integration?.slug;
      return state.rows.find((r) => r.slug === slug) ?? null;
    }),
  },
}));

vi.mock("@chatcenter/shared", async (orig) => {
  const actual = (await orig()) as any;
  return {
    ...actual,
    prisma: prismaMock,
    decryptCredentials: (v: any) => (typeof v === "string" ? JSON.parse(v) : v),
    encryptCredentials: (v: any) => JSON.stringify(v),
    isShopifyAuthorized: vi.fn(async (_t: string, capability?: string) =>
      capability ? state.funded.has(capability) : state.funded.size > 0,
    ),
  };
});

import { loadConnection } from "../services/connectors/integration-framework";

const TENANT = "t1";

beforeEach(() => {
  state.funded = new Set();
  state.rows = [
    { id: "ti_shopify", slug: "shopify", status: "CONNECTED", credentials: { accessToken: "x" }, config: { shopDomain: "d.myshopify.com" } },
    { id: "ti_woo", slug: "woocommerce", status: "CONNECTED", credentials: { key: "k" }, config: {} },
  ];
});

describe("Shopify data access", () => {
  it("is denied when the named capability is not funded", async () => {
    state.funded = new Set(["shopify_catalog_sync"]);
    const conn = await loadConnection({ tenantId: TENANT, slug: "shopify", capability: "shopify_order_read" });
    expect(conn).toBeNull();
  });

  it("is allowed when the named capability IS funded", async () => {
    state.funded = new Set(["shopify_order_read"]);
    const conn = await loadConnection({ tenantId: TENANT, slug: "shopify", capability: "shopify_order_read" });
    expect(conn?.tenantIntegrationId).toBe("ti_shopify");
  });

  // The defect this whole change exists to fix: a funded row of ANY kind used
  // to unlock every Shopify path.
  it("one funded capability does not unlock another", async () => {
    state.funded = new Set(["shopify_storefront_widget"]);
    for (const asked of ["shopify_catalog_sync", "shopify_order_read", "shopify_order_actions"]) {
      expect(await loadConnection({ tenantId: TENANT, slug: "shopify", capability: asked as any })).toBeNull();
    }
  });

  it("is denied when NO capability is declared, even if Shopify is funded", async () => {
    state.funded = new Set(["shopify_catalog_sync", "shopify_order_read"]);
    expect(await loadConnection({ tenantId: TENANT, slug: "shopify" })).toBeNull();
  });

  it("is denied when nothing is funded at all", async () => {
    expect(
      await loadConnection({ tenantId: TENANT, slug: "shopify", capability: "shopify_catalog_sync" }),
    ).toBeNull();
  });
});

describe("install and OAuth survive with no entitlement", () => {
  it("purpose:install loads the connection with nothing funded", async () => {
    expect(state.funded.size).toBe(0);
    const conn = await loadConnection({ tenantId: TENANT, slug: "shopify", purpose: "install" });
    expect(conn?.tenantIntegrationId).toBe("ti_shopify");
  });

  it("purpose:install needs no capability argument", async () => {
    const conn = await loadConnection({ tenantId: TENANT, slug: "shopify", purpose: "install" });
    expect(conn).not.toBeNull();
  });
});

describe("non-Shopify providers are untouched", () => {
  it("WooCommerce loads with no Shopify entitlement and no capability", async () => {
    expect(state.funded.size).toBe(0);
    const conn = await loadConnection({ tenantId: TENANT, slug: "woocommerce" });
    expect(conn?.tenantIntegrationId).toBe("ti_woo");
  });

  it("WooCommerce is unaffected by a cancelled Shopify Connector", async () => {
    state.funded = new Set();
    expect(await loadConnection({ tenantId: TENANT, slug: "woocommerce" })).not.toBeNull();
    expect(
      await loadConnection({ tenantId: TENANT, slug: "shopify", capability: "shopify_catalog_sync" }),
    ).toBeNull();
  });
});
