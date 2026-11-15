/**
 * Omer, 2026-11-14: when the owner wrote to a customer from the phone in the
 * last 24 hours, the customer's new conversation starts human-owned, and stays
 * so until someone hands it back (no timer).
 *
 * Smoovee prod 2026-11-13, conv cmweyp0940r1wkdj39ue69ui0: the owner's 06:47
 * message from the WhatsApp Business app came in only as imported history
 * (CLOSED); the customer's 12:37 answer opened a live conversation and the
 * bot took it. Replayed here through dispatch(), against the same in-memory
 * store as inbound-duplicate-delivery.
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
import { OWNER_RECENT_MS } from "../services/owner-recent.service";

const CUSTOMER = "972541111111";
const HOUR = 60 * 60 * 1000;
const wa = (mid: string, from = CUSTOMER, channel = "WHATSAPP") => ({
  id: `job-${Math.random()}`,
  name: "process",
  data: {
    tenantId: "t1", channel, channelAccountId: "ca1",
    normalizedMessage: { externalMessageId: mid, senderId: from, senderDisplayName: "Dana", body: "תודה, ומה עם המשלוח?", messageType: "text", timestamp: new Date().toISOString() },
  },
}) as any;

/** A finished thread with one business-side message, `ago` ms back. */
function pastThread(o: { ago: number; kind: "echo" | "history" | "bot" | "agent"; customer?: string; channel?: string }) {
  const conv = { id: `old-${Math.random()}`, tenantId: "t1", channel: o.channel ?? "WHATSAPP", customerExternalId: o.customer ?? CUSTOMER, status: "CLOSED",
    isHandedOver: o.kind === "echo", origin: o.kind === "history" ? "HISTORICAL_IMPORT" : "LIVE" };
  H.db.conversations.push(conv);
  H.db.messages.push({
    id: `m-${Math.random()}`, tenantId: "t1", channel: conv.channel, conversationId: conv.id, direction: "OUTBOUND",
    createdAt: new Date(Date.now() - o.ago),
    origin: o.kind === "history" ? "HISTORICAL_IMPORT" : "LIVE",
    metadata: o.kind === "echo" ? { source: "whatsapp_business_app", echo: true } : o.kind === "agent" ? { sentByUserId: "u1" } : { aiGenerated: true },
  });
}

const settle = () => H.tick(40);
const aiTurns = () => H.route.mock.calls.length + H.aiTurns.mock.calls.length;
const live = () => H.db.conversations.filter((c) => c.status !== "CLOSED");
const divider = () => H.db.messages.filter((m) => m.messageType === "system" && m.metadata?.systemEvent === "whatsapp_app_takeover");

beforeEach(() => {
  vi.clearAllMocks();
  H.db.conversations.length = 0;
  H.db.messages.length = 0;
  H.redis.clear();
  H.ownerQueryFails = false;
  H.ownerQueries.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("★ the owner wrote from the phone in the last 24 hours: the new conversation is theirs", () => {
  it("★ Smoovee: the owner's message is in imported history, 6 hours back: human-owned, no AI turn, the divider says why", async () => {
    pastThread({ ago: 6 * HOUR, kind: "history" });
    await dispatch(wa("wamid.A1"));
    await settle();
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({ isHandedOver: true, handledBy: "human", status: "OPEN" });
    expect(aiTurns()).toBe(0);
    expect(divider()).toHaveLength(1);
    expect(divider()[0].metadata.reason).toBe("owner_wrote_recently");
  });

  it("an echo from the Business app 2 hours back, in a closed live thread: human-owned", async () => {
    pastThread({ ago: 2 * HOUR, kind: "echo" });
    await dispatch(wa("wamid.A2"));
    await settle();
    expect(live()[0]).toMatchObject({ isHandedOver: true, handledBy: "human" });
    expect(aiTurns()).toBe(0);
  });

  it("no timer: the customer's next message, hours later, still gets no AI turn", async () => {
    pastThread({ ago: 23 * HOUR, kind: "echo" });
    await dispatch(wa("wamid.A3"));
    await dispatch(wa("wamid.A4"));
    await settle();
    expect(live()).toHaveLength(1);
    expect(aiTurns()).toBe(0);
    // Asked once, when the conversation was created; never per message.
    expect(H.ownerQueries).toHaveLength(1);
  });

  it("the window is 24 hours, from now", async () => {
    expect(OWNER_RECENT_MS).toBe(24 * HOUR);
    await dispatch(wa("wamid.W1"));
    const since = H.ownerQueries[0].createdAt.gte.getTime();
    expect(Math.abs(Date.now() - since - 24 * HOUR)).toBeLessThan(5000);
  });
});

describe("controls: the bot starts as before", () => {
  const starts = async (mid: string, from = CUSTOMER, channel = "WHATSAPP") => {
    await dispatch(wa(mid, from, channel));
    await settle();
    expect(live()).toHaveLength(1);
    expect(live()[0].isHandedOver).toBe(false);
    expect(aiTurns()).toBe(1);
    expect(divider()).toHaveLength(0);
  };

  it("the owner's last phone message is 25 hours old", async () => {
    pastThread({ ago: 25 * HOUR, kind: "history" });
    await starts("wamid.C1");
  });

  it("the last business-side message was the bot's", async () => {
    pastThread({ ago: 1 * HOUR, kind: "bot" });
    await starts("wamid.C2");
  });

  it("the last business-side message was an agent's, from the GOTCHA inbox", async () => {
    pastThread({ ago: 1 * HOUR, kind: "agent" });
    await starts("wamid.C3");
  });

  it("the owner wrote to a DIFFERENT customer", async () => {
    pastThread({ ago: 1 * HOUR, kind: "echo", customer: "972549999999" });
    await starts("wamid.C4");
  });

  it("a new customer with no history at all", async () => {
    await starts("wamid.C5");
  });

  it("the check itself fails: the conversation starts as usual (never lose the customer's message)", async () => {
    pastThread({ ago: 1 * HOUR, kind: "echo" });
    H.ownerQueryFails = true;
    await starts("wamid.C6");
  });

  it("an existing open conversation is not touched: the rule only decides a NEW conversation's start", async () => {
    H.db.conversations.push({ id: "open1", tenantId: "t1", channel: "WHATSAPP", customerExternalId: CUSTOMER, status: "OPEN", isHandedOver: false, assignedAgentId: null });
    pastThread({ ago: 1 * HOUR, kind: "echo" });
    await dispatch(wa("wamid.C7"));
    await settle();
    expect(H.ownerQueries).toHaveLength(0);
    expect(H.db.conversations.find((c) => c.id === "open1")!.isHandedOver).toBe(false);
  });
});

describe("the service: WhatsApp only, history included", () => {
  const svc = readFileSync(join(__dirname, "../services/owner-recent.service.ts"), "utf8");
  it("only WhatsApp has a phone app to write from", () => {
    expect(svc).toMatch(/if \(args\.channel !== "WHATSAPP"\) return false;/);
  });
  it("reads imported history (the live-only guard would hide the Smoovee message)", () => {
    expect(svc).toMatch(/withHistoricalRecords\(\(\) => db\.message\.findFirst/);
    expect(svc).toContain('{ origin: "HISTORICAL_IMPORT" }');
    expect(svc).toContain('{ metadata: { path: ["source"], equals: "whatsapp_business_app" } }');
  });
});
