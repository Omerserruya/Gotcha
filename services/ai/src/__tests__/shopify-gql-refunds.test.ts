import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  suggestRefund,
  createRefund,
  listOrderRefunds,
  refundIdempotencyKey,
} from "../services/connectors/shopify-gql-refunds";

/**
 * The refund path, which is the only one here that moves money.
 *
 * Three properties matter more than the shapes:
 *
 *   1. pricing a refund must never create one - it is a QUERY, and these assert
 *      the operation that goes over the wire, not just its result;
 *   2. the same refund attempted twice must carry the SAME idempotency key, or
 *      Shopify's deduplication does nothing and a redelivered job refunds
 *      twice;
 *   3. a `userErrors` response is a refund that did NOT happen and must throw.
 */

vi.mock("@chatcenter/shared", () => ({
  assertPublicUrl: async () => {},
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true }),
}));

const ctx = { token: "shpat_test", base: "https://demo.myshopify.com/admin/api/2026-07" };

function reply(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const sent = () => JSON.parse(String(fetchMock.mock.calls[0][1].body));

describe("pricing a refund", () => {
  const suggested = {
    data: {
      order: {
        suggestedRefund: {
          amountSet: { shopMoney: { amount: "150.00", currencyCode: "ILS" } },
          maximumRefundableSet: { shopMoney: { amount: "150.00" } },
          shipping: { amountSet: { shopMoney: { amount: "0.00" } } },
          suggestedTransactions: [
            { amountSet: { shopMoney: { amount: "150.00", currencyCode: "ILS" } }, gateway: "manual", kind: "SUGGESTED_REFUND", parentTransaction: { id: "gid://shopify/OrderTransaction/7" } },
          ],
        },
      },
    },
  };

  it("asks a QUERY, never a mutation - pricing cannot move money", async () => {
    fetchMock.mockResolvedValue(reply(suggested));
    await suggestRefund(ctx, 2001, [{ line_item_id: 31, quantity: 2, restock_type: "return" }], true);
    expect(sent().query).toMatch(/^\s*query\b/m);
    expect(sent().query).not.toMatch(/\bmutation\b/);
  });

  it("translates the line ids and the restock enum Shopify expects", async () => {
    fetchMock.mockResolvedValue(reply(suggested));
    await suggestRefund(ctx, 2001, [{ line_item_id: 31, quantity: 2, restock_type: "return", location_id: 61 }], true);
    expect(sent().variables.refundLineItems[0]).toEqual({
      lineItemId: "gid://shopify/LineItem/31",
      quantity: 2,
      restockType: "RETURN",
      locationId: "gid://shopify/Location/61",
    });
  });

  // The four restock values are not cosmetic: they decide whether Shopify
  // treats a unit as never-shipped or as physically returned.
  it("refuses to invent a restock type it does not recognise", async () => {
    fetchMock.mockResolvedValue(reply(suggested));
    await suggestRefund(ctx, 2001, [{ line_item_id: 31, quantity: 1, restock_type: "restock" }], false);
    expect(sent().variables.refundLineItems[0].restockType).toBe("NO_RESTOCK");
  });

  it("reports the parent transaction as the gid the mutation needs back", async () => {
    fetchMock.mockResolvedValue(reply(suggested));
    const s = (await suggestRefund(ctx, 2001, [], true))!;
    expect(s.transactions[0]).toEqual({ parent_id: "gid://shopify/OrderTransaction/7", amount: "150.00", gateway: "manual" });
    expect(s.currency).toBe("ILS");
  });

  it("returns null when Shopify prices nothing", async () => {
    fetchMock.mockResolvedValue(reply({ data: { order: { suggestedRefund: null } } }));
    expect(await suggestRefund(ctx, 2001, [], true)).toBeNull();
  });
});

describe("the idempotency key", () => {
  const input = {
    currency: "ILS",
    note: "GOTCHA refund",
    notify: true,
    transactions: [{ parent_id: "gid://shopify/OrderTransaction/7", amount: "150.00" }],
    refund_line_items: [{ line_item_id: 31, quantity: 2, restock_type: "return" }],
  };

  // The whole point: a redelivered job must reuse the key so Shopify returns
  // the refund that already exists instead of creating a second one.
  it("is identical for the same refund attempted twice", () => {
    expect(refundIdempotencyKey(2001, input)).toBe(refundIdempotencyKey(2001, input));
  });

  it("differs when the AMOUNT differs", () => {
    const other = { ...input, transactions: [{ parent_id: "gid://shopify/OrderTransaction/7", amount: "50.00" }] };
    expect(refundIdempotencyKey(2001, other)).not.toBe(refundIdempotencyKey(2001, input));
  });

  it("differs when the LINES differ", () => {
    const other = { ...input, refund_line_items: [{ line_item_id: 31, quantity: 1, restock_type: "return" }] };
    expect(refundIdempotencyKey(2001, other)).not.toBe(refundIdempotencyKey(2001, input));
  });

  it("differs across orders, so one order's refund cannot suppress another's", () => {
    expect(refundIdempotencyKey(2002, input)).not.toBe(refundIdempotencyKey(2001, input));
  });

  it("is a plain opaque string Shopify will accept", () => {
    expect(refundIdempotencyKey(2001, input)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("creating a refund", () => {
  const created = {
    data: {
      refundCreate: {
        refund: {
          legacyResourceId: "555",
          createdAt: "2026-07-20T10:00:00Z",
          totalRefundedSet: { shopMoney: { amount: "150.00", currencyCode: "ILS" } },
          transactions: {
            nodes: [{ id: "gid://shopify/OrderTransaction/9", status: "SUCCESS", kind: "REFUND", amountSet: { shopMoney: { amount: "150.00" } }, gateway: "manual" }],
          },
        },
        userErrors: [],
      },
    },
  };

  const input = {
    currency: "ILS",
    note: "GOTCHA refund",
    notify: true,
    transactions: [{ parent_id: "gid://shopify/OrderTransaction/7", amount: "150.00", gateway: "manual" }],
    refund_line_items: [{ line_item_id: 31, quantity: 2, restock_type: "return" as const }],
  };

  it("sends the idempotency key with the mutation", async () => {
    fetchMock.mockResolvedValue(reply(created));
    await createRefund(ctx, 2001, input);
    expect(sent().query).toContain("@idempotent(key: $idempotencyKey)");
    expect(sent().variables.idempotencyKey).toBe(refundIdempotencyKey(2001, input));
  });

  it("builds the transaction against the order and its parent transaction", async () => {
    fetchMock.mockResolvedValue(reply(created));
    await createRefund(ctx, 2001, input);
    expect(sent().variables.input.transactions[0]).toEqual({
      orderId: "gid://shopify/Order/2001",
      parentId: "gid://shopify/OrderTransaction/7",
      amount: "150.00",
      kind: "REFUND",
      gateway: "manual",
    });
  });

  it("reports the transaction status in REST's words, so callers can read it", async () => {
    fetchMock.mockResolvedValue(reply(created));
    const r = (await createRefund(ctx, 2001, input))!;
    expect(r.id).toBe(555);
    expect(r.transactions[0]).toMatchObject({ id: 9, status: "success", amount: "150.00" });
  });

  // The failure that must never be reported as a success.
  it("THROWS on userErrors rather than returning a refund that did not happen", async () => {
    fetchMock.mockResolvedValue(reply({
      data: { refundCreate: { refund: null, userErrors: [{ field: ["refundLineItems"], message: "You need to set a location to restock items" }] } },
    }));
    await expect(createRefund(ctx, 2001, input)).rejects.toThrow(/shopify_user_error.*location to restock/s);
  });

  it("is never repeated by the transport, even under throttling", async () => {
    fetchMock.mockResolvedValue(reply({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }));
    await expect(createRefund(ctx, 2001, input)).rejects.toThrow(/throttled/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("omits the line items entirely for an amount-only refund", async () => {
    fetchMock.mockResolvedValue(reply(created));
    await createRefund(ctx, 2001, { ...input, refund_line_items: [] });
    expect(sent().variables.input.refundLineItems).toBeUndefined();
  });
});

describe("reading existing refunds", () => {
  it("gives the reconciler the per-line quantities it counts", async () => {
    fetchMock.mockResolvedValue(reply({
      data: {
        order: {
          refunds: [{
            legacyResourceId: "901",
            createdAt: "2026-08-03T00:00:00Z",
            note: null,
            totalRefundedSet: { shopMoney: { amount: "150.00", currencyCode: "ILS" } },
            refundLineItems: { nodes: [{ lineItem: { id: "gid://shopify/LineItem/31" }, quantity: 2, restockType: "RETURN" }] },
            transactions: { nodes: [{ id: "gid://shopify/OrderTransaction/9", status: "SUCCESS", kind: "REFUND", amountSet: { shopMoney: { amount: "150.00" } }, gateway: "manual" }] },
          }],
        },
      },
    }));
    const [r] = await listOrderRefunds(ctx, 2001);
    expect(r.id).toBe(901);
    expect(r.refund_line_items[0]).toEqual({ line_item_id: 31, quantity: 2, restock_type: "return" });
    // The prior-refund arithmetic filters on exactly these two words.
    expect(r.transactions[0]).toMatchObject({ kind: "refund", status: "success", amount: "150.00" });
  });

  it("returns an empty list for an order with no refunds", async () => {
    fetchMock.mockResolvedValue(reply({ data: { order: { refunds: [] } } }));
    expect(await listOrderRefunds(ctx, 2001)).toEqual([]);
  });
});
