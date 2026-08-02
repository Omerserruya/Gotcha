import { describe, it, expect, vi } from "vitest";

const { auditCreate } = vi.hoisted(() => ({ auditCreate: vi.fn().mockResolvedValue({}) }));
vi.mock("@chatcenter/shared", () => ({
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    auditLog: { create: auditCreate },
    contact: {
      findFirst: vi.fn().mockResolvedValue({ id: "c1", tenantId: "t1", tags: [] }),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ id: "c1", tags: ["x"] }),
    },
  },
  evaluateToolGate: vi.fn().mockResolvedValue({ decision: "ALLOW", reason: "test default" }),
}));

vi.mock("../services/connectors/types", async () => {
  const mod = await vi.importActual<any>("../services/connectors/types");
  return {
    ...mod,
    getMessagingConnector: () => ({
      name: "fail",
      async send() {
        return { ok: false, error: "smtp 550" };
      },
    }),
  };
});

import { executeAction, PlannedAction } from "../services/action-executor.service";

describe("chaos scenarios", () => {
  it("propagates connector {ok:false} as execution failure (Scenario 1)", async () => {
    const action: PlannedAction = {
      tool: "send_message",
      params: { contactId: "c1", channel: "email", body: "hi" },
      reason: "test",
      riskLevel: "high",
    };
    const r = await executeAction("t1", action, { approved: true, approvedBy: "u1" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/smtp/);
  });

  it("surfaces auditFailed when audit write throws (Scenario 5)", async () => {
    auditCreate.mockRejectedValueOnce(new Error("db down"));
    const action: PlannedAction = {
      tool: "noop",
      params: { note: "x" },
      reason: "test",
      riskLevel: "low",
    };
    const r = await executeAction("t1", action, {});
    expect(r.ok).toBe(true);
    expect(r.auditFailed).toBe(true);
  });

  it("writes idempotencyKey into audit metadata (Scenario 3)", async () => {
    auditCreate.mockClear();
    const action: PlannedAction = {
      tool: "noop",
      params: {},
      reason: "test",
      riskLevel: "low",
    };
    await executeAction("t1", action, { idempotencyKey: "req-42" });
    const call = auditCreate.mock.calls[0][0];
    expect(call.data.metadata.idempotencyKey).toBe("req-42");
  });
});
