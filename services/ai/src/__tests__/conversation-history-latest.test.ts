/**
 * The model reads the NEWEST turns of a long conversation (2026-10-25, P0).
 *
 * `orderBy asc, take 50` read the first 50 messages: past message 50 the
 * customer's current message never reached the model. The mock below honours
 * orderBy and take as Postgres does, so the old query fails these tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({ rows: [] as any[] }));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    message: {
      findMany: async (a: any) => {
        const order = [a.orderBy].flat()[0] ?? {};
        const dir = order.createdAt === "desc" ? -1 : 1;
        const sorted = H.rows
          .filter((r) => r.conversationId === a.where.conversationId && r.tenantId === a.where.tenantId)
          .sort((x, y) => dir * (x.createdAt.getTime() - y.createdAt.getTime()));
        return a.take ? sorted.slice(0, a.take) : sorted;
      },
    },
  },
}));

import { loadRecentHistory, historyChatMessages, BOT_HISTORY_LIMIT } from "../services/conversation-history.service";

const t0 = Date.UTC(2026, 9, 25, 8, 0, 0);
function conversation(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`, tenantId: "T", conversationId: "c1",
    direction: i % 2 === 0 ? "INBOUND" : "OUTBOUND",
    body: i === n - 1 ? "ומה עם מידה L?" : `הודעה ${i + 1}`,
    messageType: "text",
    createdAt: new Date(t0 + i * 60_000),
  }));
}

beforeEach(() => { H.rows = conversation(61); });

describe("★ a 61-message conversation", () => {
  it("the customer's last message reaches the model's chat turns, last", async () => {
    const chat = historyChatMessages(await loadRecentHistory("T", "c1"));
    expect(chat.at(-1)).toEqual({ role: "user", content: "ומה עם מידה L?" });
  });

  it("the newest 50, oldest first; the first 11 drop out", async () => {
    const rows = await loadRecentHistory<any>("T", "c1");
    expect(rows).toHaveLength(BOT_HISTORY_LIMIT);
    expect(rows[0].id).toBe("m12");
    expect(rows.at(-1).id).toBe("m61");
    for (let i = 1; i < rows.length; i++) expect(rows[i].createdAt.getTime()).toBeGreaterThan(rows[i - 1].createdAt.getTime());
  });

  it("a short conversation comes back whole, in order", async () => {
    H.rows = conversation(3);
    expect((await loadRecentHistory<any>("T", "c1")).map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("history mapping", () => {
  it("customer = user, ours = assistant; empty and system rows skipped", () => {
    expect(historyChatMessages([
      { direction: "INBOUND", body: "היי" },
      { direction: "OUTBOUND", body: "  " },
      { direction: "OUTBOUND", body: "note", messageType: "system" },
      { direction: "OUTBOUND", body: "שלום" },
    ])).toEqual([{ role: "user", content: "היי" }, { role: "assistant", content: "שלום" }]);
  });
});

describe("★ no transcript for the model reads the FIRST N", () => {
  // Every history read that feeds a model or a burst timer: newest first, then reversed.
  const FILES = [
    "services/ai-bot.service.ts",
    "routes/ai-debug.ts",
    "services/agent-loop/bot-loop-adapter.ts",
    "services/intelligence-live-extract.service.ts",
    "services/conversation-history.service.ts",
  ];
  it.each(FILES)("%s has no message.findMany with asc + take", (f) => {
    const src = readFileSync(join(__dirname, "..", f), "utf8");
    const calls = src.split("prisma.message.findMany(").slice(1).map((c) => c.slice(0, c.indexOf("})") + 2));
    for (const c of calls) expect(/createdAt: "asc"[\s\S]*take:|take:[\s\S]*createdAt: "asc"/.test(c), c).toBe(false);
  });
  it("the worker's burst timer reads the newest 50 too", () => {
    const src = readFileSync(join(__dirname, "../../../incoming-worker/src/services/ai-bot.service.ts"), "utf8");
    const calls = src.split("prisma.message.findMany(").slice(1).map((c) => c.slice(0, c.indexOf("})") + 2));
    for (const c of calls) expect(/createdAt: "asc"[\s\S]*take:|take:[\s\S]*createdAt: "asc"/.test(c), c).toBe(false);
  });
});
