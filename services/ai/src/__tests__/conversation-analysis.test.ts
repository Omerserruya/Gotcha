/**
 * ★ Conversation intelligence on every close
 * (docs/architecture/conversation-intelligence-on-close.md):
 *   - a closed real conversation: ONE metered micro-model call with the real
 *     workspace, a fixed intent, the pipeline's summary reused, the intent on
 *     the last customer message
 *   - never: a rehearsal, a test row, imported history, VOICE, an open one
 *   - once: up to date after its last message (old heuristic rows do not
 *     count), a lock against the event and the sweeper both running
 *   - the daily cap (a person asking is not capped); over it, nothing written
 *   - an answer outside the list is not a guess: settled with no intent
 *   - a failing model is retried 3 times, then settled (no paid loop)
 *   - the sweeper finds what no event announced and leaves a capped workspace
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({
  convs: [] as any[],
  messages: [] as any[],
  intel: new Map<string, any>(),
  msgUpdates: [] as any[],
  redis: new Map<string, number | string>(),
  calls: [] as any[],
  reply: (() => ({ content: JSON.stringify({ intent: "returns_exchanges", sentiment: "negative", sentimentScore: -0.6, topics: ["duvet size", "exchange"] }) })) as (a: any) => any,
  inFlight: 0,
  maxInFlight: 0,
  delayMs: 0,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const redis = {
    incr: async (k: string) => { const v = Number(H.redis.get(k) ?? 0) + 1; H.redis.set(k, v); return v; },
    decr: async (k: string) => { const v = Number(H.redis.get(k) ?? 0) - 1; H.redis.set(k, v); return v; },
    expire: async () => 1,
    get: async (k: string) => (H.redis.has(k) ? String(H.redis.get(k)) : null),
    set: async (k: string, v: string, ..._a: any[]) => { if (H.redis.has(k)) return null; H.redis.set(k, v); return "OK"; },
    del: async (k: string) => { H.redis.delete(k); return 1; },
  };
  return {
    ...actual,
    getRedis: () => redis,
    createWorker: () => undefined,
    readDurableSetting: async () => JSON.stringify({ timezone: "Asia/Jerusalem", schedule: {} }),
    resolveEffectiveLocale: async () => ({ effective: "he" }),
    prisma: {
      conversation: { findFirst: async (a: any) => H.convs.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null },
      conversationIntelligence: {
        findUnique: async (a: any) => H.intel.get(a.where.conversationId) ?? null,
        upsert: async (a: any) => { const row = { ...(H.intel.get(a.where.conversationId) ?? a.create), ...(H.intel.has(a.where.conversationId) ? a.update : {}) }; H.intel.set(a.where.conversationId, row); return row; },
      },
      message: {
        findMany: async (a: any) => H.messages.filter((m) => m.conversationId === a.where.conversationId && m.messageType !== "system"),
        update: async (a: any) => { H.msgUpdates.push(a); return {}; },
      },
      toolExecution: { count: async () => 2 },
      // The sweep's query, in JS: same conditions as the SQL (the SQL itself is checked live).
      $queryRaw: async (_s: TemplateStringsArray, since: Date, exclude: string[], excludeIds: string[], limit: number) =>
        H.convs
          .filter((c) => c.status === "CLOSED" && c.origin === "LIVE" && !c.isTest && !String(c.customerExternalId).startsWith("sandbox:") && c.channel !== "VOICE" && c.updatedAt >= since && !exclude.includes(c.tenantId) && !excludeIds.includes(c.id))
          .filter((c) => { const i = H.intel.get(c.id); return !i || i.metadata?.source !== "close-analysis" || i.analyzedAt < (c.lastMessageAt ?? c.updatedAt); })
          .slice(0, limit)
          .map((c) => ({ id: c.id, tenant_id: c.tenantId })),
    },
  };
});

vi.mock("../services/ai.service", () => ({
  getMicroModel: () => "gpt-5-nano",
  generateResponse: async (a: any) => {
    H.calls.push(a);
    H.inFlight++;
    H.maxInFlight = Math.max(H.maxInFlight, H.inFlight);
    try {
      if (H.delayMs) await new Promise((r) => setTimeout(r, H.delayMs));
      return H.reply(a);
    } finally {
      H.inFlight--;
    }
  },
}));

import { analyzeConversationOnClose, runSweep, parseAnalysis, transcriptOf, intentLabel } from "../services/conversation-analysis.service";

const now = Date.now();
const conv = (id: string, o: any = {}) => ({
  id, tenantId: "T", status: "CLOSED", channel: "WHATSAPP", isTest: false, customerExternalId: `9725${id}`, origin: "LIVE",
  lastMessageAt: new Date(now - 60_000), updatedAt: new Date(now - 30_000), aiSummary: "Wanted a bigger duvet", ...o,
});
const msgs = (conversationId: string) => [
  { id: `${conversationId}-m1`, conversationId, direction: "INBOUND", body: "The duvet is too small", messageType: "text", metadata: { channelMsgId: "w1" } },
  { id: `${conversationId}-m2`, conversationId, direction: "OUTBOUND", body: "We can exchange it", messageType: "text", metadata: {} },
  { id: `${conversationId}-sys`, conversationId, direction: "INBOUND", body: "", messageType: "system", metadata: {} },
];
const run = (id: string, o: any = {}) => analyzeConversationOnClose("T", id, { trigger: "closed", ...o });

beforeEach(() => {
  H.convs = [conv("c1")];
  H.messages = msgs("c1");
  H.intel = new Map();
  H.msgUpdates = [];
  H.redis = new Map([["intel:enabled", "1"]]);
  H.calls = [];
  H.inFlight = 0; H.maxInFlight = 0; H.delayMs = 0;
  H.reply = () => ({ content: JSON.stringify({ intent: "returns_exchanges", sentiment: "negative", sentimentScore: -0.6, topics: ["duvet size", "exchange"] }) });
  delete process.env.CONVERSATION_ANALYSIS_DAILY_CAP;
  delete process.env.CONVERSATION_ANALYSIS;
});
afterEach(() => { vi.useRealTimers(); });

describe("★ a closed real conversation is analysed once, with one metered call", () => {
  it("the row: a listed intent, sentiment, topics, the pipeline's summary; the intent on the last customer message", async () => {
    expect(await run("c1")).toBe("analyzed");
    expect(H.calls).toHaveLength(1);
    const call = H.calls[0];
    expect(call).toMatchObject({ tenantId: "T", model: "gpt-5-nano", responseFormat: { type: "json_object" }, metadata: { conversationId: "c1" } });
    expect(call.messages[0].content).toMatch(/Write topics in Hebrew/);
    expect(call.messages[1].content).toBe("Customer: The duvet is too small\nBusiness: We can exchange it");
    expect(H.intel.get("c1")).toMatchObject({
      tenantId: "T", conversationId: "c1", detectedIntent: "returns_exchanges", sentiment: "negative", sentimentScore: -0.6,
      topics: ["duvet size", "exchange"], summary: "Wanted a bigger duvet", resolutionOutcome: "resolved", customerEffort: 1,
      metadata: { source: "close-analysis", trigger: "closed", model: "gpt-5-nano" },
    });
    expect(H.msgUpdates).toEqual([{ where: { id: "c1-m1" }, data: { metadata: { channelMsgId: "w1", intent: "returns_exchanges" } } }]);
  });

  it.each([
    ["a rehearsal", { customerExternalId: "sandbox:ag:1" }, "not_real"],
    ["a test row", { isTest: true }, "not_real"],
    ["imported history", { origin: "HISTORICAL" }, "not_real"],
    ["a call", { channel: "VOICE" }, "voice"],
    ["an open conversation", { status: "OPEN" }, "not_closed"],
  ])("never %s (no call, no row)", async (_n, o, outcome) => {
    H.convs = [conv("c1", o)];
    expect(await run("c1")).toBe(outcome);
    expect(H.calls).toHaveLength(0);
    expect(H.intel.size).toBe(0);
  });

  it("another workspace's conversation is not found", async () => {
    expect(await analyzeConversationOnClose("OTHER", "c1", { trigger: "closed" })).toBe("not_found");
    expect(H.calls).toHaveLength(0);
  });

  it("no customer text: settled without an intent, no call", async () => {
    H.messages = msgs("c1").filter((m) => m.direction !== "INBOUND");
    expect(await run("c1")).toBe("no_customer_text");
    expect(H.calls).toHaveLength(0);
    expect(H.intel.get("c1")).toMatchObject({ detectedIntent: null, sentiment: null, metadata: { source: "close-analysis", outcome: "no_customer_text" } });
  });
});

describe("★ off until switched on (it spends money; the first sweep is a backfill)", () => {
  it("not switched on: no automatic analysis and no sweep; a person asking still gets one", async () => {
    H.redis.delete("intel:enabled");
    expect(await run("c1")).toBe("disabled");
    expect(await runSweep()).toEqual({});
    expect(H.calls).toHaveLength(0);
    expect(await analyzeConversationOnClose("T", "c1", { trigger: "manual", force: true })).toBe("analyzed");
  });

  it("the env decides when set", async () => {
    process.env.CONVERSATION_ANALYSIS = "off";
    expect(await run("c1")).toBe("disabled");
    H.redis.delete("intel:enabled");
    process.env.CONVERSATION_ANALYSIS = "on";
    expect(await run("c1")).toBe("analyzed");
  });
});

describe("★ once", () => {
  it("up to date after its last message: no second call", async () => {
    await run("c1");
    expect(await run("c1")).toBe("up_to_date");
    expect(H.calls).toHaveLength(1);
  });

  it("an old heuristic row does not count as analysed", async () => {
    H.intel.set("c1", { detectedIntent: "general", sentiment: "neutral", metadata: null, analyzedAt: new Date() });
    expect(await run("c1")).toBe("analyzed");
  });

  it("reopened and closed again with new messages: analysed again", async () => {
    await run("c1");
    H.convs[0].lastMessageAt = new Date(Date.now() + 60_000);
    expect(await run("c1")).toBe("analyzed");
    expect(H.calls).toHaveLength(2);
  });

  it("the event and the sweeper at once: the lock lets one through", async () => {
    H.redis.set("intel:lock:c1", "1");
    expect(await run("c1")).toBe("locked");
    expect(H.calls).toHaveLength(0);
  });

  it("the lock is released after a run", async () => {
    await run("c1");
    expect(H.redis.has("intel:lock:c1")).toBe(false);
  });
});

describe("★ the daily cap", () => {
  it("over the cap: nothing written; the next workspace day it runs; a person asking is not capped", async () => {
    process.env.CONVERSATION_ANALYSIS_DAILY_CAP = "2";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    H.convs = ["a", "b", "c"].map((id) => conv(id, { lastMessageAt: new Date("2026-10-08T09:00:00Z"), updatedAt: new Date("2026-10-08T09:00:00Z") }));
    H.messages = [...msgs("a"), ...msgs("b"), ...msgs("c")];
    expect([await run("a"), await run("b"), await run("c")]).toEqual(["analyzed", "analyzed", "over_cap"]);
    expect(H.calls).toHaveLength(2);
    expect(H.intel.has("c")).toBe(false);
    expect(await analyzeConversationOnClose("T", "c", { trigger: "manual", force: true })).toBe("analyzed");
    // 21:30 UTC is already 9 October in Jerusalem: a new day's allowance.
    vi.setSystemTime(new Date("2026-10-08T21:30:00Z"));
    H.intel.delete("c");
    expect(await run("c")).toBe("analyzed");
  });

  it("a cap of 0 analyses nothing automatically", async () => {
    process.env.CONVERSATION_ANALYSIS_DAILY_CAP = "0";
    expect(await run("c1")).toBe("over_cap");
    expect(H.calls).toHaveLength(0);
  });
});

describe("★ never a guess, never a paid loop", () => {
  it.each([
    ["an intent outside the list", { intent: "general", sentiment: "neutral", sentimentScore: 0, topics: [] }],
    ["a sentiment outside the list", { intent: "refund", sentiment: "angry", sentimentScore: -1, topics: [] }],
    ["a score out of range", { intent: "refund", sentiment: "negative", sentimentScore: -3, topics: [] }],
  ])("%s: settled without an intent", async (_n, out) => {
    H.reply = () => ({ content: JSON.stringify(out) });
    expect(await run("c1")).toBe("invalid_output");
    expect(H.intel.get("c1")).toMatchObject({ detectedIntent: null, metadata: { outcome: "invalid_output" } });
    expect(await run("c1")).toBe("up_to_date");
  });

  it("parseAnalysis refuses what is not JSON and trims topics", () => {
    expect(parseAnalysis("not json")).toBeNull();
    expect(parseAnalysis(JSON.stringify({ intent: "refund", sentiment: "neutral", sentimentScore: 0, topics: [" a ", 3, "", "b", "c", "d"] }))?.topics).toEqual(["a", "b", "c"]);
  });

  it("a failing model: retried, and settled on the third failure", async () => {
    H.reply = () => { throw new Error("provider down"); };
    expect(await run("c1")).toBe("model_failed");
    expect(H.intel.has("c1")).toBe(false);
    expect(await run("c1")).toBe("model_failed");
    expect(H.intel.has("c1")).toBe(false);
    expect(await run("c1")).toBe("model_failed");
    expect(H.intel.get("c1")).toMatchObject({ detectedIntent: null, metadata: { outcome: "model_failed" } });
    expect(await run("c1")).toBe("up_to_date");
    expect(H.calls).toHaveLength(3);
  });
});

describe("bounded input and load", () => {
  it("the transcript keeps the END of a long conversation and cuts each message", () => {
    const long = Array.from({ length: 60 }, (_, i) => ({ direction: i % 2 ? "OUTBOUND" : "INBOUND", body: `${i} ${"x".repeat(900)}` }));
    const t = transcriptOf(long);
    expect(t.length).toBeLessThanOrEqual(6000);
    expect(t.endsWith("x".repeat(10))).toBe(true);
    expect(t).toContain("Business: 59 ");
    expect(t).not.toContain("Customer: 0 ");
    for (const line of t.split("\n")) expect(line.length).toBeLessThanOrEqual("Business: ".length + 500);
  });

  it("a burst of closes: at most 2 model calls at once", async () => {
    H.delayMs = 20;
    H.convs = ["a", "b", "c", "d", "e"].map((id) => conv(id));
    H.messages = H.convs.flatMap((c) => msgs(c.id));
    const out = await Promise.all(H.convs.map((c) => run(c.id)));
    expect(out).toEqual(Array(5).fill("analyzed"));
    expect(H.maxInFlight).toBe(2);
  });

  it("intents read in words", () => {
    expect(intentLabel("returns_exchanges", "he")).toBe("החזרות והחלפות");
    expect(intentLabel("returns_exchanges", "en")).toBe("Returns and exchanges");
  });
});

describe("★ the sweeper", () => {
  it("analyses closes no event announced, skips what is done, leaves a capped workspace", async () => {
    process.env.CONVERSATION_ANALYSIS_DAILY_CAP = "1";
    H.convs = [
      conv("done"), conv("new1"), conv("old", { updatedAt: new Date(now - 9 * 86400_000) }),
      conv("u1", { tenantId: "U" }), conv("u2", { tenantId: "U" }), conv("u3", { tenantId: "U" }),
    ];
    H.messages = H.convs.flatMap((c) => msgs(c.id));
    H.intel.set("done", { metadata: { source: "close-analysis" }, analyzedAt: new Date(now) });
    const counts = await runSweep();
    // T: new1 analysed. U: u1 analysed, u2 over the cap, and U leaves the sweep (u3 not tried).
    expect(counts).toEqual({ analyzed: 2, over_cap: 1 });
    expect(H.intel.has("new1")).toBe(true);
    expect(H.intel.has("old")).toBe(false);
    expect(H.calls.map((c) => c.metadata.conversationId).sort()).toEqual(["new1", "u1"]);
  });

  it("★ a passing failure does not stall the sweep on its page (the dev backfill stopped at 50 of 68)", async () => {
    H.convs = ["a", "b", "c", "d", "e"].map((id) => conv(id));
    H.messages = H.convs.flatMap((c) => msgs(c.id));
    H.reply = (a: any) => {
      if (["a", "b"].includes(a.metadata.conversationId)) throw new Error("provider blip");
      return { content: JSON.stringify({ intent: "refund", sentiment: "neutral", sentimentScore: 0, topics: [] }) };
    };
    // Pages of 2: a and b fail (no row), and the next pages still reach c, d, e.
    const counts = await runSweep(7, 10, 2);
    expect(counts).toEqual({ model_failed: 2, analyzed: 3 });
  });
});
