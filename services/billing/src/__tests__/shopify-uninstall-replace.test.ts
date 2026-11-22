/**
 * App Review 132211 (2026-11-22), billing's side of a Shopify uninstall:
 *   - an OLD store's late app/uninstalled (after the workspace replaced it) never revokes the NEW store's
 *     Shopify-funded access;
 *   - a Replace spends the grandfather grant, so a newly attached store goes through Shopify Billing.
 * No provider is called; the database is a double (never a DATABASE_URL here).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  conns: [] as any[],
  ents: [] as any[],
  grants: [] as any[],
}));

vi.mock("@chatcenter/shared", async () => {
  const match = (r: any, w: any) => Object.entries(w ?? {}).every(([k, v]: [string, any]) =>
    v && typeof v === "object" && "not" in v ? r[k] !== v.not : r[k] === v);
  const prisma: any = {
    commerceConnection: {
      findUnique: async (a: any) => H.conns.find((c) => c.platform === a.where.platform_externalShopId.platform && c.externalShopId === a.where.platform_externalShopId.externalShopId) ?? null,
      findFirst: async (a: any) => H.conns.find((c) => match(c, a.where)) ?? null,
      update: async (a: any) => Object.assign(H.conns.find((c) => c.id === a.where.id), a.data),
    },
    providerSubscription: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    tenantEntitlement: {
      deleteMany: async (a: any) => {
        const gone = H.ents.filter((e) => e.tenantId === a.where.tenantId && e.source === a.where.source);
        H.ents = H.ents.filter((e) => !gone.includes(e));
        return { count: gone.length };
      },
    },
    shopifyGrandfatherGrant: {
      updateMany: async (a: any) => {
        const hit = H.grants.filter((g) => g.tenantId === a.where.tenantId && g.status === a.where.status);
        hit.forEach((g) => Object.assign(g, a.data));
        return { count: hit.length };
      },
    },
  };
  return { prisma, setTenantEntitlement: vi.fn() };
});

import { handleCommerceUninstall } from "../services/provider-subscription.service";

const ENTS = () => [
  { tenantId: "T", source: "SHOPIFY_SUBSCRIPTION", key: "shopify_catalog_sync" },
  { tenantId: "T", source: "SHOPIFY_GRANDFATHERED", key: "shopify_order_read" },
  { tenantId: "T", source: "GOTCHA_PLAN", key: "whatsapp" },
];

beforeEach(() => {
  H.conns = [{ id: "old", tenantId: "T", platform: "SHOPIFY", externalShopId: "111", status: "CONNECTED" }];
  H.ents = ENTS();
  H.grants = [{ tenantId: "T", status: "ACTIVE" }];
});

describe("an uninstall in a workspace that replaced its store", () => {
  it("the only store: its Shopify-funded access goes, the grant stays (a plain uninstall)", async () => {
    const r = await handleCommerceUninstall({ platform: "SHOPIFY" as any, externalShopId: "111" });
    expect(r).toMatchObject({ tenantId: "T", revoked: 2 });
    expect(H.ents.map((e) => e.source)).toEqual(["GOTCHA_PLAN"]);
    expect(H.grants[0].status).toBe("ACTIVE");
    expect(H.conns[0].status).toBe("DISCONNECTED");
  });

  it("★ the old store's late uninstall while the new store is live: the new store's access is kept", async () => {
    H.conns.push({ id: "new", tenantId: "T", platform: "SHOPIFY", externalShopId: "222", status: "CONNECTED" });
    const r = await handleCommerceUninstall({ platform: "SHOPIFY" as any, externalShopId: "111" });
    expect(r.revoked).toBe(0);
    expect(H.ents).toHaveLength(3);
    expect(H.conns.find((c) => c.id === "new").status).toBe("CONNECTED");
  });

  it("another workspace's live store does not count", async () => {
    H.conns.push({ id: "theirs", tenantId: "OTHER", platform: "SHOPIFY", externalShopId: "333", status: "CONNECTED" });
    expect((await handleCommerceUninstall({ platform: "SHOPIFY" as any, externalShopId: "111" })).revoked).toBe(2);
  });

  it("★ a Replace: access revoked and the grandfather grant spent, with its reason", async () => {
    const r = await handleCommerceUninstall({ platform: "SHOPIFY" as any, externalShopId: "111", replaced: true });
    expect(r).toMatchObject({ revoked: 2, grantRevoked: true });
    expect(H.grants[0]).toMatchObject({ status: "REVOKED", revokedReason: "store_replaced", revokedBy: "system:store-replaced" });
    expect(H.grants[0].revokedAt).toBeInstanceOf(Date);
  });

  it("a Replace with no grant: nothing to spend", async () => {
    H.grants = [];
    expect((await handleCommerceUninstall({ platform: "SHOPIFY" as any, externalShopId: "111", replaced: true })).grantRevoked).toBe(false);
  });
});
