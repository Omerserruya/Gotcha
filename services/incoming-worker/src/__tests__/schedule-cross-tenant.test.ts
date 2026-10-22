/**
 * "On a schedule" automations run, for every tenant (2026-10-22).
 *
 * runDueSchedules reads every tenant's live schedules - a cross-tenant query -
 * and the tenant guard refused it on every scheduler tick, so no schedule
 * automation ever ran (dev and prod logs: "[TenantGuard] ChatbotFlow.findMany
 * blocked"). The query now runs inside withCrossTenantAccess; each run is still
 * started for its own flow's tenant.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ inScope: false, runs: [] as any[], flows: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    // The real guard's rule: a query with no tenantId runs only inside the scope.
    withCrossTenantAccess: async (fn: () => Promise<any>) => {
      H.inScope = true;
      try { return await fn(); } finally { H.inScope = false; }
    },
    prisma: {
      chatbotFlow: {
        findMany: vi.fn(async (a: any) => {
          if (!a.where.tenantId && !H.inScope) throw new Error("[TenantGuard] ChatbotFlow.findMany blocked: where clause is missing tenantId.");
          return H.flows;
        }),
      },
      automationRun: {
        // Record which tenant each run is started for, then end it as a
        // duplicate so no flow is walked.
        create: vi.fn(async (a: any) => { H.runs.push(a.data); const e: any = new Error("dup"); e.code = "P2002"; throw e; }),
      },
    },
  };
});

import { runDueSchedules } from "../services/automation-runner.service";

const NOW = new Date("2026-10-22T07:00:10Z"); // 10:00 in Asia/Jerusalem
const sched = (id: string, tenantId: string, at: string) => ({ id, tenantId, triggerConfig: { at, timezone: "Asia/Jerusalem" } });

beforeEach(() => { H.runs = []; H.inScope = false; });

describe("★ runDueSchedules", () => {
  it("reads every tenant's schedules without being refused by the tenant guard", async () => {
    H.flows = [sched("f1", "tenant_a", "10:00")];
    await expect(runDueSchedules(NOW)).resolves.toBeTypeOf("number");
  });

  it("★ due flows in 2 tenants each start a run for THEIR OWN tenant", async () => {
    H.flows = [sched("f1", "tenant_a", "10:00"), sched("f2", "tenant_b", "10:00"), sched("f3", "tenant_b", "11:00")];
    await runDueSchedules(NOW);
    expect(H.runs.map((r) => [r.flowId, r.tenantId, r.triggerType])).toEqual([
      ["f1", "tenant_a", "schedule"],
      ["f2", "tenant_b", "schedule"],
    ]);
  });

  it("the cross-tenant scope covers only the read: runs are started outside it", async () => {
    H.flows = [sched("f1", "tenant_a", "10:00")];
    const { prisma } = await import("@chatcenter/shared");
    (prisma.automationRun.create as any).mockImplementationOnce(async (a: any) => {
      H.runs.push({ ...a.data, inScope: H.inScope });
      const e: any = new Error("dup"); e.code = "P2002"; throw e;
    });
    await runDueSchedules(NOW);
    expect(H.runs[0]).toMatchObject({ tenantId: "tenant_a", inScope: false });
  });
});
