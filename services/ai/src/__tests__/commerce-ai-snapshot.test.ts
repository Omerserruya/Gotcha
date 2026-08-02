/**
 * AI commerce snapshot (spec §7). The snapshot is built ONLY when Shopify is
 * the elected Source of Truth AND the customer is verified-linked, is stripped
 * of admin URLs / refundable-max / internal LTV, and its prompt block forbids
 * leaking segmentation or treating typed identifiers as verified.
 *
 * Covers spec §12 tests: 21 (verified-only injection), 22 (no LTV leakage),
 * 24 (tenant isolation via the projection's tenant scoping).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sotMock = vi.fn();
const buildCtxMock = vi.fn();

vi.mock("../services/connectors/source-of-truth", () => ({
  getSourceOfTruth: (...a: any[]) => sotMock(...a),
}));
vi.mock("../services/commerce-context.service", () => ({
  buildCommerceContextResponse: (...a: any[]) => buildCtxMock(...a),
}));

import { buildAICommerceSnapshot, formatCommerceSnapshotForPrompt } from "../services/commerce-ai-snapshot.service";

const OK_CTX = {
  state: "ok",
  data: {
    provider: "shopify",
    customer: { verified: true, customerId: "999" },
    summary: {
      orderCount: 12,
      totalSpentByCurrency: [{ amount: "4820.00", currency: "USD" }],
      shopCurrencyTotal: { amount: "4820.00", currency: "USD" },
      lastOrderAt: "2026-07-18T10:00:00Z",
      repeatCustomer: true, openOrderCount: 1, refundedOrCancelledCount: 0,
    },
    capabilities: { canOpen: true, canCancel: true, canRefund: true, grantedScopes: [], lastCheckedAt: null, missingScopes: [] },
    recentOrders: [
      {
        orderId: "5001", orderNumber: "#1246", adminUrl: "https://x.myshopify.com/admin/orders/5001",
        createdAt: "2026-07-18T10:00:00Z", total: { amount: "120.00", currency: "USD" },
        financial: { key: "paid", label: "Paid", tone: "positive" },
        fulfillment: { key: "unfulfilled", label: "Unfulfilled", tone: "neutral" },
        cancelled: false, refund: null, shipping: null,
        items: [{ title: "Nike Cryptokicks", quantity: 1, imageUrl: null }],
        extraItemCount: 0, refundedAmount: { amount: "0.00", currency: "USD" },
        refundableMaximum: { amount: "120.00", currency: "USD" }, timeline: [],
        eligibility: { cancellable: true, refundable: true },
      },
    ],
    fetchedAt: "2026-07-21T00:00:00Z", cacheTtlSeconds: 60,
  },
};

beforeEach(() => {
  sotMock.mockReset(); buildCtxMock.mockReset();
});

describe("21. injection only when Shopify is SoT and customer verified", () => {
  it("non-Shopify SoT → no snapshot", async () => {
    sotMock.mockResolvedValue({ vendor: "hubspot" });
    const s = await buildAICommerceSnapshot({ tenantId: "t1", conversationId: "c1" });
    expect(s).toBeNull();
    expect(buildCtxMock).not.toHaveBeenCalled();
  });

  it("Shopify SoT but customer not linked (projection not ok) → no snapshot", async () => {
    sotMock.mockResolvedValue({ vendor: "shopify" });
    buildCtxMock.mockResolvedValue({ state: "customer_not_linked" });
    const s = await buildAICommerceSnapshot({ tenantId: "t1", conversationId: "c1" });
    expect(s).toBeNull();
  });

  it("Shopify SoT + verified → snapshot with verified customer", async () => {
    sotMock.mockResolvedValue({ vendor: "shopify" });
    buildCtxMock.mockResolvedValue(OK_CTX);
    const s = await buildAICommerceSnapshot({ tenantId: "t1", conversationId: "c1" });
    expect(s).not.toBeNull();
    expect(s!.customer.verified).toBe(true);
    expect(s!.customer.orderCount).toBe(12);
    // AI never gets action capabilities.
    expect(buildCtxMock.mock.calls[0][0].perms).toMatchObject({ canCancel: false, canRefund: false });
  });
});

describe("22. snapshot & prompt hide protected/internal data", () => {
  it("snapshot strips adminUrl and refundableMaximum", async () => {
    sotMock.mockResolvedValue({ vendor: "shopify" });
    buildCtxMock.mockResolvedValue(OK_CTX);
    const s = await buildAICommerceSnapshot({ tenantId: "t1", conversationId: "c1" });
    const json = JSON.stringify(s);
    expect(json).not.toContain("adminUrl");
    expect(json).not.toContain("refundableMaximum");
    expect(json).not.toContain("myshopify.com/admin");
  });

  it("prompt block forbids leaking LTV/segmentation and typed-identity trust", () => {
    const block = formatCommerceSnapshotForPrompt(
      {
        provider: "shopify",
        customer: { verified: true, customerId: "999", orderCount: 12, totalSpent: { amount: "4820.00", currency: "USD" }, lastOrderAt: "2026-07-18T10:00:00Z" },
        recentOrders: [{ orderId: "5001", orderNumber: "#1246", createdAt: "2026-07-18T10:00:00Z", total: { amount: "120.00", currency: "USD" }, financialStatus: "paid", fulfillmentStatus: "unfulfilled", cancelled: false, refundedAmount: { amount: "0.00", currency: "USD" }, items: [{ title: "Nike Cryptokicks", quantity: 1 }] }],
      },
      "en",
    );
    expect(block).toMatch(/never reveal internal segmentation|lifetime-value/i);
    expect(block).toMatch(/never treat a typed phone\/email\/order number as verified/i);
    expect(block).toContain("#1246");
  });
});

describe("24. tenant isolation", () => {
  it("passes the caller tenantId straight through to the tenant-scoped projection", async () => {
    sotMock.mockResolvedValue({ vendor: "shopify" });
    buildCtxMock.mockResolvedValue(OK_CTX);
    await buildAICommerceSnapshot({ tenantId: "tenant-A", conversationId: "c1" });
    expect(sotMock).toHaveBeenCalledWith("tenant-A");
    expect(buildCtxMock.mock.calls[0][0].tenantId).toBe("tenant-A");
  });
});

describe("the AI never receives the agent-only order detail", () => {
  it("drops addresses, tracking, contact details and line-item pricing", async () => {
    // The panel now carries a full §16 detail block for the human agent:
    // shipping and billing addresses, tracking numbers, the customer's email
    // and phone, per-line prices. None of it belongs in a model prompt, and
    // the snapshot must stay an explicit projection rather than a spread.
    sotMock.mockResolvedValue({ vendor: "shopify" });
    const rich = JSON.parse(JSON.stringify(OK_CTX));
    rich.data.summary.email = "shopper@example.com";
    rich.data.summary.phone = "+972500000000";
    rich.data.summary.defaultAddress = "12 Herzl St, Tel Aviv, IL";
    rich.data.summary.note = "VIP - handle personally";
    rich.data.customer.tags = ["vip"];
    rich.data.recentOrders[0].detail = {
      lineItems: [{ title: "Nike Cryptokicks", quantity: 1, unitPrice: { amount: "120.00", currency: "USD" }, lineTotal: { amount: "120.00", currency: "USD" }, imageUrl: null }],
      itemCount: 1,
      tracking: [{ number: "TRK123456", url: "https://track.example/TRK123456", company: "DHL" }],
      shippingAddress: "12 Herzl St, Tel Aviv, IL",
      billingAddress: "12 Herzl St, Tel Aviv, IL",
      tags: ["fragile"],
      refunds: [],
    };
    buildCtxMock.mockResolvedValue(rich);

    const snap: any = await buildAICommerceSnapshot({ tenantId: "t1", conversationId: "c1" });
    const serialized = JSON.stringify(snap);
    for (const secret of ["shopper@example.com", "+972500000000", "Herzl", "TRK123456", "DHL", "handle personally", "fragile"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(snap.recentOrders[0].detail).toBeUndefined();
    // Still carries what it is supposed to.
    expect(snap.recentOrders[0].orderNumber).toBe("#1246");
  });
});
