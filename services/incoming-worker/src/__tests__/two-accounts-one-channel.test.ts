/**
 * Two numbers of one channel on one tenant (prod GOTCHA 2026-11-16): Matan
 * wrote from his phone to the tenant's NEW WhatsApp number (055-293-5559) and
 * the message landed in his open conversation on the SALES number
 * (055-263-3304); the inbox reply went out from the sales number. With two
 * numbers of a channel, the number is part of the conversation's key.
 * Replayed through dispatch(), on the same in-memory store as owner-recent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
  const db = { conversations: [] as any[], messages: [] as any[] };
  const redis = new Map<string, string>();
  const redisState = { down: false };
  const locks = new Map<string, Promise<void>>();
  const accounts: Array<{ id: string; tenantId: string; channel: string; isActive: boolean }> = [];
  let seq = 0;

  const conversation = {
    findFirst: vi.fn(async (a: any) => {
      await tick(1);
      const w = a.where;
      const hits = db.conversations.filter((c) => c.tenantId === w.tenantId && c.channel === w.channel
        && c.customerExternalId === w.customerExternalId && c.status !== "CLOSED"
        && (!("channelAccountId" in w) || (c.channelAccountId ?? null) === w.channelAccountId));
      H.convWheres.push(w);
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
      const row = db.conversations.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId && (c.channelAccountId ?? null) === a.where.channelAccountId);
      if (!row) return { count: 0 };
      Object.assign(row, a.data);
      return { count: 1 };
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
          && db.conversations.find((c) => c.id === m.conversationId && c.customerExternalId === w.conversation.customerExternalId
            && (!("channelAccountId" in w.conversation) || c.channelAccountId === w.conversation.channelAccountId))
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
    channelAccount: {
      findUnique: vi.fn(async (a: any) => ({ id: a.where.id, externalId: "pn", credentials: null })),
      findMany: vi.fn(async (a: any) => {
        const w = a.where;
        return accounts.filter((x) => x.tenantId === w.tenantId && x.channel === w.channel && (w.isActive === undefined || x.isActive === w.isActive)
          && (!w.id?.not || x.id !== w.id.not)).slice(0, a.take ?? 99).map((x) => ({ id: x.id }));
      }),
    },
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
  return { db, accounts, convWheres: [] as any[], redis, redisState, locks, prisma, getRedis, tick, failNextMessageCreate: false, ownerQueryFails: false, ownerQueries: [] as any[], aiTurns: vi.fn(async () => true), route: vi.fn(async () => ({ handledByAI: true })) };
});

vi.mock("@chatcenter/shared", () => ({
  // One-member workspaces (sole-member.ts): two or more members here, nothing assigned.
  assignSoleMemberOnHandoff: async () => null,
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

const MATAN = "972545680665";
const SALES = "ca-sales";
const NEW = "ca-matan";
const HOUR = 60 * 60 * 1000;
const wa = (mid: string, account: string | null, from = MATAN) => ({
  id: `job-${Math.random()}`,
  name: "process",
  data: {
    tenantId: "t1", channel: "WHATSAPP", ...(account ? { channelAccountId: account } : {}),
    normalizedMessage: { externalMessageId: mid, senderId: from, senderDisplayName: "Matan", body: "בדיקה מהמספר החדש", messageType: "text", timestamp: new Date().toISOString() },
  },
}) as any;
const openOn = (account: string | null, extra: Record<string, unknown> = {}) => {
  const row = { id: `conv-${account ?? "detached"}`, tenantId: "t1", channel: "WHATSAPP", channelAccountId: account, customerExternalId: MATAN, status: "OPEN",
    assignedAgentId: null, isHandedOver: false, handledBy: null, assignedAiAgentId: null, departmentId: null, ...extra };
  H.db.conversations.push(row);
  return row;
};
const live = () => H.db.conversations.filter((c) => c.status !== "CLOSED");
const settle = () => H.tick(40);
const msgsIn = (convId: string) => H.db.messages.filter((m) => m.conversationId === convId && m.messageType !== "system");

beforeEach(() => {
  vi.clearAllMocks();
  H.db.conversations.length = 0;
  H.db.messages.length = 0;
  H.accounts.length = 0;
  H.convWheres.length = 0;
  H.redis.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("★ two WhatsApp numbers on one tenant: each number has its own conversation", () => {
  beforeEach(() => {
    H.accounts.push({ id: SALES, tenantId: "t1", channel: "WHATSAPP", isActive: true }, { id: NEW, tenantId: "t1", channel: "WHATSAPP", isActive: true });
  });

  it("★ GOTCHA: Matan writes to the NEW number while his sales-number thread is open -> a new conversation on the new number", async () => {
    const sales = openOn(SALES);
    await dispatch(wa("wamid.M1", NEW));
    await settle();
    expect(live()).toHaveLength(2);
    const mine = live().find((c) => c.id !== sales.id)!;
    expect(mine.channelAccountId).toBe(NEW);
    expect(msgsIn(mine.id)).toHaveLength(1);
    // The sales thread got nothing and still points at the sales number.
    expect(msgsIn(sales.id)).toHaveLength(0);
    expect(sales.channelAccountId).toBe(SALES);
  });

  it("the same customer writing to the SALES number stays in the sales conversation", async () => {
    const sales = openOn(SALES);
    await dispatch(wa("wamid.M2", SALES));
    await settle();
    expect(live()).toHaveLength(1);
    expect(msgsIn(sales.id)).toHaveLength(1);
  });

  it("both numbers, both threads: every message lands on its own number", async () => {
    await dispatch(wa("wamid.M3", SALES));
    await dispatch(wa("wamid.M4", NEW));
    await dispatch(wa("wamid.M5", SALES));
    await dispatch(wa("wamid.M6", NEW));
    await settle();
    expect(live()).toHaveLength(2);
    const bySales = live().find((c) => c.channelAccountId === SALES)!;
    const byNew = live().find((c) => c.channelAccountId === NEW)!;
    expect(msgsIn(bySales.id).map((m) => m.externalMessageId)).toEqual(["wamid.M3", "wamid.M5"]);
    expect(msgsIn(byNew.id).map((m) => m.externalMessageId)).toEqual(["wamid.M4", "wamid.M6"]);
  });

  it("two quick messages to the new number at once -> one conversation", async () => {
    await Promise.all([dispatch(wa("wamid.R1", NEW)), dispatch(wa("wamid.R2", NEW))]);
    await settle();
    expect(live().filter((c) => c.channelAccountId === NEW)).toHaveLength(1);
  });

  it("a DETACHED open conversation is never guessed into one of two numbers", async () => {
    const detached = openOn(null);
    await dispatch(wa("wamid.D1", NEW));
    await settle();
    expect(detached.channelAccountId).toBeNull();
    expect(msgsIn(detached.id)).toHaveLength(0);
    expect(live().find((c) => c.channelAccountId === NEW)).toBeTruthy();
  });

  it("the owner wrote on the SALES number from the phone: the new number's conversation does not start human-owned", async () => {
    const old = { id: "old-sales", tenantId: "t1", channel: "WHATSAPP", channelAccountId: SALES, customerExternalId: MATAN, status: "CLOSED" };
    H.db.conversations.push(old);
    H.db.messages.push({ id: "echo1", tenantId: "t1", channel: "WHATSAPP", conversationId: old.id, direction: "OUTBOUND", createdAt: new Date(Date.now() - HOUR), origin: "LIVE", metadata: { source: "whatsapp_business_app" } });
    await dispatch(wa("wamid.O1", NEW));
    await settle();
    const mine = live().find((c) => c.channelAccountId === NEW)!;
    expect(mine.isHandedOver).toBe(false);
    expect(H.ownerQueries[0].conversation).toMatchObject({ customerExternalId: MATAN, channelAccountId: NEW });
  });

  it("an INACTIVE second number does not count: a detached thread is still re-attached to the one live number", async () => {
    H.accounts[1].isActive = false;
    const detached = openOn(null);
    await dispatch(wa("wamid.I1", SALES));
    await settle();
    expect(live()).toHaveLength(1);
    expect(msgsIn(detached.id)).toHaveLength(1);
    expect(detached.channelAccountId).toBe(SALES);
  });
});

describe("controls: one number per channel behaves exactly as before", () => {
  beforeEach(() => { H.accounts.push({ id: SALES, tenantId: "t1", channel: "WHATSAPP", isActive: true }); });

  it("the lookup is unscoped (no channelAccountId in the where)", async () => {
    openOn(SALES);
    await dispatch(wa("wamid.S1", SALES));
    await settle();
    expect(live()).toHaveLength(1);
    expect(H.convWheres.every((w) => !("channelAccountId" in w))).toBe(true);
  });

  it("a detached open conversation still takes the message and is re-attached to the number", async () => {
    const detached = openOn(null);
    await dispatch(wa("wamid.S2", SALES));
    await settle();
    expect(live()).toHaveLength(1);
    expect(msgsIn(detached.id)).toHaveLength(1);
    expect(detached.channelAccountId).toBe(SALES);
  });

  it("a job with no account (old queue entries) is unscoped even when the tenant has two numbers", async () => {
    H.accounts.push({ id: NEW, tenantId: "t1", channel: "WHATSAPP", isActive: true });
    const sales = openOn(SALES);
    await dispatch(wa("wamid.S3", null));
    await settle();
    expect(live()).toHaveLength(1);
    expect(msgsIn(sales.id)).toHaveLength(1);
  });

  it("another tenant's or another channel's accounts never count", async () => {
    H.accounts.push({ id: "x1", tenantId: "t2", channel: "WHATSAPP", isActive: true }, { id: "x2", tenantId: "t1", channel: "INSTAGRAM", isActive: true });
    const sales = openOn(SALES);
    await dispatch(wa("wamid.S4", SALES));
    await settle();
    expect(H.convWheres.every((w) => !("channelAccountId" in w))).toBe(true);
    expect(msgsIn(sales.id)).toHaveLength(1);
  });
});
