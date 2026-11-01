/**
 * A pilot gets EVERYTHING (Omer, 2026-11-01).
 *
 * Prod, One Of A Kind (POC from the console, "everything on"): automations,
 * broadcasts, the dashboard and nine more were TRIAL false, and
 * POST /api/automations answered 402. The capability keys were matched to the
 * picked areas by their first segment, and communication / commerce / manager
 * match no area.
 *   - provisioning writes every area and every capability true, whatever was picked
 *   - the Shopify pair stays false: a TRIAL row never funds Shopify
 *   - the repair flips an existing pilot's false rows, keeps its expiry, and writes
 *     nothing in a dry run; a paying tenant is never touched
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  ents: new Map<string, { value: unknown; source: string; expiresAt: Date | null }>(),
  writes: [] as any[],
  materialized: 0,
  sub: { id: "sub1", status: "ACTIVE", planKey: "poc", planVersion: 1, currentPeriodEnd: new Date("2026-12-20T00:00:00Z") } as any,
  planKind: "POC",
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    setTenantEntitlement: vi.fn(async (i: any) => {
      H.writes.push(i);
      H.ents.set(i.key, { value: i.value, source: i.source, expiresAt: i.expiresAt ?? null });
    }),
    materializeEntitlements: vi.fn(async () => { H.materialized++; }),
    invalidatePermissionsCache: vi.fn(),
    rolloverIncluded: vi.fn(async () => undefined),
    getBalance: vi.fn(async () => ({ balance: 0 })),
    prisma: {
      tenant: { findUnique: async () => ({ id: "t1" }) },
      plan: { upsert: async () => ({}), findUnique: async () => ({ kind: H.planKind }) },
      subscription: { upsert: async () => H.sub },
      subscriptionEvent: { create: async () => ({}) },
      billableEntityTenant: { findUnique: async () => ({ entity: { subscription: H.sub } }) },
      tenantEntitlement: {
        findMany: async ({ where }: any) =>
          [...H.ents.entries()]
            .filter(([k, v]) => v.source === where.source && where.entitlementKey.in.includes(k))
            .map(([k, v]) => ({ entitlementKey: k, value: v.value })),
      },
    },
  };
});
vi.mock("../services/billable-entity.service", () => ({ ensureBillableEntity: async () => "e1", tenantsForEntity: async () => ["t1"] }));
vi.mock("../lib/events", () => ({ emitBillingEvent: async () => undefined }));
vi.mock("../services/evaluation-ended.service", () => ({ sendEvaluationEndedEmail: async () => undefined }));

import { provisionPoc, grantAllEvaluationFeatures, POC_FEATURE_DOMAINS, PILOT_CAPABILITY_KEYS } from "../services/poc.service";

const SHOPIFY = ["commerce.shopify_live_chat", "commerce.shopify_product_messaging"];
const PROD_FALSE = [
  "communication.automations", "communication.broadcasts", "communication.crm_summaries", "communication.omnichannel",
  "communication.social_engagement", "commerce.auto_buy", "manager.dashboard", "manager.data_retention",
  "manager.integrations", "manager.representative_tracking",
];
const valueOf = (k: string) => {
  const v: any = H.ents.get(k)?.value;
  return typeof v === "boolean" ? v : Boolean(v?.bool ?? v?.value);
};

beforeEach(() => {
  H.ents.clear(); H.writes = []; H.materialized = 0; H.planKind = "POC";
  H.sub = { id: "sub1", status: "ACTIVE", planKey: "poc", planVersion: 1, currentPeriodEnd: new Date("2026-12-20T00:00:00Z") };
});

describe("provisioning a pilot", () => {
  it("the console's 'everything on' (every area listed) turns every capability on, automations first", async () => {
    await provisionPoc({ tenantId: "t1", credits: 1000, expiresAt: new Date("2026-12-20T00:00:00Z"), features: [...POC_FEATURE_DOMAINS] });
    for (const k of PROD_FALSE) expect(valueOf(k), k).toBe(true);
    for (const d of POC_FEATURE_DOMAINS) expect(valueOf(d), d).toBe(true);
  });

  it("even a narrow pick gets everything now", async () => {
    const r = await provisionPoc({ tenantId: "t1", credits: 1000, expiresAt: new Date("2026-12-20T00:00:00Z"), features: ["conversation"] });
    expect(r.featuresDenied).toEqual([]);
    for (const k of PILOT_CAPABILITY_KEYS.filter((k) => !SHOPIFY.includes(k))) expect(valueOf(k), k).toBe(true);
  });

  it("the Shopify pair stays false: the Connector funds it, never a trial", async () => {
    await provisionPoc({ tenantId: "t1", credits: 1000, expiresAt: new Date("2026-12-20T00:00:00Z") });
    for (const k of SHOPIFY) expect(valueOf(k), k).toBe(false);
  });

  it("still refuses an unknown area name", async () => {
    await expect(provisionPoc({ tenantId: "t1", credits: 1000, expiresAt: new Date("2026-12-20T00:00:00Z"), features: ["nope"] })).rejects.toThrow(/unknown_feature_domain/);
  });
});

describe("repairing a live pilot", () => {
  const prodShape = () => {
    for (const k of [...POC_FEATURE_DOMAINS, ...PILOT_CAPABILITY_KEYS]) {
      H.ents.set(k, { value: !PROD_FALSE.includes(k) && !SHOPIFY.includes(k), source: "TRIAL", expiresAt: new Date("2026-12-20T00:00:00Z") });
    }
  };

  it("a dry run lists exactly prod's ten false capabilities and writes nothing", async () => {
    prodShape();
    const r = await grantAllEvaluationFeatures({ tenantId: "t1", apply: false });
    expect(r.evaluation).toBe(true);
    expect(r.changes.map((c) => c.key).sort()).toEqual([...PROD_FALSE].sort());
    expect(r.changes.every((c) => c.from === false && c.to === true)).toBe(true);
    expect(H.writes).toHaveLength(0);
    expect(H.materialized).toBe(0);
  });

  it("applied: those ten on, on the pilot's own expiry, the Shopify pair untouched, materialized once", async () => {
    prodShape();
    await grantAllEvaluationFeatures({ tenantId: "t1", apply: true, actor: "ops" });
    for (const k of PROD_FALSE) expect(valueOf(k), k).toBe(true);
    for (const k of SHOPIFY) expect(valueOf(k), k).toBe(false);
    expect(H.writes.every((w) => w.source === "TRIAL" && +w.expiresAt === +H.sub.currentPeriodEnd)).toBe(true);
    expect(H.materialized).toBe(1);
  });

  it("a second run changes nothing", async () => {
    prodShape();
    await grantAllEvaluationFeatures({ tenantId: "t1", apply: true });
    H.writes = [];
    expect((await grantAllEvaluationFeatures({ tenantId: "t1", apply: true })).changes).toEqual([]);
    expect(H.writes).toHaveLength(0);
  });

  it("a paying tenant is never touched", async () => {
    prodShape();
    H.planKind = "PUBLIC";
    expect(await grantAllEvaluationFeatures({ tenantId: "t1", apply: true })).toEqual({ evaluation: false, changes: [] });
    expect(H.writes).toHaveLength(0);
  });
});
