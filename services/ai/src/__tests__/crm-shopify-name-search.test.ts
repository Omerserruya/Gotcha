/**
 * Shopify source-of-truth NAME search (ShopifyCRMAdapter.searchByName).
 *
 * Shopify's customer search supports free-text and first_name/last_name
 * filter queries - the previous "phone/email only" limitation was ours, not
 * Shopify's. These tests pin down:
 *   • query building (default text search, reliable first/last split,
 *     escaping of Shopify search operators and apostrophes)
 *   • Hebrew and English names
 *   • multiple same-name candidates all returned (no auto-pick)
 *   • empty results and missing read_customers scope propagation
 *   • tenant isolation: every tool call carries the adapter's OWN tenantId
 *   • list masking helpers (identifiers hidden until explicit selection)
 *
 * Hermetic: executeAdapterTool is mocked - the tool plane itself (scope
 * enforcement, OAuth refresh, rate limits) is covered by its own tests.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prismaMock: {
    tenantIntegration: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  } as any,
  executeAdapterToolMock: vi.fn(),
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: mocks.prismaMock,
  encryptCredentials: (x: any) => x,
  decryptCredentials: (x: any) => x,
  assertPublicUrl: async (u: string) => new URL(u),
}));

vi.mock("../services/connectors/integration-framework", async () => ({
  executeAdapterTool: mocks.executeAdapterToolMock,
  loadConnection: vi.fn(),
  registerAdapter: vi.fn(),
  ensureFreshToken: vi.fn(),
  setConnectionStatus: vi.fn(),
  persistCredentials: vi.fn(),
  idempotencyKey: vi.fn().mockReturnValue("idemp_test"),
}));

vi.mock("../services/zoho.service", () => ({
  maybeRefreshZohoToken: vi.fn(),
  ZOHO_DEFAULT_SCOPES: "",
  exchangeZohoCode: vi.fn(),
  getZohoAccountsUrl: () => "https://accounts.zoho.com",
  refreshZohoAccessToken: vi.fn(),
}));

import {
  ShopifyCRMAdapter,
  buildShopifyNameQueries,
  escapeShopifyQueryValue,
} from "../services/connectors/crm-adapter.impl";
import { maskPhone, maskEmail } from "../lib/mask";

const { executeAdapterToolMock } = mocks;

function shopifyCustomer(over: Record<string, unknown> = {}) {
  return {
    id: 111,
    first_name: "Omer",
    last_name: "Serruya",
    email: "omer@example.com",
    phone: "+972521234567",
    orders_count: 4,
    total_spent: "612.00",
    currency: "ILS",
    ...over,
  };
}

beforeEach(() => {
  executeAdapterToolMock.mockReset();
});

describe("buildShopifyNameQueries", () => {
  it("full name: default text search + reliable first/last filter", () => {
    expect(buildShopifyNameQueries("Omer Serruya")).toEqual([
      "Omer Serruya",
      'first_name:"Omer" last_name:"Serruya"',
    ]);
  });

  it("single token (first OR last name): default text search only", () => {
    expect(buildShopifyNameQueries("Omer")).toEqual(["Omer"]);
    expect(buildShopifyNameQueries("Serruya")).toEqual(["Serruya"]);
  });

  it("three tokens: split is unreliable, default search only", () => {
    expect(buildShopifyNameQueries("Jose Luis Garcia")).toEqual(["Jose Luis Garcia"]);
  });

  it("Hebrew names work in both forms", () => {
    expect(buildShopifyNameQueries("עומר סרויה")).toEqual([
      "עומר סרויה",
      'first_name:"עומר" last_name:"סרויה"',
    ]);
  });

  it("apostrophes survive; Shopify operators are neutralized", () => {
    expect(buildShopifyNameQueries("Mary O'Brien")).toEqual([
      "Mary O'Brien",
      'first_name:"Mary" last_name:"O\'Brien"',
    ]);
    // A crafted input cannot smuggle field filters, negation, wildcards or
    // quotes into the free-text query.
    expect(buildShopifyNameQueries('email:x "y" (z) -*')).toEqual(["email x y z"]);
  });

  it("escapeShopifyQueryValue escapes quotes and backslashes for quoted values", () => {
    expect(escapeShopifyQueryValue('O"Brien\\')).toBe('O\\"Brien\\\\');
  });

  it("blank input builds nothing", () => {
    expect(buildShopifyNameQueries("   ")).toEqual([]);
  });
});

describe("ShopifyCRMAdapter.searchByName", () => {
  it("full-name search merges default + filter queries and dedupes by id", async () => {
    const adapter = new ShopifyCRMAdapter("tenant-a");
    executeAdapterToolMock
      .mockResolvedValueOnce({ ok: true, result: [shopifyCustomer(), shopifyCustomer({ id: 222, first_name: "Omer", last_name: "Serr" })] })
      .mockResolvedValueOnce({ ok: true, result: [shopifyCustomer()] }); // duplicate id 111
    const r = await adapter.searchByName("Omer Serruya");
    expect(r.ok).toBe(true);
    expect(r.candidates.map((c) => c.id)).toEqual(["111", "222"]);
    expect(executeAdapterToolMock).toHaveBeenCalledTimes(2);
    expect(executeAdapterToolMock.mock.calls[0][0]).toMatchObject({
      tenantId: "tenant-a",
      toolFunctionName: "shopify.search_customers",
      args: { query: "Omer Serruya", limit: 8 },
    });
    expect(executeAdapterToolMock.mock.calls[1][0].args.query).toBe('first_name:"Omer" last_name:"Serruya"');
  });

  it("first-name-only and last-name-only searches issue one default query", async () => {
    const adapter = new ShopifyCRMAdapter("tenant-a");
    for (const q of ["Omer", "Serruya"]) {
      executeAdapterToolMock.mockReset();
      executeAdapterToolMock.mockResolvedValue({ ok: true, result: [shopifyCustomer()] });
      const r = await adapter.searchByName(q);
      expect(r.ok).toBe(true);
      expect(r.candidates).toHaveLength(1);
      expect(executeAdapterToolMock).toHaveBeenCalledTimes(1);
      expect(executeAdapterToolMock.mock.calls[0][0].args.query).toBe(q);
    }
  });

  it("returns candidate rows with id, name, identifiers, order count and spend", async () => {
    const adapter = new ShopifyCRMAdapter("tenant-a");
    executeAdapterToolMock.mockResolvedValue({ ok: true, result: [shopifyCustomer()] });
    const r = await adapter.searchByName("Omer");
    expect(r.candidates[0]).toEqual({
      id: "111",
      kind: "contact",
      display_name: "Omer Serruya",
      email: "omer@example.com",
      phone: "+972521234567",
      orders_count: 4,
      total_spent: "612.00",
      currency: "ILS",
    });
  });

  it("multiple customers with the same name: ALL candidates returned, none auto-picked", async () => {
    const adapter = new ShopifyCRMAdapter("tenant-a");
    executeAdapterToolMock.mockResolvedValue({
      ok: true,
      result: [
        shopifyCustomer({ id: 1, email: "a@x.com" }),
        shopifyCustomer({ id: 2, email: "b@x.com" }),
        shopifyCustomer({ id: 3, email: "c@x.com" }),
      ],
    });
    const r = await adapter.searchByName("Omer");
    expect(r.candidates).toHaveLength(3);
    expect(new Set(r.candidates.map((c) => c.id)).size).toBe(3);
  });

  it("caps merged results at the requested limit", async () => {
    const adapter = new ShopifyCRMAdapter("tenant-a");
    const many = Array.from({ length: 30 }, (_, i) => shopifyCustomer({ id: i + 1 }));
    executeAdapterToolMock.mockResolvedValue({ ok: true, result: many });
    const r = await adapter.searchByName("Omer", 5);
    expect(r.candidates).toHaveLength(5);
    expect(executeAdapterToolMock.mock.calls[0][0].args.limit).toBe(5);
  });

  it("no results: ok with an empty candidate list", async () => {
    const adapter = new ShopifyCRMAdapter("tenant-a");
    executeAdapterToolMock.mockResolvedValue({ ok: true, result: [] });
    const r = await adapter.searchByName("Nobody Here");
    expect(r).toEqual({ ok: true, candidates: [] });
  });

  it("missing read_customers scope propagates as a failure reason", async () => {
    const adapter = new ShopifyCRMAdapter("tenant-a");
    executeAdapterToolMock.mockResolvedValue({ ok: false, reason: "missing_scopes:read_customers" });
    const r = await adapter.searchByName("Omer Serruya");
    expect(r.ok).toBe(false);
    expect(r.candidates).toEqual([]);
    expect(r.reason).toBe("missing_scopes:read_customers");
  });

  it("a failed SECONDARY filter query degrades to the primary results", async () => {
    const adapter = new ShopifyCRMAdapter("tenant-a");
    executeAdapterToolMock
      .mockResolvedValueOnce({ ok: true, result: [shopifyCustomer()] })
      .mockResolvedValueOnce({ ok: false, reason: "rate_limited" });
    const r = await adapter.searchByName("Omer Serruya");
    expect(r.ok).toBe(true);
    expect(r.candidates).toHaveLength(1);
  });

  it("cross-tenant isolation: every tool call carries the adapter's own tenantId", async () => {
    executeAdapterToolMock.mockResolvedValue({ ok: true, result: [] });
    await new ShopifyCRMAdapter("tenant-a").searchByName("Omer Serruya");
    await new ShopifyCRMAdapter("tenant-b").searchByName("Omer Serruya");
    const tenants = executeAdapterToolMock.mock.calls.map((c: any[]) => c[0].tenantId);
    expect(tenants.slice(0, 2)).toEqual(["tenant-a", "tenant-a"]);
    expect(tenants.slice(2)).toEqual(["tenant-b", "tenant-b"]);
  });
});

describe("picker-list masking", () => {
  it("masks phones to prefix + last two digits", () => {
    expect(maskPhone("+972521234567")).toBe("+972•••••••67");
    expect(maskPhone(null)).toBeNull();
  });

  it("masks emails to first character + domain", () => {
    expect(maskEmail("omer@example.com")).toBe("o•••@example.com");
    expect(maskEmail(null)).toBeNull();
  });
});
