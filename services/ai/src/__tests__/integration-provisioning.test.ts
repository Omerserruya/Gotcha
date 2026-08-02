/**
 * A reconnect must not disarm the assistant.
 *
 * Part 3 found the first half of this defect: connecting created no tool
 * permissions at all, so a reconnect left a healthy store and a toolless AI.
 *
 * Part 6 found the other half, the same way - by an operator reconnecting to
 * grant scopes, on the day those scopes were needed. Disconnect deletes tenant
 * tools by cascade and the fix only re-granted READ tools, so the store was
 * healthy, the capability probe was green, 42 of 68 tools were present, and
 * every one of the 26 missing was a WRITE or an ACTION. The assistant could
 * look up any order and could not cancel, refund, return or exchange one.
 *
 * That is worse than having no tools, because the reads answer every diagnostic
 * anyone thinks to run - and reconnecting is the ONLY way to grant a scope, so
 * the operation that makes an assistant more capable is the one that disarms it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// `vi.hoisted`, because `vi.mock` is lifted above every const in the file and a
// factory that closes over a plain `const` reads it before initialisation.
const prismaMock: any = vi.hoisted(() => ({
  catalogTool: { findMany: undefined as any },
  tenantTool: { findMany: undefined as any, createMany: undefined as any },
  aIAgent: { findMany: undefined as any },
  agentToolPermission: { findMany: undefined as any, createMany: undefined as any },
}));
vi.mock("@chatcenter/shared", () => ({ prisma: prismaMock }));

import {
  provisionIntegrationTools,
  enableReadToolsForIntegration,
} from "../services/integration-provisioning.service";

const CATALOG = [
  { id: "r1", category: "READ", slug: "get_order" },
  { id: "r2", category: "READ", slug: "get_customer" },
  { id: "w1", category: "WRITE", slug: "add_order_note" },
  { id: "a1", category: "ACTION", slug: "process_refund" },
  { id: "a2", category: "ACTION", slug: "create_return" },
];

beforeEach(() => {
  prismaMock.catalogTool.findMany = vi.fn();
  prismaMock.tenantTool.findMany = vi.fn();
  prismaMock.tenantTool.createMany = vi.fn();
  prismaMock.aIAgent.findMany = vi.fn();
  prismaMock.agentToolPermission.findMany = vi.fn();
  prismaMock.agentToolPermission.createMany = vi.fn();
  prismaMock.catalogTool.findMany.mockImplementation(async ({ where }: any) => {
    const cats = where?.category?.in as string[] | undefined;
    return cats ? CATALOG.filter((t) => cats.includes(t.category)) : CATALOG;
  });
  prismaMock.tenantTool.createMany.mockResolvedValue({ count: 0 });
  prismaMock.aIAgent.findMany.mockResolvedValue([{ id: "agent1" }]);
  prismaMock.agentToolPermission.findMany.mockResolvedValue([]);
  prismaMock.agentToolPermission.createMany.mockImplementation(async ({ data }: any) => ({ count: data.length }));
});

/** TenantTool rows as they exist after `createMany` has filled the gaps. */
function tenantToolsFor(ids: string[], disabled: string[] = []) {
  return ids.map((catalogToolId) => ({
    id: `tt_${catalogToolId}`,
    catalogToolId,
    isEnabled: !disabled.includes(catalogToolId),
  }));
}

describe("a reconnect restores the whole surface", () => {
  it("provisions WRITE and ACTION tools, not only READ", async () => {
    prismaMock.tenantTool.findMany
      .mockResolvedValueOnce([]) // nothing exists yet
      .mockResolvedValueOnce(tenantToolsFor(["r1", "r2", "w1", "a1", "a2"]));

    const r = await provisionIntegrationTools("t1", "ti1", "cat_shopify");

    expect(r.granted).toBe(5);
    expect(r.byCategory).toEqual({ READ: 2, WRITE: 1, ACTION: 2 });
  });

  it("is the exact regression: reads present, writes and actions missing", async () => {
    // The live shape - READ rows survived, WRITE/ACTION rows did not.
    prismaMock.tenantTool.findMany
      .mockResolvedValueOnce([{ id: "tt_r1", catalogToolId: "r1", isEnabled: true }, { id: "tt_r2", catalogToolId: "r2", isEnabled: true }])
      .mockResolvedValueOnce(tenantToolsFor(["r1", "r2", "w1", "a1", "a2"]));
    prismaMock.agentToolPermission.findMany.mockResolvedValue([
      { aiAgentId: "agent1", tenantToolId: "tt_r1", isAllowed: true },
      { aiAgentId: "agent1", tenantToolId: "tt_r2", isAllowed: true },
    ]);

    const r = await provisionIntegrationTools("t1", "ti1", "cat_shopify");

    expect(r.byCategory).toEqual({ WRITE: 1, ACTION: 2 });
    expect(r.granted).toBe(3);
  });

  it("creates TenantTool rows for the tools that have none", async () => {
    prismaMock.tenantTool.findMany
      .mockResolvedValueOnce([{ id: "tt_r1", catalogToolId: "r1", isEnabled: true }])
      .mockResolvedValueOnce(tenantToolsFor(["r1", "r2", "w1", "a1", "a2"]));

    await provisionIntegrationTools("t1", "ti1", "cat_shopify");

    const created = prismaMock.tenantTool.createMany.mock.calls[0][0].data.map((d: any) => d.catalogToolId);
    expect(created.sort()).toEqual(["a1", "a2", "r2", "w1"]);
  });
});

describe("an operator's decision is never overwritten", () => {
  it("skips a tool the operator switched off, and counts it as preserved", async () => {
    prismaMock.tenantTool.findMany
      .mockResolvedValueOnce(tenantToolsFor(["r1", "r2", "w1", "a1", "a2"], ["a1"]))
      .mockResolvedValueOnce(tenantToolsFor(["r1", "r2", "w1", "a1", "a2"], ["a1"]));

    const r = await provisionIntegrationTools("t1", "ti1", "cat_shopify");

    const granted = prismaMock.agentToolPermission.createMany.mock.calls[0][0].data.map((d: any) => d.tenantToolId);
    expect(granted).not.toContain("tt_a1");
    expect(r.preserved).toBeGreaterThanOrEqual(1);
  });

  it("does not re-allow a permission the operator explicitly denied", async () => {
    prismaMock.tenantTool.findMany
      .mockResolvedValueOnce(tenantToolsFor(["r1", "r2", "w1", "a1", "a2"]))
      .mockResolvedValueOnce(tenantToolsFor(["r1", "r2", "w1", "a1", "a2"]));
    prismaMock.agentToolPermission.findMany.mockResolvedValue([
      { aiAgentId: "agent1", tenantToolId: "tt_a1", isAllowed: false },
    ]);

    const r = await provisionIntegrationTools("t1", "ti1", "cat_shopify");

    const granted = prismaMock.agentToolPermission.createMany.mock.calls[0][0].data.map((d: any) => d.tenantToolId);
    expect(granted).not.toContain("tt_a1");
    expect(r.preserved).toBe(1);
  });

  it("is idempotent - a second run grants nothing", async () => {
    prismaMock.tenantTool.findMany
      .mockResolvedValue(tenantToolsFor(["r1", "r2", "w1", "a1", "a2"]));
    prismaMock.agentToolPermission.findMany.mockResolvedValue(
      ["tt_r1", "tt_r2", "tt_w1", "tt_a1", "tt_a2"].map((tenantToolId) => ({ aiAgentId: "agent1", tenantToolId, isAllowed: true })),
    );

    const r = await provisionIntegrationTools("t1", "ti1", "cat_shopify");
    expect(r.granted).toBe(0);
    expect(prismaMock.agentToolPermission.createMany).not.toHaveBeenCalled();
  });

  it("grants nothing when the tenant has no AI employee", async () => {
    prismaMock.tenantTool.findMany.mockResolvedValue(tenantToolsFor(["r1"]));
    prismaMock.aIAgent.findMany.mockResolvedValue([]);
    expect((await provisionIntegrationTools("t1", "ti1", "cat_shopify")).granted).toBe(0);
  });
});

describe("the CRM source-of-truth toggle still means reads", () => {
  it("grants READ only - electing a system of record is not a licence to write to it", async () => {
    prismaMock.tenantTool.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(tenantToolsFor(["r1", "r2"]));

    const granted = await enableReadToolsForIntegration("t1", "ti1", "cat_shopify");

    expect(granted).toBe(2);
    expect(prismaMock.catalogTool.findMany.mock.calls[0][0].where.category).toEqual({ in: ["READ"] });
  });
});
