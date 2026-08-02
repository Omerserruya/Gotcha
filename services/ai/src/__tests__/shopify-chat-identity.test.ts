/**
 * Verified shopper identity, end to end through the real router.
 *
 * The question every case here answers is the same one: can a shopper
 * make us believe they are somebody else? Identity may enter through
 * exactly one door — an App Proxy request Shopify signed — and these
 * drive the actual Express routes to prove no other door exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-that-is-long-enough";
  process.env.WIDGET_SESSION_SECRET = "test-widget-session-secret";
  process.env.SHOPIFY_CHAT_APP_SECRET = "shpss_test_secret";
  process.env.SHOPIFY_CHAT_BOOTSTRAP_RPM = "200";
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
    createdConversation: { current: null as any },
    conversationRow: { current: null as any },
    findFirstArgs: { current: null as any },
    prisma: {
      channelAccount: { findFirst: v.fn(), findUnique: v.fn(), update: v.fn() },
      tenant: { findUnique: v.fn() },
      conversation: { findFirst: v.fn(), create: v.fn(), update: v.fn() },
      message: { findMany: v.fn(), create: v.fn(), count: v.fn() },
      shopifyChatInstallation: { updateMany: v.fn(), findFirst: v.fn(), update: v.fn() },
    },
  };
});

vi.mock("@chatcenter/shared", async (orig) => {
  const actual = (await orig()) as any;
  H.prisma.channelAccount.findFirst.mockImplementation(async () => H.channelRow.current);
  H.prisma.channelAccount.findUnique.mockImplementation(async () => H.channelRow.current);
  H.prisma.channelAccount.update.mockResolvedValue({});
  H.prisma.tenant.findUnique.mockResolvedValue({ status: "ACTIVE", isActive: true });
  H.prisma.conversation.findFirst.mockImplementation(async (args: any) => {
    H.findFirstArgs.current = args;
    return H.conversationRow.current;
  });
  H.prisma.conversation.create.mockImplementation(async (args: any) => {
    H.createdConversation.current = args.data;
    return { id: "conv1", status: "OPEN", ...args.data };
  });
  H.prisma.conversation.update.mockResolvedValue({});
  H.prisma.message.findMany.mockResolvedValue([]);
  H.prisma.message.count.mockResolvedValue(0);
  H.prisma.message.create.mockResolvedValue({ id: "m1", createdAt: new Date() });
  H.prisma.shopifyChatInstallation.updateMany.mockResolvedValue({ count: 1 });
  // Resolving by shop domain goes through the installation row; without
  // one the bootstrap denies with `unknown_channel` before it ever looks
  // at an identity token.
  H.prisma.shopifyChatInstallation.findFirst.mockResolvedValue({
    id: "inst1",
    channelAccountId: "ch1",
    shopDomain: "demo-store.myshopify.com",
    status: "ACTIVE",
    verifiedDomains: ["shop.example.com"],
  });
  H.prisma.shopifyChatInstallation.update.mockResolvedValue({});
  return {
    ...actual,
    prisma: H.prisma,
    incomingMessageQueue: { add: vi.fn().mockResolvedValue(undefined) },
    analyticsQueue: { add: vi.fn().mockResolvedValue(undefined) },
    publishEvent: vi.fn().mockResolvedValue(undefined),
    isFeatureEnabledForTenant: vi.fn().mockResolvedValue(true),
    withCrossTenantAccess: (fn: () => Promise<unknown>) => fn(),
  };
});

import router from "../routes/shopify-chat-public";
import {
  verifyVisitorSession,
  signCustomerIdentity,
  defaultShopifyLiveChatConfig,
} from "@chatcenter/shared";

const SHOP = "demo-store.myshopify.com";
const STOREFRONT = "https://shop.example.com";
const SECRET = "shpss_test_secret";
const CUSTOMER = "6820381";

function channel() {
  // A FULL config: normalizeShopifyLiveChatConfig throws on a partial one,
  // and the route surfaces that as a plain 500.
  const config = defaultShopifyLiveChatConfig();
  config.shopDomain = SHOP;
  config.tenantIntegrationId = "ti1";
  config.enabled = true;
  config.install.storefrontDomains = ["shop.example.com"];
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

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/shopify-chat", router);
  return a;
}

/** Sign a proxy query the way Shopify does: sorted, joined with NOTHING. */
function proxyQuery(params: Record<string, string>, secret = SECRET) {
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
  const signature = crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
  return new URLSearchParams({ ...params, signature }).toString();
}

beforeEach(() => {
  H.channelRow.current = channel();
  H.conversationRow.current = null;
  H.createdConversation.current = null;
  H.findFirstArgs.current = null;
});

// ─── The proxy door ─────────────────────────────────────────

describe("GET /proxy/identity", () => {
  it("vouches for a signed-in shopper when Shopify signed the request", async () => {
    const qs = proxyQuery({
      shop: SHOP,
      path_prefix: "/apps/gotcha-chat",
      timestamp: String(Math.floor(Date.now() / 1000)),
      logged_in_customer_id: CUSTOMER,
    });
    const res = await request(app()).get(`/api/shopify-chat/proxy/identity?${qs}`);

    expect(res.status).toBe(200);
    expect(res.body.data.identified).toBe(true);
    expect(typeof res.body.data.identityToken).toBe("string");
    // The id itself never travels back to the browser.
    expect(JSON.stringify(res.body)).not.toContain(CUSTOMER);
  });

  it("says nobody is signed in, rather than failing, for a logged-out shopper", async () => {
    const qs = proxyQuery({ shop: SHOP, timestamp: "1", logged_in_customer_id: "" });
    const res = await request(app()).get(`/api/shopify-chat/proxy/identity?${qs}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ identified: false });
  });

  it("refuses a request nobody signed", async () => {
    const res = await request(app())
      .get(`/api/shopify-chat/proxy/identity?shop=${SHOP}&logged_in_customer_id=${CUSTOMER}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unavailable" });
  });

  it("refuses a customer id swapped after signing", async () => {
    // The attack this whole mechanism exists to stop.
    const qs = proxyQuery({ shop: SHOP, timestamp: "1", logged_in_customer_id: "1" });
    const tampered = qs.replace("logged_in_customer_id=1", `logged_in_customer_id=${CUSTOMER}`);
    const res = await request(app()).get(`/api/shopify-chat/proxy/identity?${tampered}`);
    expect(res.status).toBe(401);
  });

  it("refuses a request signed with someone else's secret", async () => {
    const qs = proxyQuery({ shop: SHOP, timestamp: "1", logged_in_customer_id: CUSTOMER }, "wrong");
    const res = await request(app()).get(`/api/shopify-chat/proxy/identity?${qs}`);
    expect(res.status).toBe(401);
  });
});

// ─── What bootstrap does with it ────────────────────────────

describe("POST /bootstrap with an identity", () => {
  async function bootstrap(body: Record<string, unknown>) {
    return request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STOREFRONT)
      .send({ shopDomain: SHOP, context: { pageType: "index" }, ...body });
  }

  it("binds a verified customer into the visitor session", async () => {
    const identityToken = signCustomerIdentity({ shopDomain: SHOP, customerId: CUSTOMER });
    const res = await bootstrap({ identityToken });

    expect(res.status).toBe(200);
    expect(res.body.data.identified).toBe(true);
    const session = verifyVisitorSession(res.body.data.session.token);
    expect(session?.customerId).toBe(CUSTOMER);
  });

  it("stays anonymous when no identity is offered", async () => {
    const res = await bootstrap({});
    expect(res.body.data.identified).toBe(false);
    expect(verifyVisitorSession(res.body.data.session.token)?.customerId).toBeNull();
  });

  it("ignores an identity token minted for a different store", async () => {
    const foreign = signCustomerIdentity({ shopDomain: "other.myshopify.com", customerId: CUSTOMER });
    const res = await bootstrap({ identityToken: foreign });
    expect(res.body.data.identified).toBe(false);
  });

  it("ignores a forged or corrupted identity token", async () => {
    for (const token of ["", "not-a-token", "a".repeat(300), signCustomerIdentity({ shopDomain: SHOP, customerId: CUSTOMER }).slice(0, -3)]) {
      const res = await bootstrap({ identityToken: token });
      expect(res.body.data.identified).toBe(false);
    }
  });

  it("never accepts a customer id asserted directly by the browser", async () => {
    // The obvious thing an attacker tries first.
    const res = await bootstrap({ customerId: CUSTOMER, loggedInCustomerId: CUSTOMER, customer: { id: CUSTOMER } });
    expect(res.body.data.identified).toBe(false);
    expect(verifyVisitorSession(res.body.data.session.token)?.customerId).toBeNull();
  });

  it("keeps a shopper identified across page loads", async () => {
    const identityToken = signCustomerIdentity({ shopDomain: SHOP, customerId: CUSTOMER });
    const first = await bootstrap({ identityToken });
    // Second page view: the proxy hop may not have completed, but the
    // session already carries the identity and must not lose it.
    const second = await bootstrap({ sessionToken: first.body.data.session.token });
    expect(second.body.data.identified).toBe(true);
    expect(verifyVisitorSession(second.body.data.session.token)?.customerId).toBe(CUSTOMER);
  });

  it("does not leak the customer id into the widget payload", async () => {
    const identityToken = signCustomerIdentity({ shopDomain: SHOP, customerId: CUSTOMER });
    const res = await bootstrap({ identityToken });
    expect(JSON.stringify(res.body.data.widget)).not.toContain(CUSTOMER);
  });
});

// ─── How conversations are filed ────────────────────────────

describe("conversation keying", () => {
  async function openConversation(identityToken?: string) {
    const boot = await request(app())
      .post("/api/shopify-chat/bootstrap")
      .set("Origin", STOREFRONT)
      .send({ shopDomain: SHOP, context: { pageType: "index" }, identityToken });

    await request(app())
      .post("/api/shopify-chat/conversation")
      .set("Origin", STOREFRONT)
      .send({ sessionToken: boot.body.data.session.token });

    return { boot, created: H.createdConversation.current, lookup: H.findFirstArgs.current };
  }

  it("files a verified shopper under a stable, namespaced customer key", async () => {
    // This is what makes history and summaries follow a person across
    // browsers instead of dying with a browser-local id.
    const { created } = await openConversation(
      signCustomerIdentity({ shopDomain: SHOP, customerId: CUSTOMER }),
    );
    expect(created.customerExternalId).toBe(`shopify-customer:${CUSTOMER}`);
    expect(created.customerName).toContain("Signed-in");
  });

  it("files an anonymous shopper under their per-browser visitor id", async () => {
    const { created } = await openConversation();
    expect(created.customerExternalId).not.toContain("shopify-customer:");
    expect(created.customerName).not.toContain("Signed-in");
  });

  it("looks up an existing thread by the same key it would create", async () => {
    // A mismatch here means a returning customer silently starts over.
    const { lookup } = await openConversation(
      signCustomerIdentity({ shopDomain: SHOP, customerId: CUSTOMER }),
    );
    expect(lookup.where.customerExternalId).toBe(`shopify-customer:${CUSTOMER}`);
  });

  it("does not adopt an anonymous conversation when someone signs in", async () => {
    // On a shared device that would hand one shopper's messages to
    // whoever logs in next.
    const anon = await openConversation();
    const anonKey = anon.created.customerExternalId;

    H.createdConversation.current = null;
    const identified = await openConversation(
      signCustomerIdentity({ shopDomain: SHOP, customerId: CUSTOMER }),
    );
    expect(identified.lookup.where.customerExternalId).not.toBe(anonKey);
  });
});
