/**
 * Commerce facts for the customer brief.
 *
 * The point of these tests is that the NUMBERS are arithmetic, not model
 * output. Lifetime spend, average order value and recency are quoted to a
 * human agent who repeats them to a paying customer, so each one is pinned
 * here - including the cases where the honest answer is "unknown".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getCrmAdapter = vi.fn();
vi.mock("../services/connectors/crm-adapter-resolver", () => ({
  getCrmAdapter: (...a: unknown[]) => getCrmAdapter(...a),
}));

import {
  loadCustomerCommerceFacts,
  renderCommerceFactsForPrompt,
} from "../services/customer-commerce-facts.service";

const NOW = new Date("2026-08-04T00:00:00.000Z");

/** An adapter whose getCustomerContext returns the given customer + orders. */
function stubAdapter(custom: Record<string, unknown>, deals: unknown[] = []) {
  return {
    capabilities: { is_stub: false },
    getCustomerContext: vi.fn().mockResolvedValue({
      ok: true,
      context: {
        contact: { id: "1", kind: "contact", vendor: "shopify", custom_fields: custom },
        deals,
      },
    }),
  };
}

const ARGS = { tenantId: "t1", crmContactId: "c1", crmObjectKind: "contact" as const, now: NOW };

beforeEach(() => {
  getCrmAdapter.mockReset();
});

describe("loadCustomerCommerceFacts", () => {
  it("takes lifetime totals from the customer record, not from the order page", async () => {
    // 42 lifetime orders but only 2 in the recent window. Summing the window
    // would report a customer who has spent 300 as having spent 300 - the
    // exact understatement that makes an agent treat a whale like a stranger.
    getCrmAdapter.mockResolvedValue(
      stubAdapter(
        { orders_count: 42, total_spent: "8400.00", currency: "ILS" },
        [
          { id: "1", name: "#1002", amount: 200, stage: "paid", close_date: "2026-08-01T00:00:00Z" },
          { id: "2", name: "#1001", amount: 100, stage: "paid", close_date: "2026-07-01T00:00:00Z" },
        ],
      ),
    );

    const f = await loadCustomerCommerceFacts(ARGS);

    expect(f?.ordersCount).toBe(42);
    expect(f?.totalSpent).toBe(8400);
    expect(f?.currency).toBe("ILS");
    expect(f?.averageOrderValue).toBe(200);
    expect(f?.recentOrderCount).toBe(2);
  });

  it("orders the recent window newest-first and dates recency from it", async () => {
    getCrmAdapter.mockResolvedValue(
      stubAdapter({ orders_count: 2, total_spent: "300" }, [
        { id: "1", name: "#1001", amount: 100, stage: "paid", close_date: "2026-07-01T00:00:00Z" },
        { id: "2", name: "#1002", amount: 200, stage: "paid", close_date: "2026-08-01T00:00:00Z" },
      ]),
    );

    const f = await loadCustomerCommerceFacts(ARGS);

    expect(f?.recentOrders[0].name).toBe("#1002");
    expect(f?.lastOrderAt).toBe("2026-08-01T00:00:00Z");
    expect(f?.daysSinceLastOrder).toBe(3);
    expect(f?.firstSeenOrderAt).toBe("2026-07-01T00:00:00Z");
  });

  it("bands a long-silent repeat buyer as lapsed, not loyal", async () => {
    // The whole reason `lapsed` is checked before `loyal`: an agent needs the
    // silence more than the order count.
    getCrmAdapter.mockResolvedValue(
      stubAdapter({ orders_count: 9, total_spent: "5000" }, [
        { id: "1", name: "#900", amount: 500, stage: "paid", close_date: "2024-01-01T00:00:00Z" },
      ]),
    );

    const f = await loadCustomerCommerceFacts(ARGS);

    expect(f?.engagement).toBe("lapsed");
  });

  it.each([
    [0, "2026-08-01T00:00:00Z", "new"],
    [1, "2026-08-01T00:00:00Z", "one_time"],
    [3, "2026-08-01T00:00:00Z", "repeat"],
    [7, "2026-08-01T00:00:00Z", "loyal"],
  ])("bands orders_count=%s as %s", async (count, when, expected) => {
    getCrmAdapter.mockResolvedValue(
      stubAdapter({ orders_count: count }, [
        { id: "1", name: "#1", amount: 10, stage: "paid", close_date: when },
      ]),
    );

    expect((await loadCustomerCommerceFacts(ARGS))?.engagement).toBe(expected);
  });

  it("reports unknown rather than guessing when the store gives no order count", async () => {
    getCrmAdapter.mockResolvedValue(stubAdapter({}, []));

    const f = await loadCustomerCommerceFacts(ARGS);

    expect(f?.engagement).toBe("unknown");
    expect(f?.ordersCount).toBeNull();
    expect(f?.averageOrderValue).toBeNull();
  });

  it("does not divide by zero to produce an average order value", async () => {
    getCrmAdapter.mockResolvedValue(stubAdapter({ orders_count: 0, total_spent: "0" }));

    expect((await loadCustomerCommerceFacts(ARGS))?.averageOrderValue).toBeNull();
  });

  it("surfaces refunded and cancelled states, and de-duplicates them", async () => {
    getCrmAdapter.mockResolvedValue(
      stubAdapter({ orders_count: 3 }, [
        { id: "1", name: "#3", amount: 10, stage: "refunded", close_date: "2026-08-01T00:00:00Z" },
        { id: "2", name: "#2", amount: 10, stage: "refunded", close_date: "2026-07-02T00:00:00Z" },
        { id: "3", name: "#1", amount: 10, stage: "paid", close_date: "2026-07-01T00:00:00Z" },
      ]),
    );

    expect((await loadCustomerCommerceFacts(ARGS))?.openOrderStates).toEqual(["refunded"]);
  });

  it("splits merchant tags from Shopify's comma-joined string", async () => {
    getCrmAdapter.mockResolvedValue(stubAdapter({ orders_count: 1, tags: "vip, wholesale ,  " }));

    expect((await loadCustomerCommerceFacts(ARGS))?.tags).toEqual(["vip", "wholesale"]);
  });

  it("returns null for a customer with no CRM link rather than calling the store", async () => {
    const f = await loadCustomerCommerceFacts({ ...ARGS, crmContactId: null });

    expect(f).toBeNull();
    expect(getCrmAdapter).not.toHaveBeenCalled();
  });

  it("degrades to null when the store read fails - a brief must still be produced", async () => {
    getCrmAdapter.mockResolvedValue({
      capabilities: { is_stub: false },
      getCustomerContext: vi.fn().mockRejectedValue(new Error("shopify_429")),
    });

    await expect(loadCustomerCommerceFacts(ARGS)).resolves.toBeNull();
  });

  it("ignores a stub adapter (no store connected)", async () => {
    getCrmAdapter.mockResolvedValue({ capabilities: { is_stub: true }, getCustomerContext: vi.fn() });

    await expect(loadCustomerCommerceFacts(ARGS)).resolves.toBeNull();
  });
});

describe("renderCommerceFactsForPrompt", () => {
  it("renders nothing when there are no facts, so the caller can splice unconditionally", () => {
    expect(renderCommerceFactsForPrompt(null)).toEqual([]);
  });

  it("attaches the currency to every money figure", async () => {
    getCrmAdapter.mockResolvedValue(
      stubAdapter({ orders_count: 2, total_spent: "500", currency: "ILS" }, [
        { id: "1", name: "#1002", amount: 300, stage: "paid", close_date: "2026-08-01T00:00:00Z" },
      ]),
    );
    const facts = await loadCustomerCommerceFacts(ARGS);

    const text = renderCommerceFactsForPrompt(facts).join("\n");

    expect(text).toContain("Lifetime spend: 500 ILS");
    expect(text).toContain("Average order value: 250 ILS");
    expect(text).toContain("300 ILS");
    // The model must not treat these as inputs to arithmetic of its own.
    expect(text).toContain("do not recalculate");
  });
});
