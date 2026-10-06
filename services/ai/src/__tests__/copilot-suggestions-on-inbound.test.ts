/**
 * Copilot suggestions are generated on a customer message, never on open.
 *
 * The model entry point (`getSuggestions`) is a counter. Pinned:
 *   - opening a conversation (GET, any number of times) calls it ZERO times,
 *     and returns what is stored in the old `{data, copilotMode}` shape;
 *   - an inbound in a conversation a PERSON answers calls it once, and a burst
 *     of three inbound messages is still once;
 *   - an inbound the AI (or a flow) is answering, or in a closed conversation,
 *     or for a tenant without Copilot, calls it zero times;
 *   - `stale` is true exactly when a customer message is newer than what the
 *     stored suggestions were built on;
 *   - "Try again" generates once, and a second press inside the cooldown is 429.
 * Through the real router (express + supertest) and the real subscriber.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => {
  const db = {
    conversations: [] as any[],
    messages: [] as any[],
    entitled: true,
    events: [] as any[],
  };
  // In-memory Redis with the TTL semantics the code relies on (EX, NX, ttl).
  const store = new Map<string, { v: string; exp: number | null }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (e && e.exp !== null && e.exp <= Date.now()) { store.delete(k); return undefined; }
    return e;
  };
  const redis = {
    get: async (k: string) => live(k)?.v ?? null,
    set: async (k: string, v: string, ...args: any[]) => {
      const ex = args.indexOf("EX");
      const nx = args.includes("NX");
      if (nx && live(k)) return null;
      store.set(k, { v, exp: ex >= 0 ? Date.now() + Number(args[ex + 1]) * 1000 : null });
      return "OK";
    },
    ttl: async (k: string) => { const e = live(k); return e?.exp ? Math.ceil((e.exp - Date.now()) / 1000) : -2; },
    incr: async (k: string) => { const n = Number(live(k)?.v ?? 0) + 1; store.set(k, { v: String(n), exp: live(k)?.exp ?? null }); return n; },
    expire: async (k: string, s: number) => { const e = live(k); if (e) e.exp = Date.now() + s * 1000; return 1; },
  };
  const getSuggestions = vi.fn(async () => [{ id: "s1", text: "Hi, how can I help?", confidence: 0.9, type: "reply" }]);
  return { db, store, redis, getSuggestions };
});

const byWhere = (rows: any[], where: any) =>
  rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));

vi.mock("@chatcenter/shared", () => ({
  // Conversation visibility guard, pass-through: this suite covers other
  // behaviour; the guard is proved in conversation-visibility-ai.test.ts.
  requireVisibleConversation: (_q: any, _s: any, n: any) => n(),
  visibleConversationFrom: () => (_q: any, _s: any, n: any) => n(),
  canViewConversation: async () => true,
  visibilityClause: () => null,
  viewerOf: (req: any) => ({ userId: req?.user?.userId }),
  requireInternalKey: (_q: any, _s: any, n: any) => n(),
  requireEntitlement: () => (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "agent1", role: "AGENT" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  resolveConversationLocale: async () => "en",
  resolveEffectiveLocale: async () => "en",
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  getRedis: () => H.redis,
  isEntitled: async () => H.db.entitled,
  publishEvent: async (e: any) => { H.db.events.push(e); },
  subscribeToEvents: () => ({}),
  prisma: {
    conversation: {
      findFirst: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("tenant guard");
        return byWhere(H.db.conversations, a.where)[0] ?? null;
      },
    },
    message: {
      findFirst: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("tenant guard");
        const rows = byWhere(H.db.messages, a.where).sort((x, y) => y.createdAt - x.createdAt);
        return rows[0] ?? null;
      },
      findMany: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("tenant guard");
        return byWhere(H.db.messages, a.where).sort((x, y) => y.createdAt - x.createdAt).slice(0, a.take ?? 1e9);
      },
    },
    department: { findUnique: async () => null },
    user: { findUnique: async () => null },
  },
}));

vi.mock("../services/ai-assist.service", () => ({
  getSuggestions: H.getSuggestions,
  getEffectiveCopilotConfig: async () => ({ isActive: true, copilotMode: "READY_MESSAGE" }),
}));
vi.mock("../services/agent-config-generator", () => ({ generateAllAgentConfigs: vi.fn(), generateAgentConfig: vi.fn() }));
vi.mock("../services/conversation-intelligence.service", () => ({
  analyzeConversation: vi.fn(), getConversationIntelligence: vi.fn(), getConversationReplay: vi.fn(),
}));
vi.mock("../services/tool-execution.service", () => ({ getToolsForTenant: vi.fn(), executeTool: vi.fn(), getToolExecutions: vi.fn() }));
vi.mock("../services/agent-performance.service", () => ({ scoreAgent: vi.fn(), getAgentScore: vi.fn() }));
vi.mock("../services/followup-generator.service", () => ({ generateFollowup: vi.fn() }));
vi.mock("../services/customer-state.service", () => ({ buildCustomerState: vi.fn() }));
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "gpt-4o-mini" }));

import aiAssistRoutes from "../routes/ai-assist";
import { handleMessageEvent } from "../workers/copilot-suggestions/subscriber";
import {
  isCopilotConversation,
  runIfEligible,
  SUGGESTION_DEBOUNCE_MS,
  __resetSuggestionTimers,
} from "../services/copilot-suggestions.service";

const app = express();
app.use(express.json());
app.use("/api/ai-assist", aiAssistRoutes);

const conv = (o: any = {}) => ({
  id: "c1", tenantId: "T", status: "OPEN", channel: "WHATSAPP", assignedAgentId: "agent1", isHandedOver: false,
  handledBy: "human", chatbotNodeId: null, departmentId: null, customerName: "Dana",
  customerExternalId: "9725", createdAt: new Date(), assignedAiAgentId: null, ...o,
});
let t = 1_000;
const inbound = (id: string) => {
  const m = { id, tenantId: "T", conversationId: "c1", direction: "INBOUND", body: `msg ${id}`, senderName: null, createdAt: new Date(t++) };
  H.db.messages.push(m);
  return m;
};
const evt = (m: any, channel = "WHATSAPP") => ({ event: "message:new", tenantId: "T", data: { message: m, conversationId: "c1", channel } }) as any;
const open = () => request(app).get("/api/ai-assist/c1/suggestions");
const flush = async () => { await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS + 10); };

beforeEach(() => {
  H.db.conversations = [conv()];
  H.db.messages = [];
  H.db.entitled = true;
  H.db.events = [];
  H.store.clear();
  H.getSuggestions.mockClear();
  __resetSuggestionTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe("★ opening a conversation never calls the model", () => {
  it("three opens with nothing stored: zero calls, empty, stale because a customer message exists", async () => {
    inbound("m1");
    for (let i = 0; i < 3; i++) {
      const r = await open();
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ data: [], copilotMode: "READY_MESSAGE", stale: true, basedOnMessageId: null });
    }
    expect(H.getSuggestions).not.toHaveBeenCalled();
  });

  it("no customer message at all: empty and NOT stale (nothing to suggest on)", async () => {
    const r = await open();
    expect(r.body).toMatchObject({ data: [], stale: false });
    expect(H.getSuggestions).not.toHaveBeenCalled();
  });
});

describe("★ an inbound message in a conversation a person answers generates once", () => {
  it("one inbound → one call; then opens read it, still zero further calls", async () => {
    vi.useFakeTimers();
    const m = inbound("m1");
    expect(handleMessageEvent(evt(m))).toBe(true);
    expect(H.getSuggestions).not.toHaveBeenCalled(); // debounced, not immediate
    await flush();
    expect(H.getSuggestions).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    for (let i = 0; i < 3; i++) {
      const r = await open();
      // The old app's contract: data + copilotMode.
      expect(r.body).toMatchObject({ data: [{ id: "s1" }], copilotMode: "READY_MESSAGE", basedOnMessageId: "m1", stale: false });
    }
    expect(H.getSuggestions).toHaveBeenCalledTimes(1);

    // Announced to the conversation's room only, without the suggestion text.
    const e = H.db.events.find((x) => x.event === "copilot.suggestions.updated");
    expect(e.data).toMatchObject({ conversationId: "c1", basedOnMessageId: "m1", channel: "conv:c1" });
    expect(JSON.stringify(e.data)).not.toContain("how can I help");
  });

  it("★ a burst of three customer messages is ONE generation, on the last one", async () => {
    vi.useFakeTimers();
    for (const id of ["m1", "m2", "m3"]) {
      handleMessageEvent(evt(inbound(id)));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await flush();
    expect(H.getSuggestions).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    expect((await open()).body).toMatchObject({ basedOnMessageId: "m3", stale: false });
  });

  it("★ a newer customer message makes the stored set stale until it is regenerated", async () => {
    vi.useFakeTimers();
    handleMessageEvent(evt(inbound("m1")));
    await flush();
    vi.useRealTimers();
    inbound("m2"); // arrived; its generation has not run yet
    expect((await open()).body).toMatchObject({ basedOnMessageId: "m1", stale: true, data: [{ id: "s1" }] });
  });
});

describe("★ no generation when nobody would read it", () => {
  const cases: Array<[string, any]> = [
    ["the AI employee is answering", { assignedAgentId: null, handledBy: "ai_agent" }],
    ["the AI is waiting on an approval", { assignedAgentId: null, handledBy: "awaiting_approval" }],
    ["a flow is answering", { assignedAgentId: null, handledBy: "flow" }],
    ["a flow is parked on a reply", { assignedAgentId: null, handledBy: null, chatbotNodeId: "n1" }],
    ["the conversation is closed", { status: "CLOSED" }],
  ];
  for (const [name, o] of cases) {
    it(`${name}: zero calls`, async () => {
      H.db.conversations = [conv(o)];
      vi.useFakeTimers();
      handleMessageEvent(evt(inbound("m1")));
      await flush();
      expect(H.getSuggestions).not.toHaveBeenCalled();
    });
  }

  it("a tenant without Copilot: zero calls", async () => {
    H.db.entitled = false;
    inbound("m1");
    expect(await runIfEligible("T", "c1")).toMatchObject({ status: "skipped", reason: "not_entitled" });
    expect(H.getSuggestions).not.toHaveBeenCalled();
  });

  it("outbound and voice messages do not schedule anything", () => {
    expect(handleMessageEvent(evt({ id: "o1", direction: "OUTBOUND" }))).toBe(false);
    expect(handleMessageEvent(evt({ id: "v1", direction: "INBOUND" }, "VOICE"))).toBe(false);
  });

  it("an AI conversation handed to a person DOES get suggestions", () => {
    expect(isCopilotConversation(conv({ handledBy: "ai_agent", isHandedOver: true, assignedAgentId: null }))).toBe(true);
    expect(isCopilotConversation(conv({ handledBy: null, assignedAgentId: null }))).toBe(true); // waiting for pickup
  });
});

describe("★ Try again", () => {
  it("generates once and returns the read shape; a second press inside the cooldown is 429", async () => {
    inbound("m1");
    const r = await request(app).post("/api/ai-assist/c1/suggestions/refresh");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ data: [{ id: "s1" }], basedOnMessageId: "m1", stale: false });
    expect(H.getSuggestions).toHaveBeenCalledTimes(1);

    const again = await request(app).post("/api/ai-assist/c1/suggestions/refresh");
    expect(again.status).toBe(429);
    expect(again.body.code).toBe("REFRESH_RATE_LIMITED");
    expect(again.headers["retry-after"]).toBeDefined();
    expect(H.getSuggestions).toHaveBeenCalledTimes(1);
  });

  it("404 for a conversation in another tenant, without calling the model", async () => {
    H.db.conversations = [conv({ tenantId: "OTHER" })];
    expect((await request(app).post("/api/ai-assist/c1/suggestions/refresh")).status).toBe(404);
    expect((await open()).status).toBe(404);
    expect(H.getSuggestions).not.toHaveBeenCalled();
  });
});
