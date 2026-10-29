/**
 * ai and billing agree on what "this store is taken" means (2026-10-29).
 *   - findShopOwner prefers the live row when a store has a DISCONNECTED row in
 *     one workspace and a live one in another;
 *   - shopHeldElsewhere blocks only another workspace's row that is not
 *     DISCONNECTED (an ERROR row is still an installed store);
 *   - linkShopifyShopToTenant refuses on a live row elsewhere and proceeds past
 *     a DISCONNECTED one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ rows: [] as any[], upserts: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withCrossTenantAccess: async (fn: any) => fn(),
    prisma: { tenantIntegration: { findMany: async () => H.rows, findUnique: async () => null, findFirst: async () => null, update: async (a: any) => ({ id: a.where.id }) } },
    encryptCredentials: () => ({ enc: true }),
  };
});
vi.mock("../services/connector-connection.service", () => ({
  findCatalog: async () => ({ id: "cat_shopify" }),
  upsertConnection: async (a: any) => { H.upserts.push(a); return { id: "ti_new" }; },
}));

import { findShopOwner, shopHeldElsewhere, linkShopifyShopToTenant } from "../services/shopify-connection-link.service";

const SHOP = "shining-face-drgeqqoi.myshopify.com";
const row = (tenantId: string, status: string) => ({ id: `ti_${tenantId}`, tenantId, status, config: { shopDomain: SHOP } });

beforeEach(() => { H.rows = []; H.upserts = []; });

describe("findShopOwner", () => {
  it("prefers the live row over a DISCONNECTED one, in either order", async () => {
    H.rows = [row("gotcha", "DISCONNECTED"), row("urban", "CONNECTED")];
    expect((await findShopOwner(SHOP))?.tenantId).toBe("urban");
    H.rows = [row("urban", "CONNECTED"), row("gotcha", "DISCONNECTED")];
    expect((await findShopOwner(SHOP))?.tenantId).toBe("urban");
  });
  it("still returns a DISCONNECTED owner when it is the only row", async () => {
    H.rows = [row("gotcha", "DISCONNECTED")];
    expect(await findShopOwner(SHOP)).toMatchObject({ tenantId: "gotcha", status: "DISCONNECTED" });
  });
});

describe("shopHeldElsewhere", () => {
  it.each([
    [null, false],
    [{ tenantId: "me", status: "CONNECTED" }, false],
    [{ tenantId: "other", status: "DISCONNECTED" }, false],
    [{ tenantId: "other", status: "CONNECTED" }, true],
    [{ tenantId: "other", status: "ERROR" }, true],
    [{ tenantId: "other", status: "PENDING" }, true],
  ])("%j → %s", (owner, held) => {
    expect(shopHeldElsewhere(owner as any, "me")).toBe(held);
  });
});

describe("linkShopifyShopToTenant", () => {
  const link = () => linkShopifyShopToTenant({ tenantId: "urban", shopDomain: SHOP, credentials: { accessToken: "t" } as any });
  it("refuses on a live row elsewhere, writes nothing", async () => {
    H.rows = [row("gotcha", "CONNECTED")];
    expect(await link()).toMatchObject({ ok: false, reason: "shop_taken" });
    expect(H.upserts).toHaveLength(0);
  });
  it("proceeds past a DISCONNECTED row elsewhere", async () => {
    H.rows = [row("gotcha", "DISCONNECTED")];
    const r = await link();
    expect(r.ok).toBe(true);
    expect(H.upserts[0]).toMatchObject({ tenantId: "urban", status: "CONNECTED" });
  });
});
