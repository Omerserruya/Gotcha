/**
 * Commerce-context cache behavior (spec §9) + webhook-driven invalidation
 * (spec §12 test 25). The panel/AI snapshot serve a short cache; a Shopify
 * order-change event drops it so the next read reflects verified new state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();
const loadConnMock = vi.fn();
const resolveIdentityMock = vi.fn();

vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: (...a: any[]) => execMock(...a),
  loadConnection: (...a: any[]) => loadConnMock(...a),
}));
vi.mock("../services/connectors/customer-access-guard", () => ({
  resolveRequesterIdentity: (...a: any[]) => resolveIdentityMock(...a),
}));

import { buildCommerceContextResponse, invalidateCommerceCache } from "../services/commerce-context.service";
import { handleCommerceCacheEvent } from "../services/commerce-cache-subscriber";

const PERMS = { canRead: true, canOpen: true, canCancel: true, canRefund: true, canReturn: true, canTag: true, canNote: true, canNotify: true };
const ORDERS = [
  { id: 5001, name: "#1246", created_at: "2026-07-18T10:00:00Z", currency: "USD", total_price: "120.00",
    financial_status: "paid", fulfillment_status: null, cancelled_at: null,
    line_items: [{ id: 1, title: "Nike Cryptokicks", quantity: 1 }], refunds: [], customer: { id: 999 } },
];

beforeEach(() => {
  execMock.mockReset(); loadConnMock.mockReset(); resolveIdentityMock.mockReset();
  invalidateCommerceCache({ tenantId: "tCACHE" }); // clean slate for this tenant
  loadConnMock.mockResolvedValue({
    tenantIntegrationId: "ti", credentials: {}, status: "CONNECTED", expiresAt: null,
    config: { shopDomain: "s.myshopify.com", grantedScopes: ["read_orders", "write_orders"] },
  });
  resolveIdentityMock.mockResolvedValue({
    phoneSuffixes: new Set(), emails: new Set(), customerIds: new Set(["999"]),
    conversationId: "conv1", channelSenderId: "+1",
  });
  execMock.mockImplementation(async ({ toolFunctionName }: any) => {
    if (toolFunctionName === "shopify.summarize_customer") return { ok: true, result: { customer: { orders_count: 1, total_spent: "120.00", currency: "USD" } } };
    if (toolFunctionName === "shopify.get_customer_orders") return { ok: true, result: ORDERS };
    return { ok: false, reason: "x" };
  });
});

describe("short cache", () => {
  it("a second read within TTL does NOT hit Shopify again", async () => {
    await buildCommerceContextResponse({ tenantId: "tCACHE", conversationId: "conv1", perms: PERMS });
    const callsAfterFirst = execMock.mock.calls.length;
    await buildCommerceContextResponse({ tenantId: "tCACHE", conversationId: "conv1", perms: PERMS });
    expect(execMock.mock.calls.length).toBe(callsAfterFirst); // served from cache
  });

  it("forceRefresh bypasses the cache", async () => {
    await buildCommerceContextResponse({ tenantId: "tCACHE", conversationId: "conv1", perms: PERMS });
    const callsAfterFirst = execMock.mock.calls.length;
    await buildCommerceContextResponse({ tenantId: "tCACHE", conversationId: "conv1", perms: PERMS, forceRefresh: true });
    expect(execMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

describe("25. webhook-driven invalidation", () => {
  it("a shopify.order.changed event drops the cache → next read re-fetches", async () => {
    await buildCommerceContextResponse({ tenantId: "tCACHE", conversationId: "conv1", perms: PERMS });
    const callsAfterFirst = execMock.mock.calls.length;

    const dropped = handleCommerceCacheEvent({ event: "shopify.order.changed", tenantId: "tCACHE", data: {} });
    expect(dropped).toBeGreaterThan(0);

    await buildCommerceContextResponse({ tenantId: "tCACHE", conversationId: "conv1", perms: PERMS });
    expect(execMock.mock.calls.length).toBeGreaterThan(callsAfterFirst); // re-fetched
  });

  it("different viewer permissions do NOT share a cache entry (capabilities are per-viewer)", async () => {
    const reader = { canRead: true, canOpen: true, canCancel: false, canRefund: false, canReturn: false, canTag: false, canNote: false, canNotify: false };
    const manager = { canRead: true, canOpen: true, canCancel: true, canRefund: true, canReturn: true, canTag: true, canNote: true, canNotify: true };
    const a = await buildCommerceContextResponse({ tenantId: "tCACHE", conversationId: "conv1", perms: reader });
    const b = await buildCommerceContextResponse({ tenantId: "tCACHE", conversationId: "conv1", perms: manager });
    if (a.state !== "ok" || b.state !== "ok") throw new Error(`${a.state}/${b.state}`);
    expect(a.data.capabilities.canCancel).toBe(false); // reader sees no cancel
    expect(b.data.capabilities.canCancel).toBe(true); // manager does - not the reader's cached value
  });

  it("an unrelated event does NOT invalidate", () => {
    const dropped = handleCommerceCacheEvent({ event: "message:new", tenantId: "tCACHE", data: {} });
    expect(dropped).toBe(0);
  });

  it("invalidation is tenant-scoped (another tenant's cache is untouched)", async () => {
    await buildCommerceContextResponse({ tenantId: "tCACHE", conversationId: "conv1", perms: PERMS });
    const n = handleCommerceCacheEvent({ event: "shopify.order.changed", tenantId: "tOTHER", data: {} });
    expect(n).toBe(0); // nothing cached for tOTHER
  });
});
