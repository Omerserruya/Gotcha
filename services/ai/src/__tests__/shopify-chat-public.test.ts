/**
 * Shopify Live Chat — public storefront API.
 *
 * The security boundary of the whole feature. These drive the real
 * Express router with a stubbed database, so what is asserted is the
 * router's actual behaviour rather than a description of it.
 *
 * Everything shared is real except `prisma`, the queues and the
 * entitlement lookup: origin checks, session signing and the visitor
 * projection are the code under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-that-is-long-enough";
  // Tight enough to exercise the limiter without a slow test.
  process.env.SHOPIFY_CHAT_BOOTSTRAP_RPM = "3";
});

vi.mock("bullmq", () => ({
  Queue: class { add = vi.fn().mockResolvedValue(undefined); },
  Worker: class {},
  Job: class {},
}));
vi.mock("ioredis", () => ({
  default: class { publish = vi.fn(); subscribe = vi.fn(); on = vi.fn(); quit = vi.fn(); },
}));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    channelRow: { current: null as any },
    tenantRow: { current: { status: "ACTIVE", isActive: true } as any },
    features: { current: { shopify_live_chat: true, shopify_product_messaging: true } as Record<string, boolean> },
    conversationRow: { current: null as any },
    messages: { current: [] as any[] },
    enqueue: v.fn().mockResolvedValue(undefined),
    createConversation: v.fn(),
    updateConversation: v.fn().mockResolvedValue({}),
    createMessage: v.fn().mockResolvedValue({ id: "msg1" }),
    updateChannel: v.fn().mockResolvedValue({}),
    validateCartLine: v.fn(),
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    prisma: {
      channelAccount: {
        findFirst: vi.fn(async () => H.channelRow.current),
        update: H.updateChannel,
      },
      tenant: { findUnique: vi.fn(async () => H.tenantRow.current) },
      conversation: {
        findFirst: vi.fn(async () => H.conversationRow.current),
        create: H.createConversation,
        update: H.updateConversation,
      },
      message: {
        findMany: vi.fn(async () => H.messages.current),
        create: H.createMessage,
      },
    },
    withCrossTenantAccess: (fn: () => Promise<unknown>) => fn(),
    incomingMessageQueue: { add: H.enqueue },
    analyticsQueue: { add: vi.fn().mockResolvedValue(undefined) },
    publishEvent: vi.fn().mockResolvedValue(undefined),
    isFeatureEnabledForTenant: vi.fn(async (_t: string, f: string) => H.features.current[f] !== false),
  };
});

vi.mock("../services/shopify-catalog.service", () => ({
  validateCartLine: H.validateCartLine,
}));

import router from "../routes/shopify-chat-public";
import { signVisitorSession, defaultShopifyLiveChatConfig } from "@chatcenter/shared";

const SHOP = "demo-store.myshopify.com";
const ORIGIN = `https://${SHOP}`;
const STOREFRONT = "https://shop.example.com";

function channel(overrides: Record<string, any> = {}) {
  const config = defaultShopifyLiveChatConfig();
  config.shopDomain = SHOP;
  config.tenantIntegrationId = "ti1";
  config.enabled = true;
  config.install.storefrontDomains = ["shop.example.com"];
  Object.assign(config, overrides.config ?? {});
  return {
    id: "ch1",
    tenantId: "t1",
    externalId: "sfy_publickey",
    displayName: "Demo Store",
    connectionStatus: "CONNECTED",
    platformMeta: { shopifyLiveChat: config },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/shopify-chat", router);
  return a;
}

/**
 * Rate limiting keys on (channel key, ip). Tests share one process and
 * one ip, so each case gets its own key or the limiter would make later
 * cases fail for reasons that have nothing to do with what they assert.
 * The channel lookup is stubbed, so any key resolves to the same row.
 */
let keySeq = 0;
function freshKey() {
  return `sfy_publickey_${++keySeq}`;
}

function session() {
  return signVisitorSession({
    tenantId: "t1",
    channelAccountId: "ch1",
    visitorId: "sfyv_visitor",
    shopDomain: SHOP,
  });
}

beforeEach(() => {
  H.channelRow.current = channel();
  H.tenantRow.current = { status: "ACTIVE", isActive: true };
  H.features.current = { shopify_live_chat: true, shopify_product_messaging: true };
  H.conversationRow.current = null;
  H.messages.current = [];
  H.createConversation.mockResolvedValue({
    id: "conv1",
    tenantId: "t1",
    status: "OPEN",
    customerName: "Shopper",
    isHandedOver: false,
    handledBy: null,
  });
  vi.clearAllMocks();
  H.createConversation.mockResolvedValue({
    id: "conv1",
    tenantId: "t1",
    status: "OPEN",
    customerName: "Shopper",
    isHandedOver: false,
    handledBy: null,
  });
  H.updateConversation.mockResolvedValue({});
  H.createMessage.mockResolvedValue({ id: "msg1" });
  H.updateChannel.mockResolvedValue({});
});

// ─── Bootstrap ──────────────────────────────────────────────

describe("POST /bootstrap", () => {
  it("returns safe widget config for a valid origin", async () => {
    // (case 8)
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", ORIGIN)
      .send({ publicKey: freshKey(), context: { pageType: "product", productHandle: "shoe" } });

    expect(res.status).toBe(200);
    expect(res.body.data.session.token).toBeTruthy();
    expect(res.body.data.widget.welcome.headline).toBeTruthy();
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  it("accepts a declared custom storefront domain", async () => {
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STOREFRONT)
      .send({ publicKey: freshKey() });
    expect(res.status).toBe(200);
  });

  it("denies an origin that is not the merchant's storefront", async () => {
    // (case 9)
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", "https://evil.com")
      .send({ publicKey: freshKey() });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "unavailable" });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never returns internal identifiers or Shopify credentials", async () => {
    // (cases 10, 11, 37)
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", ORIGIN)
      .send({ publicKey: freshKey() });

    // The session token is AES-GCM ciphertext rendered as base64url, so a
    // two-character id like "t1" turns up inside it by chance often enough
    // to fail this suite for no reason. Check the ENVELOPE for short ids
    // and the whole body for the long, distinctive names a real leak would
    // carry.
    const envelope = JSON.stringify({ ...res.body, data: { ...res.body.data, session: undefined } });
    for (const leak of ["t1", "ch1", "ti1", "agent1"]) {
      expect(envelope).not.toContain(leak);
    }
    const body = JSON.stringify(res.body);
    for (const leak of ["accessToken", "shpat_", "credentials", "tenantId", "tenantIntegrationId"]) {
      expect(body).not.toContain(leak);
    }
    expect(res.body.data.widget).not.toHaveProperty("routing");
  });

  it("fails closed for a disabled channel", async () => {
    // (cases 5, 14)
    const config = defaultShopifyLiveChatConfig();
    config.shopDomain = SHOP;
    config.enabled = false;
    H.channelRow.current = channel({ platformMeta: { shopifyLiveChat: config } });

    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", ORIGIN)
      .send({ publicKey: freshKey() });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "unavailable" });
  });

  it("fails closed without the entitlement, and leaks no billing detail", async () => {
    // (cases 6, 55) The storefront must not learn WHY it was refused.
    H.features.current = { shopify_live_chat: false };
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", ORIGIN)
      .send({ publicKey: freshKey() });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "unavailable" });
    expect(JSON.stringify(res.body)).not.toMatch(/plan|entitle|billing|feature/i);
  });

  it("turns product messaging off when only that entitlement is missing", async () => {
    // Text chat keeps working; the cards do not.
    H.features.current = { shopify_live_chat: true, shopify_product_messaging: false };
    const res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", ORIGIN)
      .send({ publicKey: freshKey() });
    expect(res.status).toBe(200);
    expect(res.body.data.widget.features.productMessaging).toBe(false);
    expect(res.body.data.widget.features.addToCart).toBe(false);
  });

  it("fails closed for an unknown key and for a suspended tenant", async () => {
    H.channelRow.current = null;
    let res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", ORIGIN)
      .send({ publicKey: freshKey() });
    expect(res.status).toBe(403);

    H.channelRow.current = channel();
    H.tenantRow.current = { status: "SUSPENDED", isActive: true };
    res = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", ORIGIN)
      .send({ publicKey: freshKey() });
    expect(res.status).toBe(403);
  });

  it("records an installation heartbeat", async () => {
    await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", ORIGIN)
      .send({ publicKey: freshKey(), themeId: "12345", context: { pageType: "index", path: "/" } });

    // The heartbeat is fire-and-forget by design: a storefront must never
    // wait on it. Let its microtask settle before asserting.
    await new Promise((r) => setTimeout(r, 10));
    expect(H.updateChannel).toHaveBeenCalled();
    const arg = H.updateChannel.mock.calls[0][0];
    expect(arg.data.platformMeta.shopifyLiveChat.install.lastHeartbeatAt).toBeTruthy();
    expect(arg.data.platformMeta.shopifyLiveChat.install.lastThemeId).toBe("12345");
  });

  it("rate limits repeated bootstraps from one channel and ip", async () => {
    // (case 13)
    const a = app();
    const key = freshKey();
    const send = () =>
      request(a).post("/api/shopify-chat/bootstrap").set("Origin", ORIGIN).send({ publicKey: key });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await send()).status);
    expect(codes).toContain(429);
  });
});

// ─── Session-scoped surfaces ────────────────────────────────

describe("visitor session enforcement", () => {
  it("refuses every session-scoped route without a valid token", async () => {
    const a = app();
    for (const path of ["/api/shopify-chat/conversation", "/api/shopify-chat/message", "/api/shopify-chat/handoff"]) {
      const res = await request(a).post(path).set("Origin", ORIGIN).send({ body: "hi" });
      expect(res.status).toBe(401);
    }
    const poll = await request(a).get("/api/shopify-chat/messages").set("Origin", ORIGIN);
    expect(poll.status).toBe(401);
  });

  it("stops honouring a session once the channel is disabled", async () => {
    const token = session();
    const config = defaultShopifyLiveChatConfig();
    config.shopDomain = SHOP;
    config.enabled = false;
    H.channelRow.current = channel({ platformMeta: { shopifyLiveChat: config } });

    const res = await request(app())
      .post("/api/shopify-chat/conversation")
      .set("Origin", ORIGIN)
      .send({ sessionToken: token });
    expect(res.status).toBe(403);
  });

  it("refuses a session presented from a foreign origin", async () => {
    const res = await request(app())
      .post("/api/shopify-chat/conversation")
      .set("Origin", "https://evil.com")
      .send({ sessionToken: session() });
    expect(res.status).toBe(403);
  });
});

// ─── Conversation lifecycle ─────────────────────────────────

describe("conversation", () => {
  it("creates exactly one conversation for a new visitor", async () => {
    // (case 15)
    const res = await request(app())
      .post("/api/shopify-chat/conversation")
      .set("Origin", ORIGIN)
      .send({ sessionToken: session() });

    expect(res.status).toBe(200);
    expect(res.body.data.conversationId).toBe("conv1");
    expect(H.createConversation).toHaveBeenCalledTimes(1);
    const created = H.createConversation.mock.calls[0][0].data;
    expect(created.channel).toBe("SHOPIFY_LIVE_CHAT");
    expect(created.customerExternalId).toBe("sfyv_visitor");
    // Deliberately UNASSIGNED. Pre-assigning a department here made the
    // incoming worker skip routeConversation entirely (it only routes when
    // `!conversation.departmentId`), so the Main Playbook never ran for
    // storefront chats. The graph owns this decision now, as it does on
    // every other channel.
    expect(created.assignedAiAgentId).toBeUndefined();
    expect(created.departmentId).toBeUndefined();
  });

  it("resumes the existing conversation instead of starting a new one", async () => {
    // (cases 16, 17) A refresh, a page change or a reconnect must not
    // restart the thread.
    H.conversationRow.current = {
      id: "conv-existing",
      tenantId: "t1",
      status: "OPEN",
      isHandedOver: false,
      customerName: "Shopper",
    };
    const res = await request(app())
      .post("/api/shopify-chat/conversation")
      .set("Origin", ORIGIN)
      .send({ sessionToken: session() });

    expect(res.body.data.conversationId).toBe("conv-existing");
    expect(H.createConversation).not.toHaveBeenCalled();
  });

  it("returns history projected for a shopper", async () => {
    // (case 19)
    H.conversationRow.current = { id: "conv1", tenantId: "t1", status: "OPEN", isHandedOver: false };
    H.messages.current = [
      { id: "m1", direction: "INBOUND", body: "hi", messageType: "text", senderName: null, metadata: {}, mediaUrl: null, createdAt: new Date() },
      { id: "m2", direction: "OUTBOUND", body: "hello", messageType: "text", senderName: "AI Bot", metadata: { source: "ai_bot" }, mediaUrl: null, createdAt: new Date() },
      { id: "m3", direction: "OUTBOUND", body: "hey", messageType: "text", senderName: "dana@merchant.com", metadata: {}, mediaUrl: null, createdAt: new Date() },
    ];
    const res = await request(app())
      .post("/api/shopify-chat/conversation")
      .set("Origin", ORIGIN)
      .send({ sessionToken: session() });

    const msgs = res.body.data.messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[1].authorKind).toBe("ai");
    expect(msgs[2].authorKind).toBe("agent");
    expect(JSON.stringify(msgs)).not.toContain("@merchant.com");
  });
});

// ─── Messages ───────────────────────────────────────────────

describe("POST /message", () => {
  it("enqueues into the shared inbound pipeline with the storefront context", async () => {
    const res = await request(app())
      .post("/api/shopify-chat/message")
      .set("Origin", ORIGIN)
      .send({
        sessionToken: session(),
        body: "Is this good for long runs?",
        clientId: "abc123def456",
        context: { pageType: "product", productHandle: "cloud-pro" },
      });

    expect(res.status).toBe(200);
    expect(H.enqueue).toHaveBeenCalledTimes(1);
    const job = H.enqueue.mock.calls[0][1];
    expect(job.channel).toBe("SHOPIFY_LIVE_CHAT");
    expect(job.tenantId).toBe("t1");
    expect(job.normalizedMessage.body).toContain("long runs");
    expect(job.normalizedMessage.metadata.storefront.productHandle).toBe("cloud-pro");
  });

  it("gives a retried send the same external id so it cannot double-post", async () => {
    // (case 18)
    const token = session();
    const a = app();
    const payload = { sessionToken: token, body: "hello", clientId: "stableclientid1" };
    await request(a).post("/api/shopify-chat/message").set("Origin", ORIGIN).send(payload);
    await request(a).post("/api/shopify-chat/message").set("Origin", ORIGIN).send(payload);

    const ids = H.enqueue.mock.calls.map((c: any[]) => c[1].normalizedMessage.externalMessageId);
    expect(ids[0]).toBe(ids[1]);
  });

  it("rejects an empty body and an oversized one", async () => {
    // (case 54)
    const a = app();
    const token = session();
    const empty = await request(a).post("/api/shopify-chat/message").set("Origin", ORIGIN).send({ sessionToken: token, body: "   " });
    expect(empty.status).toBe(400);

    const huge = await request(a)
      .post("/api/shopify-chat/message")
      .set("Origin", ORIGIN)
      .send({ sessionToken: token, body: "x".repeat(20000) });
    expect(huge.status).toBe(413);
    expect(H.enqueue).not.toHaveBeenCalled();
  });

  it("normalises hostile message content before it reaches the model", async () => {
    // (case 52)
    await request(app())
      .post("/api/shopify-chat/message")
      .set("Origin", ORIGIN)
      .send({ sessionToken: session(), body: "hi [31m<script>alert(1)</script>" });

    const body = H.enqueue.mock.calls[0][1].normalizedMessage.body;
    expect(body).not.toContain(" ");
    expect(body).not.toContain("");
  });
});

// ─── Cart ───────────────────────────────────────────────────

describe("POST /cart/validate", () => {
  it("returns a server-resolved variant, never the browser's numbers", async () => {
    // (cases 27, 28, 31)
    H.validateCartLine.mockResolvedValue({
      ok: true,
      variantId: "9001",
      quantity: 2,
      price: "120.00",
      currency: "USD",
      title: "Cloud Pro",
      variantTitle: "41",
      productUrl: "https://demo-store.myshopify.com/products/cloud-pro",
    });

    const res = await request(app())
      .post("/api/shopify-chat/cart/validate")
      .set("Origin", ORIGIN)
      .send({ sessionToken: session(), productId: "111", variantId: "9001", quantity: 2, price: "0.01" });

    expect(res.status).toBe(200);
    expect(res.body.data.price).toBe("120.00");
    // The channel decides the store; the request never gets a say.
    expect(H.validateCartLine.mock.calls[0][0].expectedShopDomain).toBe(SHOP);
    expect(H.validateCartLine.mock.calls[0][0]).not.toHaveProperty("price");
  });

  it("surfaces a refusal as a shopper-safe message", async () => {
    // (cases 25, 26, 32, 33, 34, 35)
    for (const code of [
      "variant_not_found",
      "variant_unavailable",
      "store_mismatch",
      "invalid_quantity",
      "selling_plan_required",
    ]) {
      H.validateCartLine.mockResolvedValue({ ok: false, code, detail: "safe sentence" });
      const res = await request(app())
        .post("/api/shopify-chat/cart/validate")
        .set("Origin", ORIGIN)
        .send({ sessionToken: session(), productId: "1", variantId: "2", quantity: 1 });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(code);
      expect(res.body.message).toBe("safe sentence");
    }
  });

  it("refuses entirely when the merchant turned Add to Cart off", async () => {
    const config = defaultShopifyLiveChatConfig();
    config.shopDomain = SHOP;
    config.enabled = true;
    config.commerce.addToCartEnabled = false;
    H.channelRow.current = channel({ platformMeta: { shopifyLiveChat: config } });

    const res = await request(app())
      .post("/api/shopify-chat/cart/validate")
      .set("Origin", ORIGIN)
      .send({ sessionToken: session(), productId: "1", variantId: "2", quantity: 1 });
    expect(res.status).toBe(403);
    expect(H.validateCartLine).not.toHaveBeenCalled();
  });

  it("never creates an order", async () => {
    // (case 36) The public surface has no order-creating route at all.
    const stack = (router as any).stack ?? [];
    const paths = stack.map((l: any) => l.route?.path).filter(Boolean);
    expect(paths).not.toContain("/order");
    expect(paths).not.toContain("/checkout");
    expect(paths.join(",")).not.toMatch(/order|checkout|payment/i);
  });
});

// ─── Handoff ────────────────────────────────────────────────

describe("POST /handoff", () => {
  it("hands the conversation to a human and marks it waiting", async () => {
    // (case 20)
    H.conversationRow.current = { id: "conv1", tenantId: "t1", status: "OPEN", isHandedOver: false };
    const res = await request(app())
      .post("/api/shopify-chat/handoff")
      .set("Origin", ORIGIN)
      .send({ sessionToken: session() });

    expect(res.status).toBe(200);
    expect(H.updateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isHandedOver: true, status: "WAITING" }) }),
    );
  });

  it("is refused when the merchant disabled human handoff", async () => {
    const config = defaultShopifyLiveChatConfig();
    config.shopDomain = SHOP;
    config.enabled = true;
    config.routing.allowHumanHandoff = false;
    H.channelRow.current = channel({ platformMeta: { shopifyLiveChat: config } });

    const res = await request(app())
      .post("/api/shopify-chat/handoff")
      .set("Origin", ORIGIN)
      .send({ sessionToken: session() });
    expect(res.status).toBe(403);
  });
});

// ─── Offline form ───────────────────────────────────────────

describe("POST /lead", () => {
  function offlineChannel() {
    const config = defaultShopifyLiveChatConfig();
    config.shopDomain = SHOP;
    config.enabled = true;
    config.hours.offlineBehavior = "form";
    config.privacy.requireOfflineConsent = true;
    return channel({ platformMeta: { shopifyLiveChat: config } });
  }

  it("requires consent before recording anything", async () => {
    // (case 21)
    H.channelRow.current = offlineChannel();
    const res = await request(app())
      .post("/api/shopify-chat/lead")
      .set("Origin", ORIGIN)
      .send({ sessionToken: session(), email: "a@b.com", message: "hi", consent: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("consent_required");
    expect(H.createMessage).not.toHaveBeenCalled();
  });

  it("records a consented submission and waits for a human", async () => {
    H.channelRow.current = offlineChannel();
    H.conversationRow.current = { id: "conv1", tenantId: "t1", status: "OPEN", isHandedOver: false };
    const res = await request(app())
      .post("/api/shopify-chat/lead")
      .set("Origin", ORIGIN)
      .send({ sessionToken: session(), name: "Dana", email: "dana@example.com", message: "Call me", consent: true });

    expect(res.status).toBe(200);
    expect(H.createMessage).toHaveBeenCalled();
    expect(H.updateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "WAITING" }) }),
    );
  });

  it("is refused when the merchant did not ask for a form", async () => {
    const res = await request(app())
      .post("/api/shopify-chat/lead")
      .set("Origin", ORIGIN)
      .send({ sessionToken: session(), message: "hi", consent: true });
    expect(res.status).toBe(403);
  });
});
