import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

/**
 * The public catalog is the one pricing route that answers without a token, so
 * a leak here is a public leak. These tests are mostly about what must NOT come
 * out of it.
 *
 * The prisma mock holds a deliberately hostile catalog: alongside the three
 * public plans there is a DRAFT, a RETIRED version, another organization's
 * CUSTOM plan, a POC and a Trial. If the route filtered by anything weaker than
 * the query itself, they would show up here.
 */

const plans: any[] = [];
const estimationRows: any[] = [];
let currencyRow: any = null;
let fxRow: any = null;

// estimation.ts and currency.ts import prisma from the shared package's own
// lib/prisma, NOT through the barrel - so mocking "@chatcenter/shared" alone
// leaves them talking to a real client. Without this, resolveEstimation() threw,
// fell back to FALLBACK_ESTIMATION, and the ratio assertions passed for the
// wrong reason.
vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    publicEstimationConfig: { findFirst: async ({ where }: any) => {
      if (where?.scope && where.scope !== "GLOBAL") return null; // no plan-scoped override
      return estimationRows[0] ?? null;
    } },
    pricingCurrencyConfig: { findFirst: async () => currencyRow },
    fxRateSnapshot: { findFirst: async () => fxRow, upsert: async () => ({}) },
    plan: { findMany: async () => [], findFirst: async () => null },
  },
  // The shared barrel re-exports these from the same module, so a partial mock
  // would break every import of "@chatcenter/shared".
  withCrossTenantAccess: (fn: any) => fn(),
  crossTenantMiddleware: {},
}));

vi.mock("@chatcenter/shared", async () => {
  const actual: any = await vi.importActual("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      plan: {
        findMany: async ({ where }: any) =>
          plans.filter((p) => {
            if (where.status && p.status !== where.status) return false;
            const or = where.OR ?? [];
            const matchesOr =
              or.length === 0 ||
              or.some((c: any) => (c.kind ? p.kind === c.kind : true) && ("tenantId" in c ? p.tenantId === c.tenantId : true));
            return matchesOr;
          }),
        findFirst: async () => plans.find((p) => p.status === "ACTIVE" && p.kind === "PUBLIC") ?? null,
      },
      publicEstimationConfig: { findFirst: async () => estimationRows[0] ?? null },
      pricingCurrencyConfig: { findFirst: async () => currencyRow },
      fxRateSnapshot: { findFirst: async () => fxRow },
    },
  };
});

import express from "express";
import request from "supertest";
import publicPricingRouter, { publicPricingEnabled } from "../routes/public-pricing";
import { invalidateEstimationCache, invalidateCurrencyCache } from "@chatcenter/shared";

function app() {
  const a = express();
  a.use("/api", publicPricingRouter);
  return a;
}

function plan(over: Partial<any> = {}) {
  const base = {
    id: `plan-${plans.length + 1}`,
    key: "foundation",
    version: 1,
    name: "Foundation",
    nameHe: "בסיס",
    descriptionEn: "Every conversation in one place.",
    descriptionHe: "כל השיחות במקום אחד.",
    status: "ACTIVE",
    kind: "PUBLIC",
    tenantId: null,
    basePrice: "149.00",
    currency: "USD",
    includedAiUnits: 2000,
    billingInterval: "MONTHLY",
    salesOnly: false,
    sortOrder: 10,
    recommended: false,
    supportLevel: "standard",
    chatVolumeEnabled: false,
    voiceVolumeEnabled: false,
    autoPurchaseEligible: true,
    creditPackagesEligible: true,
    effectiveFrom: null,
    effectiveTo: null,
    updatedAt: new Date("2026-08-01"),
    // Fields that must NEVER reach a public response.
    internalNote: "PROVISIONAL - do not enable live checkout",
    publishedBy: "seed",
    approvalState: "APPROVED",
    entitlements: [
      { entitlementKey: "communication.omnichannel", valueType: "BOOLEAN", value: { bool: true } },
      { entitlementKey: "ai.employee", valueType: "BOOLEAN", value: { bool: false } },
      // Catalogued but NOT built - must not surface publicly at all.
      { entitlementKey: "manager.auto_csat", valueType: "BOOLEAN", value: { bool: true } },
      { entitlementKey: "limit:ai_employees", valueType: "COUNTER", value: { count: 0 } },
      { entitlementKey: "config:credit_split", valueType: "CONFIG", value: { chat: 2000, voice: 0 } },
    ],
    volumeOptions: [],
  };
  return { ...base, ...over };
}

beforeEach(() => {
  // The estimation and currency loaders hold a 30s in-process cache. Without
  // clearing it, one test's ratio leaks into the next and an assertion can pass
  // against a stale value.
  invalidateEstimationCache();
  invalidateCurrencyCache();
  plans.length = 0;
  estimationRows.length = 0;
  currencyRow = {
    baseCurrency: "USD",
    displayCurrencies: ["USD", "ILS"],
    ilsRoundingIncrement: 5,
    roundingMode: "UP",
    fxSource: "boi",
    fxRefreshHours: 24,
    fallbackUsdIls: "3.70",
    chargeInDisplayCurrency: false,
    updatedAt: new Date("2026-08-01"),
  };
  fxRow = { rate: "3.70", source: "boi", rateDate: "2026-08-01", fetchedAt: new Date(), quoteCurrency: "ILS", baseCurrency: "USD" };
  estimationRows.push({
    id: "est-1", scope: "GLOBAL", version: 1, active: true,
    chatCreditsPerEstimatedConversation: 8, voiceCreditsPerEstimatedCall: 20,
    businessDaysPerMonth: 25, createdAt: new Date("2026-08-01"),
    internalNote: "Initial commercial assumption",
  });
  process.env.PUBLIC_PRICING_ENABLED = "true";
});

afterEach(() => {
  delete process.env.PUBLIC_PRICING_ENABLED;
});

// ── Feature flag ────────────────────────────────────────────────────────────

describe("publication flag", () => {
  it("defaults to DISABLED when the variable is absent", () => {
    expect(publicPricingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is disabled for every value that is not exactly true", () => {
    for (const v of ["false", "0", "no", "", "TRUE ", "yes"]) {
      expect(publicPricingEnabled({ PUBLIC_PRICING_ENABLED: v } as any), v).toBe(false);
    }
    expect(publicPricingEnabled({ PUBLIC_PRICING_ENABLED: "true" } as any)).toBe(true);
    expect(publicPricingEnabled({ PUBLIC_PRICING_ENABLED: "TRUE" } as any)).toBe(true);
  });

  it("404s the public catalog when disabled, revealing nothing", async () => {
    process.env.PUBLIC_PRICING_ENABLED = "false";
    plans.push(plan());
    const res = await request(app()).get("/api/public/pricing");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    // A disabled page must not hint that a catalog exists.
    expect(JSON.stringify(res.body)).not.toMatch(/plan|price|pricing_disabled/i);
  });
});

// ── What it returns ─────────────────────────────────────────────────────────

describe("public catalog contents", () => {
  it("returns active public plans", async () => {
    plans.push(plan({ key: "foundation" }), plan({ key: "ai_workforce", id: "p2", sortOrder: 20, recommended: true }));
    const res = await request(app()).get("/api/public/pricing");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.plans.map((p: any) => p.key)).toEqual(["foundation", "ai_workforce"]);
  });

  it("prices from the canonical service, not a duplicated formula", async () => {
    plans.push(plan());
    const res = await request(app()).get("/api/public/pricing");
    const p = res.body.plans[0];
    expect(p.price.formatted).toBe("$149");
    expect(p.includedCredits).toBe(2000);
    // 2,000 credits / 8 per chat = 250 a month at the configured ratio.
    expect(p.estimate.chat.monthly).toBe(250);
    expect(p.estimate.ratios.chatCreditsPerEstimatedConversation).toBe(8);
  });

  /**
   * The bug this guards: `config:credit_split` is seeded once and cloned into
   * every new version, while the plan editor writes `includedAiUnits`. The
   * split was believed over the plan's own total, so a plan edited to 10,000
   * credits still advertised - and, through quoteFor(), still SOLD and granted
   * - the seeded 2,000.
   */
  it("sells the plan's included credits, not a stale channel split", async () => {
    plans.push(
      plan({
        includedAiUnits: 10_000,
        entitlements: [{ entitlementKey: "config:credit_split", valueType: "CONFIG", value: { chat: 2000, voice: 0 } }],
      }),
    );

    const p = (await request(app()).get("/api/public/pricing")).body.plans[0];
    expect(p.includedCredits).toBe(10_000);
    expect(p.creditSplit).toEqual({ chat: 10_000, voice: 0 });
    // 10,000 / 8 per chat. The old split would have claimed 250.
    expect(p.estimate.chat.monthly).toBe(1250);
  });

  /**
   * The bug this guards: the plan SELLS "10 conversations per business day" in
   * its selector, and separately carries a credit allowance. Editing the
   * allowance to 750 without touching the tiers made the catalog answer ~94 a
   * month - contradicting the very tier the visitor is choosing from.
   */
  it("advertises the volume the plan sells, not the volume its credits imply", async () => {
    plans.push(
      plan({
        includedAiUnits: 750,
        basePrice: "39.00",
        chatVolumeEnabled: true,
        entitlements: [{ entitlementKey: "config:credit_split", valueType: "CONFIG", value: { chat: 750, voice: 0 } }],
        volumeOptions: [
          {
            id: "vo-1", key: "chat_10", channel: "CHAT", dailyVolume: 10, monthlyVolume: 250,
            businessDaysPerMonth: 25, creditsPerUnit: "3.0000", additionalCredits: 0, additionalPrice: "0.00",
            currency: "USD", isDefault: true, enabled: true, sortOrder: 0, activeFrom: null, activeTo: null,
          },
        ],
      }),
    );

    const p = (await request(app()).get("/api/public/pricing")).body.plans[0];
    expect(p.estimate.chat.monthly).toBe(250);
    expect(p.estimate.chat.daily).toBe(10);
    expect(p.estimate.chat.basis).toBe("DECLARED_VOLUME");
    // And it says what that costs per conversation: 750 / 250.
    expect(p.estimate.chat.creditsPerUnit).toBe(3);
  });

  it("still divides by the ratio for a plan that sells no declared volume", async () => {
    plans.push(plan({ includedAiUnits: 750, entitlements: [{ entitlementKey: "config:credit_split", valueType: "CONFIG", value: { chat: 750, voice: 0 } }] }));
    const p = (await request(app()).get("/api/public/pricing")).body.plans[0];
    expect(p.estimate.chat.basis).toBe("CREDIT_RATIO");
    expect(p.estimate.chat.monthly).toBe(94); // 750 / 8, rounded
  });

  it("keeps the voice share when reconciling a stale split", async () => {
    plans.push(
      plan({
        includedAiUnits: 9000,
        entitlements: [{ entitlementKey: "config:credit_split", valueType: "CONFIG", value: { chat: 2000, voice: 5000 } }],
      }),
    );

    const p = (await request(app()).get("/api/public/pricing")).body.plans[0];
    expect(p.creditSplit).toEqual({ chat: 4000, voice: 5000 });
  });

  /**
   * Guards against the estimate silently coming from FALLBACK_ESTIMATION, which
   * happens to use the same 8/20/25 numbers as the seed. A non-default ratio
   * proves the CONFIGURED value is what reaches the public response.
   */
  it("uses the configured ratio, not the built-in fallback", async () => {
    estimationRows[0].chatCreditsPerEstimatedConversation = 16;
    estimationRows[0].businessDaysPerMonth = 20;
    plans.push(plan());

    const res = await request(app()).get("/api/public/pricing");
    const p = res.body.plans[0];
    expect(p.estimate.ratios.chatCreditsPerEstimatedConversation).toBe(16);
    expect(p.estimate.ratios.businessDaysPerMonth).toBe(20);
    // 2,000 / 16 = 125 a month, 125 / 20 business days = 6.25 a day.
    expect(p.estimate.chat.monthly).toBe(125);
    expect(p.estimate.chat.daily).toBeCloseTo(6.3, 1);
  });

  it("converts and rounds ILS server-side and labels it an estimate", async () => {
    plans.push(plan());
    const res = await request(app()).get("/api/public/pricing?currency=ILS");
    const p = res.body.plans[0];
    // 149 x 3.70 = 551.30, rounded up to the ₪5 increment.
    expect(p.price.formatted).toBe("₪555");
    expect(p.price.base.formatted).toBe("$149");
    expect(p.price.isEstimatedConversion).toBe(true);
    expect(p.price.chargedCurrency).toBe("USD");
    expect(res.body.currency.fx.rate).toBe("3.70");
  });

  it("ignores an unsupported currency rather than trusting the query", async () => {
    plans.push(plan());
    const res = await request(app()).get("/api/public/pricing?currency=XYZ");
    expect(res.body.currency.display).toBe("USD");
  });

  it("carries the estimate disclaimer in both locales", async () => {
    plans.push(plan());
    const res = await request(app()).get("/api/public/pricing");
    expect(res.body.disclaimer.en).toMatch(/based on the plan configuration/i);
    expect(res.body.disclaimer.he).toBeTruthy();
    expect(res.body.disclaimer.en).not.toMatch(/average|other customers/i);
  });

  it("localizes feature names for Hebrew", async () => {
    plans.push(plan());
    const en = await request(app()).get("/api/public/pricing?locale=en");
    const he = await request(app()).get("/api/public/pricing?locale=he");
    const f = (r: any) => r.body.plans[0].features.find((x: any) => x.key === "communication.omnichannel");
    expect(f(en).name).toBe("Omnichannel inbox");
    expect(f(he).name).toBe("תיבה מאוחדת רב-ערוצית");
  });
});

// ── What it must never return ───────────────────────────────────────────────

describe("private data never leaks publicly", () => {
  beforeEach(() => {
    plans.push(
      plan({ key: "foundation" }),
      plan({ id: "d1", key: "ai_workforce", status: "DRAFT", basePrice: "999.00", internalNote: "unreleased price" }),
      plan({ id: "r1", key: "legacy_pro", status: "RETIRED", kind: "LEGACY" }),
      plan({ id: "c1", key: "custom_acme", kind: "CUSTOM", tenantId: "tenant-acme", basePrice: "2500.00" }),
      plan({ id: "poc1", key: "poc", kind: "POC", salesOnly: true }),
      plan({ id: "t1", key: "trial", kind: "TRIAL", salesOnly: true }),
    );
  });

  it("excludes draft, retired, custom, POC and Trial plans", async () => {
    const res = await request(app()).get("/api/public/pricing");
    const keys = res.body.plans.map((p: any) => p.key);
    expect(keys).toEqual(["foundation"]);
    for (const forbidden of ["ai_workforce", "legacy_pro", "custom_acme", "poc", "trial"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("never leaks another organization's negotiated price", async () => {
    const res = await request(app()).get("/api/public/pricing");
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("2500.00");
    expect(raw).not.toContain("tenant-acme");
  });

  it("never leaks an unpublished draft price", async () => {
    const res = await request(app()).get("/api/public/pricing");
    expect(JSON.stringify(res.body)).not.toContain("999.00");
  });

  it("omits internal catalog metadata", async () => {
    const res = await request(app()).get("/api/public/pricing");
    const raw = JSON.stringify(res.body);
    for (const forbidden of ["internalNote", "PROVISIONAL", "publishedBy", "approvalState", "tenantId", "kind", "subscriberCount"]) {
      expect(raw, `public response must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("omits every internal usage, token and cost metric", async () => {
    const res = await request(app()).get("/api/public/pricing");
    const raw = JSON.stringify(res.body);
    for (const forbidden of [
      "token", "promptTokens", "completionTokens", "costUsd", "modelCost",
      "marginFactor", "unitCostBasis", "avgCreditsPerConversation", "aiUnit",
    ]) {
      expect(raw.toLowerCase(), `public response must not contain ${forbidden}`).not.toContain(forbidden.toLowerCase());
    }
  });

  it("never exposes a capability the product has not built", async () => {
    const res = await request(app()).get("/api/public/pricing");
    const keys = res.body.plans[0].features.map((f: any) => f.key);
    // manager.auto_csat is entitled TRUE on the fixture plan and is still absent.
    expect(keys).not.toContain("manager.auto_csat");
    expect(keys).toContain("communication.omnichannel");
  });

  it("reports a not-included capability honestly rather than hiding it", async () => {
    const res = await request(app()).get("/api/public/pricing");
    const aiEmployee = res.body.plans[0].features.find((f: any) => f.key === "ai.employee");
    expect(aiEmployee).toBeDefined();
    expect(aiEmployee.included).toBe(false);
  });
});

// ── Caching ─────────────────────────────────────────────────────────────────

describe("caching", () => {
  it("is publicly cacheable with a validator", async () => {
    plans.push(plan());
    const res = await request(app()).get("/api/public/pricing");
    expect(res.headers["cache-control"]).toMatch(/public/);
    expect(res.headers["cache-control"]).toMatch(/must-revalidate/);
    expect(res.headers.etag).toBeTruthy();
  });

  it("answers 304 for an unchanged catalog", async () => {
    plans.push(plan());
    const first = await request(app()).get("/api/public/pricing");
    const second = await request(app()).get("/api/public/pricing").set("If-None-Match", first.headers.etag);
    expect(second.status).toBe(304);
  });

  /** A publish must not be masked by the cache window. */
  it("changes its validator when a plan is republished", async () => {
    plans.push(plan());
    const before = (await request(app()).get("/api/public/pricing")).headers.etag;
    plans[0].updatedAt = new Date("2026-09-15");
    const after = (await request(app()).get("/api/public/pricing")).headers.etag;
    expect(after).not.toBe(before);
  });

  it("varies its validator by display currency and locale", async () => {
    plans.push(plan());
    const usd = (await request(app()).get("/api/public/pricing?currency=USD")).headers.etag;
    const ils = (await request(app()).get("/api/public/pricing?currency=ILS")).headers.etag;
    const he = (await request(app()).get("/api/public/pricing?locale=he")).headers.etag;
    expect(new Set([usd, ils, he]).size).toBe(3);
  });
});

// ── No tenant resolution ────────────────────────────────────────────────────

describe("the public route resolves no tenant", () => {
  it("answers without any Authorization header", async () => {
    plans.push(plan());
    const res = await request(app()).get("/api/public/pricing");
    expect(res.status).toBe(200);
  });

  it("ignores a tenant hint, so one visitor cannot poison the shared cache", async () => {
    plans.push(plan(), plan({ id: "c1", key: "custom_acme", kind: "CUSTOM", tenantId: "tenant-acme" }));
    const res = await request(app())
      .get("/api/public/pricing")
      .set("X-Tenant-Id", "tenant-acme")
      .set("Authorization", "Bearer whatever");
    expect(res.body.plans.map((p: any) => p.key)).toEqual(["foundation"]);
  });

  it("returns no current-plan or subscription state", async () => {
    plans.push(plan());
    const res = await request(app()).get("/api/public/pricing");
    const raw = JSON.stringify(res.body);
    for (const forbidden of ["currentPlanKey", "subscription", "invoice", "paymentMethod", "balance"]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
