/**
 * Shopify Live Chat — merchant admin API.
 *
 * Channel setup rules and the human-agent product picker, driven through
 * the real router. Auth middleware is replaced with a pass-through that
 * injects a fixed principal; the entitlement gate stays switchable so the
 * "no plan, no feature" path is exercised rather than assumed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-that-is-long-enough";
  // The deep link is built from the CHAT app's identity now that the
  // storefront widget ships in its own Shopify app.
  process.env.SHOPIFY_CHAT_APP_CLIENT_ID = "test-client-id";
  process.env.SHOPIFY_CHAT_BLOCK_HANDLE = "gotcha_chat";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    features: { current: {} as Record<string, boolean> },
    role: { current: "ADMIN" },
    channels: { current: [] as any[] },
    conversation: { current: null as any },
    agents: { current: [] as any[] },
    departments: { current: [] as any[] },
    createChannel: v.fn(),
    updateChannel: v.fn(),
    deleteChannel: v.fn().mockResolvedValue({}),
    createMessage: v.fn(),
    updateConversation: v.fn().mockResolvedValue({}),
    createAudit: v.fn().mockResolvedValue({}),
    store: { current: null as any },
    capability: { current: { ok: true } as any },
    searchCatalog: v.fn(),
    getProductSnapshots: v.fn(),
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const pass = (_req: any, _res: any, next: any) => next();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: "u1", tenantId: "t1", role: H.role.current, email: "dana@merchant.com" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = "t1";
      next();
    },
    requireActiveTenant: () => pass,
    requireRole: (role: string) => (req: any, res: any, next: any) =>
      H.role.current === role || H.role.current === "SYSTEM_ADMIN"
        ? next()
        : res.status(403).json({ error: "Insufficient permissions" }),
    requireFeature: (feature: string) => (_req: any, res: any, next: any) =>
      H.features.current[feature] === false
        ? res.status(403).json({ error: "Feature not available", code: "FEATURE_NOT_AVAILABLE", feature })
        : next(),
    isFeatureEnabledForTenant: vi.fn(async (_t: string, f: string) => H.features.current[f] !== false),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    prisma: {
      channelAccount: {
        findMany: vi.fn(async () => H.channels.current),
        findFirst: vi.fn(async ({ where }: any) =>
          H.channels.current.find((c) => c.id === where.id) ?? null,
        ),
        create: H.createChannel,
        update: H.updateChannel,
        delete: H.deleteChannel,
      },
      conversation: {
        findFirst: vi.fn(async () => H.conversation.current),
        update: H.updateConversation,
      },
      message: { create: H.createMessage },
      aIAgent: { findFirst: vi.fn(async ({ where }: any) => H.agents.current.find((a) => a.id === where.id) ?? null) },
      department: { findFirst: vi.fn(async ({ where }: any) => H.departments.current.find((d) => d.id === where.id) ?? null) },
      auditLog: { create: H.createAudit },
    },
  };
});

vi.mock("../services/shopify-catalog.service", () => ({
  resolveShopifyStore: vi.fn(async () => H.store.current),
  probeProductCapability: vi.fn(async () => H.capability.current),
  searchCatalog: H.searchCatalog,
  getProductSnapshots: H.getProductSnapshots,
}));

import router from "../routes/shopify-live-chat";
import { defaultShopifyLiveChatConfig, buildProductSnapshot } from "@chatcenter/shared";

const SHOP = "demo-store.myshopify.com";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/shopify-live-chat", router);
  return a;
}

function channelRow(mutate?: (c: any) => void) {
  const config = defaultShopifyLiveChatConfig();
  config.shopDomain = SHOP;
  config.tenantIntegrationId = "ti1";
  config.enabled = true;
  mutate?.(config);
  return {
    id: "ch1",
    tenantId: "t1",
    externalId: "sfy_publickey",
    displayName: "Demo Store",
    connectionStatus: "CONNECTED",
    platformMeta: { shopifyLiveChat: config },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const PRODUCT = buildProductSnapshot({
  shopDomain: SHOP,
  currency: "USD",
  product: {
    id: 111,
    title: "Cloud Pro Runner",
    handle: "cloud-pro-runner",
    status: "active",
    image: { src: "https://cdn.shopify.com/s/files/1/x.jpg" },
    options: [{ name: "Size" }],
    variants: [{ id: 9001, title: "41", price: "120.00", available: true, option1: "41" }],
  },
})!;

beforeEach(() => {
  vi.clearAllMocks();
  H.features.current = {};
  H.role.current = "ADMIN";
  H.channels.current = [];
  H.conversation.current = null;
  H.agents.current = [{ id: "agent1", name: "Sales" }];
  H.departments.current = [{ id: "dept1", name: "Support" }];
  H.store.current = { ok: true, store: { tenantIntegrationId: "ti1", shopDomain: SHOP, currency: "USD" } };
  H.capability.current = { ok: true };
  H.createChannel.mockImplementation(async ({ data }: any) => {
    const row = { ...channelRow(), ...data, id: "ch-new", createdAt: new Date(), updatedAt: new Date() };
    H.channels.current = [row];
    return row;
  });
  H.updateChannel.mockImplementation(async ({ where, data }: any) => {
    const row = H.channels.current.find((c) => c.id === where.id);
    Object.assign(row, data);
    return row;
  });
  H.createMessage.mockResolvedValue({ id: "msg1", createdAt: new Date() });
  H.searchCatalog.mockResolvedValue({
    ok: true,
    store: { shopDomain: SHOP, currency: "USD", tenantIntegrationId: "ti1" },
    data: [PRODUCT],
  });
  H.getProductSnapshots.mockResolvedValue({
    ok: true,
    store: { shopDomain: SHOP, currency: "USD", tenantIntegrationId: "ti1" },
    data: [PRODUCT],
  });
});

// ─── Channel setup ──────────────────────────────────────────

describe("channel creation", () => {
  it("creates a channel bound to the connected store, disabled", async () => {
    // (cases 1, 24 of the migration list) Activation is always explicit.
    const res = await request(app()).post("/api/shopify-live-chat/channels").send({});
    expect(res.status).toBe(201);
    const created = H.createChannel.mock.calls[0][0].data;
    expect(created.channel).toBe("SHOPIFY_LIVE_CHAT");
    expect(created.connectionStatus).toBe("DISCONNECTED");
    expect(created.isActive).toBe(false);
    expect(created.platformMeta.shopifyLiveChat.enabled).toBe(false);
    expect(created.platformMeta.shopifyLiveChat.shopDomain).toBe(SHOP);
    expect(created.externalId).toMatch(/^sfy_[0-9a-f]{32}$/);
  });

  it("requires a connected store", async () => {
    // (case 2)
    H.store.current = { ok: false, reason: "not_connected" };
    const res = await request(app()).post("/api/shopify-live-chat/channels").send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_CONNECTED");
    expect(H.createChannel).not.toHaveBeenCalled();
  });

  it("binds to the tenant's own store and ignores any store named in the request", async () => {
    // (case 3) There is no request field that can point at another
    // tenant's store: the binding comes from the tenant's connection.
    const res = await request(app())
      .post("/api/shopify-live-chat/channels")
      .send({ config: { shopDomain: "someone-else.myshopify.com", tenantIntegrationId: "ti-other" } });
    expect(res.status).toBe(201);
    const created = H.createChannel.mock.calls[0][0].data;
    expect(created.platformMeta.shopifyLiveChat.shopDomain).toBe(SHOP);
    expect(created.platformMeta.shopifyLiveChat.tenantIntegrationId).toBe("ti1");
  });

  it("refuses a second channel for the same store", async () => {
    H.channels.current = [channelRow()];
    const res = await request(app()).post("/api/shopify-live-chat/channels").send({});
    expect(res.status).toBe(409);
  });

  it("is refused without the entitlement", async () => {
    // (case 55)
    H.features.current = { shopify_live_chat: false };
    const res = await request(app()).post("/api/shopify-live-chat/channels").send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FEATURE_NOT_AVAILABLE");
  });

  it("is refused for a non-admin", async () => {
    H.role.current = "AGENT";
    const res = await request(app()).post("/api/shopify-live-chat/channels").send({});
    expect(res.status).toBe(403);
  });

  it("lists only this tenant's Shopify channels", async () => {
    // (case 7) Existing live channels of other types are untouched: the
    // query is filtered to this channel type and this tenant.
    H.channels.current = [channelRow()];
    const res = await request(app()).get("/api/shopify-live-chat/channels");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].publicKey).toBe("sfy_publickey");
  });
});

describe("channel configuration", () => {
  beforeEach(() => {
    H.channels.current = [channelRow()];
  });

  it("enables without a channel-level owner, because the graph routes", async () => {
    // This used to be refused with NO_ROUTING_TARGET. The channel no longer
    // owns an AI employee or a department: the Main Playbook decides, as it
    // does for every other channel, and an unrouted conversation waits in
    // the inbox for a human — which is the platform's normal behaviour, not
    // a misconfiguration to block on.
    const res = await request(app())
      .put("/api/shopify-live-chat/channels/ch1")
      .send({ config: { enabled: true } });
    expect(res.status).toBe(200);
  });

  it("cannot be pointed at another workspace's AI employee, because it cannot be pointed anywhere", async () => {
    // (case 48) The old cross-tenant check existed because a channel could
    // name an employee by id. It cannot any more — the ids are dropped on
    // normalisation, so the whole class of mistake is gone rather than
    // guarded.
    const res = await request(app())
      .put("/api/shopify-live-chat/channels/ch1")
      .send({
        config: {
          routing: { aiAgentId: "agent-from-another-tenant", departmentId: "dept-from-another-tenant" },
        },
      });
    expect(res.status).toBe(200);

    const saved =
      H.updateChannel.mock.calls.at(-1)?.[0]?.data?.platformMeta?.shopifyLiveChat ?? {};
    expect(saved.routing).not.toHaveProperty("aiAgentId");
    expect(saved.routing).not.toHaveProperty("departmentId");
    expect(JSON.stringify(saved)).not.toContain("another-tenant");
  });

  it("normalises what it stores, so unsafe config never reaches a storefront", async () => {
    // (case 52)
    const res = await request(app())
      .put("/api/shopify-live-chat/channels/ch1")
      .send({
        config: {
          appearance: { primaryColor: "url(javascript:alert(1))", cornerRadius: 900 },
          welcome: { headline: "<img src=x onerror=1>" },
        },
      });
    expect(res.status).toBe(200);
    const stored = H.updateChannel.mock.calls[0][0].data.platformMeta.shopifyLiveChat;
    expect(stored.appearance.primaryColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(stored.appearance.cornerRadius).toBe(28);
    expect(stored.welcome.headline).not.toContain("<");
  });

  it("cannot be rebound to another store by a config patch", async () => {
    await request(app())
      .put("/api/shopify-live-chat/channels/ch1")
      .send({ config: { shopDomain: "elsewhere.myshopify.com" } });
    const stored = H.updateChannel.mock.calls[0][0].data.platformMeta.shopifyLiveChat;
    expect(stored.shopDomain).toBe(SHOP);
  });

  it("disables the account row when the merchant turns the channel off", async () => {
    await request(app()).put("/api/shopify-live-chat/channels/ch1").send({ config: { enabled: false } });
    const data = H.updateChannel.mock.calls[0][0].data;
    expect(data.connectionStatus).toBe("DISCONNECTED");
    expect(data.isActive).toBe(false);
  });

  it("turns the widget off before deleting, so the storefront stops immediately", async () => {
    const res = await request(app()).delete("/api/shopify-live-chat/channels/ch1");
    expect(res.status).toBe(200);
    expect(H.updateChannel).toHaveBeenCalled();
    expect(H.deleteChannel).toHaveBeenCalledWith({ where: { id: "ch1" } });
  });
});

// ─── Diagnostics ────────────────────────────────────────────

describe("diagnostics", () => {
  beforeEach(() => {
    H.channels.current = [channelRow()];
  });

  it("names the blocking problem and how to fix it", async () => {
    // (case 19 of the diagnostics list) App embed never seen.
    const res = await request(app()).get("/api/shopify-live-chat/channels/ch1/diagnostics");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("blocked");
    expect(res.body.data.blockingCheck).toBe("app_embed");
    const check = res.body.data.checks.find((c: any) => c.id === "app_embed");
    expect(check.fix).toMatch(/Theme Editor|app embed/i);
  });

  it("reports a lost store connection", async () => {
    H.store.current = { ok: false, reason: "not_connected" };
    const res = await request(app()).get("/api/shopify-live-chat/channels/ch1/diagnostics");
    expect(res.body.data.blockingCheck).toBe("store_connected");
  });

  it("degrades product messaging without blocking text chat", async () => {
    // (case 42)
    H.capability.current = { ok: false, code: "missing_scope", detail: "missing read_products" };
    const res = await request(app()).get("/api/shopify-live-chat/channels/ch1/diagnostics");
    const check = res.body.data.checks.find((c: any) => c.id === "product_capability");
    expect(check.state).toBe("degraded");
    expect(res.body.data.blockingCheck).not.toBe("product_capability");
  });

  it("never shows a raw Shopify error", async () => {
    H.capability.current = { ok: false, code: "unreachable", detail: "Shopify did not answer a product read." };
    const res = await request(app()).get("/api/shopify-live-chat/channels/ch1/diagnostics");
    expect(JSON.stringify(res.body)).not.toMatch(/shopify_5\d\d|ECONNRESET|stack/i);
  });

  it("returns install instructions with a theme editor deep link", async () => {
    const res = await request(app()).get("/api/shopify-live-chat/channels/ch1/install");
    expect(res.body.data.themeEditorDeepLink).toContain(`https://${SHOP}/admin/themes/current/editor`);
    expect(res.body.data.blockHandle).toBe("gotcha_chat");
    expect(res.body.data.themeEditorDeepLink).toContain("test-client-id");
    expect(res.body.data.steps.length).toBeGreaterThan(3);
  });
});

// ─── Agent product picker ───────────────────────────────────

describe("agent product picker", () => {
  beforeEach(() => {
    H.channels.current = [channelRow()];
    H.conversation.current = { id: "conv1", tenantId: "t1", channelAccount: channelRow() };
  });

  it("searches the connected catalogue", async () => {
    // (case 43)
    const res = await request(app()).get("/api/shopify-live-chat/products?q=runner");
    expect(res.status).toBe(200);
    expect(res.body.data.products).toHaveLength(1);
    expect(res.body.data.shopDomain).toBe(SHOP);
    expect(H.searchCatalog.mock.calls[0][0].tenantId).toBe("t1");
  });

  it("is refused without the product messaging entitlement", async () => {
    // (case 55)
    H.features.current = { shopify_product_messaging: false };
    const res = await request(app()).get("/api/shopify-live-chat/products?q=x");
    expect(res.status).toBe(403);
  });

  it("sends a single product into the conversation", async () => {
    // (cases 44, 45)
    const res = await request(app())
      .post("/api/shopify-live-chat/conversations/conv1/products")
      .send({ products: [{ productId: "111", variantId: "9001" }], text: "This one is my pick." });

    expect(res.status).toBe(201);
    expect(res.body.data.productCount).toBe(1);
    // The lead-in text is its own message so it reads before the card.
    expect(H.createMessage).toHaveBeenCalledTimes(2);
    const card = H.createMessage.mock.calls[1][0].data;
    expect(card.messageType).toBe("shopify_product");
    expect(card.metadata.shopify.shopDomain).toBe(SHOP);
    expect(card.metadata.shopify.channelAccountId).toBe("ch1");
    expect(card.metadata.shopify.source).toBe("agent");
  });

  it("sends several products as one carousel", async () => {
    // (case 46)
    H.getProductSnapshots.mockResolvedValue({
      ok: true,
      store: { shopDomain: SHOP, currency: "USD", tenantIntegrationId: "ti1" },
      data: [PRODUCT, { ...PRODUCT, productId: "222" }, { ...PRODUCT, productId: "333" }],
    });
    const res = await request(app())
      .post("/api/shopify-live-chat/conversations/conv1/products")
      .send({ products: [{ productId: "111" }, { productId: "222" }, { productId: "333" }] });

    expect(res.body.data.productCount).toBe(3);
    expect(H.createMessage.mock.calls[0][0].data.messageType).toBe("shopify_product_carousel");
  });

  it("respects the merchant's carousel size", async () => {
    H.channels.current = [channelRow((c) => { c.commerce.carouselSize = 2; })];
    H.conversation.current = { id: "conv1", tenantId: "t1", channelAccount: H.channels.current[0] };
    await request(app())
      .post("/api/shopify-live-chat/conversations/conv1/products")
      .send({ products: [{ productId: "1" }, { productId: "2" }, { productId: "3" }, { productId: "4" }] });
    expect(H.getProductSnapshots.mock.calls[0][1]).toHaveLength(2);
  });

  it("refuses a conversation on another channel or another tenant", async () => {
    // (cases 47, 48) The lookup is tenant-scoped AND channel-scoped, so
    // there is no id an agent can pass to reach somebody else's chat.
    H.conversation.current = null;
    const res = await request(app())
      .post("/api/shopify-live-chat/conversations/conv-elsewhere/products")
      .send({ products: [{ productId: "111" }] });
    expect(res.status).toBe(404);
    expect(H.createMessage).not.toHaveBeenCalled();
  });

  it("refuses when the merchant disabled product messaging on the channel", async () => {
    H.channels.current = [channelRow((c) => { c.commerce.productMessagingEnabled = false; })];
    H.conversation.current = { id: "conv1", tenantId: "t1", channelAccount: H.channels.current[0] };
    const res = await request(app())
      .post("/api/shopify-live-chat/conversations/conv1/products")
      .send({ products: [{ productId: "111" }] });
    expect(res.status).toBe(403);
  });

  it("drops unpublished products rather than sending them", async () => {
    // (case 30)
    H.getProductSnapshots.mockResolvedValue({
      ok: true,
      store: { shopDomain: SHOP, currency: "USD", tenantIntegrationId: "ti1" },
      data: [{ ...PRODUCT, status: "draft" }],
    });
    const res = await request(app())
      .post("/api/shopify-live-chat/conversations/conv1/products")
      .send({ products: [{ productId: "111" }] });
    expect(res.status).toBe(409);
  });

  it("audits the send", async () => {
    await request(app())
      .post("/api/shopify-live-chat/conversations/conv1/products")
      .send({ products: [{ productId: "111" }] });
    expect(H.createAudit).toHaveBeenCalled();
    const audit = H.createAudit.mock.calls[0][0].data;
    expect(audit.action).toBe("shopify_live_chat.product_message_sent");
    expect(audit.actorId).toBe("u1");
  });

  it("requires at least one product", async () => {
    const res = await request(app())
      .post("/api/shopify-live-chat/conversations/conv1/products")
      .send({ products: [] });
    expect(res.status).toBe(400);
  });
});
