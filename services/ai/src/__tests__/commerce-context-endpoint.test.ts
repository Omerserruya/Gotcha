/**
 * buildCommerceContextResponse - the human-panel read projection. The context
 * customer is resolved ONLY from the trusted linkage; connection/link/scope
 * states are explicit; order counts and totals come from verified Shopify.
 *
 * Covers spec §12 tests: 1 (appears when connected+linked), 2 (hidden when not
 * connected), 3/4 (another customer / typed input can't set the customer),
 * 5 (order count), 6 (total spent), 13 (no orders honest state).
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

const PERMS = { canRead: true, canOpen: true, canCancel: true, canRefund: true };

function connectedShopify() {
  loadConnMock.mockResolvedValue({
    tenantIntegrationId: "ti1",
    credentials: {},
    config: { shopDomain: "urban-supply.myshopify.com", grantedScopes: ["read_orders", "write_orders"] },
    status: "CONNECTED",
    expiresAt: null,
  });
}
function linkedTo(customerId: string) {
  resolveIdentityMock.mockResolvedValue({
    phoneSuffixes: new Set(), emails: new Set(), customerIds: new Set([customerId]),
    conversationId: "c1", channelSenderId: "+972500000000",
  });
}
function adapterReturns(summary: any, orders: any[]) {
  execMock.mockImplementation(async ({ toolFunctionName }: any) => {
    if (toolFunctionName === "shopify.summarize_customer") return { ok: true, result: summary };
    if (toolFunctionName === "shopify.get_customer_orders") return { ok: true, result: orders };
    return { ok: false, reason: "unexpected" };
  });
}

const ORDERS = [
  { id: 5001, name: "#1246", created_at: "2026-07-18T10:00:00Z", currency: "USD", total_price: "120.00",
    financial_status: "paid", fulfillment_status: null, cancelled_at: null,
    line_items: [{ id: 1, title: "Nike Cryptokicks", quantity: 1 }], refunds: [], customer: { id: 999 } },
  { id: 5000, name: "#1245", created_at: "2026-07-10T10:00:00Z", currency: "USD", total_price: "80.00",
    financial_status: "paid", fulfillment_status: "fulfilled", cancelled_at: null,
    line_items: [{ id: 2, title: "Socks", quantity: 2 }], refunds: [], customer: { id: 999 } },
];

beforeEach(() => {
  execMock.mockReset(); loadConnMock.mockReset(); resolveIdentityMock.mockReset();
  invalidateCommerceCache({ tenantId: "t1" }); // isolate cache between tests
});

describe("visibility states", () => {
  it("2. not connected → not_connected", async () => {
    loadConnMock.mockResolvedValue(null);
    const r = await buildCommerceContextResponse({ tenantId: "t1", conversationId: "c1", perms: PERMS });
    expect(r.state).toBe("not_connected");
  });

  it("connection in ERROR → connection_unhealthy", async () => {
    loadConnMock.mockResolvedValue({ config: { shopDomain: "x.myshopify.com" }, status: "ERROR", credentials: {}, tenantIntegrationId: "ti", expiresAt: null });
    const r = await buildCommerceContextResponse({ tenantId: "t1", conversationId: "c1", perms: PERMS });
    expect(r.state).toBe("connection_unhealthy");
  });

  it("3. connected but no verified linkage → customer_not_linked (no protected data loaded)", async () => {
    connectedShopify();
    resolveIdentityMock.mockResolvedValue({ phoneSuffixes: new Set(), emails: new Set(), customerIds: new Set(), conversationId: "c1", channelSenderId: null });
    const r = await buildCommerceContextResponse({ tenantId: "t1", conversationId: "c1", perms: PERMS });
    expect(r.state).toBe("customer_not_linked");
    expect(execMock).not.toHaveBeenCalled(); // never touched Shopify
  });

  it("1. connected + linked → ok with orders", async () => {
    connectedShopify(); linkedTo("999");
    adapterReturns({ customer: { orders_count: 12, total_spent: "4820.00", currency: "USD" } }, ORDERS);
    const r = await buildCommerceContextResponse({ tenantId: "t1", conversationId: "c1", perms: PERMS });
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.data.recentOrders).toHaveLength(2);
    expect(r.data.recentOrders[0].orderNumber).toBe("#1246");
  });
});

describe("customer resolution is trusted-only (tests 4)", () => {
  it("4. the adapter is queried with the LINKED customer id, never a caller-supplied one", async () => {
    connectedShopify(); linkedTo("999");
    adapterReturns({ customer: { orders_count: 1, total_spent: "120.00", currency: "USD" } }, [ORDERS[0]]);
    await buildCommerceContextResponse({ tenantId: "t1", conversationId: "c1", perms: PERMS });
    const summarizeCall = execMock.mock.calls.find((c) => c[0].toolFunctionName === "shopify.summarize_customer");
    expect(summarizeCall![0].args.customer_id).toBe("999");
  });
});

describe("summary accuracy (tests 5, 6)", () => {
  it("5. orderCount comes from the Shopify customer aggregate", async () => {
    connectedShopify(); linkedTo("999");
    adapterReturns({ customer: { orders_count: 12, total_spent: "4820.00", currency: "USD" } }, ORDERS);
    const r = await buildCommerceContextResponse({ tenantId: "t1", conversationId: "c1", perms: PERMS });
    if (r.state !== "ok") throw new Error(r.state);
    expect(r.data.summary.orderCount).toBe(12);
    expect(r.data.summary.repeatCustomer).toBe(true);
  });

  it("6. total spent = provider shop-currency aggregate, not summed across currencies", async () => {
    connectedShopify(); linkedTo("999");
    adapterReturns({ customer: { orders_count: 12, total_spent: "4820.00", currency: "USD" } }, ORDERS);
    const r = await buildCommerceContextResponse({ tenantId: "t1", conversationId: "c1", perms: PERMS });
    if (r.state !== "ok") throw new Error(r.state);
    expect(r.data.summary.shopCurrencyTotal).toEqual({ amount: "4820.00", currency: "USD" });
    expect(r.data.summary.totalSpentByCurrency).toEqual([{ amount: "4820.00", currency: "USD" }]);
  });
});

describe("recent orders sorted most-recent first (test 8)", () => {
  it("8. orders returned out of order by the provider are sorted newest-first", async () => {
    connectedShopify(); linkedTo("999");
    // Provider returns oldest first; projection must sort newest first.
    adapterReturns(
      { customer: { orders_count: 2, total_spent: "200.00", currency: "USD" } },
      [ORDERS[1], ORDERS[0]], // #1245 (older) then #1246 (newer)
    );
    const r = await buildCommerceContextResponse({ tenantId: "t1", conversationId: "c1", perms: PERMS });
    if (r.state !== "ok") throw new Error(r.state);
    expect(r.data.recentOrders.map((o) => o.orderNumber)).toEqual(["#1246", "#1245"]);
  });
});

describe("no orders honest state (test 13)", () => {
  it("13. connected + linked but zero orders → no_orders (not an infinite loader)", async () => {
    connectedShopify(); linkedTo("999");
    adapterReturns({ customer: { orders_count: 0, total_spent: "0.00", currency: "USD" } }, []);
    const r = await buildCommerceContextResponse({ tenantId: "t1", conversationId: "c1", perms: PERMS });
    expect(r.state).toBe("no_orders");
  });
});

describe("scope / provider failure states", () => {
  it("adapter scope denial → missing_scopes", async () => {
    connectedShopify(); linkedTo("999");
    execMock.mockResolvedValue({ ok: false, reason: "access_denied: missing scope read_orders" });
    const r = await buildCommerceContextResponse({ tenantId: "t1", conversationId: "c1", perms: PERMS });
    expect(r.state).toBe("missing_scopes");
  });

  it("provider failure (not scope) → unavailable/retryable, not no_orders", async () => {
    connectedShopify(); linkedTo("999");
    execMock.mockResolvedValue({ ok: false, reason: "shopify_5xx timeout" });
    const r = await buildCommerceContextResponse({ tenantId: "t1", conversationId: "c1", perms: PERMS });
    expect(r.state).toBe("unavailable");
  });
});
