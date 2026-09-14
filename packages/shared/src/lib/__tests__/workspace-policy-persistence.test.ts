import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BusinessPolicy persistence: write → "restart" (module reset, cache cleared)
 * → read still returns the persisted shape from the database.
 *
 * MOVED HERE with the implementation. In services/ai this test mocked the
 * whole @chatcenter/shared barrel; now that the policy lives inside that
 * package, mocking the barrel would have mocked the thing under test. Mocking
 * only `./prisma` is both simpler and what the test always meant.
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

vi.mock("../prisma", () => ({ prisma: { businessPolicy: businessPolicyMock } }));

const TENANT = "tenant-persist";

beforeEach(() => {
  dbStore.clear();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("workspace policy persistence", () => {
  it("writes through to the database on set", async () => {
    const { setPolicy } = await import("../workspace-policy");
    await setPolicy(TENANT, { blockedTopics: ["no delivery promises"] });
    expect(businessPolicyMock.upsert).toHaveBeenCalledTimes(1);
    expect(dbStore.get(TENANT).blockedTopics).toEqual(["no delivery promises"]);
  });

  it("reads from the database after a restart, not from a stale cache", async () => {
    const first = await import("../workspace-policy");
    await first.setPolicy(TENANT, { maxDiscountPercent: 25 });

    // Fresh module instance = empty in-process cache, as after a deploy.
    vi.resetModules();
    const second = await import("../workspace-policy");
    const policy = await second.getPolicy(TENANT);
    expect(policy.maxDiscountPercent).toBe(25);
  });

  it("returns the defaults when the database has no row", async () => {
    const { getPolicy, DEFAULT_POLICY } = await import("../workspace-policy");
    const policy = await getPolicy("tenant-with-nothing");
    expect(policy).toEqual(DEFAULT_POLICY);
  });

  it("merges a patch rather than replacing the policy", async () => {
    // The narrow prohibited-claims route sends one field; the discount ceiling
    // and the refund rule share this blob and must survive that write.
    const { setPolicy } = await import("../workspace-policy");
    await setPolicy(TENANT, { maxDiscountPercent: 30, refundRequiresApproval: false });
    const after = await setPolicy(TENANT, { blockedTopics: ["no medical advice"] });
    expect(after.maxDiscountPercent).toBe(30);
    expect(after.refundRequiresApproval).toBe(false);
    expect(after.blockedTopics).toEqual(["no medical advice"]);
  });

  it("drops malformed entries already stored, rather than serving them", async () => {
    // Rows written before the write path validated anything are in the
    // database and reach the system prompt. [1, 2, {}] used to arrive at the
    // model as "1, 2, [object Object]".
    dbStore.set(TENANT, { blockedTopics: [1, "a real rule", {}, ""] });
    const { getPolicy } = await import("../workspace-policy");
    const policy = await getPolicy(TENANT);
    expect(policy.blockedTopics).toEqual(["a real rule"]);
  });
});
