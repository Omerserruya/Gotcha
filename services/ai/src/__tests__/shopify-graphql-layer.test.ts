import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  shopifyGraphQLRequest,
  paginate,
  toGid,
  numericId,
  escapeSearchValue,
  ShopifyUserError,
} from "../services/connectors/shopify-graphql";

/**
 * The transport underneath the REST→GraphQL migration.
 *
 * The dangerous differences between the two protocols all live here, so this is
 * where they are pinned:
 *
 *   * GraphQL answers 200 for failures REST answered 4xx for - a mutation that
 *     "succeeded" with userErrors is a refund that did not happen;
 *   * throttling is a 200 as well, and is the ONE error worth repeating;
 *   * a retried mutation is a second write, so mutations are never retried;
 *   * ids change shape, and GOTCHA compares numeric ids everywhere.
 */

vi.mock("@chatcenter/shared", () => ({
  assertPublicUrl: async () => {},
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true }),
}));

const ctx = { token: "shpat_test", base: "https://demo.myshopify.com/admin/api/2026-07" };

function reply(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (k: string) => (init.headers ?? {})[k] ?? null },
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

describe("id translation", () => {
  it("builds a gid and leaves an existing one alone", () => {
    expect(toGid("Order", 1234)).toBe("gid://shopify/Order/1234");
    expect(toGid("Order", "gid://shopify/Order/1234")).toBe("gid://shopify/Order/1234");
  });

  // GOTCHA stores numeric ids in tool arguments, conversation metadata and the
  // Shopify context panel. A gid reaching any of those stops matching silently.
  it("recovers the numeric id from a gid", () => {
    expect(numericId({ id: "gid://shopify/Customer/987" })).toBe(987);
  });

  it("prefers Shopify's own legacyResourceId over parsing the gid", () => {
    expect(numericId({ id: "gid://shopify/Order/1", legacyResourceId: "556677" })).toBe(556677);
  });

  it("returns null rather than NaN for something that is not an id", () => {
    expect(numericId({ id: "gid://shopify/Order/not-a-number" })).toBeNull();
    expect(numericId(null)).toBeNull();
    expect(numericId({})).toBeNull();
  });
});

describe("search escaping", () => {
  // REST passed these through a URL parameter with no escaping either; a quote
  // in a customer's name ended the term and the rest was parsed as syntax.
  it("quotes the value and escapes embedded quotes and backslashes", () => {
    expect(escapeSearchValue('O"Brien')).toBe('"O\\"Brien"');
    expect(escapeSearchValue("back\\slash")).toBe('"back\\\\slash"');
  });

  it("survives a value that is entirely query syntax", () => {
    expect(escapeSearchValue('" OR id:*')).toBe('"\\" OR id:*"');
  });
});

describe("errors are distinguished, not collapsed", () => {
  it("keeps the REST-compatible shopify_<status> for HTTP failures", async () => {
    fetchMock.mockResolvedValue(reply({ errors: "Not Found" }, { status: 404 }));
    await expect(shopifyGraphQLRequest(ctx, "query{shop{name}}")).rejects.toThrow(/shopify_404/);
  });

  it("reports a top-level GraphQL error", async () => {
    fetchMock.mockResolvedValue(reply({ errors: [{ message: "Field 'nope' doesn't exist" }] }));
    await expect(shopifyGraphQLRequest(ctx, "query{nope}")).rejects.toThrow(/shopify_graphql_error/);
  });

  it("names the scope Shopify asked for on an access denial", async () => {
    fetchMock.mockResolvedValue(
      reply({ errors: [{ message: "Access denied for refundCreate field. Required access: `write_orders` scope." }] }),
    );
    await expect(shopifyGraphQLRequest(ctx, "mutation{}")).rejects.toThrow(/access_denied.*write_orders/s);
  });

  // The most dangerous case in the whole migration: 200 OK, data present, and
  // the write did not happen.
  it("throws on userErrors instead of returning a fake success", async () => {
    fetchMock.mockResolvedValue(
      reply({ data: { customerUpdate: { customer: null, userErrors: [{ field: ["email"], message: "Email has already been taken", code: "TAKEN" }] } } }),
    );
    await expect(
      shopifyGraphQLRequest(ctx, "mutation{}", {}, { userErrorsAt: "customerUpdate" }),
    ).rejects.toThrow(ShopifyUserError);
    await expect(
      shopifyGraphQLRequest(ctx, "mutation{}", {}, { userErrorsAt: "customerUpdate" }),
    ).rejects.toThrow(/email: Email has already been taken \(TAKEN\)/);
  });

  it("returns data when a mutation reports no userErrors", async () => {
    fetchMock.mockResolvedValue(reply({ data: { customerUpdate: { customer: { id: "gid://shopify/Customer/1" }, userErrors: [] } } }));
    const data = await shopifyGraphQLRequest(ctx, "mutation{}", {}, { userErrorsAt: "customerUpdate" });
    expect(data.customerUpdate.customer.id).toBe("gid://shopify/Customer/1");
  });
});

describe("retries", () => {
  it("repeats a throttled READ and returns the eventual answer", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 0, restoreRate: 100 } } } }))
      .mockResolvedValueOnce(reply({ data: { shop: { name: "Demo" } } }));
    const data = await shopifyGraphQLRequest(ctx, "query{shop{name}}", {}, { retryable: true });
    expect(data.shop.name).toBe("Demo");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // A retried refundCreate is a second refund. This is the guard that makes the
  // "never retry mutations" rule real rather than a comment.
  it("NEVER repeats a mutation, even when throttled", async () => {
    fetchMock.mockResolvedValue(reply({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }));
    await expect(shopifyGraphQLRequest(ctx, "mutation{refundCreate}", {}, { userErrorsAt: "refundCreate" })).rejects.toThrow(/throttled/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("repeats a retryable 5xx but not a 4xx", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ errors: "boom" }, { status: 502 }))
      .mockResolvedValueOnce(reply({ data: { shop: { name: "Demo" } } }));
    await expect(shopifyGraphQLRequest(ctx, "query{shop{name}}", {}, { retryable: true })).resolves.toBeTruthy();

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(reply({ errors: "bad request" }, { status: 400 }));
    await expect(shopifyGraphQLRequest(ctx, "query{shop{name}}", {}, { retryable: true })).rejects.toThrow(/shopify_400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt budget rather than looping", async () => {
    fetchMock.mockResolvedValue(reply({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }));
    await expect(
      shopifyGraphQLRequest(ctx, "query{shop{name}}", {}, { retryable: true, maxAttempts: 2 }),
    ).rejects.toThrow(/throttled/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("cursor pagination", () => {
  const query = "query($first:Int!,$after:String){products(first:$first,after:$after){nodes{id} pageInfo{hasNextPage endCursor}}}";

  it("follows the cursor until the limit is filled", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ data: { products: { nodes: [{ id: "1" }, { id: "2" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } }))
      .mockResolvedValueOnce(reply({ data: { products: { nodes: [{ id: "3" }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
    const rows = await paginate<{ id: string }>(ctx, query, {}, "products", 10);
    expect(rows.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(fetchMock.mock.calls[1][1].body).toContain('"after":"c1"');
  });

  it("stops at the limit and never over-fetches", async () => {
    fetchMock.mockResolvedValue(reply({ data: { products: { nodes: [{ id: "1" }, { id: "2" }], pageInfo: { hasNextPage: true, endCursor: "c" } } } }));
    const rows = await paginate<{ id: string }>(ctx, query, {}, "products", 2);
    expect(rows).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads edges when a connection has no nodes shortcut", async () => {
    fetchMock.mockResolvedValue(reply({ data: { products: { edges: [{ node: { id: "9" } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
    const rows = await paginate<{ id: string }>(ctx, query, {}, "products", 5);
    expect(rows.map((r) => r.id)).toEqual(["9"]);
  });

  // A connection that keeps claiming hasNextPage while returning nothing must
  // not spin.
  it("breaks out of an empty page that still claims more", async () => {
    fetchMock.mockResolvedValue(reply({ data: { products: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "c" } } } }));
    const rows = await paginate<{ id: string }>(ctx, query, {}, "products", 50);
    expect(rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("transport", () => {
  it("posts to graphql.json with the token and separated variables", async () => {
    fetchMock.mockResolvedValue(reply({ data: { ok: true } }));
    await shopifyGraphQLRequest(ctx, "query Q($id:ID!){node(id:$id){id}}", { id: "gid://shopify/Order/1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://demo.myshopify.com/admin/api/2026-07/graphql.json");
    expect(init.headers["X-Shopify-Access-Token"]).toBe("shpat_test");
    const body = JSON.parse(init.body);
    expect(body.variables).toEqual({ id: "gid://shopify/Order/1" });
    expect(body.query).toContain("query Q(");
  });
});
