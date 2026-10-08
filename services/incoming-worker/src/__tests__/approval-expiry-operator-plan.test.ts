/**
 * ★ An approval that expires: a customer's request hands their conversation
 * to a person (so the customer is not left hanging); a plan the team proposed
 * in GOTCHA (Home or the command bar) is expired WITHOUT touching the
 * customer's conversation, which would stop GOTCHA answering them
 * (2026-10-08). Neither sends the customer anything.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ approvals: [] as any[], convUpdates: [] as any[], approvalUpdates: [] as any[], events: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      approvalRequest: {
        findMany: async () => H.approvals,
        update: async (a: any) => { H.approvalUpdates.push(a); return {}; },
      },
      conversation: { update: async (a: any) => { H.convUpdates.push(a); return {}; } },
    },
    publishEvent: async (e: any) => { H.events.push(e); },
    outgoingMessageQueue: { add: async () => { throw new Error("must not send"); } },
  };
});

import { expireDueApprovals } from "../workers/idle-conversation.worker";

const row = (o: any) => ({ id: "ap", tenantId: "T", status: "PENDING", conversationId: "conv_1", expiresAt: new Date(0), params: {}, ...o });

beforeEach(() => { H.approvals = []; H.convUpdates = []; H.approvalUpdates = []; H.events = []; });

describe("★ expiry", () => {
  it("a customer's request: EXPIRED, and their conversation goes to a person", async () => {
    H.approvals = [row({ id: "ap_c", tool: "shopify.cancel_order" })];
    await expireDueApprovals();
    expect(H.approvalUpdates[0]).toMatchObject({ where: { id: "ap_c" }, data: { status: "EXPIRED" } });
    expect(H.convUpdates).toEqual([{ where: { id: "conv_1" }, data: { handledBy: "human", isHandedOver: true } }]);
  });

  it("the team's plan (propose_plan, or raised from Home or the command bar): EXPIRED, the conversation untouched", async () => {
    H.approvals = [
      row({ id: "ap_p", tool: "propose_plan", params: { source: "home_assistant" } }),
      row({ id: "ap_h", tool: "assign_conversation", params: { source: "home_assistant" } }),
      row({ id: "ap_b", tool: "close_conversation", params: { source: "command_bar" } }),
      // Any propose_plan is the team's, even one with no source recorded.
      row({ id: "ap_x", tool: "propose_plan", params: {} }),
    ];
    await expireDueApprovals();
    expect(H.approvalUpdates.map((u) => u.where.id)).toEqual(["ap_p", "ap_h", "ap_b", "ap_x"]);
    expect(H.convUpdates).toEqual([]);
    // The panels still hear it expired.
    expect(H.events.map((e) => e.data.approvalId)).toEqual(["ap_p", "ap_h", "ap_b", "ap_x"]);
  });

  it("no conversation at all: expired, nothing else attempted", async () => {
    H.approvals = [row({ id: "ap_n", tool: "issue_refund", conversationId: null })];
    await expireDueApprovals();
    expect(H.approvalUpdates).toHaveLength(1);
    expect(H.convUpdates).toEqual([]);
  });
});
