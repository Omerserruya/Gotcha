/**
 * Disconnecting must remove the TENANT'S tool assignments, and nothing else.
 *
 * FOUND IN PRODUCTION. Two teardown paths had drifted: the in-product
 * "Disconnect" route deleted the tenant's tool assignments, the verified
 * `app/uninstalled` webhook did not. A merchant who uninstalled from Shopify
 * Admin - the path Shopify's own reviewers use - kept 68 tenant tool rows for
 * a store that no longer existed.
 *
 * THE DANGEROUS NEIGHBOUR
 * On the workspace where this was found, `tenant_tools` for that tenant and
 * `catalog_tools` globally BOTH held exactly 68 Shopify rows. Deleting from
 * the wrong one would have removed Shopify's tools for every tenant in the
 * installation. Several tests below exist purely to pin that distinction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteMany = vi.fn();
vi.mock("@chatcenter/shared", () => ({
  prisma: { tenantTool: { deleteMany: (...a: unknown[]) => deleteMany(...a) } },
}));

import {
  removeTenantToolAssignments,
  stripLiveConnectionClaims,
} from "../services/connectors/integration-teardown";

beforeEach(() => {
  deleteMany.mockReset().mockResolvedValue({ count: 68 });
});

describe("it deletes the tenant's assignments", () => {
  it("removes them and reports how many", async () => {
    const r = await removeTenantToolAssignments({ tenantId: "t1", tenantIntegrationId: "ti1" });
    expect(r).toEqual({ removed: 68 });
  });

  it("targets tenant_tools, NOT the global catalog", async () => {
    await removeTenantToolAssignments({ tenantId: "t1", tenantIntegrationId: "ti1" });
    // If this ever becomes catalogTool.deleteMany, every tenant loses Shopify.
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("scopes by BOTH tenant and integration", async () => {
    await removeTenantToolAssignments({ tenantId: "t1", tenantIntegrationId: "ti1" });
    const where = deleteMany.mock.calls[0][0].where;
    // Tenant alone would take this tenant's OTHER providers' tools.
    expect(where.tenantId).toBe("t1");
    // Integration alone would reach across tenants.
    expect(where.tenantIntegrationId).toBe("ti1");
    expect(Object.keys(where).sort()).toEqual(["tenantId", "tenantIntegrationId"]);
  });

  it("cannot touch another tenant's rows", async () => {
    await removeTenantToolAssignments({ tenantId: "t1", tenantIntegrationId: "ti1" });
    const where = deleteMany.mock.calls[0][0].where;
    expect(where.tenantId).not.toBeUndefined();
    expect(where.tenantId).not.toBeNull();
  });

  it("cannot touch another provider's rows for the same tenant", async () => {
    await removeTenantToolAssignments({ tenantId: "t1", tenantIntegrationId: "ti1" });
    expect(deleteMany.mock.calls[0][0].where.tenantIntegrationId).not.toBeUndefined();
  });
});

describe("it is idempotent, so a duplicate webhook is safe", () => {
  it("a second run finds nothing and does not fail", async () => {
    deleteMany.mockResolvedValueOnce({ count: 68 }).mockResolvedValueOnce({ count: 0 });
    const first = await removeTenantToolAssignments({ tenantId: "t1", tenantIntegrationId: "ti1" });
    const second = await removeTenantToolAssignments({ tenantId: "t1", tenantIntegrationId: "ti1" });
    expect(first.removed).toBe(68);
    expect(second.removed).toBe(0);
  });

  it("survives a driver that reports no count at all", async () => {
    deleteMany.mockResolvedValue({});
    const r = await removeTenantToolAssignments({ tenantId: "t1", tenantIntegrationId: "ti1" });
    expect(r).toEqual({ removed: 0 });
  });
});

describe("stripLiveConnectionClaims keeps history, drops live claims", () => {
  const config = {
    shopDomain: "new-for-test.myshopify.com",
    shopCurrency: "USD",
    useAsCrm: true,
    capabilityState: { status: "ok", grantedScopes: ["read_orders"] },
    catalogFacets: { vendors: ["x"] },
    uninstallRequestedAt: "2026-09-30T10:19:20.000Z",
  };

  it("drops everything that asserts the connection is live", () => {
    const out = stripLiveConnectionClaims(config);
    for (const k of ["useAsCrm", "capabilityState", "catalogFacets", "uninstallRequestedAt"]) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it("keeps which store it was - that is history the screens label disconnected", () => {
    const out = stripLiveConnectionClaims(config);
    expect(out.shopDomain).toBe("new-for-test.myshopify.com");
    expect(out.shopCurrency).toBe("USD");
  });

  it("does not mutate the caller's object", () => {
    const copy = { ...config };
    stripLiveConnectionClaims(config);
    expect(config).toEqual(copy);
  });

  it("handles a null or missing config", () => {
    expect(stripLiveConnectionClaims(null)).toEqual({});
    expect(stripLiveConnectionClaims(undefined)).toEqual({});
  });
});

/**
 * BOTH teardown paths must call the shared cleanup.
 *
 * The unit tests above prove the function is correct. They would all have
 * passed while the webhook never called it, which is exactly how 68 rows
 * survived an uninstall. These read the source and fail by name if either
 * path stops calling it.
 */
describe("both paths use the shared teardown", () => {
  const read = (p: string) =>
    require("fs").readFileSync(require("path").join(process.cwd(), p), "utf8");

  it("the verified app/uninstalled webhook removes tool assignments", () => {
    const src = read("src/routes/shopify-webhooks.ts");
    expect(src).toMatch(/removeTenantToolAssignments\(/);
  });

  it("the in-product disconnect route removes tool assignments", () => {
    const src = read("src/routes/integrations.ts");
    expect(src).toMatch(/removeTenantToolAssignments\(/);
  });

  it("neither path deletes tenant tools by hand any more", () => {
    // Two hand-rolled deletions are how they drifted the first time.
    for (const p of ["src/routes/shopify-webhooks.ts", "src/routes/integrations.ts"]) {
      expect(read(p)).not.toMatch(/tenantTool\.deleteMany/);
    }
  });

  it("neither path strips config by hand any more", () => {
    for (const p of ["src/routes/shopify-webhooks.ts", "src/routes/integrations.ts"]) {
      expect(read(p)).not.toMatch(/delete\s+\w+\.capabilityState/);
    }
  });
});
