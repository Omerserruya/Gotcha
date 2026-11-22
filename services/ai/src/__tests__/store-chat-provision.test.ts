/**
 * A connected store gets its storefront chat (2026-10-30).
 *
 * Under the unified app only the legacy "enable" button ever recorded and
 * bound a chat installation, so a store connected from v2 had none and its
 * storefront's preflight was refused. Found on prod: shining-face claimed into
 * Urban Supply, its installation row still bound to the GOTCHA workspace.
 *   - a connect binds the installation, makes a channel and switches it on
 *   - a stale binding to another workspace MOVES: old channel off, audit in both
 *   - a workspace still holding the store live keeps it
 *   - a revival never restores another workspace's binding
 *   - not entitled: nothing bound, the reason kept for the status route
 *   - a refused origin is not kept refused after the bind
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.CHANNEL_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const SHOP = "shining-face.myshopify.com";
const OLD = "t-gotcha";
const NEW = "t-urban";

const H = vi.hoisted(() => ({
  installs: [] as any[],
  channels: [] as any[],
  integrations: [] as any[],
  settings: new Map<string, string>(),
  audits: [] as any[],
  entitled: true,
  seq: 0,
}));

const matches = (row: any, where: any): boolean => {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "status" && v && typeof v === "object") {
      if ((v as any).not !== undefined && row.status === (v as any).not) return false;
      continue;
    }
    // A parked install (App Review 132211) is never the shop's row: `appIdentity: { not: ... }`.
    if (k === "appIdentity" && v && typeof v === "object") {
      if (row.appIdentity === (v as any).not) return false;
      continue;
    }
    if (k === "verifiedDomains") {
      if (!(row.verifiedDomains ?? []).includes((v as any).array_contains)) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
};
const STATUS_ORDER: Record<string, number> = { PENDING: 0, ACTIVE: 1, UNINSTALLED: 2 };

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withCrossTenantAccess: async (fn: any) => fn(),
    isFeatureEnabledForTenant: vi.fn(async () => H.entitled),
    getRedis: () => ({ set: vi.fn(async () => "OK"), get: vi.fn(async () => null), del: vi.fn(async () => 1) }),
    readDurableSetting: vi.fn(async (t: string, k: string) => H.settings.get(`${t}:${k}`) ?? null),
    writeDurableSetting: vi.fn(async (t: string, k: string, v: string | null) => {
      if (v === null) H.settings.delete(`${t}:${k}`);
      else H.settings.set(`${t}:${k}`, v);
    }),
    auditSystem: vi.fn(async (tenantId: string, action: string, target: any, metadata: any) => {
      H.audits.push({ tenantId, action, target, metadata });
    }),
    prisma: {
      shopifyChatInstallation: {
        findFirst: vi.fn(async ({ where, orderBy }: any) => {
          let rows = H.installs.filter((r) => matches(r, where));
          if (Array.isArray(orderBy)) rows = [...rows].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
          return rows[0] ?? null;
        }),
        findUnique: vi.fn(async ({ where }: any) => H.installs.find((r) => r.id === where.id) ?? null),
        findMany: vi.fn(async ({ where }: any) => H.installs.filter((r) => matches(r, where))),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: `i${++H.seq}`, installedAt: new Date(), tenantId: null, channelAccountId: null, ...data };
          H.installs.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => Object.assign(H.installs.find((r) => r.id === where.id), data)),
      },
      channelAccount: {
        findMany: vi.fn(async ({ where }: any) => H.channels.filter((c) => matches(c, { tenantId: where.tenantId, channel: where.channel }))),
        findFirst: vi.fn(async ({ where }: any) => H.channels.find((c) => matches(c, where)) ?? null),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: `c${++H.seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
          H.channels.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => Object.assign(H.channels.find((c) => c.id === where.id), data)),
      },
      tenantIntegration: {
        findFirst: vi.fn(async ({ where }: any) =>
          H.integrations.find(
            (r) => r.tenantId === where.tenantId && r.status !== where.status?.not && r.shopDomain === where.config?.equals,
          ) ?? null,
        ),
      },
      tenant: { findUnique: vi.fn(async () => ({ status: "ACTIVE", isActive: true })) },
    },
  };
});

vi.mock("../services/shopify-catalog.service", () => ({
  resolveShopifyStore: vi.fn(async () => ({ ok: false, reason: "not_connected" })),
}));
vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: vi.fn(async () => ({ ok: false })),
  loadConnection: vi.fn(async () => null),
}));

import {
  provisionStoreChat,
  recordAuthorizedInstall,
  isKnownStorefrontOrigin,
  readProvisionFailure,
  releaseReplacedStoreChat,
  __resetKnownOriginCache,
} from "../services/shopify-chat-install.service";
import { resolveForBootstrap } from "../services/shopify-live-chat.service";

function channel(id: string, tenantId: string, shopDomain: string, enabled: boolean) {
  const row = {
    id,
    tenantId,
    channel: "SHOPIFY_LIVE_CHAT",
    externalId: `sfy_${id}`,
    displayName: "Shopify Live Chat",
    connectionStatus: enabled ? "CONNECTED" : "DISCONNECTED",
    isActive: enabled,
    createdAt: new Date(),
    updatedAt: new Date(),
    platformMeta: { shopifyLiveChat: { enabled, shopDomain, install: { storefrontDomains: [] }, commerce: { productMessagingEnabled: true } } },
  };
  H.channels.push(row);
  return row;
}

/** prod's shape on 10-30: GOTCHA's retired row and channel for the shop. */
function goTchaLeftovers(status = "UNINSTALLED") {
  channel("c-old", OLD, SHOP, status !== "UNINSTALLED");
  H.installs.push({
    id: "i-old", shopDomain: SHOP, status, tenantId: OLD, channelAccountId: "c-old",
    verifiedDomains: [SHOP], installedAt: new Date("2026-09-03"), uninstalledAt: status === "UNINSTALLED" ? new Date() : null, boundAt: new Date(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  H.installs = [];
  H.channels = [];
  H.integrations = [];
  H.settings.clear();
  H.audits = [];
  H.entitled = true;
  H.seq = 0;
  __resetKnownOriginCache();
});

describe("a connected store gets its chat", () => {
  it("a first connect records, binds, makes a channel and switches it on", async () => {
    const out = await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP });
    expect(out.ok).toBe(true);
    expect(H.installs).toHaveLength(1);
    expect(H.installs[0]).toMatchObject({ shopDomain: SHOP, status: "ACTIVE", tenantId: NEW });
    const ch = H.channels.find((c) => c.id === H.installs[0].channelAccountId);
    expect(ch).toMatchObject({ tenantId: NEW, connectionStatus: "CONNECTED", isActive: true });
    expect(ch.platformMeta.shopifyLiveChat.enabled).toBe(true);
    expect(H.audits).toHaveLength(0);
  });

  it("a store reconnected after an uninstall gets its old channel back, switched on", async () => {
    // Dev's shape on 10-30: the uninstall switched the channel off; v2 has no switch to turn it back on.
    channel("c-mine", NEW, SHOP, false);
    H.installs.push({ id: "i-mine", shopDomain: SHOP, status: "UNINSTALLED", tenantId: null, channelAccountId: null, verifiedDomains: [SHOP], installedAt: new Date(), uninstalledAt: new Date() });
    const out = await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP });
    expect(out.ok).toBe(true);
    expect(H.installs.find((r) => r.id === "i-mine")).toMatchObject({ status: "ACTIVE", tenantId: NEW, channelAccountId: "c-mine" });
    expect(H.channels.find((c) => c.id === "c-mine")).toMatchObject({ isActive: true, connectionStatus: "CONNECTED" });
  });

  it("a channel this workspace already had for the shop keeps its owner's choice", async () => {
    channel("c-mine", NEW, SHOP, false);
    H.installs.push({ id: "i-mine", shopDomain: SHOP, status: "ACTIVE", tenantId: NEW, channelAccountId: "c-mine", verifiedDomains: [SHOP], installedAt: new Date() });
    const out = await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP });
    expect(out.ok).toBe(true);
    expect(H.channels.find((c) => c.id === "c-mine").platformMeta.shopifyLiveChat.enabled).toBe(false);
  });
});

describe("a store another workspace left behind: the chat moves with it", () => {
  it("prod's case: a retired row bound to GOTCHA is rebound, GOTCHA's channel stays off, audit in both", async () => {
    goTchaLeftovers("UNINSTALLED");
    const out = await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP });
    expect(out).toMatchObject({ ok: true, movedFromTenantId: OLD });
    const row = H.installs.find((r) => r.id === "i-old");
    expect(row).toMatchObject({ status: "ACTIVE", tenantId: NEW });
    expect(row.channelAccountId).not.toBe("c-old");
    const old = H.channels.find((c) => c.id === "c-old");
    expect(old).toMatchObject({ tenantId: OLD, isActive: false, connectionStatus: "DISCONNECTED" });
    expect(old.platformMeta.shopifyLiveChat.enabled).toBe(false);
    expect(H.audits.map((a) => [a.tenantId, a.action])).toEqual([
      [OLD, "shopify_chat.installation.moved"],
      [NEW, "shopify_chat.installation.moved"],
    ]);
    expect(H.audits[0].metadata).toMatchObject({ fromTenantId: OLD, toTenantId: NEW, shopDomain: SHOP });
  });

  it("a LIVE row still bound to a workspace that left the store moves too, and its channel is switched off", async () => {
    goTchaLeftovers("ACTIVE");
    H.integrations.push({ tenantId: OLD, status: "DISCONNECTED", shopDomain: SHOP });
    const out = await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP });
    expect(out).toMatchObject({ ok: true, movedFromTenantId: OLD });
    expect(H.channels.find((c) => c.id === "c-old")).toMatchObject({ isActive: false, connectionStatus: "DISCONNECTED" });
  });

  it("the moved store's origin is known, and the old channel's bootstrap no longer answers", async () => {
    goTchaLeftovers("ACTIVE");
    // The old channel served this storefront until the move.
    expect(await resolveForBootstrap({ publicKey: "sfy_c-old", origin: `https://${SHOP}` })).toMatchObject({ ok: true });
    await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP });
    expect(await isKnownStorefrontOrigin(`https://${SHOP}`)).toBe(true);
    expect(await resolveForBootstrap({ publicKey: "sfy_c-old", origin: `https://${SHOP}` })).toEqual({ ok: false, denial: "disabled" });
    const now = await resolveForBootstrap({ shopDomain: SHOP, origin: `https://${SHOP}` });
    expect(now.ok).toBe(true);
    expect((now as any).channel.tenantId).toBe(NEW);
  });

  it("a workspace still holding the store live keeps its chat", async () => {
    goTchaLeftovers("ACTIVE");
    H.integrations.push({ tenantId: OLD, status: "CONNECTED", shopDomain: SHOP });
    const out = await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP });
    expect(out).toEqual({ ok: false, reason: "shop_taken" });
    expect(H.installs.find((r) => r.id === "i-old")).toMatchObject({ tenantId: OLD, channelAccountId: "c-old", status: "ACTIVE" });
    expect(H.channels.find((c) => c.id === "c-old")).toMatchObject({ isActive: true });
    expect(H.audits).toHaveLength(0);
  });
});

describe("a revival never restores another workspace's binding", () => {
  it("revived for the workspace that proved the store: unbound, PENDING", async () => {
    goTchaLeftovers("UNINSTALLED");
    const row = await recordAuthorizedInstall({ shopDomain: SHOP, forTenantId: NEW });
    expect(row).toMatchObject({ status: "PENDING", tenantId: null, channelAccountId: null });
  });
  it("revived for the same workspace: its setup comes back", async () => {
    goTchaLeftovers("UNINSTALLED");
    const row = await recordAuthorizedInstall({ shopDomain: SHOP, forTenantId: OLD });
    expect(row).toMatchObject({ status: "ACTIVE", tenantId: OLD, channelAccountId: "c-old" });
  });
});

describe("a refusal never fails the connect, and is kept", () => {
  it("not entitled: nothing bound, the reason is readable, a later success clears it", async () => {
    H.entitled = false;
    const out = await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP });
    expect(out).toEqual({ ok: false, reason: "not_entitled" });
    expect(H.installs.every((r) => r.tenantId !== NEW)).toBe(true);
    expect(H.channels).toHaveLength(0);
    expect(await readProvisionFailure(NEW)).toMatchObject({ reason: "not_entitled", shopDomain: SHOP });

    H.entitled = true;
    expect((await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP })).ok).toBe(true);
    expect(await readProvisionFailure(NEW)).toBeNull();
  });

  it("an error inside is caught and reported, never thrown", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).shopifyChatInstallation.findFirst.mockRejectedValueOnce(new Error("db down"));
    await expect(provisionStoreChat({ tenantId: NEW, shopDomain: SHOP })).resolves.toEqual({ ok: false, reason: "error" });
    expect(await readProvisionFailure(NEW)).toMatchObject({ reason: "error" });
  });
});

describe("the origin cache", () => {
  it("a storefront refused a moment ago is known right after the bind", async () => {
    expect(await isKnownStorefrontOrigin(`https://${SHOP}`)).toBe(false);
    await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP });
    expect(await isKnownStorefrontOrigin(`https://${SHOP}`)).toBe(true);
  });
});

describe("replacing the store stops the chat on the old one", () => {
  it("the old store's channel off, its installation unbound, its origin no longer known, audited", async () => {
    await provisionStoreChat({ tenantId: NEW, shopDomain: "old-store.myshopify.com" });
    expect(await isKnownStorefrontOrigin("https://old-store.myshopify.com")).toBe(true);
    const inst = H.installs[0];
    const chId = inst.channelAccountId;

    expect(await releaseReplacedStoreChat({ tenantId: NEW, shopDomain: "old-store.myshopify.com" })).toEqual({ released: true });
    expect(inst).toMatchObject({ status: "PENDING", tenantId: null, channelAccountId: null });
    expect(H.channels.find((c) => c.id === chId)).toMatchObject({ isActive: false, connectionStatus: "DISCONNECTED" });
    expect(await isKnownStorefrontOrigin("https://old-store.myshopify.com")).toBe(false);
    const pk = H.channels.find((c) => c.id === chId).externalId;
    expect(await resolveForBootstrap({ publicKey: pk, origin: "https://old-store.myshopify.com" })).toEqual({ ok: false, denial: "disabled" });
    expect(H.audits.at(-1)).toMatchObject({ tenantId: NEW, action: "shopify_chat.installation.released" });
  });

  it("another workspace's installation for that shop is not touched", async () => {
    goTchaLeftovers("ACTIVE");
    expect(await releaseReplacedStoreChat({ tenantId: NEW, shopDomain: SHOP })).toEqual({ released: false });
    expect(H.installs.find((r) => r.id === "i-old")).toMatchObject({ tenantId: OLD, status: "ACTIVE" });
    expect(H.channels.find((c) => c.id === "c-old")).toMatchObject({ isActive: true });
  });
});

describe("a channel made by a connect looks like the widget the merchant set up", () => {
  it("prod's case: Urban's old store channel carries Snowy, the avatar and the logo; the new store's channel gets them", async () => {
    const old = channel("c-demo", NEW, "urban-supply-gotcha-demo.myshopify.com", true);
    Object.assign(old.platformMeta.shopifyLiveChat, {
      welcome: { assistantName: "Snowy", headline: "Hi", subline: "", suggestedQuestions: ["What fits me?"] },
      appearance: { primaryColor: "#0E7C66", logoUrl: "https://cdn.example.com/snowboard_sky.png", avatarUrl: "https://cdn.example.com/snowy.png" },
      // What the v2 widget screen saves, and what its preview reads.
      ux: { welcome: { title: "Hi", assistantName: "Snowy", avatarUrl: "https://cdn.example.com/snowy.png" } },
    });
    const out = await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP });
    expect(out.ok).toBe(true);
    const ch = H.channels.find((c) => c.id === H.installs[0].channelAccountId);
    expect(ch.id).not.toBe("c-demo");
    const cfg = ch.platformMeta.shopifyLiveChat;
    expect(cfg.welcome.assistantName).toBe("Snowy");
    expect(cfg.appearance.logoUrl).toBe("https://cdn.example.com/snowboard_sky.png");
    expect(cfg.appearance.avatarUrl).toBe("https://cdn.example.com/snowy.png");
    expect(cfg.shopDomain).toBe(SHOP);
    expect(cfg.enabled).toBe(true);
  });

  it("nothing to copy (the workspace's first store): defaults, switched on", async () => {
    const out = await provisionStoreChat({ tenantId: NEW, shopDomain: SHOP });
    expect(out.ok).toBe(true);
    const cfg = H.channels[0].platformMeta.shopifyLiveChat;
    expect(cfg.welcome.assistantName).toBe("Store Assistant");
    expect(cfg.enabled).toBe(true);
  });
});
