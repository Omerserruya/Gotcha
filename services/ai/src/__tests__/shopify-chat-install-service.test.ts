/**
 * Chat installation lifecycle - the decisions, not the plumbing.
 *
 * Exactly one channel per store, one store per organization, a reinstall
 * that restores rather than duplicates, and an uninstall that stops the
 * chat without touching the Core commerce connection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.CHANNEL_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const SHOP = "my-store.myshopify.com";

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    installs: { rows: [] as any[] },
    channels: { rows: [] as any[] },
    features: { current: {} as Record<string, boolean> },
    createChannel: v.fn(),
    updateChannel: v.fn(),
    updateInstall: v.fn(),
    createInstall: v.fn(),
    store: { current: { ok: false } as any },
    adapterResult: { current: { ok: false } as any },
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withCrossTenantAccess: async (fn: any) => fn(),
    isFeatureEnabledForTenant: vi.fn(async (_t: string, f: string) => H.features.current[f] !== false),
    getRedis: () => ({ set: vi.fn(async () => "OK"), get: vi.fn(async () => null), del: vi.fn(async () => 1) }),
    prisma: {
      shopifyChatInstallation: {
        findFirst: vi.fn(async ({ where }: any) =>
          H.installs.rows.find((r) => {
            if (where.shopDomain && r.shopDomain !== where.shopDomain) return false;
            if (where.status?.not && r.status === where.status.not) return false;
            if (typeof where.status === "string" && r.status !== where.status) return false;
            return true;
          }) ?? null,
        ),
        findUnique: vi.fn(async ({ where }: any) => H.installs.rows.find((r) => r.id === where.id) ?? null),
        create: H.createInstall,
        update: H.updateInstall,
      },
      channelAccount: {
        findMany: vi.fn(async () => H.channels.rows),
        findFirst: vi.fn(async ({ where }: any) => H.channels.rows.find((c) => c.id === where.id) ?? null),
        create: H.createChannel,
        update: H.updateChannel,
      },
      tenant: { findUnique: vi.fn(async () => ({ status: "ACTIVE", isActive: true })) },
    },
  };
});

vi.mock("../services/shopify-catalog.service", () => ({
  resolveShopifyStore: vi.fn(async () => H.store.current),
}));
vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: vi.fn(async () => H.adapterResult.current),
  loadConnection: vi.fn(async () => null),
}));

import {
  recordAuthorizedInstall,
  bindInstallationToTenant,
  ensureChannelForShop,
  markUninstalledByShop,
  refreshVerifiedDomains,
} from "../services/shopify-chat-install.service";

function channelRow(id: string, shopDomain: string | null, tenantId = "t1") {
  return {
    id,
    tenantId,
    externalId: `sfy_${id}`,
    displayName: "Shopify Live Chat",
    connectionStatus: "DISCONNECTED",
    createdAt: new Date(),
    updatedAt: new Date(),
    platformMeta: {
      shopifyLiveChat: {
        enabled: false,
        shopDomain,
        install: { storefrontDomains: [] },
        commerce: { productMessagingEnabled: true },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.installs.rows = [];
  H.channels.rows = [];
  H.features.current = {};
  H.store.current = { ok: false, reason: "not_connected" };
  H.createInstall.mockImplementation(async ({ data }: any) => {
    const row = { id: "i-new", ...data, verifiedDomains: data.verifiedDomains ?? [] };
    H.installs.rows.push(row);
    return row;
  });
  H.updateInstall.mockImplementation(async ({ where, data }: any) => {
    const row = H.installs.rows.find((r) => r.id === where.id);
    Object.assign(row, data);
    return row;
  });
  H.createChannel.mockImplementation(async ({ data }: any) => {
    const row = { id: "c-new", ...data, createdAt: new Date(), updatedAt: new Date() };
    H.channels.rows.push(row);
    return row;
  });
  H.updateChannel.mockImplementation(async ({ where, data }: any) => {
    const row = H.channels.rows.find((c) => c.id === where.id);
    Object.assign(row, data);
    return row;
  });
});

describe("recording an authorized install", () => {
  it("creates a PENDING row carrying the canonical shop domain", async () => {
    const inst = await recordAuthorizedInstall({ shopDomain: "my-store" });
    expect(inst.shopDomain).toBe(SHOP);
    expect(inst.status).toBe("PENDING");
    // The merchant never typed this - it came from the verified install.
    expect(inst.verifiedDomains).toContain(SHOP);
  });

  it("stores no token when the app has no scopes", async () => {
    await recordAuthorizedInstall({ shopDomain: SHOP });
    expect(H.createInstall).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ accessToken: expect.anything() }) }),
    );
  });

  it("encrypts a token when one exists", async () => {
    await recordAuthorizedInstall({ shopDomain: SHOP, accessToken: "shpat_secret", scopes: "read_products" });
    const arg = H.createInstall.mock.calls[0][0].data;
    expect(arg.accessToken).toBeDefined();
    expect(arg.accessToken).not.toContain("shpat_secret");
  });

  it("is idempotent for a shop that is already installed", async () => {
    H.installs.rows = [{ id: "i1", shopDomain: SHOP, status: "PENDING", verifiedDomains: [SHOP] }];
    await recordAuthorizedInstall({ shopDomain: SHOP });
    expect(H.createInstall).not.toHaveBeenCalled();
    expect(H.updateInstall).toHaveBeenCalled();
  });

  it("restores a previous binding on reinstall, but only after authorization", async () => {
    H.installs.rows = [
      {
        id: "i-old",
        shopDomain: SHOP,
        status: "UNINSTALLED",
        tenantId: "t1",
        channelAccountId: "c1",
        verifiedDomains: [SHOP],
        uninstalledAt: new Date(),
      },
    ];
    const inst = await recordAuthorizedInstall({ shopDomain: SHOP });
    expect(inst.status).toBe("ACTIVE");
    expect(inst.tenantId).toBe("t1");
    expect(H.createInstall).not.toHaveBeenCalled();
  });
});

describe("binding to an organization", () => {
  beforeEach(() => {
    H.installs.rows = [
      { id: "i1", shopDomain: SHOP, status: "PENDING", tenantId: null, channelAccountId: null, verifiedDomains: [SHOP] },
    ];
  });

  it("creates exactly one channel and binds it", async () => {
    const res = await bindInstallationToTenant({ installationId: "i1", tenantId: "t1", userId: "u1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.created).toBe(true);
      expect(res.installation.tenantId).toBe("t1");
      expect(res.installation.channelAccountId).toBe(res.channel.id);
    }
    expect(H.createChannel).toHaveBeenCalledTimes(1);
  });

  it("creates the channel switched OFF", async () => {
    await bindInstallationToTenant({ installationId: "i1", tenantId: "t1" });
    const created = H.createChannel.mock.calls[0][0].data;
    expect(created.platformMeta.shopifyLiveChat.enabled).toBe(false);
    expect(created.isActive).toBe(false);
  });

  it("reuses an existing channel for the same store instead of making a second", async () => {
    H.channels.rows = [channelRow("c1", SHOP)];
    const res = await bindInstallationToTenant({ installationId: "i1", tenantId: "t1" });
    expect(res.ok && res.created).toBe(false);
    expect(H.createChannel).not.toHaveBeenCalled();
  });

  it("refuses an organization whose plan lacks the chat entitlement", async () => {
    H.features.current = { shopify_live_chat: false };
    const res = await bindInstallationToTenant({ installationId: "i1", tenantId: "t1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_entitled");
    expect(H.createChannel).not.toHaveBeenCalled();
  });

  it("refuses to move a store that already belongs to another organization", async () => {
    H.installs.rows = [
      { id: "i1", shopDomain: SHOP, status: "ACTIVE", tenantId: "t-other", channelAccountId: "c9", verifiedDomains: [SHOP] },
    ];
    const res = await bindInstallationToTenant({ installationId: "i1", tenantId: "t1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bound_to_other_tenant");
  });

  it("refuses an uninstalled installation", async () => {
    H.installs.rows = [
      { id: "i1", shopDomain: SHOP, status: "UNINSTALLED", tenantId: null, channelAccountId: null, verifiedDomains: [] },
    ];
    const res = await bindInstallationToTenant({ installationId: "i1", tenantId: "t1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("installation_uninstalled");
  });

  it("is idempotent: binding the same store twice keeps one channel", async () => {
    await bindInstallationToTenant({ installationId: "i1", tenantId: "t1" });
    const second = await bindInstallationToTenant({ installationId: "i1", tenantId: "t1" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.created).toBe(false);
    expect(H.createChannel).toHaveBeenCalledTimes(1);
  });
});

describe("verified domains", () => {
  it("asks Shopify for the primary domain through the Core connection", async () => {
    H.installs.rows = [
      { id: "i1", shopDomain: SHOP, status: "ACTIVE", tenantId: "t1", channelAccountId: "c1", verifiedDomains: [SHOP] },
    ];
    H.store.current = { ok: true, store: { shopDomain: SHOP, tenantIntegrationId: "ti1", currency: "USD" } };
    H.adapterResult.current = { ok: true, result: { primary_domain: "shop.example.com" } };

    const domains = await refreshVerifiedDomains({
      id: "i1",
      shopDomain: SHOP,
      status: "ACTIVE" as const,
      appIdentity: "gotcha-core",
      tenantId: "t1",
      channelAccountId: "c1",
      verifiedDomains: [SHOP],
      installedAt: new Date(),
      uninstalledAt: null,
      boundAt: null,
      lastHeartbeatAt: null,
    });
    expect(domains).toContain(SHOP);
    expect(domains).toContain("shop.example.com");
  });

  it("keeps only the canonical domain when Core cannot answer", async () => {
    H.installs.rows = [
      { id: "i1", shopDomain: SHOP, status: "ACTIVE", tenantId: "t1", channelAccountId: "c1", verifiedDomains: [SHOP] },
    ];
    H.store.current = { ok: false, reason: "not_connected" };
    const domains = await refreshVerifiedDomains({
      id: "i1",
      shopDomain: SHOP,
      status: "ACTIVE" as const,
      appIdentity: "gotcha-core",
      tenantId: "t1",
      channelAccountId: "c1",
      verifiedDomains: [SHOP],
      installedAt: new Date(),
      uninstalledAt: null,
      boundAt: null,
      lastHeartbeatAt: null,
    });
    expect(domains).toEqual([SHOP]);
  });
});

describe("uninstall", () => {
  beforeEach(() => {
    H.installs.rows = [
      { id: "i1", shopDomain: SHOP, status: "ACTIVE", tenantId: "t1", channelAccountId: "c1", verifiedDomains: [SHOP] },
    ];
    H.channels.rows = [channelRow("c1", SHOP)];
  });

  it("retires the installation and switches the channel off", async () => {
    const res = await markUninstalledByShop(SHOP);
    expect(res?.status).toBe("UNINSTALLED");
    const update = H.updateChannel.mock.calls[0][0].data;
    expect(update.platformMeta.shopifyLiveChat.enabled).toBe(false);
    expect(update.connectionStatus).toBe("DISCONNECTED");
  });

  it("drops token material", async () => {
    await markUninstalledByShop(SHOP);
    const call = H.updateInstall.mock.calls.at(-1)![0];
    expect(call.data.accessToken).toBeNull();
    expect(call.data.tokenScopes).toBeNull();
  });

  it("does nothing for a shop that was never installed", async () => {
    const res = await markUninstalledByShop("nobody.myshopify.com");
    expect(res).toBeNull();
    expect(H.updateChannel).not.toHaveBeenCalled();
  });
});
