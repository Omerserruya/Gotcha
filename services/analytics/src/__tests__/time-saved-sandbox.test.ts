/**
 * Time saved counts the same conversations as /daily and /team: no test and
 * no sandbox rehearsal. Sandbox conversations carry isTest=false, so isTest
 * alone let every setup rehearsal into "Handled by GOTCHA".
 */
import { describe, it, expect, vi } from "vitest";

const DB = vi.hoisted(() => ({
  aiMsgs: [
    { conversationId: "real", conv: { isTest: false, customerExternalId: "97250" } },
    { conversationId: "sandbox", conv: { isTest: false, customerExternalId: "sandbox:abc" } },
    { conversationId: "test", conv: { isTest: true, customerExternalId: "97251" } },
  ],
}));

vi.mock("@chatcenter/shared", () => ({
  getRedis: () => ({}),
  prisma: {
    message: {
      findMany: async (a: any) => {
        const w = a.where.conversation;
        return DB.aiMsgs
          .filter((m) => (w.isTest === false ? !m.conv.isTest : true) && (!w.NOT || !m.conv.customerExternalId.startsWith(w.NOT.customerExternalId.startsWith)))
          .map((m) => ({ conversationId: m.conversationId }));
      },
    },
    conversation: { findMany: async () => [] },
  },
}));

import { getTimeSaved } from "../services/analytics.service";

describe("getTimeSaved", () => {
  it("★ a sandbox rehearsal is not a conversation GOTCHA handled", async () => {
    const r = await getTimeSaved("T");
    expect(r.basis.conversationsHandled).toBe(1);
  });
});
