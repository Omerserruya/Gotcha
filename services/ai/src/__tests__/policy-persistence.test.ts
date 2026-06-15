import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 3 - BusinessPolicy persistence: write → "restart" (module reset,
 * cache cleared) → read still returns the persisted shape via the DB.
 */

const dbStore = new Map<string, any>();
const businessPolicyMock = {
  findUnique: vi.fn(async ({ where }: any) => {
    const row = dbStore.get(where.tenantId);
    return row ? { tenantId: where.tenantId, data: row } : null;
  }),
  upsert: vi.fn(async ({ where, update, create }: any) => {
    const data = (update && update.data) ?? (create && create.data);
    dbStore.set(where.tenantId, data);
    return { tenantId: where.tenantId, data };
  }),
};

vi.mock("@chatcenter/shared", () => ({
  prisma: { businessPolicy: businessPolicyMock },
}));

describe("policy.service - DB persistence", () => {
  beforeEach(() => {
    dbStore.clear();
    businessPolicyMock.findUnique.mockClear();
    businessPolicyMock.upsert.mockClear();
    vi.resetModules(); // simulate "restart" - fresh import = fresh cache
  });

  it("setPolicy writes through to DB via upsert", async () => {
    const { setPolicy } = await import("../services/policy.service");
    const p = await setPolicy("tenant-persist", { maxDiscountPercent: 42 });
    expect(p.maxDiscountPercent).toBe(42);
    expect(businessPolicyMock.upsert).toHaveBeenCalledTimes(1);
    expect(dbStore.get("tenant-persist").maxDiscountPercent).toBe(42);
  });

  it("getPolicy after 'restart' reads from DB, not stale cache", async () => {
    // Round 1 - write
    {
      const { setPolicy } = await import("../services/policy.service");
      await setPolicy("tenant-r", { maxDiscountPercent: 33 });
    }
    // Simulated restart: module cache dropped, in-process Map gone.
    vi.resetModules();
    businessPolicyMock.findUnique.mockClear();
    {
      const { getPolicy } = await import("../services/policy.service");
      const p = await getPolicy("tenant-r");
      expect(businessPolicyMock.findUnique).toHaveBeenCalledTimes(1);
      expect(p.maxDiscountPercent).toBe(33);
    }
  });

  it("getPolicy returns DEFAULT_POLICY when the DB has no row", async () => {
    const { getPolicy, DEFAULT_POLICY } = await import("../services/policy.service");
    const p = await getPolicy("tenant-none");
    expect(p).toEqual(DEFAULT_POLICY);
  });

  it("cache never overrides DB: stale cache value is replaced on re-read", async () => {
    const mod = await import("../services/policy.service");
    await mod.setPolicy("tenant-x", { maxDiscountPercent: 10 });
    // Out-of-band DB mutation (simulating another replica).
    dbStore.set("tenant-x", { ...dbStore.get("tenant-x"), maxDiscountPercent: 99 });
    const fresh = await mod.getPolicy("tenant-x");
    expect(fresh.maxDiscountPercent).toBe(99);
  });
});
