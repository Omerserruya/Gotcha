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

const prismaMock = vi.hoisted(() => ({
  tenantIntegration: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(async () => ({})),
  },
  auditLog: { create: vi.fn(async () => ({})) },
}));

vi.mock("@chatcenter/shared", () => ({
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
      json: async () => ({ order: { id: 9, name: "#9" } }),
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
