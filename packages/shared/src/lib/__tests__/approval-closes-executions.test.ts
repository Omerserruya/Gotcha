/**
 * closeProposedExecutions: an approval decided against (expired, rejected)
 * moves the orchestrator's "proposed" rows it was opened for to "denied".
 * Matched by tenant, conversation, tool and time, since no column links them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ calls: [] as any[], fail: false, rows: [] as any[], approval: null as any }));
vi.mock("../prisma", () => ({
  prisma: {
    toolExecutionRequest: { updateMany: async (a: any) => { if (H.fail) throw new Error("db down"); H.calls.push(a); return { count: 2 }; } },
    approvalRequest: {
      updateMany: async () => ({ count: H.approval ? 1 : 0 }),
      findFirst: async () => H.approval,
    },
  },
}));
vi.mock("../event-bus", () => ({ publishEvent: async () => undefined }));

import { closeProposedExecutions, rejectRequest } from "../approval-requests";

beforeEach(() => { H.calls = []; H.fail = false; H.approval = null; vi.spyOn(console, "warn").mockImplementation(() => undefined); });

const AR = { tenantId: "T", conversationId: "cmwhgsog", tool: "woocommerce.list_customer_orders", createdAt: new Date("2026-11-15T06:39:55.586Z"), decidedAt: new Date("2026-11-15T07:10:00.198Z") };

describe("closing an approval's execution rows", () => {
  it("only that conversation's still-proposed rows of that tool, from a minute before the approval to its decision", async () => {
    expect(await closeProposedExecutions(AR, "expired")).toBe(2);
    const w = H.calls[0].where;
    expect(w).toMatchObject({ tenantId: "T", conversationId: "cmwhgsog", tool: "woocommerce.list_customer_orders", status: "proposed" });
    expect(w.proposedAt.gte.toISOString()).toBe("2026-11-15T06:38:55.586Z");
    // Rachel's re-proposal at 06:45:40 falls inside, so it closes too.
    expect(+w.proposedAt.lte).toBe(+AR.decidedAt);
    expect(H.calls[0].data).toMatchObject({ status: "denied", error: "approval expired" });
  });
  it("a rejection says so", async () => {
    await closeProposedExecutions(AR, "rejected");
    expect(H.calls[0].data.error).toBe("approval rejected");
  });
  it("no conversation: nothing touched; a database error never throws", async () => {
    expect(await closeProposedExecutions({ ...AR, conversationId: null }, "expired")).toBe(0);
    expect(H.calls).toHaveLength(0);
    H.fail = true;
    expect(await closeProposedExecutions(AR, "expired")).toBe(0);
  });
  it("rejectRequest closes them after it claims the approval, and not when it claims nothing", async () => {
    H.approval = { id: "ap", ...AR, status: "REJECTED" };
    await rejectRequest("T", "ap", "u1", "no");
    expect(H.calls).toHaveLength(1);
    expect(H.calls[0].data.error).toBe("approval rejected");
    H.calls = []; H.approval = null;
    expect(await rejectRequest("T", "ap", "u1", "no")).toBeNull();
    expect(H.calls).toHaveLength(0);
  });
});
