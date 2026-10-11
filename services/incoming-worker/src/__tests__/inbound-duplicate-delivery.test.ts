/**
 * ONE Instagram DM produced two conversations, two message rows and two AI
 * replies (dev, 2026-10-11): Meta delivered every event twice ~400ms apart and
 * two workers raced through check-then-write. Replayed here through dispatch(),
 * concurrently, against an in-memory store whose lock and SET NX behave like
 * the real ones - a double that serialised everything would pass the old code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
  const db = { conversations: [] as any[], messages: [] as any[] };
  const redis = new Map<string, string>();
  const redisState = { down: false };
  const locks = new Map<string, Promise<void>>();
  let seq = 0;

  const conversation = {
    findFirst: vi.fn(async (a: any) => {
      await tick(1);
      const w = a.where;
      const hits = db.conversations.filter((c) => c.tenantId === w.tenantId && c.channel === w.channel
        && c.customerExternalId === w.customerExternalId && c.status !== "CLOSED");
      return hits.length ? { ...hits[hits.length - 1] } : null;
    }),
    create: vi.fn(async (a: any) => {
      await tick(2);
      const row = { id: `conv${++seq}`, assignedAgentId: null, isHandedOver: false, departmentId: null, handledBy: null,
        assignedAiAgentId: null, chatbotNodeId: null, chatbotFlowId: null, automationRunId: null, flowExpiresAt: null, ...a.data };
      db.conversations.push(row);
      return { ...row };
    }),
    update: vi.fn(async () => ({})),
  };
  const message = {
    findFirst: vi.fn(async (a: any) => {
      await tick(1);
      return db.messages.find((m) => a.where.externalMessageId && m.externalMessageId === a.where.externalMessageId) ?? null;
    }),
    create: vi.fn(async (a: any) => {
      if (H.failNextMessageCreate) { H.failNextMessageCreate = false; throw new Error("db blip"); }
      await tick(1);
      const row = { id: `msg${++seq}`, createdAt: new Date(), ...a.data };
      db.messages.push(row);
      return row;
    }),
    count: vi.fn(async () => 1),
  };

  /** pg_advisory_xact_lock: waits for the holder, held until the transaction ends. */
  async function $transaction(fn: (tx: any) => Promise<unknown>) {
    const held: Array<() => void> = [];
    const tx = {
      conversation, message,
      $executeRaw: async (_s: TemplateStringsArray, key: string) => {
        while (locks.has(key)) await locks.get(key);
        let release!: () => void;
        locks.set(key, new Promise<void>((r) => { release = () => { locks.delete(key); r(); }; }));
        held.push(release);
        return 1;
      },
    };
    try { return await fn(tx); } finally { held.forEach((r) => r()); }
  }

  const prisma = {
    tenant: { findUnique: vi.fn(async () => ({ status: "ACTIVE" })) },
    conversation, message,
    channelAccount: { findUnique: vi.fn(async () => ({ id: "ca1", externalId: "ig1", credentials: null })) },
    contact: { update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })), findFirst: vi.fn(async () => null) },
    $transaction: vi.fn($transaction),
  };
  const getRedis = () => ({
    set: async (key: string, val: string, _ex: string, _ttl: number, nx: string) => {
      if (redisState.down) throw new Error("ECONNREFUSED");
      await tick(1);
      if (nx === "NX" && redis.has(key)) return null;
      redis.set(key, val);
      return "OK";
    },
    del: async (key: string) => { if (redisState.down) throw new Error("ECONNREFUSED"); redis.delete(key); return 1; },
  });
  return { db, redis, redisState, locks, prisma, getRedis, tick, failNextMessageCreate: false, aiTurns: vi.fn(async () => true), route: vi.fn(async () => ({ handledByAI: true })) };
});

vi.mock("@chatcenter/shared", () => ({
  probeUploadsDir: () => ({ ok: true, dir: "/tmp/uploads" }),
  describeUploadsProbe: () => "uploads ok",
  classifyMediaFailure: () => "download_failed",
  reportOperationalFailure: () => {},
  ERROR_CODES: new Proxy({}, { get: (_t, k) => String(k) }),
  prisma: H.prisma,
  getRedis: H.getRedis,
  publishEvent: vi.fn(async () => undefined),
  isInboundExcluded: vi.fn(async () => false),
  createWorker: vi.fn(),
  analyticsQueue: { add: vi.fn() },
  outgoingMessageQueue: { add: vi.fn() },
  decryptCredentials: vi.fn(() => ({})),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  resolveContactByChannelId: vi.fn(async () => null),
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
}));
vi.mock("axios", () => ({ default: { get: vi.fn(), head: vi.fn(), post: vi.fn(async () => ({ data: {} })) } }));
vi.mock("../services/whatsapp-approval-inbound.service", () => ({ handleApprovalButtonReply: vi.fn(async () => ({ handled: false })) }));
vi.mock("../services/comment-trigger.service", () => ({ processCommentTrigger: vi.fn() }));
// The pause a real contact lookup has: what lets two workers interleave
// between "no conversation yet" and "create".
vi.mock("../services/ensure-contact.service", () => ({
  ensureContactForInbound: vi.fn(async () => { await H.tick(8); return { id: "k1", displayName: "Omer", avatarUrl: "a" }; }),
}));
vi.mock("../services/locale-detect.service", () => ({ recordDetectedLocaleIfMissing: vi.fn(async () => undefined) }));
vi.mock("../services/identity-link.service", () => ({ tryLinkIdentifierFromInbound: vi.fn(async () => undefined) }));
vi.mock("../services/whatsapp-handoff-link.service", () => ({ linkWebsiteHandoff: vi.fn(async () => ({ linked: false })) }));
// No automation answers, so the message reaches the AI the way Omer's DM did.
vi.mock("../services/automation-runner.service", () => ({
  automationsForInbound: vi.fn(async () => false),
  automationAnsweredBefore: vi.fn(async () => false),
}));
vi.mock("../services/first-unanswered.service", () => ({ isFirstUnanswered: vi.fn(async () => true) }));
vi.mock("../services/ai-bot.service", () => ({ processAIBot: H.aiTurns }));
vi.mock("../services/routing.service", () => ({ routeConversation: H.route }));
vi.mock("../services/flow-executor.service", () => ({ executeMainFlow: vi.fn(), executeSubFlow: vi.fn() }));

import { dispatch } from "../workers/incoming.worker";

const dm = (mid: string, body = "היי") => ({
  id: `job-${Math.random()}`,
  name: "process",
  data: {
    tenantId: "t1", channel: "INSTAGRAM", channelAccountId: "ca1",
    normalizedMessage: { externalMessageId: mid, senderId: "1031990639501705", senderDisplayName: "Omer", body, messageType: "text", timestamp: new Date().toISOString() },
  },
}) as any;

const settle = () => H.tick(40);
/** Every way the worker starts an AI turn: routing (a new conversation) or the bot directly. */
const aiTurns = () => H.route.mock.calls.length + H.aiTurns.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  H.db.conversations.length = 0;
  H.db.messages.length = 0;
  H.redis.clear();
  H.redisState.down = false;
  H.failNextMessageCreate = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the same inbound message delivered twice", () => {
  it("concurrently (two subscriptions, two workers): one conversation, one message, one AI turn", async () => {
    await Promise.all([dispatch(dm("aWdfMID_1")), dispatch(dm("aWdfMID_1"))]);
    await settle();

    expect(H.db.conversations).toHaveLength(1);
    expect(H.db.messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1);
    expect(aiTurns()).toBe(1);
  });

  it("one after the other (a provider retry): still one of each", async () => {
    await dispatch(dm("aWdfMID_2"));
    await dispatch(dm("aWdfMID_2"));
    await settle();

    expect(H.db.conversations).toHaveLength(1);
    expect(H.db.messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1);
    expect(aiTurns()).toBe(1);
  });

  it("a processing failure gives the claim back, so the job's retry is not dropped", async () => {
    H.failNextMessageCreate = true;
    await expect(dispatch(dm("aWdfMID_3"))).rejects.toThrow("db blip");
    await dispatch(dm("aWdfMID_3"));
    await settle();

    expect(H.db.messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1);
    expect(aiTurns()).toBe(1);
  });

  it("Redis down: the message is still processed (never lost), on the database check alone", async () => {
    H.redisState.down = true;
    await dispatch(dm("aWdfMID_4"));
    await settle();

    expect(H.db.messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1);
  });
});

describe("two DIFFERENT messages from a new customer at the same moment", () => {
  it("one conversation, both messages kept", async () => {
    await Promise.all([dispatch(dm("aWdfMID_A", "hi")), dispatch(dm("aWdfMID_B", "are you there?"))]);
    await settle();

    expect(H.db.conversations).toHaveLength(1);
    const inbound = H.db.messages.filter((m) => m.direction === "INBOUND");
    expect(inbound.map((m) => m.externalMessageId).sort()).toEqual(["aWdfMID_A", "aWdfMID_B"]);
    expect(new Set(inbound.map((m) => m.conversationId)).size).toBe(1);
  });

  it("the lock is released: a later conversation lookup does not wait forever", async () => {
    await dispatch(dm("aWdfMID_C"));
    expect(H.locks.size).toBe(0);
  });
});
