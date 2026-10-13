/**
 * An AI employee's own tool level, at dispatch (A1, Omer 2026-10-13): equal to
 * or stricter than the workspace, never looser. Never denies; Ask turns the
 * workspace's auto-run into an approval; nothing an employee stores can make
 * a workspace "Ask" run on its own.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ levels: {} as Record<string, string>, fail: false, reads: [] as any[] }));
vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    tenantTool: { findFirst: vi.fn(), findUnique: vi.fn() },
    tenantToolPermission: { findUnique: vi.fn().mockResolvedValue(null) },
    agentToolPermission: { findFirst: vi.fn().mockResolvedValue({ isAllowed: true }) },
    customApiTool: { findUnique: vi.fn().mockResolvedValue(null) },
    customDbQueryTool: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("../../../../packages/shared/src/lib/agent-tool-levels", async () => {
  const actual = await vi.importActual<any>("../../../../packages/shared/src/lib/agent-tool-levels");
  return { ...actual, readAgentToolLevels: vi.fn(async (t: string, a: string) => { H.reads.push([t, a]); if (H.fail) throw new Error("blip"); return H.levels; }) };
});

import { evaluatePolicies, prisma } from "@chatcenter/shared";

const p = prisma as any;
function staticTool(requiresApproval: boolean | null) {
  p.tenantToolPermission.findUnique.mockResolvedValue(requiresApproval === null ? null : { enabled: true, requiresApproval });
}

beforeEach(() => { H.levels = {}; H.fail = false; H.reads = []; p.tenantToolPermission.findUnique.mockReset(); });

describe("the employee's level at dispatch", () => {
  it("★ workspace Execute + employee Ask = approval", async () => {
    staticTool(false);
    H.levels = { send_message: "ask" };
    const r = await evaluatePolicies({ tenantId: "T", toolName: "send_message", employeeId: "emp1" });
    expect(r.decision).toBe("REQUIRE_APPROVAL");
    expect(r.reason).toContain("employee=ask");
    expect(H.reads).toEqual([["T", "emp1"]]);
  });

  it("★ employee Never = denied, whatever the workspace", async () => {
    staticTool(false);
    H.levels = { send_message: "never" };
    expect((await evaluatePolicies({ tenantId: "T", toolName: "send_message", employeeId: "emp1" })).decision).toBe("DENY");
  });

  it("workspace Ask stays Ask: an employee cannot loosen it (nothing to store but ask/never)", async () => {
    staticTool(true);
    H.levels = { send_message: "execute" as any };
    expect((await evaluatePolicies({ tenantId: "T", toolName: "send_message", employeeId: "emp1" })).decision).toBe("REQUIRE_APPROVAL");
  });

  it("no level for this tool: the workspace decides", async () => {
    staticTool(false);
    H.levels = { other_tool: "never" };
    expect((await evaluatePolicies({ tenantId: "T", toolName: "send_message", employeeId: "emp1" })).decision).toBe("ALLOW");
  });

  it("no employee: never read", async () => {
    staticTool(false);
    await evaluatePolicies({ tenantId: "T", toolName: "send_message" });
    expect(H.reads).toHaveLength(0);
  });

  it("aiAgentId implies the employee's level too", async () => {
    staticTool(false);
    H.levels = { send_message: "never" };
    expect((await evaluatePolicies({ tenantId: "T", toolName: "send_message", aiAgentId: "emp1" })).decision).toBe("DENY");
  });

  it("unreadable levels: the workspace level holds", async () => {
    staticTool(true);
    H.fail = true;
    expect((await evaluatePolicies({ tenantId: "T", toolName: "send_message", employeeId: "emp1" })).decision).toBe("REQUIRE_APPROVAL");
  });
});
