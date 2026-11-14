/**
 * Prod GOTCHA 2026-11-14: removing a WhatsApp number deleted its channel row,
 * conversations.channel_account_id is SET NULL, and the re-onboarded number
 * got a new row. 237 open conversations kept receiving inbound (the lookup is
 * tenant + channel + customer) with no account, so no inbox reply could be
 * sent. An inbound on such a conversation now re-attaches it to the account
 * the message arrived on. Replayed through dispatch(), on the harness of
 * owner-recent-new-conversation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    updateMany: vi.fn(async (a: any) => {
      await tick(1);
      const w = a.where;
      const hits = db.conversations.filter((c) => (!w.id || c.id === w.id) && c.tenantId === w.tenantId
        && (w.channelAccountId === undefined || c.channelAccountId === w.channelAccountId));
      hits.forEach((c) => Object.assign(c, a.data));
      return { count: hits.length };
    }),
  };
  const message = {
    findFirst: vi.fn(async (a: any) => {
      await tick(1);
      const w = a.where;
      if (H.ownerQueryFails && w.direction === "OUTBOUND") throw new Error("db blip");
      if (w.direction === "OUTBOUND" && w.createdAt?.gte) {
        H.ownerQueries.push(w);
        return db.messages.find((m) => m.tenantId === w.tenantId && m.channel === w.channel && m.direction === "OUTBOUND"
          && m.createdAt >= w.createdAt.gte
          && db.conversations.find((c) => c.id === m.conversationId)?.customerExternalId === w.conversation.customerExternalId
          && (m.origin === "HISTORICAL_IMPORT" || m.metadata?.source === "whatsapp_business_app")) ?? null;
      }
      return db.messages.find((m) => w.externalMessageId && m.externalMessageId === w.externalMessageId) ?? null;
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
  return { db, redis, redisState, locks, prisma, getRedis, tick, failNextMessageCreate: false, ownerQueryFails: false, ownerQueries: [] as any[], aiTurns: vi.fn(async () => true), route: vi.fn(async () => ({ handledByAI: true })) };
});

vi.mock("@chatcenter/shared", () => ({
  probeUploadsDir: () => ({ ok: true, dir: "/tmp/uploads" }),
  describeUploadsProbe: () => "uploads ok",
  classifyMediaFailure: () => "download_failed",
  reportOperationalFailure: () => {},
  ERROR_CODES: new Proxy({}, { get: (_t, k) => String(k) }),
  prisma: H.prisma,
  withHistoricalRecords: async (fn: () => Promise<unknown>) => await fn(),
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

const CUSTOMER = "972525401686";
const wa = (mid: string, channelAccountId: string | null = "ca_new") => ({
  id: `job-${Math.random()}`,
  name: "process",
  data: {
    tenantId: "t1", channel: "WHATSAPP", channelAccountId,
    normalizedMessage: { externalMessageId: mid, senderId: CUSTOMER, senderDisplayName: "Dana", body: "שלום", messageType: "text", timestamp: new Date().toISOString() },
  },
}) as any;
const openConv = (o: any = {}) => {
  const row = { id: "cmsztwsru0hytz6dblovgaqdd", tenantId: "t1", channel: "WHATSAPP", customerExternalId: CUSTOMER, status: "OPEN",
    channelAccountId: null, customerName: "Dana", customerAvatarUrl: "a", isHandedOver: true, handledBy: "human", assignedAgentId: "u1", ...o };
  H.db.conversations.push(row);
  return row;
};
const settle = () => H.tick(40);

beforeEach(() => {
  vi.clearAllMocks();
  H.db.conversations.length = 0;
  H.db.messages.length = 0;
  H.redis.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("★ an inbound on a detached conversation re-attaches it to the account it arrived on", () => {
  it("★ the prod case: NULL account, the customer writes to the re-onboarded number: attached to it, the message lands in the same conversation", async () => {
    const conv = openConv();
    await dispatch(wa("wamid.R1"));
    await settle();
    expect(conv.channelAccountId).toBe("ca_new");
    expect(H.db.conversations.filter((c) => c.status !== "CLOSED")).toHaveLength(1);
    expect(H.db.messages.filter((m) => m.conversationId === conv.id && m.direction === "INBOUND")).toHaveLength(1);
  });

  it("the write is guarded on NULL, scoped to the tenant and the conversation", async () => {
    openConv();
    await dispatch(wa("wamid.R2"));
    await settle();
    const call = H.prisma.conversation.updateMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a.data.channelAccountId === "ca_new");
    expect(call.where).toEqual({ id: "cmsztwsru0hytz6dblovgaqdd", tenantId: "t1", channelAccountId: null });
  });

  it("control: an attached conversation is never moved to another account", async () => {
    const conv = openConv({ channelAccountId: "ca_other" });
    await dispatch(wa("wamid.R3"));
    await settle();
    expect(conv.channelAccountId).toBe("ca_other");
    expect(H.prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("control: a job with no account leaves it detached (nothing to attach to)", async () => {
    const conv = openConv();
    await dispatch(wa("wamid.R4", null));
    await settle();
    expect(conv.channelAccountId).toBeNull();
    expect(H.prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("a failed attach never loses the message", async () => {
    const conv = openConv();
    H.prisma.conversation.updateMany.mockRejectedValueOnce(new Error("db blip"));
    await dispatch(wa("wamid.R5"));
    await settle();
    expect(conv.channelAccountId).toBeNull();
    expect(H.db.messages.filter((m) => m.conversationId === conv.id && m.direction === "INBOUND")).toHaveLength(1);
  });

  it("a new conversation still takes the job's account, as before", async () => {
    await dispatch(wa("wamid.R6"));
    await settle();
    const live = H.db.conversations.filter((c) => c.status !== "CLOSED");
    expect(live).toHaveLength(1);
    expect(live[0].channelAccountId).toBe("ca_new");
  });
});
