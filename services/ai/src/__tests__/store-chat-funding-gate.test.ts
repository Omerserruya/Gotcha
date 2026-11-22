/**
 * The store chat is the Connector's to grant (split billing, 2026-10-30).
 *
 * Prod, Urban Supply: the Connector paid through Shopify
 * (shopify_storefront_widget, SHOPIFY_SUBSCRIPTION) and still no store chat,
 * because the gate also read the GOTCHA-side `shopify_live_chat` row - a TRIAL
 * `false` that no Shopify payment could ever turn on. The real
 * isFeatureEnabledForTenant runs here; only the database is a double.
 *   - Urban's exact rows: chat and product messaging on
 *   - no Connector: off, whatever the GOTCHA side says
 *   - a staff OVERRIDE false or a COMPLIANCE_DENY still turns it off; an expired one does not
 *   - the other Shopify features keep the veto: a GOTCHA-side false still denies
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));

const DB = vi.hoisted(() => ({
  entitlements: [] as any[],
  features: [] as any[],
}));

vi.mock("../../../../packages/shared/src/lib/prisma", async (importOriginal) => {
  const actual: any = await importOriginal();
  const prisma = {
    tenantEntitlement: {
      // The where as Prisma reads it: keys AND together, OR / AND / NOT lists, equality, { in }, { notIn },
      // { not } (2026-11-22: the Shopify gate names its sources as an OR of (source[, reason])).
      findMany: async ({ where }: any) => {
        const m = (r: any, w: any): boolean => Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
          if (k === "OR") return (v as any[]).some((x) => m(r, x));
          if (k === "AND") return (Array.isArray(v) ? v : [v]).every((x: any) => m(r, x));
          if (k === "NOT") return !(Array.isArray(v) ? v : [v]).some((x: any) => m(r, x));
          if (v && typeof v === "object" && !(v instanceof Date)) {
            if ("in" in v) return (v.in as any[]).includes(r[k]);
            if ("notIn" in v) return !(v.notIn as any[]).includes(r[k]);
            if ("not" in v) return (r[k] ?? null) !== v.not;
            return true;
          }
          return (r[k] ?? null) === v;
        });
        return DB.entitlements.filter((r) => m(r, where));
      },
    },
    tenantFeature: { findMany: async ({ where }: any) => DB.features.filter((r) => r.tenantId === where.tenantId) },
    tenant: { findUnique: async () => ({ botEnabled: true, firstTakeCareEnabled: false, voiceCopilotEnabled: false, voiceInboxUiEnabled: false, voiceIncomingEnabled: false }) },
  };
  return { ...actual, prisma };
});

import { isFeatureEnabledForTenant, FEATURES } from "@chatcenter/shared";

let n = 0;
const ent = (tenantId: string, entitlementKey: string, on: boolean, source: string, expiresAt: Date | null = null) =>
  DB.entitlements.push({ tenantId, entitlementKey, value: { bool: on }, source, expiresAt });
const feat = (tenantId: string, feature: string, enabled: boolean) => DB.features.push({ tenantId, feature, enabled });

/** Urban Supply on prod, 2026-10-30, row for row. */
function urban(): string {
  const t = `urban-${++n}`;
  for (const k of ["shopify_storefront_widget", "shopify_catalog_sync", "shopify_order_read", "shopify_order_actions"]) {
    ent(t, k, true, "SHOPIFY_SUBSCRIPTION");
  }
  ent(t, "commerce.shopify_live_chat", false, "TRIAL", new Date("2027-05-31"));
  ent(t, "commerce.shopify_product_messaging", false, "TRIAL", new Date("2027-05-31"));
  feat(t, "shopify_live_chat", false);
  feat(t, "commerce.shopify_live_chat", false);
  feat(t, "shopify_storefront_widget", false);
  feat(t, "shopify_integration", true);
  return t;
}

beforeEach(() => {
  DB.entitlements = [];
  DB.features = [];
});

describe("the store chat is granted by the Connector", () => {
  it("Urban's exact rows: store chat and product messaging are on", async () => {
    const t = urban();
    expect(await isFeatureEnabledForTenant(t, FEATURES.SHOPIFY_LIVE_CHAT)).toBe(true);
    expect(await isFeatureEnabledForTenant(t, FEATURES.SHOPIFY_PRODUCT_MESSAGING)).toBe(true);
  });

  it("no Connector: off, even with a GOTCHA-side true", async () => {
    const t = `noconn-${++n}`;
    ent(t, "commerce.shopify_live_chat", true, "TRIAL");
    feat(t, "shopify_live_chat", true);
    expect(await isFeatureEnabledForTenant(t, FEATURES.SHOPIFY_LIVE_CHAT)).toBe(false);
  });

  it("a Connector without the storefront capability: no store chat", async () => {
    const t = urban();
    DB.entitlements = DB.entitlements.filter((r) => !(r.tenantId === t && r.entitlementKey === "shopify_storefront_widget"));
    expect(await isFeatureEnabledForTenant(t, FEATURES.SHOPIFY_LIVE_CHAT)).toBe(false);
    expect(await isFeatureEnabledForTenant(t, FEATURES.SHOPIFY_PRODUCT_MESSAGING)).toBe(true);
  });
});

describe("a deliberate staff decision still wins", () => {
  it("an OVERRIDE false on the canonical key turns it off", async () => {
    const t = urban();
    ent(t, "commerce.shopify_live_chat", false, "OVERRIDE");
    expect(await isFeatureEnabledForTenant(t, FEATURES.SHOPIFY_LIVE_CHAT)).toBe(false);
  });
  it("a COMPLIANCE_DENY turns it off", async () => {
    const t = urban();
    ent(t, "commerce.shopify_live_chat", true, "COMPLIANCE_DENY");
    expect(await isFeatureEnabledForTenant(t, FEATURES.SHOPIFY_LIVE_CHAT)).toBe(false);
  });
  it("an expired OVERRIDE false no longer does", async () => {
    const t = urban();
    ent(t, "commerce.shopify_live_chat", false, "OVERRIDE", new Date(Date.now() - 1000));
    expect(await isFeatureEnabledForTenant(t, FEATURES.SHOPIFY_LIVE_CHAT)).toBe(true);
  });
});

describe("the other Shopify features keep the veto", () => {
  it("a GOTCHA-side false still denies the integration, Connector paid or not", async () => {
    const t = urban();
    DB.features = DB.features.map((r) => (r.tenantId === t && r.feature === "shopify_integration" ? { ...r, enabled: false } : r));
    expect(await isFeatureEnabledForTenant(t, FEATURES.SHOPIFY_INTEGRATION)).toBe(false);
  });
  it("and allows it when switched on and funded", async () => {
    const t = urban();
    expect(await isFeatureEnabledForTenant(t, FEATURES.SHOPIFY_INTEGRATION)).toBe(true);
  });
});
