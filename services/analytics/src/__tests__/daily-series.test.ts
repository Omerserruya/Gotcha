/**
 * GET /api/analytics/daily - the Overview "Conversations a day · GOTCHA · your
 * team" chart and 06b "Alone, or with a person".
 *
 * Pinned: one row per UTC day, oldest first, zeros for quiet days; a
 * conversation answered by a person that day is "team" even if the AI also
 * replied; a conversation started that day is "passedOver" if a person has
 * taken it; test and sandbox conversations are excluded (the double applies
 * the route's own filter, so dropping it fails here).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DB = vi.hoisted(() => ({ messages: [] as any[], convs: [] as any[] }));
const real = (c: any) => !c.isTest && !String(c.customerExternalId).startsWith("sandbox:");

vi.mock("@chatcenter/shared", () => ({
  getRedis: () => ({}),
  prisma: {
    message: {
      findMany: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("tenant guard");
        const w = a.where;
        return DB.messages.filter((m) => {
          const c = DB.convs.find((x) => x.id === m.conversationId)!;
          const convOk = !w.conversation || (w.conversation.isTest === false ? !c.isTest : true) && (!w.conversation.NOT || !String(c.customerExternalId).startsWith(w.conversation.NOT.customerExternalId.startsWith));
          return m.direction === w.direction && m.messageType !== "system" && m.createdAt >= w.createdAt.gte && m.createdAt <= w.createdAt.lte && convOk;
        });
      },
    },
    conversation: {
      findMany: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("tenant guard");
        const w = a.where;
        return DB.convs.filter((c) => (w.isTest === false ? !c.isTest : true)
          && (!w.NOT || !String(c.customerExternalId).startsWith(w.NOT.customerExternalId.startsWith))
          && c.createdAt >= w.createdAt.gte && c.createdAt <= w.createdAt.lte);
      },
    },
  },
}));

import { getDailySeries, isAiOutbound } from "../services/analytics.service";

const today = new Date();
const dayAgo = (n: number, h = 10) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - n, h));
const AI = { source: "ai_bot" };

beforeEach(() => {
  DB.convs = [
    { id: "a", createdAt: dayAgo(1), isTest: false, customerExternalId: "9725", isHandedOver: false, assignedAgentId: null, handledBy: "ai_agent" },
    { id: "b", createdAt: dayAgo(1), isTest: false, customerExternalId: "9726", isHandedOver: true, assignedAgentId: null, handledBy: "human" },
    { id: "t", createdAt: dayAgo(1), isTest: true, customerExternalId: "9727", isHandedOver: false, assignedAgentId: null, handledBy: "ai_agent" },
    { id: "s", createdAt: dayAgo(1), isTest: false, customerExternalId: "sandbox:x", isHandedOver: false, assignedAgentId: null, handledBy: "ai_agent" },
  ];
  DB.messages = [
    { conversationId: "a", direction: "OUTBOUND", messageType: "text", createdAt: dayAgo(1, 11), metadata: AI },
    { conversationId: "a", direction: "OUTBOUND", messageType: "text", createdAt: dayAgo(1, 12), metadata: AI },
    { conversationId: "b", direction: "OUTBOUND", messageType: "text", createdAt: dayAgo(1, 11), metadata: AI },
    { conversationId: "b", direction: "OUTBOUND", messageType: "text", createdAt: dayAgo(1, 13), metadata: {}, senderName: "dana@shop" },
    { conversationId: "a", direction: "OUTBOUND", messageType: "text", createdAt: dayAgo(0, 1), metadata: AI },
    { conversationId: "t", direction: "OUTBOUND", messageType: "text", createdAt: dayAgo(1, 11), metadata: AI },
    { conversationId: "s", direction: "OUTBOUND", messageType: "text", createdAt: dayAgo(1, 11), metadata: AI },
  ];
});

describe("getDailySeries", () => {
  it("★ one row per day, oldest first, with both splits", async () => {
    const r = await getDailySeries("T", 3);
    expect(r.series.map((x) => x.date)).toHaveLength(3);
    const [d2, d1, d0] = r.series;
    expect(d2).toMatchObject({ gotcha: 0, team: 0, alone: 0, passedOver: 0 });
    // Yesterday: a = AI only, b = a person replied too. Test + sandbox excluded.
    expect(d1).toMatchObject({ gotcha: 1, team: 1, alone: 1, passedOver: 1 });
    // Today: a again, AI only - counted once per conversation per day.
    expect(d0).toMatchObject({ gotcha: 1, team: 0 });
  });

  it("caps the window at 90 days and floors at 1", async () => {
    expect((await getDailySeries("T", 500)).series).toHaveLength(90);
    expect((await getDailySeries("T", 0)).series).toHaveLength(7);
  });
});

describe("isAiOutbound - every marker the bot writes", () => {
  it("★ an approval continuation and a plain 'AI Bot' message are the AI, not a person", () => {
    expect(isAiOutbound({ metadata: { source: "approval_continuation" }, senderName: "AI Bot" })).toBe(true);
    expect(isAiOutbound({ metadata: {}, senderName: "AI Bot" })).toBe(true);
    expect(isAiOutbound({ metadata: { aiGenerated: true } })).toBe(true);
    expect(isAiOutbound({ metadata: {}, senderName: "dana@shop" })).toBe(false);
  });
});
