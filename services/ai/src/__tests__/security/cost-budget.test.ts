/**
 * Unit tests for `cost-budget.service.ts`.
 *
 * Mocks `@chatcenter/shared.prisma` so the conv/tenant aggregations don't
 * need a real database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories run BEFORE the file body, so any variables referenced
// inside must be hoisted via vi.hoisted(). vi.hoisted() runs in the same
// pre-import phase as vi.mock() factories.
const { aggregateMock, auditCreateMock } = vi.hoisted(() => ({
  aggregateMock: (vi as any).fn(),
  auditCreateMock: (vi as any).fn().mockResolvedValue({}),
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    usageLog: { aggregate: aggregateMock },
    auditLog: { create: auditCreateMock },
  },
}));

import {
  createTurnBudget,
  BudgetExceededError,
  auditBudgetAbort,
  getDefaultCaps,
} from "../../services/cost-budget.service";

beforeEach(() => {
  aggregateMock.mockReset();
  auditCreateMock.mockClear();
});

describe("createTurnBudget — per-turn cap", () => {
  it("does not trip below the cap", () => {
    const b = createTurnBudget({
      tenantId: "t1",
      conversationId: "c1",
      capsOverride: { perTurn: 1000 },
    });
    b.addUsage(400);
    b.addUsage(200);
    expect(b.exceededTurnCap()).toBe(false);
    expect(b.tokensThisTurn()).toBe(600);
  });

  it("trips when usage exceeds the per-turn cap", () => {
    const b = createTurnBudget({
      tenantId: "t1",
      conversationId: "c1",
      capsOverride: { perTurn: 1000 },
    });
    b.addUsage(700);
    b.addUsage(400);
    expect(b.exceededTurnCap()).toBe(true);
    expect(b.tokensThisTurn()).toBe(1100);
  });

  it("ignores negative / NaN / Infinity additions", () => {
    const b = createTurnBudget({
      tenantId: "t1",
      conversationId: "c1",
      capsOverride: { perTurn: 100 },
    });
    b.addUsage(-50);
    b.addUsage(NaN);
    b.addUsage(Infinity);
    expect(b.tokensThisTurn()).toBe(0);
  });
});

describe("createTurnBudget — preflight conversation cap", () => {
  it("throws when prior conversation usage already exceeds cap", async () => {
    aggregateMock.mockImplementation(async ({ where }: any) => {
      // First call: conversation lookup. Second call: tenant lookup.
      if (where?.metadata) return { _sum: { tokensTotal: 5_000_000 } };
      return { _sum: { tokensTotal: 0 } };
    });

    const b = createTurnBudget({
      tenantId: "t1",
      conversationId: "c1",
      capsOverride: { perConversation: 1000, perTenantDaily: 1_000_000 },
    });

    await expect(b.preflight()).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("throws when tenant daily usage exceeds cap", async () => {
    aggregateMock.mockImplementation(async ({ where }: any) => {
      if (where?.metadata) return { _sum: { tokensTotal: 0 } };
      return { _sum: { tokensTotal: 50_000_000 } };
    });

    const b = createTurnBudget({
      tenantId: "t1",
      conversationId: "c1",
      capsOverride: { perConversation: 100_000, perTenantDaily: 1_000_000 },
    });

    try {
      await b.preflight();
      expect.fail("preflight should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as BudgetExceededError).scope).toBe("tenant_day");
    }
  });

  it("passes preflight when nothing is over budget", async () => {
    aggregateMock.mockResolvedValue({ _sum: { tokensTotal: 0 } });
    const b = createTurnBudget({ tenantId: "t1", conversationId: "c1" });
    await expect(b.preflight()).resolves.toBeUndefined();
  });

  it("fails open on DB errors (never blocks legitimate traffic)", async () => {
    aggregateMock.mockRejectedValue(new Error("db down"));
    const b = createTurnBudget({ tenantId: "t1", conversationId: "c1" });
    await expect(b.preflight()).resolves.toBeUndefined();
  });
});

describe("BudgetExceededError", () => {
  it("carries scope, used, and cap fields", () => {
    const err = new BudgetExceededError("turn", 12000, 10000);
    expect(err.scope).toBe("turn");
    expect(err.used).toBe(12000);
    expect(err.cap).toBe(10000);
    expect(err.message).toMatch(/turn/);
  });
});

describe("auditBudgetAbort", () => {
  it("writes an AuditLog row tagged with the abort scope", async () => {
    await auditBudgetAbort({
      tenantId: "t1",
      conversationId: "c1",
      scope: "turn",
      used: 11000,
      cap: 10000,
    });
    expect(auditCreateMock).toHaveBeenCalledTimes(1);
    const args = auditCreateMock.mock.calls[0][0];
    expect(args.data.action).toBe("ai.budget.aborted.turn");
    expect(args.data.tenantId).toBe("t1");
    expect(args.data.metadata.tokensUsed).toBe(11000);
    expect(args.data.metadata.tokensCap).toBe(10000);
  });

  it("swallows audit write failures", async () => {
    auditCreateMock.mockRejectedValueOnce(new Error("audit fail"));
    await expect(
      auditBudgetAbort({ tenantId: "t1", scope: "tenant_day", used: 1, cap: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe("getDefaultCaps", () => {
  it("returns sane positive defaults", () => {
    const caps = getDefaultCaps();
    expect(caps.perTurn).toBeGreaterThan(0);
    expect(caps.perConversation).toBeGreaterThan(0);
    expect(caps.perTenantDaily).toBeGreaterThan(0);
    expect(caps.perTenantDaily).toBeGreaterThan(caps.perConversation);
    expect(caps.perConversation).toBeGreaterThan(caps.perTurn);
  });
});
