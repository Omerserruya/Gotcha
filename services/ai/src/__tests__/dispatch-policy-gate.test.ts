/**
 * The final execution boundary.
 *
 * Every test here is a way somebody could have made a provider do something the
 * tenant had not agreed to. The gate exists because one of them was real: an
 * operator disabled `process_refund`, the bot surface refused it correctly, and
 * a direct call to `executeAdapterTool` went to Shopify anyway. It was declined
 * only because that order happened to have nothing left to refund.
 *
 * So these are not defensive-programming tests. They are the list of doors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock: any = vi.hoisted(() => ({
  tenantTool: { findFirst: undefined as any },
  approvalRequest: { findUnique: undefined as any, findFirst: undefined as any },
  auditLog: { create: undefined as any },
}));
vi.mock("@chatcenter/shared", () => ({ prisma: prismaMock }));

import { assertDispatchAllowed, normaliseArgs, type DispatchActor } from "../services/dispatch-policy-gate.service";

const TENANT = "t1";
const OTHER_TENANT = "t2";
const CONV = "conv1";

/** A tenant tool row as the gate reads it. */
function toolRow(over: any = {}) {
  return {
    id: "tt1",
    isEnabled: true,
    configOverrides: {},
    catalogTool: { slug: "process_refund", allowedModes: ["AUTO", "ASSIST"], category: "ACTION" },
    tenantIntegration: { status: "CONNECTED", integration: { slug: "shopify" } },
    ...over,
  };
}

function approval(over: any = {}) {
  return {
    id: "ap1",
    tenantId: TENANT,
    conversationId: CONV,
    tool: "shopify.process_refund",
    params: { order_id: "1014", amount: 40 },
    status: "APPROVED",
    executionState: "NOT_STARTED",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...over,
  };
}

const HITL = { hitlPolicy: { mode: "always", expiresAfterMin: 30, allowModification: false } };

const CUSTOMER_AI: DispatchActor = { type: "customer_ai", conversationId: CONV };
const COPILOT: DispatchActor = { type: "copilot", userId: "u1", conversationId: CONV };
const HUMAN: DispatchActor = { type: "human_agent", userId: "u1" };
const ADMIN: DispatchActor = { type: "admin", userId: "u9" };
const SERVICE: DispatchActor = { type: "internal_service", purpose: "approval_dispatch" };

function setup(over: { tool?: any; approval?: any; priorOp?: any } = {}) {
  prismaMock.tenantTool.findFirst = vi.fn(async () =>
    over.tool === null ? null : toolRow(over.tool));
  prismaMock.approvalRequest.findUnique = vi.fn(async () =>
    over.approval === null ? null : approval(over.approval));
  prismaMock.approvalRequest.findFirst = vi.fn(async () => over.priorOp ?? null);
  prismaMock.auditLog.create = vi.fn(async () => ({}));
}

const call = (actor: DispatchActor, extra: any = {}) =>
  assertDispatchAllowed({
    tenantId: TENANT,
    toolFunctionName: "shopify.process_refund",
    args: { order_id: "1014", amount: 40 },
    actor,
    conversationId: CONV,
    ...extra,
  });

beforeEach(() => setup());

// ─────────────────────────────────────────────────────────────────────────────
describe("disabled policy - the decision must hold at the boundary", () => {
  it("1. a disabled tool cannot execute through the customer AI", async () => {
    setup({ tool: { isEnabled: false } });
    const r = await call(CUSTOMER_AI);
    expect(r.decision).toBe("DENY_TOOL_DISABLED");
  });

  it("2. a disabled tool cannot execute through direct adapter dispatch", async () => {
    // THE incident: an unlabelled server-side call, which used to sail through.
    setup({ tool: { isEnabled: false } });
    const r = await call({ type: "internal_service", purpose: "unspecified_legacy_caller" });
    expect(r.decision).toBe("DENY_TOOL_DISABLED");
  });

  it("3. a disabled tool cannot execute through a workflow or background job", async () => {
    setup({ tool: { isEnabled: false } });
    const r = await call({ type: "internal_service", purpose: "workflow_step" });
    expect(r.decision).toBe("DENY_TOOL_DISABLED");
  });

  it("4. a disabled tool cannot execute after a reconnect", async () => {
    // Reconnect restores the SURFACE. It must not restore the permission.
    setup({ tool: { isEnabled: false, tenantIntegration: { status: "CONNECTED", integration: { slug: "shopify" } } } });
    const r = await call(CUSTOMER_AI);
    expect(r.decision).toBe("DENY_TOOL_DISABLED");
  });

  it("5. a disabled tool cannot execute with a perfectly valid approval attached", async () => {
    // The human said yes to a question the tenant has since answered no to.
    setup({ tool: { isEnabled: false, configOverrides: HITL } });
    const r = await call(CUSTOMER_AI, { approvalId: "ap1" });
    expect(r.decision).toBe("DENY_TOOL_DISABLED");
  });

  it("6. a human agent cannot run a disabled tool without an explicit audited override", async () => {
    setup({ tool: { isEnabled: false } });
    expect((await call(HUMAN)).decision).toBe("DENY_TOOL_DISABLED");
    // Being an admin is not itself an override.
    expect((await call(ADMIN)).decision).toBe("DENY_TOOL_DISABLED");
    // An attributed override is, and it is recorded.
    const ok = await call({ type: "admin", userId: "u9", override: { reason: "merchant phoned", grantedBy: "u9" } });
    expect(ok.decision).toBe("ALLOW");
    expect((ok as any).overrodePolicy).toBe(true);
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
  });

  it("7. another tenant's enabled policy does not leak into this tenant", async () => {
    setup({ tool: null }); // this tenant has no row at all
    const r = await call(CUSTOMER_AI);
    expect(r.decision).toBe("DENY_TOOL_DISABLED");
    expect(prismaMock.tenantTool.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("HITL - a yes must be real, current, and for this exact action", () => {
  it("8. a HITL tool with no approval at all is denied", async () => {
    setup({ tool: { configOverrides: HITL } });
    const r = await call(CUSTOMER_AI);
    expect(r.decision).toBe("DENY_APPROVAL_REQUIRED");
  });

  it("9. a PENDING approval is not a yes", async () => {
    setup({ tool: { configOverrides: HITL }, approval: { status: "PENDING" } });
    expect((await call(CUSTOMER_AI, { approvalId: "ap1" })).decision).toBe("DENY_APPROVAL_REQUIRED");
  });

  it("10. a REJECTED approval is denied", async () => {
    setup({ tool: { configOverrides: HITL }, approval: { status: "REJECTED" } });
    expect((await call(CUSTOMER_AI, { approvalId: "ap1" })).decision).toBe("DENY_APPROVAL_REJECTED");
  });

  it("11. an expired approval is denied, by timestamp and not only by status", async () => {
    setup({ tool: { configOverrides: HITL }, approval: { status: "EXPIRED" } });
    expect((await call(CUSTOMER_AI, { approvalId: "ap1" })).decision).toBe("DENY_APPROVAL_STALE");
    // Still APPROVED because the sweeper has not run, but past its expiry.
    setup({ tool: { configOverrides: HITL }, approval: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(CUSTOMER_AI, { approvalId: "ap1" })).decision).toBe("DENY_APPROVAL_STALE");
  });

  it("12. an approval for a different tool is denied", async () => {
    setup({ tool: { configOverrides: HITL }, approval: { tool: "shopify.cancel_order" } });
    expect((await call(CUSTOMER_AI, { approvalId: "ap1" })).decision).toBe("DENY_APPROVAL_MISMATCH");
  });

  it("13. an approval whose arguments were changed afterwards is denied", async () => {
    setup({ tool: { configOverrides: HITL }, approval: { params: { order_id: "1014", amount: 40 } } });
    const r = await assertDispatchAllowed({
      tenantId: TENANT, toolFunctionName: "shopify.process_refund",
      args: { order_id: "1014", amount: 400 }, // an extra zero
      actor: CUSTOMER_AI, conversationId: CONV, approvalId: "ap1",
    });
    expect(r.decision).toBe("DENY_APPROVAL_MISMATCH");
  });

  it("14. an approval belonging to another tenant is denied", async () => {
    setup({ tool: { configOverrides: HITL }, approval: { tenantId: OTHER_TENANT } });
    expect((await call(CUSTOMER_AI, { approvalId: "ap1" })).decision).toBe("DENY_TENANT_MISMATCH");
  });

  it("15. an approval from another conversation is denied", async () => {
    setup({ tool: { configOverrides: HITL }, approval: { conversationId: "conv-other" } });
    expect((await call(CUSTOMER_AI, { approvalId: "ap1" })).decision).toBe("DENY_APPROVAL_MISMATCH");
  });

  it("16. a consumed approval cannot execute a second time", async () => {
    setup({ tool: { configOverrides: HITL }, approval: { executionState: "SUCCEEDED" } });
    expect((await call(CUSTOMER_AI, { approvalId: "ap1" })).decision).toBe("DENY_ALREADY_EXECUTED");
  });

  it("17. a duplicate callback arriving mid-flight cannot execute twice", async () => {
    setup({ tool: { configOverrides: HITL }, approval: { executionState: "EXECUTING" } });
    expect((await call(CUSTOMER_AI, { approvalId: "ap1" })).decision).toBe("DENY_ALREADY_EXECUTED");
  });

  it("18. a valid, current, matching approval executes", async () => {
    setup({ tool: { configOverrides: HITL } });
    const r = await call(CUSTOMER_AI, { approvalId: "ap1" });
    expect(r.decision).toBe("ALLOW");
    expect((r as any).approvalId).toBe("ap1");
  });

  it("19. an approver permitted to edit arguments is honoured", async () => {
    setup({
      tool: { configOverrides: { hitlPolicy: { mode: "always", allowModification: true } } },
      approval: { params: { order_id: "1014", amount: 40 } },
    });
    const r = await assertDispatchAllowed({
      tenantId: TENANT, toolFunctionName: "shopify.process_refund",
      args: { order_id: "1014", amount: 25 }, // the approver reduced it
      actor: CUSTOMER_AI, conversationId: CONV, approvalId: "ap1",
    });
    expect(r.decision).toBe("ALLOW");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("connection and scopes - availability is not policy", () => {
  it("20. an enabled tool on a DISCONNECTED integration is denied", async () => {
    setup({ tool: { tenantIntegration: { status: "DISCONNECTED", integration: { slug: "shopify" } } } });
    expect((await call(CUSTOMER_AI)).decision).toBe("DENY_DISCONNECTED");
  });

  it("21. an approval dispatched after a disconnect cannot reach the provider", async () => {
    setup({
      tool: { configOverrides: HITL, tenantIntegration: { status: "DISCONNECTED", integration: { slug: "shopify" } } },
    });
    expect((await call(SERVICE, { approvalId: "ap1" })).decision).toBe("DENY_DISCONNECTED");
  });

  it("22. an ERROR connection is denied rather than retried into the provider", async () => {
    setup({ tool: { tenantIntegration: { status: "ERROR", integration: { slug: "shopify" } } } });
    expect((await call(CUSTOMER_AI)).decision).toBe("DENY_DISCONNECTED");
  });

  it("23. reconnecting restores availability WITHOUT changing policy", async () => {
    // Disabled + disconnected -> reconnect -> still disabled. Availability
    // changed; the decision did not.
    setup({ tool: { isEnabled: false, tenantIntegration: { status: "DISCONNECTED", integration: { slug: "shopify" } } } });
    expect((await call(CUSTOMER_AI)).decision).toBe("DENY_TOOL_DISABLED");
    setup({ tool: { isEnabled: false, tenantIntegration: { status: "CONNECTED", integration: { slug: "shopify" } } } });
    expect((await call(CUSTOMER_AI)).decision).toBe("DENY_TOOL_DISABLED");
  });

  it("24. losing a scope blocks execution without deleting the policy row", async () => {
    // The row survives and stays enabled; the connection is what degraded.
    setup({ tool: { isEnabled: true, tenantIntegration: { status: "ERROR", integration: { slug: "shopify" } } } });
    const r = await call(CUSTOMER_AI);
    expect(r.decision).toBe("DENY_DISCONNECTED");
    expect(prismaMock.tenantTool.findFirst).toHaveBeenCalled(); // policy was read, not removed
  });

  it("25. restoring the connection re-enables execution only when policy allows", async () => {
    setup({ tool: { isEnabled: true } });
    expect((await call(CUSTOMER_AI)).decision).toBe("ALLOW");
    setup({ tool: { isEnabled: false } });
    expect((await call(CUSTOMER_AI)).decision).toBe("DENY_TOOL_DISABLED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("actors - internal was never one thing", () => {
  it("26. the customer AI is refused a tool not permitted in AUTO mode", async () => {
    setup({ tool: { catalogTool: { slug: "process_refund", allowedModes: ["ASSIST"], category: "ACTION" } } });
    expect((await call(CUSTOMER_AI)).decision).toBe("DENY_MODE");
  });

  it("27. a human agent may run an enabled tool", async () => {
    expect((await call(HUMAN)).decision).toBe("ALLOW");
  });

  it("28. a human agent cannot act across a tenant boundary", async () => {
    setup({ tool: null }); // no policy row exists in THIS tenant
    expect((await call(HUMAN)).decision).toBe("DENY_TOOL_DISABLED");
  });

  it("29. a call with no tenant in trusted context is refused outright", async () => {
    const r = await assertDispatchAllowed({
      tenantId: "", toolFunctionName: "shopify.process_refund", args: {}, actor: HUMAN,
    });
    expect(r.decision).toBe("DENY_TENANT_MISMATCH");
  });

  it("30. a copilot cannot bypass HITL by proposing", async () => {
    setup({ tool: { configOverrides: HITL } });
    expect((await call(COPILOT)).decision).toBe("DENY_APPROVAL_REQUIRED");
  });

  it("31. an internal service must declare a purpose", async () => {
    const r = await call({ type: "internal_service", purpose: "  " });
    expect(r.decision).toBe("DENY_UNAUTHENTICATED_SERVICE");
  });

  it("32. an admin does not inherit tenant action rights by being an admin", async () => {
    setup({ tool: { isEnabled: false } });
    expect((await call(ADMIN)).decision).toBe("DENY_TOOL_DISABLED");
    // and a HITL tool still needs its approval for a customer-facing actor
    setup({ tool: { configOverrides: HITL } });
    expect((await call(CUSTOMER_AI)).decision).toBe("DENY_APPROVAL_REQUIRED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("idempotency - money must not move twice", () => {
  const dup = (key: string) => call(SERVICE, { operationKey: key });

  it("33. a refund already executed under this operation key is refused", async () => {
    setup({ priorOp: { id: "ap-prev", executionState: "SUCCEEDED" } });
    const r = await dup("refund:1014:40");
    expect(r.decision).toBe("DENY_ALREADY_EXECUTED");
  });

  it("34. a cancel already in flight is refused", async () => {
    setup({ priorOp: { id: "ap-prev", executionState: "EXECUTING" } });
    expect((await dup("cancel:1014")).decision).toBe("DENY_ALREADY_EXECUTED");
  });

  it("35. an exchange already executed is refused", async () => {
    setup({ priorOp: { id: "ap-prev", executionState: "SUCCEEDED" } });
    expect((await dup("exchange:1014:v2")).decision).toBe("DENY_ALREADY_EXECUTED");
  });

  it("36. a return already executed is refused", async () => {
    setup({ priorOp: { id: "ap-prev", executionState: "SUCCEEDED" } });
    expect((await dup("return:1014")).decision).toBe("DENY_ALREADY_EXECUTED");
  });

  it("37. a legacy row of unverified outcome is not retryable", async () => {
    // Re-running an old refund is worse than never learning whether it ran.
    setup({ priorOp: { id: "ap-old", executionState: "LEGACY_UNVERIFIED" } });
    expect((await dup("refund:1006:80")).decision).toBe("DENY_ALREADY_EXECUTED");
    // A fresh key with no prior execution proceeds.
    setup({ priorOp: null });
    expect((await dup("refund:9999:10")).decision).toBe("ALLOW");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the gate's own failure modes", () => {
  it("fails CLOSED for customer-facing actors when it cannot answer", async () => {
    prismaMock.tenantTool.findFirst = vi.fn(async () => { throw new Error("db down"); });
    const r = await call(CUSTOMER_AI);
    expect(r.decision).toBe("DENY_PROVIDER_UNAVAILABLE");
  });

  it("argument comparison ignores key order and whitespace, never values", async () => {
    expect(normaliseArgs({ b: 1, a: " x " })).toBe(normaliseArgs({ a: "x", b: 1 }));
    expect(normaliseArgs({ amount: 40 })).not.toBe(normaliseArgs({ amount: 400 }));
  });

  it("never records tool arguments in its audit trail", async () => {
    setup({ tool: { isEnabled: false } });
    await call(CUSTOMER_AI, { approvalId: "ap1" });
    const written = JSON.stringify(prismaMock.auditLog.create.mock.calls ?? []);
    expect(written).not.toContain("order_id");
    expect(written).not.toContain("1014");
  });
});
