import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  // Workspace policy lives in shared now. The real getPolicy/setPolicy reach
  // the DB, so they are replaced by an in-memory store; the REAL
  // validateAgainstPolicy (from `actual`) stays, so policy checks are genuine.
  const policyStore = new Map<string, any>();
  return {
    ...actual,
    // Durable tenant settings read the DB; default: nothing configured.
    readDurableSetting: async () => null,
    writeDurableSetting: async () => undefined,
    prisma: {
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      contact: {
        findFirst: vi.fn().mockResolvedValue({ id: "c1", tenantId: "t1", tags: ["vip"] }),
        findUnique: vi.fn().mockResolvedValue({ id: "c1", tags: ["vip"] }),
        update: vi.fn().mockResolvedValue({ id: "c1", tags: ["vip", "churn"] }),
      },
    },
    evaluateToolGate: vi.fn().mockResolvedValue({ decision: "ALLOW", reason: "test default" }),
    // tag_contact emits tag_added automation events onto a BullMQ queue
    // (Redis). Same count as the real one, nothing enqueued.
    emitTagsAdded: vi.fn(async (_t: string, _c: string, before: unknown, after: unknown) =>
      actual.tagsAdded(before, after).length,
    ),
    getPolicy: async (tenantId: string) => policyStore.get(tenantId) ?? actual.DEFAULT_POLICY,
    setPolicy: async (tenantId: string, patch: any) => {
      const next = { ...(policyStore.get(tenantId) ?? actual.DEFAULT_POLICY), ...patch };
      policyStore.set(tenantId, next);
      return next;
    },
    getPolicyPrompt: async () => "",
  };
});

import { validateAction, executeAction, PlannedAction } from "../services/action-executor.service";
import { setPolicy } from "../services/policy.service";

const lowRisk: PlannedAction = {
  tool: "tag_contact",
  params: { contactId: "c1", tags: ["churn"] },
  reason: "segmentation",
  riskLevel: "low",
};

const highRisk: PlannedAction = {
  tool: "send_message",
  params: { contactId: "c1", channel: "whatsapp", body: "hi" },
  reason: "re-engage",
  riskLevel: "high",
};

describe("action-executor validateAction", () => {
  it("allows low-risk action without approval", () => {
    expect(validateAction(lowRisk, {}).ok).toBe(true);
  });
  it("blocks high-risk action without approval", () => {
    const r = validateAction(highRisk, {});
    expect(r.ok).toBe(false);
  });
  it("permits high-risk action when approved", () => {
    const r = validateAction(highRisk, { approved: true, approvedBy: "u1" });
    expect(r.ok).toBe(true);
  });
});

describe("action-executor executeAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips high-risk without approval and reports skipReason", async () => {
    const r = await executeAction("t1", highRisk, {});
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/approval/);
  });

  it("executes tag_contact and merges tags", async () => {
    const r = await executeAction("t1", lowRisk, { actorId: "u1" });
    expect(r.ok).toBe(true);
    expect((r.output as any).tags).toContain("churn");
  });

  it("dry-run short-circuits execution", async () => {
    const r = await executeAction("t1", lowRisk, { dryRun: true });
    expect(r.ok).toBe(true);
    expect((r.output as any).dryRun).toBe(true);
  });

  it("blocks when policy discount exceeded", async () => {
    await setPolicy("t-policy", { maxDiscountPercent: 10 });
    const action: PlannedAction = {
      tool: "update_crm",
      params: { contactId: "c1", discountPercent: 50 },
      reason: "upsell",
      riskLevel: "high",
    };
    const r = await executeAction("t-policy", action, { approved: true, approvedBy: "admin" });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toMatch(/exceeds max/);
  });
});
