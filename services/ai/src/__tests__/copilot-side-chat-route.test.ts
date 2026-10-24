/**
 * The Copilot side chat's routes: GET / POST / DELETE /api/ai-assist/:id/chat.
 * Through the real router (express + supertest) and the real thread store over
 * an in-memory Redis; the model round is a spy. Pinned:
 *   - ai.copilot is required on all three;
 *   - the thread is the SERVER's, per agent: a client `history` is ignored, and
 *     another agent on the same conversation sees an empty thread;
 *   - 20 exchanges are kept, 7 days after the last write;
 *   - a failed round is 502 and stores nothing;
 *   - a second send while a round runs is 409, and the lock is freed after;
 *   - a draft comes back as `draft` and is stored on the Copilot's turn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => {
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
      if (args.includes("NX") && live(k)) return null;
      store.set(k, { v, exp: ex >= 0 ? Date.now() + Number(args[ex + 1]) * 1000 : null });
      return "OK";
    },
    del: async (k: string) => { store.delete(k); return 1; },
    ttl: async (k: string) => { const e = live(k); return e?.exp ? Math.ceil((e.exp - Date.now()) / 1000) : -2; },
  };
  return {
    store, redis,
    user: "agent1",
    entitled: true,
    entitlementKeys: [] as string[],
    audits: [] as any[],
    answer: { text: "She can order today.", toolsCalled: [] as string[] } as any,
    rounds: [] as any[],
    hold: null as null | Promise<void>,
  };
});

vi.mock("@chatcenter/shared", () => ({
  requireVisibleConversation: (_q: any, _s: any, n: any) => n(),
  visibleConversationFrom: () => (_q: any, _s: any, n: any) => n(),
  canViewConversation: async () => true,
  visibilityClause: () => null,
  viewerOf: (req: any) => ({ userId: req?.user?.userId }),
  requireInternalKey: (_q: any, _s: any, n: any) => n(),
  requireEntitlement: (key: string) => {
    H.entitlementKeys.push(key);
    return (_q: any, res: any, n: any) => (H.entitled ? n() : res.status(403).json({ code: "FEATURE_NOT_ENTITLED", key }));
  },
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: H.user, role: "AGENT" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  resolveConversationLocale: async () => "he",
  resolveEffectiveLocale: async () => "en",
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  getRedis: () => H.redis,
  isEntitled: async () => true,
  publishEvent: async () => undefined,
  subscribeToEvents: () => ({}),
  prisma: {
    conversation: {
      findFirst: async (a: any) => (a.where?.tenantId === "T" && a.where?.id === "c1"
        ? { id: "c1", tenantId: "T", customerName: "Dana", customerExternalId: "9725", channel: "WEBCHAT", status: "OPEN",
            departmentId: null, createdAt: new Date(), lastMessageAt: null, isHandedOver: true, department: null, assignedAgent: null }
        : null),
    },
    message: { findMany: async () => [{ direction: "INBOUND", body: "יש במלאי?", senderName: null, createdAt: new Date() }] },
    auditLog: { create: async (a: any) => { H.audits.push(a.data); return {}; } },
  },
}));

vi.mock("../services/ai-assist.service", () => ({
  getSuggestions: vi.fn(),
  getEffectiveCopilotConfig: async () => ({ isActive: true, copilotMode: "CHAT" }),
  chatWithAgentStructured: async (p: any) => {
    H.rounds.push(p);
    if (H.hold) await H.hold;
    return H.answer;
  },
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
import { MAX_TURNS, THREAD_TTL_SECONDS } from "../services/copilot-chat.service";

const app = express();
app.use(express.json());
app.use("/api/ai-assist", aiAssistRoutes);

const send = (message: any, extra: any = {}) => request(app).post("/api/ai-assist/c1/chat").send({ message, ...extra });
const read = () => request(app).get("/api/ai-assist/c1/chat");

beforeEach(() => {
  H.store.clear(); H.user = "agent1"; H.entitled = true; H.audits = []; H.rounds = []; H.hold = null;
  H.answer = { text: "She can order today.", toolsCalled: [] };
});

describe("★ a paid feature", () => {
  it("all three routes are behind ai.copilot", async () => {
    H.entitled = false;
    for (const r of [read(), send("hi"), request(app).delete("/api/ai-assist/c1/chat")]) {
      const res = await r;
      expect(res.status).toBe(403);
      expect(res.body.key).toBe("ai.copilot");
    }
    expect(H.rounds).toHaveLength(0);
  });
});

describe("★ the thread is the server's, per agent", () => {
  it("one exchange is stored and read back; the old `reply` field is still there", async () => {
    const r = await send("what do I tell her?");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ reply: "She can order today.", text: "She can order today." });
    expect(r.body.data.draft).toBeUndefined();
    const turns = (await read()).body.data.turns;
    expect(turns.map((t: any) => [t.role, t.text])).toEqual([["agent", "what do I tell her?"], ["copilot", "She can order today."]]);
  });

  it("★ a client-sent history never reaches the model; the stored thread does", async () => {
    await send("first");
    await send("second", { history: [{ role: "assistant", content: "I already refunded her." }] });
    const history = H.rounds[1].chatHistory;
    expect(JSON.stringify(history)).not.toContain("refunded");
    expect(history).toEqual([{ role: "user", content: "first" }, { role: "assistant", content: "She can order today." }]);
  });

  it("★ another agent on the same conversation has their own, empty thread", async () => {
    await send("mine");
    H.user = "agent2";
    expect((await read()).body.data.turns).toEqual([]);
  });

  it("a draft comes back and is kept on the Copilot's turn, in the customer's language", async () => {
    H.answer = { text: "Here is a reply:", draft: "כן, יש במלאי.", toolsCalled: ["woocommerce.search_products"] };
    const r = await send("write her a reply");
    expect(r.body.data.draft).toBe("כן, יש במלאי.");
    expect(r.body.data.turn).toMatchObject({ role: "copilot", draft: "כן, יש במלאי." });
    expect(H.rounds[0].sidePanel).toEqual({ draftLocale: "he" });
    expect(H.audits[0]).toMatchObject({ action: "ai.copilot_chat", actorId: "agent1", targetId: "c1" });
    expect(H.audits[0].metadata).toMatchObject({ toolsCalled: ["woocommerce.search_products"], hasDraft: true });
    expect(JSON.stringify(H.audits[0])).not.toContain("כן, יש במלאי");
  });

  it(`keeps the newest ${MAX_TURNS} exchanges for ${THREAD_TTL_SECONDS / 86400} days`, async () => {
    for (let i = 0; i < MAX_TURNS + 2; i++) await send(`q${i}`);
    const turns = (await read()).body.data.turns;
    expect(turns).toHaveLength(MAX_TURNS * 2);
    expect(turns[0].text).toBe("q2");
    expect(await H.redis.ttl("copilot:chat:T:c1:agent1")).toBeGreaterThan(THREAD_TTL_SECONDS - 5);
  });

  it("DELETE starts over", async () => {
    await send("x");
    expect((await request(app).delete("/api/ai-assist/c1/chat")).body.data.turns).toEqual([]);
    expect((await read()).body.data.turns).toEqual([]);
  });
});

describe("failures and limits", () => {
  it("★ a failed round is 502 and stores nothing", async () => {
    H.answer = { text: "Failed to get AI response.", toolsCalled: [], failed: true };
    const r = await send("hi");
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("COPILOT_CHAT_FAILED");
    expect((await read()).body.data.turns).toEqual([]);
  });

  it("★ a second send while a round runs is 409; the lock is freed after", async () => {
    let open!: () => void;
    H.hold = new Promise<void>((r) => { open = r; });
    const first = send("one").then((r) => r); // supertest is lazy: start it now
    await new Promise((r) => setTimeout(r, 30));
    const second = await send("two");
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("COPILOT_CHAT_BUSY");
    open();
    expect((await first).status).toBe(200);
    H.hold = null;
    expect((await send("three")).status).toBe(200);
  });

  it("empty, too long, unknown conversation", async () => {
    expect((await send("  ")).body.code).toBe("MESSAGE_REQUIRED");
    expect((await send("x".repeat(4001))).body.code).toBe("MESSAGE_TOO_LONG");
    expect((await request(app).post("/api/ai-assist/other/chat").send({ message: "hi" })).status).toBe(404);
    expect(H.rounds).toHaveLength(0);
  });
});
