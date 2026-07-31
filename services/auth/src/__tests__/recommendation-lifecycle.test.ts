/**
 * Recommendation lifecycle (Your Business page):
 *   OPEN → COMPLETED (with completedAt) → reopen → OPEN (stamps cleared).
 *
 * Hermetic: prisma is mocked; asserts the exact writes so a "Completed"
 * section can only ever show items whose backend transition succeeded, and
 * reopen genuinely restores the pre-resolution state.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prismaMock: {
    recommendation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    tenantIntegration: { findMany: vi.fn() },
  } as any,
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
  prisma: mocks.prismaMock,
}));

import { setRecommendationStatus } from "../services/recommendations.service";

const { prismaMock } = mocks;

beforeEach(() => {
  prismaMock.recommendation.findFirst.mockReset();
  prismaMock.recommendation.update.mockReset();
});

describe("setRecommendationStatus", () => {
  it("completes: stamps completedAt and reports the previous status", async () => {
    prismaMock.recommendation.findFirst.mockResolvedValue({ id: "r1", status: "OPEN" });
    prismaMock.recommendation.update.mockResolvedValue({});
    const r = await setRecommendationStatus("t1", "r1", "COMPLETED");
    expect(r).toEqual({ ok: true, previous: "OPEN" });
    const write = prismaMock.recommendation.update.mock.calls[0][0];
    expect(write.data.status).toBe("COMPLETED");
    expect(write.data.completedAt).toBeInstanceOf(Date);
  });

  it("reopen: restores OPEN and CLEARS the resolution stamps", async () => {
    prismaMock.recommendation.findFirst.mockResolvedValue({ id: "r1", status: "COMPLETED" });
    prismaMock.recommendation.update.mockResolvedValue({});
    const r = await setRecommendationStatus("t1", "r1", "OPEN");
    expect(r).toEqual({ ok: true, previous: "COMPLETED" });
    const write = prismaMock.recommendation.update.mock.calls[0][0];
    expect(write.data).toEqual({ status: "OPEN", completedAt: null, dismissedAt: null });
  });

  it("is tenant-scoped: a foreign tenant's rec id is not found and nothing is written", async () => {
    prismaMock.recommendation.findFirst.mockResolvedValue(null);
    const r = await setRecommendationStatus("tenant-b", "r1", "COMPLETED");
    expect(r.ok).toBe(false);
    expect(prismaMock.recommendation.findFirst.mock.calls[0][0].where).toMatchObject({ id: "r1", tenantId: "tenant-b" });
    expect(prismaMock.recommendation.update).not.toHaveBeenCalled();
  });
});
