/**
 * App Review 132211 (2026-11-22): replacing a workspace's Shopify store retires the OLD one completely,
 * in order, before the new one is attached (shopify-store-replace.service), and the uninstall's own
 * steps touch only THIS workspace's row (completeShopifyUninstall with replacedBy).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  order: [] as string[],
  shopifyAnswer: { ok: true, state: "awaiting_webhook", shopDomain: "old.myshopify.com" } as any,
  notified: [] as any[],
  rows: [] as any[],
  updates: [] as any[],
  toolsRemoved: [] as any[],
}));

vi.mock("../services/connectors/shopify-self-uninstall.service", () => ({
  requestShopifySelfUninstall: vi.fn(async () => { H.order.push("shopify"); return H.shopifyAnswer; }),
}));
vi.mock("../services/shopify-billing-bridge.service", () => ({
  notifyShopifyUninstalled: vi.fn(async (i: any) => { H.order.push("billing"); H.notified.push(i); }),
}));
vi.mock("../services/shopify-chat-install.service", () => ({
  releaseReplacedStoreChat: vi.fn(async () => { H.order.push("chat"); return { released: true }; }),
  disableChatForUninstalledShop: vi.fn(async () => { H.order.push("chat-off"); return { disabled: true }; }),
  markUninstalledByShop: vi.fn(),
  findLatestInstallation: vi.fn(),
}));
vi.mock("../services/connectors/integration-teardown", () => ({
  removeTenantToolAssignments: vi.fn(async (i: any) => { H.order.push("tools"); H.toolsRemoved.push(i); return { removed: 3 }; }),
  stripLiveConnectionClaims: (c: any) => ({ shopDomain: c?.shopDomain }),
}));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig<any>()),
  withCrossTenantAccess: (fn: any) => fn(),
  prisma: {
    tenantIntegration: {
      findMany: async () => H.rows,
      update: async (a: any) => { H.order.push("row"); H.updates.push(a); return {}; },
    },
  },
}));

import { retireReplacedStore } from "../services/shopify-store-replace.service";
import { completeShopifyUninstall } from "../routes/shopify-webhooks";

beforeEach(() => {
  H.order = []; H.notified = []; H.updates = []; H.toolsRemoved = [];
  H.shopifyAnswer = { ok: true, state: "awaiting_webhook", shopDomain: "old.myshopify.com" };
  H.rows = [
    { id: "mine", tenantId: "T", status: "CONNECTED", config: { shopDomain: "old.myshopify.com" } },
    { id: "theirs", tenantId: "OTHER", status: "DISCONNECTED", config: { shopDomain: "old.myshopify.com" } },
  ];
});

describe("retiring the replaced store", () => {
  it("★ connected: uninstalled at Shopify FIRST (its own token is still on the row), then billing, the row, tools, chat", async () => {
    const r = await retireReplacedStore({ tenantId: "T", shopDomain: "old.myshopify.com", connected: true });
    expect(H.order).toEqual(["shopify", "billing", "row", "tools", "chat-off", "chat"]);
    expect(H.notified).toEqual([{ externalShopId: null, shopDomain: "old.myshopify.com", replaced: true, tenantId: "T" }]);
    expect(H.updates[0]).toMatchObject({ where: { id: "mine" }, data: { status: "DISCONNECTED", credentials: {} } });
    expect(H.toolsRemoved).toEqual([{ tenantId: "T", tenantIntegrationId: "mine" }]);
    expect(r).toMatchObject({ shopDomain: "old.myshopify.com", shopify: { ok: true } });
  });

  it("Shopify refuses (the token is already dead): our side is still cleaned", async () => {
    H.shopifyAnswer = { ok: false, reason: "shopify_refused" };
    await retireReplacedStore({ tenantId: "T", shopDomain: "old.myshopify.com", connected: true });
    expect(H.order).toEqual(["shopify", "billing", "row", "tools", "chat-off", "chat"]);
  });

  it("★ already uninstalled: nothing asked of Shopify; billing spends the grant for this workspace; the chat leftovers go", async () => {
    const r = await retireReplacedStore({ tenantId: "T", shopDomain: "old.myshopify.com", connected: false });
    expect(H.order).toEqual(["billing", "chat"]);
    expect(H.notified).toEqual([{ shopDomain: "old.myshopify.com", replaced: true, tenantId: "T" }]);
    expect(r.shopify).toBeNull();
  });
});

describe("the uninstall's steps on a Replace touch only this workspace", () => {
  it("★ another workspace's row for the same domain is never touched", async () => {
    H.rows = [{ id: "theirs", tenantId: "OTHER", status: "CONNECTED", config: { shopDomain: "old.myshopify.com" } }];
    const r = await completeShopifyUninstall({ shopDomain: "old.myshopify.com", body: {}, replacedBy: { tenantId: "T" } });
    expect(H.updates).toEqual([]);
    expect(H.toolsRemoved).toEqual([]);
    expect(r.tenantId).toBeNull();
  });

  it("a real app/uninstalled (no replacedBy) is unchanged: the shop's live row, whoever holds it", async () => {
    H.rows = [{ id: "theirs", tenantId: "OTHER", status: "CONNECTED", config: { shopDomain: "old.myshopify.com" } }];
    const r = await completeShopifyUninstall({ shopDomain: "old.myshopify.com", body: { id: 99 } });
    expect(H.updates[0]).toMatchObject({ where: { id: "theirs" } });
    expect(H.notified).toEqual([{ externalShopId: "99", shopDomain: "old.myshopify.com" }]);
    expect(r.tenantId).toBe("OTHER");
  });
});
