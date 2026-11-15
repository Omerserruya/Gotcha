/**
 * Smoovee prod 2026-11-15: two approvals EXPIRED at 30 minutes, but their
 * three tool_execution_requests rows stayed "proposed", so the conversation's
 * AI-activity panel listed them as waiting forever. Expiry closes them now.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ approvals: [] as any[], closed: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      approvalRequest: { findMany: async () => H.approvals, update: async () => ({}) },
      conversation: { update: async () => ({}) },
    },
    publishEvent: async () => undefined,
    closeProposedExecutions: async (ar: any, outcome: string) => { H.closed.push({ ar, outcome }); return 1; },
    outgoingMessageQueue: { add: async () => { throw new Error("must not send"); } },
  };
});

import { expireDueApprovals } from "../workers/idle-conversation.worker";

beforeEach(() => { H.approvals = []; H.closed = []; vi.spyOn(console, "log").mockImplementation(() => undefined); });

describe("an expired approval closes its execution rows", () => {
  it("with the approval's tenant, conversation, tool and the expiry time", async () => {
    const createdAt = new Date("2026-11-15T06:28:15.065Z");
    H.approvals = [{ id: "cmwhgdyl", tenantId: "T", conversationId: "cmwhgdr7", tool: "woocommerce.list_customer_orders", status: "PENDING", expiresAt: new Date(0), params: {}, createdAt }];
    await expireDueApprovals();
    expect(H.closed).toHaveLength(1);
    expect(H.closed[0].outcome).toBe("expired");
    expect(H.closed[0].ar).toMatchObject({ tenantId: "T", conversationId: "cmwhgdr7", tool: "woocommerce.list_customer_orders", createdAt });
    expect(H.closed[0].ar.decidedAt).toBeInstanceOf(Date);
  });
});
