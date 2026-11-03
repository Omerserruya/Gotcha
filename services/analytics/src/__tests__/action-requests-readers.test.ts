/**
 * Home's in-flight line and the tools report read the AI employees' actions
 * (tool_execution_requests) as well as the legacy tool_executions (2026-11-03).
 * Both tables held the truth on different routes; only the legacy one, empty
 * everywhere, was read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  executions: [] as any[],
  requests: [] as any[],
  audits: [] as any[],
  requestWheres: [] as any[],
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      conversation: { count: async () => 0 },
      approvalRequest: { count: async () => 0 },
      toolExecution: { findMany: async () => H.executions },
      auditLog: { findMany: async () => H.audits },
      toolExecutionRequest: {
        findMany: async (a: any) => { H.requestWheres.push(a.where); return H.requests; },
      },
    },
  };
});

import { getInFlight, getToolUsageStats } from "../services/analytics.service";

beforeEach(() => {
  H.executions = []; H.requests = []; H.audits = []; H.requestWheres = [];
});

describe("in flight", () => {
  it("counts the AI's actions by subject, dotted names by their bare tool, unmapped ones left out", async () => {
    H.requests = [
      { tool: "shopify.get_order" }, { tool: "woocommerce.order_lookup" }, { tool: "check_delivery_eta" },
      { tool: "shopify.create_discount_code" }, { tool: "woocommerce.list_products" }, { tool: "escalate_to_human" },
    ];
    H.executions = [{ toolName: "get_order" }];
    const r = await getInFlight("T");
    expect(r.toolsRunning).toEqual([{ subject: "order", count: 4 }, { subject: "customer", count: 1 }]);
  });

  it("reads only running or completed actions started inside the window, for this tenant", async () => {
    const before = Date.now();
    await getInFlight("T");
    const w = H.requestWheres[0];
    expect(w.tenantId).toBe("T");
    expect(w.status).toEqual({ in: ["running", "completed"] });
    const since = (w.startedAt.gte as Date).getTime();
    expect(before - since).toBeGreaterThanOrEqual(2 * 60_000 - 50);
    expect(before - since).toBeLessThanOrEqual(2 * 60_000 + 1000);
  });
});

describe("tools report", () => {
  it("adds the undotted actions: completed a success, denied a refusal, failed an error, with durations", async () => {
    const t = (s: number) => new Date(Date.UTC(2026, 10, 3, 10, 0, s));
    H.requests = [
      { tool: "escalate_to_human", status: "completed", startedAt: t(0), completedAt: t(2) },
      { tool: "escalate_to_human", status: "completed", startedAt: t(0), completedAt: t(4) },
      { tool: "escalate_to_human", status: "denied", startedAt: null, completedAt: null },
      { tool: "escalate_to_human", status: "failed", startedAt: t(0), completedAt: t(6) },
    ];
    const rows = await getToolUsageStats("T");
    expect(rows).toEqual([{
      toolId: "escalate_to_human", toolName: "escalate_to_human",
      executionCount: 4, successRate: 50, successCount: 2, refusedCount: 1, erroredCount: 1,
      unclassifiedFailureCount: 0, avgDurationMs: 4000,
    }]);
  });

  it("never reads a dotted (connector) action from the requests: the adapter audit row already counts it", async () => {
    H.audits = [{ metadata: { tool: "shopify.get_order", ok: true, durationMs: 100 } }];
    await getToolUsageStats("T");
    const w = H.requestWheres[0];
    expect(w.NOT).toEqual({ tool: { contains: "." } });
    expect(w.tenantId).toBe("T");
    expect(w.status).toEqual({ in: ["completed", "failed", "denied"] });
    expect(w.proposedAt).toHaveProperty("gte");
    expect(w.proposedAt).toHaveProperty("lte");
  });
});
