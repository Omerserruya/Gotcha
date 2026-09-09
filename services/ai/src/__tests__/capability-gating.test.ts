/**
 * Capability gating: a Shopify shop that never granted a scope must not be
 * hammered with predictable 403s, and the AI must never be offered (or open a
 * HITL for) a tool that cannot execute.
 *
 * Live incident locked in here: urban-supply's shop lacks merchant approval
 * for write_customers and read/write_price_rules - update_customer 403'd on
 * every bot turn, and an issue_compensation_coupon HITL was approved that
 * could never run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { orderNode } from "./helpers/shopify-graphql-fixtures";

const prismaMock = vi.hoisted(() => ({
  tenantIntegration: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(async () => ({})),
  },
  auditLog: { create: vi.fn(async () => ({})) },
}));

vi.mock("@chatcenter/shared", () => ({
  // Durable tenant settings (business hours, auto-greeting, SLA). Exhaustive
  // mocks of this barrel must supply them or the read path throws instead of
  // returning "not configured". Default: nothing configured.
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: prismaMock,
  encryptCredentials: (v: unknown) => v,
  decryptCredentials: (v: unknown) => v,
  assertPublicUrl: vi.fn(async () => {}),
}));

import {
  executeAdapterTool,
  missingScopesFromConfig,
  toolBlockedByMissingScopes,
  extractMissingScopes,
  getAdapter,
  refreshCapabilityState,
  capabilityStateIsFresh,
  CAPABILITY_FRESHNESS_MS,
} from "../services/connectors/integration-framework";
import "../services/connectors/shopify.adapter";

const CONN = (config: Record<string, unknown>) => ({
  id: "ti1",
  status: "CONNECTED",
  credentials: { accessToken: "shpat_x" },
  config,
  integration: { slug: "shopify" },
});

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
});

describe("scope metadata", () => {
  it("Shopify write tools declare their required scopes", () => {
    const tools = getAdapter("shopify")!.tools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("shopify.update_customer")!.requiredScopes).toContain("write_customers");
    expect(byName.get("shopify.cancel_order")!.requiredScopes).toContain("write_orders");
    expect(byName.get("shopify.process_refund")!.requiredScopes).toContain("write_orders");
    expect(byName.get("shopify.issue_compensation_coupon")!.requiredScopes).toContain("write_price_rules");
    expect(byName.get("shopify.list_discounts")!.requiredScopes).toContain("read_price_rules");
  });

  it("extractMissingScopes parses Shopify's merchant-approval 403", () => {
    expect(
      extractMissingScopes('shopify_403: {"errors":"[API] This action requires merchant approval for write_customers scope."}'),
    ).toEqual(["write_customers"]);
    expect(extractMissingScopes("order_not_found")).toEqual([]);
  });

  it("toolBlockedByMissingScopes matches only declared scopes", () => {
    const def: any = { name: "shopify.add_tag", requiredScopes: ["write_customers"] };
    expect(toolBlockedByMissingScopes(def, ["write_customers"])).toBe(true);
    expect(toolBlockedByMissingScopes(def, ["write_orders"])).toBe(false);
    expect(toolBlockedByMissingScopes({ name: "x" } as any, ["write_customers"])).toBe(false);
  });

  it("missingScopesFromConfig tolerates absent/garbage config", () => {
    expect(missingScopesFromConfig(undefined)).toEqual([]);
    expect(missingScopesFromConfig({ missingScopes: "nope" } as any)).toEqual([]);
    expect(missingScopesFromConfig({ missingScopes: ["a", "", 3, "b"] } as any)).toEqual(["a", "b"]);
  });
});

describe("proactive capability discovery", () => {
  it("refreshCapabilityState persists granted scopes, missing scopes, and a freshness anchor", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValue(CONN({ shopDomain: "s.myshopify.com" }));
    prismaMock.tenantIntegration.findUnique.mockResolvedValue({ config: { shopDomain: "s.myshopify.com" } });
    (globalThis as any).fetch = vi.fn(async (url: string) =>
      /access_scopes\.json/.test(String(url))
        ? { ok: true, status: 200, json: async () => ({ access_scopes: [{ handle: "read_orders" }, { handle: "read_customers" }, { handle: "read_products" }] }) }
        : { ok: false, status: 404, json: async () => ({}), text: async () => "{}" },
    );
    const r = await refreshCapabilityState({ tenantId: "t1", slug: "shopify" });
    expect(r.ok).toBe(false); // write scopes are missing
    expect(r.missingScopes).toContain("write_orders");
    const write = prismaMock.tenantIntegration.update.mock.calls.map((c: any[]) => c[0])
      .find((w: any) => w?.data?.config?.capabilityState);
    expect(write.data.config.capabilityState.grantedScopes).toContain("read_orders");
    expect(write.data.config.capabilityState.status).toBe("missing_scopes");
    expect(write.data.config.capabilityState.lastCheckedAt).toBeTruthy();
    // enforcement state follows the enumerated probe
    expect(write.data.config.missingScopes).toContain("write_price_rules");
  });

  it("a fully-granted probe clears the enforcement state", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValue(
      CONN({ shopDomain: "s.myshopify.com", missingScopes: ["write_customers"] }),
    );
    prismaMock.tenantIntegration.findUnique.mockResolvedValue({
      config: { shopDomain: "s.myshopify.com", missingScopes: ["write_customers"] },
    });
    // "Fully granted" now includes fulfillment orders, inventory and returns.
    // A connection without them used to test GREEN while answering every
    // shipping and cancellability question from fields that read null, so a
    // green connection that cannot see fulfillment is not a passing state.
    //
    // `write_returns` and `write_order_edits` joined the list when returns and
    // exchanges got tools. Both had been granted-but-unused, and leaving them
    // out of the connection test is how an exchange reached a live store and
    // failed at the last GraphQL call with "Requires `write_order_edits`
    // access scope" - after eligibility passed and a human had approved it.
    const all = [
      "read_customers", "write_customers", "read_orders", "write_orders",
      "read_products", "read_price_rules", "write_price_rules",
      "read_merchant_managed_fulfillment_orders", "read_inventory",
      "read_returns", "write_returns", "write_order_edits",
    ];
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ access_scopes: all.map((handle) => ({ handle })) }),
    }));
    const r = await refreshCapabilityState({ tenantId: "t1", slug: "shopify" });
    expect(r.ok).toBe(true);
    const write = prismaMock.tenantIntegration.update.mock.calls.map((c: any[]) => c[0])
      .find((w: any) => w?.data?.config?.capabilityState);
    expect(write.data.config.capabilityState.status).toBe("ok");
    expect(write.data.config.missingScopes).toBeUndefined();
  });

  it("freshness policy: no snapshot or an expired snapshot is stale; a recent one is fresh", () => {
    expect(capabilityStateIsFresh(undefined)).toBe(false);
    expect(capabilityStateIsFresh({})).toBe(false);
    expect(capabilityStateIsFresh({ capabilityState: { lastCheckedAt: new Date(Date.now() - CAPABILITY_FRESHNESS_MS - 1000).toISOString() } })).toBe(false);
    expect(capabilityStateIsFresh({ capabilityState: { lastCheckedAt: new Date().toISOString() } })).toBe(true);
  });

  it("a probe that errors WITHOUT enumerating scopes keeps the last known enforcement state", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValue(
      CONN({ shopDomain: "s.myshopify.com", missingScopes: ["write_customers"] }),
    );
    prismaMock.tenantIntegration.findUnique.mockResolvedValue({
      config: { shopDomain: "s.myshopify.com", missingScopes: ["write_customers"] },
    });
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "{}" }));
    const r = await refreshCapabilityState({ tenantId: "t1", slug: "shopify" });
    expect(r.ok).toBe(false);
    const write = prismaMock.tenantIntegration.update.mock.calls.map((c: any[]) => c[0])
      .find((w: any) => w?.data?.config?.capabilityState);
    expect(write.data.config.capabilityState.status).toBe("error");
    // last-known missing scopes survive an inconclusive probe
    expect(write.data.config.missingScopes).toEqual(["write_customers"]);
  });
});

describe("executeAdapterTool pre-flight short-circuit", () => {
  it("known-missing scope fails locally with NO provider HTTP call", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValue(
      CONN({ shopDomain: "s.myshopify.com", missingScopes: ["write_customers"] }),
    );
    const r = await executeAdapterTool({
      tenantId: "t1",
      toolFunctionName: "shopify.update_customer",
      args: { customer_id: "1", fields: { note: "x" } },
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(/missing_scope:write_customers/);
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });

  it("tools whose scopes are granted are unaffected by other missing scopes", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValue(
      CONN({ shopDomain: "s.myshopify.com", missingScopes: ["write_price_rules"] }),
    );
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true, status: 200,
      // The order read is Admin GraphQL now.
      json: async () => ({ data: { order: orderNode({ id: 9, name: "#9" }) } }),
      text: async () => "{}",
    }));
    const r = await executeAdapterTool({
      tenantId: "t1",
      toolFunctionName: "shopify.get_order",
      args: { order_id: "9" },
    });
    expect(r.ok).toBe(true);
    expect((globalThis as any).fetch).toHaveBeenCalled();
  });

  it("a merchant-approval 403 persists the scope so the NEXT call short-circuits", async () => {
    prismaMock.tenantIntegration.findFirst.mockResolvedValue(
      CONN({ shopDomain: "s.myshopify.com" }),
    );
    // updateMissingScopes re-reads config through findUnique before writing.
    prismaMock.tenantIntegration.findUnique.mockResolvedValue({ config: { shopDomain: "s.myshopify.com" } });
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      if (/customers\/search/.test(String(url))) {
        return { ok: true, status: 200, json: async () => ({ customers: [{ id: 5, tags: "" }] }), text: async () => "{}" };
      }
      return {
        ok: false, status: 403,
        text: async () => '{"errors":"[API] This action requires merchant approval for write_customers scope."}',
        json: async () => ({}),
      };
    });
    const r = await executeAdapterTool({
      tenantId: "t1",
      toolFunctionName: "shopify.add_tag",
      args: { customer_id: "5", tag: "vip" },
    });
    expect(r.ok).toBe(false);
    // the missing scope was written back onto the connection config
    const writes = prismaMock.tenantIntegration.update.mock.calls.map((c: any[]) => c[0]);
    const scopeWrite = writes.find((w: any) => Array.isArray(w?.data?.config?.missingScopes));
    expect(scopeWrite?.data?.config?.missingScopes).toContain("write_customers");
  });
});
