import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Controllable in-memory data for the mocked prisma client ────────────────
interface PlanRow {
  id: string;
  key: string;
  version: number;
  includedAiUnits: number;
  entitlements: Array<{ entitlementKey: string; valueType: string; value: unknown }>;
  volumeOptions: Array<{ key: string; channel: string; additionalCredits: number }>;
}

const db = {
  link: null as any,
  plans: [] as PlanRow[],
  tenantEntitlements: [] as Array<{
    tenantId: string;
    entitlementKey: string;
    valueType: string;
    value: unknown;
    source: string;
    expiresAt: Date | null;
  }>,
};

vi.mock("../../prisma", () => ({
  prisma: {
    billableEntityTenant: {
      findUnique: async ({ where }: any) => (db.link?.tenantId === where.tenantId ? db.link : null),
    },
    plan: {
      findUnique: async ({ where }: any) =>
        db.plans.find(
          (p) => p.key === where.key_version.key && p.version === where.key_version.version,
        ) ?? null,
    },
    tenantEntitlement: {
      findMany: async ({ where }: any) =>
        db.tenantEntitlements.filter((r) => r.tenantId === where.tenantId),
    },
  },
}));

import {
  resolveEntitlements,
  isEntitled,
  assertEntitled,
  resolveLimit,
  assertWithinLimit,
  overLimitDisposition,
  EntitlementDeniedError,
  entitlementErrorResponse,
} from "../entitlement-resolver";

const T = "tenant-1";

function subscribe(planKey: string, opts: { chatVolumeOptionKey?: string; voiceVolumeOptionKey?: string } = {}) {
  db.link = {
    tenantId: T,
    billableEntityId: "ent-1",
    entity: {
      subscription: {
        planKey,
        planVersion: 1,
        chatVolumeOptionKey: opts.chatVolumeOptionKey ?? null,
        voiceVolumeOptionKey: opts.voiceVolumeOptionKey ?? null,
      },
    },
  };
}

function seedPlan(key: string, entitlements: Record<string, unknown>, volumeOptions: PlanRow["volumeOptions"] = []) {
  db.plans.push({
    id: `plan-${key}`,
    key,
    version: 1,
    includedAiUnits: 2000,
    entitlements: Object.entries(entitlements).map(([entitlementKey, value]) => ({
      entitlementKey,
      valueType: typeof value === "object" && value && "count" in (value as any) ? "COUNTER" : "BOOLEAN",
      value,
    })),
    volumeOptions,
  });
}

beforeEach(() => {
  db.link = null;
  db.plans = [];
  db.tenantEntitlements = [];
});

describe("entitlement resolver - plan defaults", () => {
  it("grants what the plan entitles and denies what it does not", async () => {
    seedPlan("foundation", { "ai.employee": { bool: false }, "communication.broadcasts": { bool: true } });
    subscribe("foundation");

    expect(await isEntitled(T, "communication.broadcasts")).toBe(true);
    expect(await isEntitled(T, "ai.employee")).toBe(false);
  });

  it("falls back to the catalog default when no layer supplies a value", async () => {
    seedPlan("foundation", {});
    subscribe("foundation");

    // Catalog defaults: omnichannel is core (true), AI Employee is paid (false).
    expect(await isEntitled(T, "communication.omnichannel")).toBe(true);
    expect(await isEntitled(T, "ai.employee")).toBe(false);
  });

  it("reports the plan key and version on the resolved set", async () => {
    seedPlan("ai_workforce", {});
    subscribe("ai_workforce");
    const set = await resolveEntitlements(T);
    expect(set.planKey).toBe("ai_workforce");
    expect(set.planVersion).toBe(1);
    expect(set.unsubscribed).toBe(false);
  });

  it("marks a tenant with no subscription as unsubscribed and still denies paid features", async () => {
    const set = await resolveEntitlements(T);
    expect(set.unsubscribed).toBe(true);
    expect(await isEntitled(T, "ai.employee")).toBe(false);
    expect(await isEntitled(T, "communication.omnichannel")).toBe(true);
  });
});

describe("entitlement resolver - precedence", () => {
  it("OVERRIDE beats PLAN_DEFAULT", async () => {
    seedPlan("foundation", { "ai.employee": { bool: false } });
    subscribe("foundation");
    db.tenantEntitlements.push({
      tenantId: T, entitlementKey: "ai.employee", valueType: "BOOLEAN",
      value: { bool: true }, source: "OVERRIDE", expiresAt: null,
    });
    expect(await isEntitled(T, "ai.employee")).toBe(true);
  });

  it("COMPLIANCE_DENY beats an OVERRIDE that grants", async () => {
    seedPlan("ai_voice", { "voice.outbound": { bool: true } });
    subscribe("ai_voice");
    db.tenantEntitlements.push(
      { tenantId: T, entitlementKey: "voice.outbound", valueType: "BOOLEAN", value: { bool: true }, source: "OVERRIDE", expiresAt: null },
      { tenantId: T, entitlementKey: "voice.outbound", valueType: "BOOLEAN", value: { bool: true }, source: "COMPLIANCE_DENY", expiresAt: null },
    );
    expect(await isEntitled(T, "voice.outbound")).toBe(false);
  });

  it("ignores an expired TRIAL grant", async () => {
    seedPlan("foundation", { "ai.employee": { bool: false } });
    subscribe("foundation");
    db.tenantEntitlements.push({
      tenantId: T, entitlementKey: "ai.employee", valueType: "BOOLEAN",
      value: { bool: true }, source: "TRIAL", expiresAt: new Date(Date.now() - 1000),
    });
    expect(await isEntitled(T, "ai.employee")).toBe(false);
  });

  it("honours a live TRIAL grant (POC all-feature access)", async () => {
    seedPlan("poc", {});
    subscribe("poc");
    db.tenantEntitlements.push({
      tenantId: T, entitlementKey: "voice.call_pilot", valueType: "BOOLEAN",
      value: { bool: true }, source: "TRIAL", expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(await isEntitled(T, "voice.call_pilot")).toBe(true);
  });
});

describe("entitlement resolver - unbuilt capabilities", () => {
  it("never entitles a catalogued-but-unimplemented feature, even if the plan says true", async () => {
    seedPlan("ai_voice", { "manager.auto_csat": { bool: true } });
    subscribe("ai_voice");
    expect(await isEntitled(T, "manager.auto_csat")).toBe(false);
  });

  it("never entitles a key that is not in the catalog at all", async () => {
    seedPlan("ai_voice", { "made.up.feature": { bool: true } });
    subscribe("ai_voice");
    expect(await isEntitled(T, "made.up.feature")).toBe(false);
  });

  it("reports FEATURE_NOT_AVAILABLE (not PLAN_FEATURE_REQUIRED) for unbuilt capabilities", async () => {
    seedPlan("foundation", {});
    subscribe("foundation");
    await expect(assertEntitled(T, "manager.auto_csat")).rejects.toMatchObject({
      body: { code: "FEATURE_NOT_AVAILABLE" },
    });
  });
});

describe("entitlement resolver - volume options", () => {
  it("adds the selected chat option's credits to the included allowance", async () => {
    seedPlan("ai_workforce", { "limit:included_ai_units": { count: 2000 } }, [
      { key: "chat_10", channel: "CHAT", additionalCredits: 0 },
      { key: "chat_50", channel: "CHAT", additionalCredits: 8000 },
    ]);
    subscribe("ai_workforce", { chatVolumeOptionKey: "chat_50" });
    expect(await resolveLimit(T, "limit:included_ai_units")).toBe(10_000);
  });

  it("adds chat and voice options together", async () => {
    seedPlan("ai_voice", { "limit:included_ai_units": { count: 2000 } }, [
      { key: "chat_25", channel: "CHAT", additionalCredits: 3000 },
      { key: "voice_25", channel: "VOICE", additionalCredits: 7500 },
    ]);
    subscribe("ai_voice", { chatVolumeOptionKey: "chat_25", voiceVolumeOptionKey: "voice_25" });
    expect(await resolveLimit(T, "limit:included_ai_units")).toBe(12_500);
  });

  it("an explicit OVERRIDE still beats the volume-option allowance", async () => {
    seedPlan("ai_workforce", { "limit:included_ai_units": { count: 2000 } }, [
      { key: "chat_50", channel: "CHAT", additionalCredits: 8000 },
    ]);
    subscribe("ai_workforce", { chatVolumeOptionKey: "chat_50" });
    db.tenantEntitlements.push({
      tenantId: T, entitlementKey: "limit:included_ai_units", valueType: "COUNTER",
      value: { count: 99_000 }, source: "OVERRIDE", expiresAt: null,
    });
    expect(await resolveLimit(T, "limit:included_ai_units")).toBe(99_000);
  });
});

describe("entitlement resolver - numeric limits", () => {
  beforeEach(() => {
    seedPlan("foundation", { "limit:ai_employees": { count: 2 } });
    subscribe("foundation");
  });

  it("allows creation below the limit", async () => {
    await expect(assertWithinLimit(T, "limit:ai_employees", 1)).resolves.toBeUndefined();
  });

  it("allows creation that lands exactly on the limit", async () => {
    await expect(assertWithinLimit(T, "limit:ai_employees", 1, 1)).resolves.toBeUndefined();
  });

  it("blocks creation that would exceed the limit, with a structured body", async () => {
    await expect(assertWithinLimit(T, "limit:ai_employees", 2)).rejects.toMatchObject({
      body: {
        code: "PLAN_LIMIT_REACHED",
        feature: "limit:ai_employees",
        currentPlan: "foundation",
        limit: 2,
        current: 2,
        upgradePath: "/settings/billing/plan",
      },
    });
  });

  it("treats an UNLIMITED entitlement as no cap", async () => {
    db.tenantEntitlements.push({
      tenantId: T, entitlementKey: "limit:ai_employees", valueType: "UNLIMITED",
      value: {}, source: "OVERRIDE", expiresAt: null,
    });
    await expect(assertWithinLimit(T, "limit:ai_employees", 10_000)).resolves.toBeUndefined();
  });
});

describe("entitlement resolver - downgrade with excess resources", () => {
  it("reports the overage and defaults to BLOCK_NEW, never deletion", async () => {
    seedPlan("foundation", { "limit:ai_employees": { count: 1 } });
    subscribe("foundation");
    const d = await overLimitDisposition(T, "limit:ai_employees", 4);
    expect(d).toEqual({ overBy: 3, behavior: "BLOCK_NEW", limit: 1 });
  });

  it("honours a configured per-limit breach behaviour", async () => {
    seedPlan("foundation", { "limit:channels": { count: 2 } });
    subscribe("foundation");
    db.tenantEntitlements.push({
      tenantId: T, entitlementKey: "config:limit_breach:limit:channels", valueType: "CONFIG",
      value: { value: "READ_ONLY" }, source: "OVERRIDE", expiresAt: null,
    });
    const d = await overLimitDisposition(T, "limit:channels", 5);
    expect(d.behavior).toBe("READ_ONLY");
    expect(d.overBy).toBe(3);
  });
});

describe("entitlement errors", () => {
  it("maps to a 402 with no pricing internals", async () => {
    seedPlan("foundation", { "ai.employee": { bool: false } });
    subscribe("foundation");
    try {
      await assertEntitled(T, "ai.employee");
      throw new Error("should have thrown");
    } catch (err) {
      const mapped = entitlementErrorResponse(err);
      expect(mapped?.status).toBe(402);
      expect(mapped?.body).toEqual({
        code: "PLAN_FEATURE_REQUIRED",
        feature: "ai.employee",
        currentPlan: "foundation",
        upgradePath: "/settings/billing/plan",
      });
      // No price, no credit cost, no plan catalog leaked to the client.
      const json = JSON.stringify(mapped?.body);
      expect(json).not.toMatch(/price|credit|token|cost/i);
    }
  });

  it("returns null for unrelated errors so callers can rethrow", () => {
    expect(entitlementErrorResponse(new Error("boom"))).toBeNull();
    expect(entitlementErrorResponse(new EntitlementDeniedError({
      code: "PLAN_FEATURE_REQUIRED", feature: "x", currentPlan: null, upgradePath: "/p",
    }))).not.toBeNull();
  });
});
