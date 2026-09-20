/**
 * Binding a verified store to a workspace: ownership and idempotency.
 *
 * The lifecycle cases this has to get right are the ones that only show up
 * over time - reinstall after uninstall, a second workspace reaching for a
 * store that is already taken, and reconnecting to grant a scope. Each of
 * those is a chance to either duplicate a connection row or silently move a
 * merchant's storefront to someone else's workspace.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.CHANNEL_ENCRYPTION_KEY = "0".repeat(64);
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    /** Every shopify TenantIntegration row in the fake database. */
    rows: [] as any[],
    upsertCalls: [] as any[],
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withCrossTenantAccess: async (fn: any) => await fn(),
    prisma: {
      tenantIntegration: {
        findMany: vi.fn(async () => H.rows),
        // The one-store-per-workspace check reads the caller's OWN row, so the
        // mock has to model the real unique key on (tenantId, integrationId)
        // rather than return the first Shopify row it finds - otherwise every
        // workspace would look as though it already held some other tenant's
        // store, and the replacement question would fire on a first install.
        findUnique: vi.fn(async ({ where }: any) => {
          const { tenantId, integrationId } = where.tenantId_integrationId;
          const row = H.rows.find(
            (r: any) => r.tenantId === tenantId && r.integrationId === integrationId,
          );
          // Default CONNECTED so existing cases are unchanged; a test that
          // cares sets `status` on the row explicitly.
          return row ? { status: "CONNECTED", ...row } : null;
        }),
      },
    },
  };
});

vi.mock("../services/connector-connection.service", () => ({
  findCatalog: vi.fn(async () => ({ id: "cat-shopify" })),
  upsertConnection: vi.fn(async (opts: any) => {
    H.upsertCalls.push(opts);
    // Model the real unique constraint: one row per (tenant, integration).
    const existing = H.rows.find(
      (r) => r.tenantId === opts.tenantId && r.integrationId === "cat-shopify",
    );
    if (existing) {
      existing.status = opts.status;
      existing.config = { ...(existing.config || {}), ...(opts.config || {}) };
      return existing;
    }
    const row = {
      id: `conn-${H.rows.length + 1}`,
      tenantId: opts.tenantId,
      integrationId: "cat-shopify",
      status: opts.status,
      config: opts.config || {},
    };
    H.rows.push(row);
    return row;
  }),
}));

vi.mock("../services/connectors/integration-framework", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    refreshCapabilityState: vi.fn(async () => ({ missingScopes: [] })),
  };
});

vi.mock("../services/tool-permission-reconcile.service", () => ({
  reconcileAgentToolPermissions: vi.fn(async () => ({ added: [] })),
}));

import {
  linkShopifyShopToTenant,
  pendingStoreReplacement,
  findShopOwner,
  SHOPIFY_OAUTH_SCOPES,
} from "../services/shopify-connection-link.service";

const SHOP = "urban-supply-dev.myshopify.com";
const CREDS = { accessToken: "shpat_secret", scope: "read_orders" };

beforeEach(() => {
  H.rows.length = 0;
  H.upsertCalls.length = 0;
  vi.clearAllMocks();
});

describe("SHOPIFY_OAUTH_SCOPES", () => {
  it("is one comma-joined string with no whitespace Shopify would reject", () => {
    expect(SHOPIFY_OAUTH_SCOPES).not.toMatch(/\s/);
    expect(SHOPIFY_OAUTH_SCOPES.split(",").length).toBeGreaterThan(5);
  });

  it("still requests the scopes whose absence caused live failures", () => {
    // Each of these is here because a tool failed on a real store without it.
    for (const scope of [
      "write_order_edits",
      "write_returns",
      "read_merchant_managed_fulfillment_orders",
      "write_customers",
      "read_all_orders",
    ]) {
      expect(SHOPIFY_OAUTH_SCOPES.split(","), scope).toContain(scope);
    }
  });
});

describe("findShopOwner", () => {
  it("finds the owner regardless of how the stored domain was written", () => {
    H.rows.push({ id: "c1", tenantId: "t1", status: "CONNECTED", config: { shopDomain: `https://${SHOP}/admin` } });
    return expect(findShopOwner(SHOP)).resolves.toMatchObject({ tenantId: "t1" });
  });

  it("still reports ownership for a DISCONNECTED row", async () => {
    // An uninstall clears the token but keeps ownership. If this returned null
    // a second workspace could claim the store the moment the first uninstalled.
    H.rows.push({ id: "c1", tenantId: "t1", status: "DISCONNECTED", config: { shopDomain: SHOP } });
    await expect(findShopOwner(SHOP)).resolves.toMatchObject({ tenantId: "t1", status: "DISCONNECTED" });
  });

  it("is null for an unconnected shop and for a malformed one", async () => {
    await expect(findShopOwner(SHOP)).resolves.toBeNull();
    await expect(findShopOwner("evil.com")).resolves.toBeNull();
  });
});

describe("linkShopifyShopToTenant", () => {
  it("creates the connection on a first install", async () => {
    const r = await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    expect(r).toMatchObject({ ok: true, reconnected: false });
    expect(H.rows).toHaveLength(1);
    expect(H.rows[0]).toMatchObject({ tenantId: "t1", status: "CONNECTED" });
  });

  it("stores the shop domain in the config, canonicalized", async () => {
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: `HTTPS://${SHOP.toUpperCase()}/`, credentials: CREDS });
    expect(H.upsertCalls[0].config).toEqual({ shopDomain: SHOP });
  });

  it("ENCRYPTS the token - the raw value never reaches the persistence layer", async () => {
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    const blob = H.upsertCalls[0].credentialsBlob;
    expect(typeof blob).toBe("string");
    expect(blob).not.toContain("shpat_secret");
  });

  it("is IDEMPOTENT: reconnecting the same store to the same workspace makes no second row", async () => {
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    const second = await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    expect(second).toMatchObject({ ok: true, reconnected: true });
    expect(H.rows).toHaveLength(1);
    expect(H.rows[0].id).toBe("conn-1");
  });

  it("survives uninstall then REINSTALL, in the same workspace, with one row", async () => {
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    // The uninstall webhook's effect: DISCONNECTED, credentials cleared,
    // ownership and shopDomain retained.
    H.rows[0].status = "DISCONNECTED";

    const again = await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    expect(again).toMatchObject({ ok: true, reconnected: true });
    expect(H.rows).toHaveLength(1);
    expect(H.rows[0].status).toBe("CONNECTED");
  });

  it("REFUSES a store owned by another workspace and changes nothing", async () => {
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    H.upsertCalls.length = 0;

    const stolen = await linkShopifyShopToTenant({ tenantId: "t2", shopDomain: SHOP, credentials: CREDS });
    expect(stolen).toEqual({ ok: false, reason: "shop_taken", conflictingTenantId: "t1" });
    // Not moved, not copied.
    expect(H.upsertCalls).toHaveLength(0);
    expect(H.rows).toHaveLength(1);
    expect(H.rows[0].tenantId).toBe("t1");
  });

  it("refuses to move an UNINSTALLED store to a different workspace either", async () => {
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    H.rows[0].status = "DISCONNECTED";
    const stolen = await linkShopifyShopToTenant({ tenantId: "t2", shopDomain: SHOP, credentials: CREDS });
    expect(stolen).toMatchObject({ ok: false, reason: "shop_taken" });
  });

  it("lets two DIFFERENT stores connect to two different workspaces", async () => {
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    const other = await linkShopifyShopToTenant({
      tenantId: "t2",
      shopDomain: "second-store.myshopify.com",
      credentials: CREDS,
    });
    expect(other).toMatchObject({ ok: true });
    expect(H.rows).toHaveLength(2);
  });

  it("refuses a malformed shop before touching the database", async () => {
    const r = await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: "evil.com", credentials: CREDS });
    expect(r).toEqual({ ok: false, reason: "shop_invalid" });
    expect(H.upsertCalls).toHaveLength(0);
  });
});

// ─── One store per workspace ─────────────────────────────────────────────

describe("replacing the workspace's existing store", () => {
  // `tenantIntegration` is unique on (tenantId, integrationId), so a workspace
  // holds at most one Shopify store and connecting a second one necessarily
  // overwrites the first.
  //
  // That used to be silent. The row's shopDomain and token were replaced, the
  // old store kept the app installed on Shopify's side, and every AI answer
  // began reading a different catalogue - while the merchant was shown
  // "Connected" exactly as they would be for a first install. Nobody was asked,
  // and nothing recorded which store had just been dropped.

  const OTHER = "second-store.myshopify.com";

  async function connectFirst() {
    const r = await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    expect(r.ok).toBe(true);
    H.upsertCalls.length = 0;
  }

  it("REFUSES a different store when replacement was not authorized", async () => {
    await connectFirst();
    const r = await linkShopifyShopToTenant({
      tenantId: "t1",
      shopDomain: OTHER,
      credentials: CREDS,
    });
    expect(r).toEqual({
      ok: false,
      reason: "another_store_connected",
      currentShopDomain: SHOP,
    });
    // The decisive assertion: nothing was written, so the store the workspace
    // had is still the store it has.
    expect(H.upsertCalls).toHaveLength(0);
    expect(H.rows.find((r: any) => r.tenantId === "t1").config.shopDomain).toBe(SHOP);
  });

  it("replaces it when the merchant authorized that, and says which", async () => {
    await connectFirst();
    const r = await linkShopifyShopToTenant({
      tenantId: "t1",
      shopDomain: OTHER,
      credentials: CREDS,
      allowReplace: true,
    });
    expect(r.ok).toBe(true);
    expect((r as any).replacedShopDomain).toBe(SHOP);
    expect(H.upsertCalls).toHaveLength(1);
    expect(H.rows.find((r: any) => r.tenantId === "t1").config.shopDomain).toBe(OTHER);
  });

  it("still makes no second row - the replacement is an update", async () => {
    await connectFirst();
    const before = H.rows.filter((r: any) => r.tenantId === "t1").length;
    await linkShopifyShopToTenant({
      tenantId: "t1",
      shopDomain: OTHER,
      credentials: CREDS,
      allowReplace: true,
    });
    expect(H.rows.filter((r: any) => r.tenantId === "t1")).toHaveLength(before);
  });

  it("does NOT treat the same store reconnecting as a replacement", async () => {
    // Reinstall and reauthorization must stay ordinary updates. If this
    // regressed, every reconnect would demand a confirmation the merchant has
    // no reason to expect.
    await connectFirst();
    const r = await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    expect(r.ok).toBe(true);
    expect((r as any).replacedShopDomain).toBeUndefined();
    expect(H.upsertCalls).toHaveLength(1);
  });

  it("checks ownership of the INCOMING store before asking about replacement", async () => {
    // Order matters. A store held by ANOTHER workspace must report
    // `shop_taken`, not invite this workspace to "replace" its own store with
    // one it may not have - answering yes would then still fail, after the
    // merchant had agreed to disconnect something.
    await connectFirst();
    await linkShopifyShopToTenant({ tenantId: "t2", shopDomain: OTHER, credentials: CREDS });
    const r = await linkShopifyShopToTenant({
      tenantId: "t1",
      shopDomain: OTHER,
      credentials: CREDS,
      allowReplace: true,
    });
    expect(r).toMatchObject({ ok: false, reason: "shop_taken" });
  });
});

describe("a DISCONNECTED store is not a store this workspace holds", () => {
  // Production has exactly this shape: the demo workspace carries a
  // DISCONNECTED Shopify row from an old uninstall. Counting it would ask
  // anyone connecting a store there to "replace" a store that is not
  // connected, naming it on screen - on the page an App Store reviewer reads.

  it("lets a workspace whose store was uninstalled connect a different one", async () => {
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    const row = H.rows.find((r: any) => r.tenantId === "t1");
    row.status = "DISCONNECTED";

    // No replacement is pending, so no confirmation is demanded.
    expect(await pendingStoreReplacement("t1", "brand-new.myshopify.com")).toBeNull();

    const r = await linkShopifyShopToTenant({
      tenantId: "t1",
      shopDomain: "brand-new.myshopify.com",
      credentials: CREDS,
    });
    expect(r.ok).toBe(true);
    expect((r as any).replacedShopDomain).toBeUndefined();
  });

  it("but the shop still cannot be taken by ANOTHER workspace", async () => {
    // Ownership is deliberately retained across an uninstall so a reinstall
    // lands back in the same workspace. That must not be weakened by the above.
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    H.rows.find((r: any) => r.tenantId === "t1").status = "DISCONNECTED";

    const stolen = await linkShopifyShopToTenant({
      tenantId: "t2",
      shopDomain: SHOP,
      credentials: CREDS,
    });
    expect(stolen).toMatchObject({ ok: false, reason: "shop_taken" });
  });
});

describe("pendingStoreReplacement", () => {
  // The question the claim route asks BEFORE it spends its single-use handle.

  it("names the store that would be replaced", async () => {
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    expect(await pendingStoreReplacement("t1", "second-store.myshopify.com")).toBe(SHOP);
  });

  it("is null for the same store, and for a workspace with none", async () => {
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    expect(await pendingStoreReplacement("t1", SHOP)).toBeNull();
    expect(await pendingStoreReplacement("t-empty", SHOP)).toBeNull();
  });

  it("is null for an unparseable incoming domain rather than throwing", async () => {
    await linkShopifyShopToTenant({ tenantId: "t1", shopDomain: SHOP, credentials: CREDS });
    expect(await pendingStoreReplacement("t1", "evil.com")).toBeNull();
  });
});
