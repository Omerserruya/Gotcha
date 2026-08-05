/**
 * Storefront bootstrap resolved from the SHOP, not from a pasted key.
 *
 * This is the test that guards the product promise: a merchant who
 * installed from the App Store never copies an identifier, so the widget
 * must be able to identify itself with the one fact the Theme App Embed
 * already knows - `shop.permanent_domain` - and the server must still
 * refuse anything whose Origin does not belong to that shop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-that-is-long-enough";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const SHOP = "my-store.myshopify.com";

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    installations: { current: [] as any[] },
    channels: { current: [] as any[] },
    tenant: { current: { status: "ACTIVE", isActive: true } as any },
    features: { current: {} as Record<string, boolean> },
    coreConnection: { current: null as any },
    loadConnection: v.fn(),
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withCrossTenantAccess: async (fn: any) => fn(),
    isFeatureEnabledForTenant: vi.fn(async (_t: string, f: string) => H.features.current[f] !== false),
    prisma: {
      shopifyChatInstallation: {
        findFirst: vi.fn(async ({ where }: any) =>
          H.installations.current.find(
            (i) => i.shopDomain === where.shopDomain && (!where.status || i.status === where.status),
          ) ?? null,
        ),
      },
      channelAccount: {
        findFirst: vi.fn(async ({ where }: any) =>
          H.channels.current.find(
            (c) => (where.id ? c.id === where.id : c.externalId === where.externalId),
          ) ?? null,
        ),
      },
      tenant: { findUnique: vi.fn(async () => H.tenant.current) },
    },
  };
});

vi.mock("../services/connectors/integration-framework", () => ({
  loadConnection: H.loadConnection,
}));

import { resolveForBootstrap } from "../services/shopify-live-chat.service";

function channelRow(overrides: any = {}) {
  return {
    id: "c1",
    tenantId: "t1",
    externalId: "sfy_recovery_key",
    displayName: "Shopify Live Chat",
    connectionStatus: "CONNECTED",
    createdAt: new Date(),
    updatedAt: new Date(),
    platformMeta: {
      shopifyLiveChat: {
        enabled: true,
        shopDomain: SHOP,
        install: { storefrontDomains: [] },
        commerce: { productMessagingEnabled: true },
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.features.current = {};
  H.tenant.current = { status: "ACTIVE", isActive: true };
  H.channels.current = [channelRow()];
  H.installations.current = [
    {
      id: "i1",
      shopDomain: SHOP,
      status: "ACTIVE",
      tenantId: "t1",
      channelAccountId: "c1",
      verifiedDomains: [SHOP, "shop.example.com"],
    },
  ];
  // Core connected to the same shop by default.
  H.loadConnection.mockResolvedValue({ tenantIntegrationId: "ti1", config: { shopDomain: SHOP }, credentials: {}, status: "CONNECTED", expiresAt: null });
});

describe("resolving by shop domain", () => {
  it("serves a storefront that presents only its shop domain", async () => {
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: `https://${SHOP}` });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.channel.id).toBe("c1");
  });

  it("accepts a custom domain verified at install time", async () => {
    // The merchant never typed this: it came from Shopify via the
    // installation record.
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: "https://shop.example.com" });
    expect(res.ok).toBe(true);
  });

  it("refuses an unrelated origin claiming to be that shop", async () => {
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: "https://attacker.example" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.denial).toBe("origin_not_allowed");
  });

  it("refuses a shop with no active installation", async () => {
    H.installations.current = [];
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: `https://${SHOP}` });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.denial).toBe("unknown_channel");
  });

  it("refuses when the installation points at a channel bound to a different shop", async () => {
    H.channels.current = [channelRow({ shopDomain: "other-store.myshopify.com" })];
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: `https://${SHOP}` });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.denial).toBe("unknown_channel");
  });

  it("still accepts the public key as a recovery path", async () => {
    H.installations.current = [];
    const res = await resolveForBootstrap({ publicKey: "sfy_recovery_key", origin: `https://${SHOP}` });
    expect(res.ok).toBe(true);
  });

  it("refuses when neither identifier is supplied", async () => {
    const res = await resolveForBootstrap({ origin: `https://${SHOP}` });
    expect(res.ok).toBe(false);
  });
});

describe("product messaging honesty", () => {
  it("is offered when entitlement, merchant switch and Core all agree", async () => {
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: `https://${SHOP}` });
    expect(res.ok && res.productMessagingEnabled).toBe(true);
    expect(res.ok && res.coreConnected).toBe(true);
  });

  it("is FALSE when the Core Shopify integration is gone - text chat continues", async () => {
    H.loadConnection.mockResolvedValue(null);
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: `https://${SHOP}` });
    // The widget still loads. It just does not promise product cards the
    // server would refuse.
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.productMessagingEnabled).toBe(false);
      expect(res.coreConnected).toBe(false);
    }
  });

  it("is FALSE when Core is connected to a DIFFERENT store", async () => {
    H.loadConnection.mockResolvedValue({ config: { shopDomain: "other-store.myshopify.com" } });
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: `https://${SHOP}` });
    expect(res.ok && res.productMessagingEnabled).toBe(false);
  });

  it("is FALSE without the product entitlement even with Core connected", async () => {
    H.features.current = { shopify_product_messaging: false };
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: `https://${SHOP}` });
    expect(res.ok && res.productMessagingEnabled).toBe(false);
  });
});

describe("commercial and tenant gates still apply", () => {
  it("refuses a tenant that is not active", async () => {
    H.tenant.current = { status: "SUSPENDED", isActive: false };
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: `https://${SHOP}` });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.denial).toBe("tenant_inactive");
  });

  it("refuses a tenant without the chat entitlement", async () => {
    H.features.current = { shopify_live_chat: false };
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: `https://${SHOP}` });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.denial).toBe("not_entitled");
  });

  it("refuses a channel the merchant switched off", async () => {
    H.channels.current = [channelRow({ enabled: false })];
    const res = await resolveForBootstrap({ shopDomain: SHOP, origin: `https://${SHOP}` });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.denial).toBe("disabled");
  });
});
