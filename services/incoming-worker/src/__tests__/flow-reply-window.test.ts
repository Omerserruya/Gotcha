/**
 * A flow's free-form send respects the customer-service window (B7,
 * 2026-10-12): a flow can resume days after a wait node. Past 24h WhatsApp
 * takes only a template and Instagram/Messenger nothing, so the send is
 * refused before the provider call (the same thrown failure Meta's 131047
 * used to produce, without the call). The rule is shared lib/reply-window.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/ai-bot.service", () => ({ processAIBot: vi.fn() }));
vi.mock("../services/identity-link.service", () => ({ tryLinkIdentifierFromInbound: vi.fn() }));

const H = vi.hoisted(() => ({
  chatbotFlow: { findFirst: vi.fn(), update: vi.fn() },
  adapter: { channel: "WHATSAPP", sendTextMessage: vi.fn(async () => "wamid.1") },
  lastInbound: null as Date | null,
  lookups: [] as any[],
  fail: false,
}));

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    chatbotFlow: H.chatbotFlow,
    conversation: { update: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    flowCanvas: { findUnique: vi.fn() },
    contact: { findFirst: vi.fn(), update: vi.fn() },
    message: { create: vi.fn() },
    messageTemplate: { findFirst: vi.fn() },
    channelAccount: { findFirst: vi.fn(async () => ({ id: "ca1", externalId: "pnid", credentials: {} })) },
  },
  getOutboundAdapter: vi.fn(() => H.adapter),
  decryptCredentials: vi.fn(() => ({})),
  describeSendError: (err: any) => ({ sendError: { message: err?.message } }),
  publishEvent: vi.fn().mockResolvedValue(undefined),
  flowResumeQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@chatcenter/shared/src/lib/reply-window", async () => {
  const actual = await vi.importActual<any>("../../../../packages/shared/src/lib/reply-window");
  return {
    ...actual,
    lastInboundAtForRecipient: vi.fn(async (a: any) => {
      H.lookups.push(a);
      if (H.fail) throw new Error("db blip");
      return H.lastInbound;
    }),
  };
});

import { executeWebhookFlow } from "../services/flow-executor.service";

const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
const run = (recipientChannel = "WHATSAPP", recipient = "972541111111") => {
  H.chatbotFlow.findFirst.mockResolvedValue({
    id: "flow-1", tenantId: "tenant-1", isActive: true,
    nodes: [
      { id: "n1", type: "start", data: {} },
      { id: "n2", type: "send_message_text", data: { text: "Still interested?", recipient, recipientChannel } },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2" }],
  });
  return executeWebhookFlow({ tenantId: "tenant-1", workflowId: "flow-1", payload: {} }).catch((e: any) => ({ thrown: e?.message }));
};

beforeEach(() => {
  vi.clearAllMocks();
  H.chatbotFlow.update.mockResolvedValue({});
  H.lastInbound = null; H.lookups = []; H.fail = false;
});

describe("flow sends and the window", () => {
  it("★ WhatsApp past 24h: the text is not sent to the provider", async () => {
    H.lastInbound = hoursAgo(30);
    const res: any = await run();
    expect(H.adapter.sendTextMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).toMatch(/TEMPLATE_REQUIRED/);
    expect(H.lookups).toEqual([{ tenantId: "tenant-1", channel: "WHATSAPP", channelAccountId: null, customerExternalId: "972541111111" }]);
  });

  it("★ Instagram past 24h: not sent either", async () => {
    H.lastInbound = hoursAgo(30);
    const res: any = await run("INSTAGRAM", "1031990639501705");
    expect(H.adapter.sendTextMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).toMatch(/REPLY_WINDOW_CLOSED/);
  });

  it("inside 24h: sent", async () => {
    H.lastInbound = hoursAgo(2);
    await run();
    expect(H.adapter.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("an unreadable window: sent anyway", async () => {
    H.fail = true;
    await run();
    expect(H.adapter.sendTextMessage).toHaveBeenCalledTimes(1);
  });
});
