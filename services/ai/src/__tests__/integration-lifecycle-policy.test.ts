/**
 * Tenant tool policy must outlive the connection it was configured through.
 *
 * The defect, observed on a live dev store: an operator disabled
 * `process_refund`, disconnected to re-grant OAuth scopes - the only way to
 * grant a scope - and reconnected. The tool came back ENABLED.
 *
 * Nothing overrode their decision. `POST /:slug/disconnect` ran an explicit
 * `tenantTool.deleteMany`, so the record of the decision was deleted, and
 * provisioning had nothing left to preserve and used the catalogue default.
 *
 * Two independent things had to be true for that to happen, and both are
 * covered here: disconnect destroyed policy, and provisioning had no durable
 * source of operator intent to rebuild from.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock: any = vi.hoisted(() => ({
  catalogTool: { findMany: undefined as any },
  tenantTool: { findMany: undefined as any, createMany: undefined as any, count: undefined as any },
  aIAgent: { findMany: undefined as any },
  agentToolPermission: { findMany: undefined as any, createMany: undefined as any },
  tenantToolPermission: { findMany: undefined as any, upsert: undefined as any },
  tenantIntegration: { update: undefined as any },
  auditLog: { create: undefined as any },
}));
vi.mock("@chatcenter/shared", () => ({ prisma: prismaMock }));

import { provisionIntegrationTools } from "../services/integration-provisioning.service";
import { disconnectIntegration, recordDisconnectAudit } from "../services/integration-lifecycle.service";
import {
  durableToolName,
  recordOperatorToolIntent,
  loadOperatorToolIntents,
  tenantToolFieldsFromIntent,
} from "../services/tool-policy-intent.service";

const CATALOG = [
  { id: "r1", category: "READ", slug: "get_order" },
  { id: "w1", category: "WRITE", slug: "add_order_note" },
  { id: "a1", category: "ACTION", slug: "process_refund" },
  { id: "a2", category: "ACTION", slug: "cancel_order" },
];

beforeEach(() => {
  prismaMock.catalogTool.findMany = vi.fn(async ({ where }: any) => {
    const cats = where?.category?.in as string[] | undefined;
    return cats ? CATALOG.filter((t) => cats.includes(t.category)) : CATALOG;
  });
  prismaMock.tenantTool.findMany = vi.fn(async () => []);
  prismaMock.tenantTool.createMany = vi.fn(async () => ({ count: 0 }));
  prismaMock.tenantTool.count = vi.fn(async () => 4);
  prismaMock.aIAgent.findMany = vi.fn(async () => [{ id: "agent1" }]);
  prismaMock.agentToolPermission.findMany = vi.fn(async () => []);
  prismaMock.agentToolPermission.createMany = vi.fn(async ({ data }: any) => ({ count: data.length }));
  prismaMock.tenantToolPermission.findMany = vi.fn(async () => []);
  prismaMock.tenantToolPermission.upsert = vi.fn(async () => ({}));
  prismaMock.tenantIntegration.update = vi.fn(async () => ({}));
  prismaMock.auditLog.create = vi.fn(async () => ({}));
});

const rows = (ids: string[], disabled: string[] = []) =>
  ids.map((catalogToolId) => ({ id: `tt_${catalogToolId}`, catalogToolId, isEnabled: !disabled.includes(catalogToolId) }));

// ── Disconnect ──────────────────────────────────────────────

describe("disconnect is a state transition, not a policy deletion", () => {
  it("never deletes tenant tool rows", async () => {
    await disconnectIntegration({ tenantId: "t1", tenantIntegrationId: "ti1", slug: "shopify", actorId: "u1" });
    // The whole defect in one assertion: there is no delete path any more.
    expect(prismaMock.tenantTool.createMany).not.toHaveBeenCalled();
    expect((prismaMock.tenantTool as any).deleteMany).toBeUndefined();
  });

  it("clears the credentials - a disconnected integration must not hold a live token", async () => {
    await disconnectIntegration({ tenantId: "t1", tenantIntegrationId: "ti1", slug: "shopify", actorId: "u1" });
    const data = prismaMock.tenantIntegration.update.mock.calls[0][0].data;
    expect(data.credentials).toEqual({});
    expect(data.status).toBe("DISCONNECTED");
  });

  it("dates and attributes the transition", async () => {
    await disconnectIntegration({ tenantId: "t1", tenantIntegrationId: "ti1", slug: "shopify", actorId: "u1" });
    const data = prismaMock.tenantIntegration.update.mock.calls[0][0].data;
    expect(data.disconnectedAt).toBeInstanceOf(Date);
    expect(data.disconnectedBy).toBe("u1");
  });

  it("reports how much policy it preserved, and audits it", async () => {
    const r = await disconnectIntegration({ tenantId: "t1", tenantIntegrationId: "ti1", slug: "shopify", actorId: "u1" });
    expect(r.policyRowsPreserved).toBe(4);
    expect(r.credentialsCleared).toBe(true);
    const audit = prismaMock.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("integration.disconnected");
    expect(audit.metadata.policyPreserved).toBe(true);
  });

  it("is idempotent - a second disconnect re-clears rather than failing", async () => {
    await disconnectIntegration({ tenantId: "t1", tenantIntegrationId: "ti1", slug: "shopify" });
    await disconnectIntegration({ tenantId: "t1", tenantIntegrationId: "ti1", slug: "shopify" });
    expect(prismaMock.tenantIntegration.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.tenantIntegration.update.mock.calls[1][0].data.credentials).toEqual({});
  });

  // The flag `credentialsCleared: true` is a fact the audit SHOULD carry. What
  // must never appear is credential MATERIAL - so this checks for the bearing
  // keys and for token-shaped values, not for the word "credentials".
  it("never records credential material in the audit", async () => {
    await disconnectIntegration({ tenantId: "t1", tenantIntegrationId: "ti1", slug: "shopify", actorId: "u1" });
    const metadata = prismaMock.auditLog.create.mock.calls[0][0].data.metadata;
    for (const bearing of ["accessToken", "refreshToken", "apiKey", "secret", "password", "token"]) {
      expect(Object.keys(metadata)).not.toContain(bearing);
    }
    const values = JSON.stringify(Object.values(metadata));
    expect(values).not.toMatch(/shpat_|shpca_|shpss_|Bearer\s/i);
  });

  it("a failed audit write does not leave the integration holding credentials", async () => {
    prismaMock.auditLog.create = vi.fn(async () => { throw new Error("audit down"); });
    await expect(
      disconnectIntegration({ tenantId: "t1", tenantIntegrationId: "ti1", slug: "shopify" }),
    ).resolves.toBeTruthy();
    expect(prismaMock.tenantIntegration.update.mock.calls[0][0].data.credentials).toEqual({});
  });

  it("scopes the transition to one tenant's connection", async () => {
    await disconnectIntegration({ tenantId: "t1", tenantIntegrationId: "ti1", slug: "shopify" });
    expect(prismaMock.tenantIntegration.update.mock.calls[0][0].where).toEqual({ id: "ti1" });
    expect(prismaMock.tenantTool.count.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", tenantIntegrationId: "ti1" });
  });

  it("recordDisconnectAudit never throws", async () => {
    prismaMock.auditLog.create = vi.fn(async () => { throw new Error("boom"); });
    await expect(recordDisconnectAudit({ tenantId: "t1", slug: "s", tenantIntegrationId: "ti1", actorId: null })).resolves.toBeUndefined();
  });
});

// ── Durable operator intent ─────────────────────────────────

describe("the operator's decision is recorded where the connection cannot reach", () => {
  it("uses the documented connection-independent name", () => {
    expect(durableToolName("process_refund")).toBe("integration.process_refund");
  });

  it("writes the decision on an explicit disable", async () => {
    await recordOperatorToolIntent({ tenantId: "t1", catalogToolSlug: "process_refund", enabled: false, actorId: "u1" });
    const call = prismaMock.tenantToolPermission.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId_toolName: { tenantId: "t1", toolName: "integration.process_refund" } });
    expect(call.update.enabled).toBe(false);
    expect(call.create.enabled).toBe(false);
  });

  it("records a HITL decision", async () => {
    await recordOperatorToolIntent({ tenantId: "t1", catalogToolSlug: "cancel_order", requiresApproval: true, approverRole: "ADMIN" });
    const call = prismaMock.tenantToolPermission.upsert.mock.calls[0][0];
    expect(call.update.requiresApproval).toBe(true);
    expect(call.update.approverRole).toBe("ADMIN");
  });

  // A partial change must not assert defaults for everything it did not mention,
  // or setting HITL would silently re-enable a disabled tool.
  it("patches only the fields the operator actually set", async () => {
    await recordOperatorToolIntent({ tenantId: "t1", catalogToolSlug: "cancel_order", requiresApproval: true });
    const update = prismaMock.tenantToolPermission.upsert.mock.calls[0][0].update;
    expect(update).not.toHaveProperty("enabled");
  });

  it("never throws - a durable-copy failure must not fail the operator's change", async () => {
    prismaMock.tenantToolPermission.upsert = vi.fn(async () => { throw new Error("db down"); });
    await expect(recordOperatorToolIntent({ tenantId: "t1", catalogToolSlug: "x", enabled: false })).resolves.toBeUndefined();
  });

  it("loads decisions keyed by catalog slug", async () => {
    prismaMock.tenantToolPermission.findMany = vi.fn(async () => [
      { toolName: "integration.process_refund", enabled: false, requiresApproval: false, expiresAfterMin: 30, allowModification: false },
      { toolName: "integration.cancel_order", enabled: true, requiresApproval: true, approverRole: "ADMIN", expiresAfterMin: 60, allowModification: true },
    ]);
    const m = await loadOperatorToolIntents("t1");
    expect(m.get("process_refund")?.enabled).toBe(false);
    expect(m.get("cancel_order")?.requiresApproval).toBe(true);
    expect(m.get("cancel_order")?.approverRole).toBe("ADMIN");
  });

  it("degrades to catalogue defaults rather than refusing to provision", async () => {
    prismaMock.tenantToolPermission.findMany = vi.fn(async () => { throw new Error("db down"); });
    expect((await loadOperatorToolIntents("t1")).size).toBe(0);
  });

  it("renders HITL in the exact shape the execution gate reads", () => {
    const f = tenantToolFieldsFromIntent({ enabled: false, requiresApproval: true, approverRole: "ADMIN", expiresAfterMin: 60, allowModification: true });
    expect(f.isEnabled).toBe(false);
    expect((f.configOverrides as any).hitlPolicy.mode).toBe("always");
    expect((f.configOverrides as any).hitlPolicy.approverRole).toBe("ADMIN");
  });
});

// ── Reconnect ───────────────────────────────────────────────

describe("reconnect rebuilds from the decision, not from the catalogue default", () => {
  it("THE regression: a disabled tool comes back disabled", async () => {
    prismaMock.tenantToolPermission.findMany = vi.fn(async () => [
      { toolName: "integration.process_refund", enabled: false, requiresApproval: false, expiresAfterMin: 30, allowModification: false },
    ]);
    prismaMock.tenantTool.findMany = vi
      .fn()
      .mockResolvedValueOnce([])                                    // post-disconnect: nothing
      .mockResolvedValueOnce(rows(["r1", "w1", "a1", "a2"], ["a1"])); // after recreate

    const r = await provisionIntegrationTools("t1", "ti1", "cat", { reason: "reconnect" });

    const created = prismaMock.tenantTool.createMany.mock.calls[0][0].data;
    const refund = created.find((d: any) => d.catalogToolId === "a1");
    expect(refund.isEnabled).toBe(false);
    expect(r.restoredFromIntent).toBe(1);
  });

  it("restores a HITL decision in the gate's own shape", async () => {
    prismaMock.tenantToolPermission.findMany = vi.fn(async () => [
      { toolName: "integration.cancel_order", enabled: true, requiresApproval: true, approverRole: "ADMIN", expiresAfterMin: 60, allowModification: false },
    ]);
    prismaMock.tenantTool.findMany = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows(["r1", "w1", "a1", "a2"]));

    await provisionIntegrationTools("t1", "ti1", "cat");

    const created = prismaMock.tenantTool.createMany.mock.calls[0][0].data;
    const cancel = created.find((d: any) => d.catalogToolId === "a2");
    expect(cancel.configOverrides.hitlPolicy.mode).toBe("always");
    expect(cancel.isEnabled).toBe(true);
  });

  it("a tool nobody configured gets the catalogue default - no invented disabled state", async () => {
    prismaMock.tenantToolPermission.findMany = vi.fn(async () => [
      { toolName: "integration.process_refund", enabled: false, requiresApproval: false, expiresAfterMin: 30, allowModification: false },
    ]);
    prismaMock.tenantTool.findMany = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows(["r1", "w1", "a1", "a2"], ["a1"]));

    const r = await provisionIntegrationTools("t1", "ti1", "cat");

    const created = prismaMock.tenantTool.createMany.mock.calls[0][0].data;
    expect(created.find((d: any) => d.catalogToolId === "r1").isEnabled).toBe(true);
    expect(created.find((d: any) => d.catalogToolId === "w1").isEnabled).toBe(true);
    expect(r.restoredFromIntent).toBe(1); // only the one that was actually decided
  });

  it("a first connect has nothing to restore and provisions the whole surface", async () => {
    prismaMock.tenantTool.findMany = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows(["r1", "w1", "a1", "a2"]));
    const r = await provisionIntegrationTools("t1", "ti1", "cat");
    expect(r.restoredFromIntent).toBe(0);
    expect(r.byCategory).toEqual({ READ: 1, WRITE: 1, ACTION: 2 });
  });

  it("a newly added catalog tool provisions at its default without touching existing rows", async () => {
    prismaMock.tenantTool.findMany = vi
      .fn()
      .mockResolvedValueOnce(rows(["r1", "w1", "a1"]))              // a2 is new
      .mockResolvedValueOnce(rows(["r1", "w1", "a1", "a2"]));
    prismaMock.agentToolPermission.findMany = vi.fn(async () => rows(["r1", "w1", "a1"]).map((t) => ({ aiAgentId: "agent1", tenantToolId: t.id, isAllowed: true })));

    await provisionIntegrationTools("t1", "ti1", "cat");

    const created = prismaMock.tenantTool.createMany.mock.calls[0][0].data;
    expect(created).toHaveLength(1);
    expect(created[0].catalogToolId).toBe("a2");
  });

  it("repeated reconnect is idempotent", async () => {
    prismaMock.tenantTool.findMany = vi.fn(async () => rows(["r1", "w1", "a1", "a2"]));
    prismaMock.agentToolPermission.findMany = vi.fn(async () =>
      rows(["r1", "w1", "a1", "a2"]).map((t) => ({ aiAgentId: "agent1", tenantToolId: t.id, isAllowed: true })),
    );
    const first = await provisionIntegrationTools("t1", "ti1", "cat");
    const second = await provisionIntegrationTools("t1", "ti1", "cat");
    expect(first.granted).toBe(0);
    expect(second.granted).toBe(0);
    expect(prismaMock.agentToolPermission.createMany).not.toHaveBeenCalled();
  });

  it("an existing disabled row is still never re-enabled", async () => {
    prismaMock.tenantTool.findMany = vi.fn(async () => rows(["r1", "w1", "a1", "a2"], ["a1"]));
    const r = await provisionIntegrationTools("t1", "ti1", "cat");
    const granted = prismaMock.agentToolPermission.createMany.mock.calls[0][0].data.map((d: any) => d.tenantToolId);
    expect(granted).not.toContain("tt_a1");
    expect(r.preserved).toBeGreaterThanOrEqual(1);
  });

  it("only ever reads this tenant's decisions", async () => {
    prismaMock.tenantTool.findMany = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows(["r1"]));
    await provisionIntegrationTools("t9", "ti9", "cat");
    expect(prismaMock.tenantToolPermission.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t9" });
  });
});
