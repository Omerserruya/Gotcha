/**
 * ★ The Website widget (docs/api/website-widget-v1.md), through the real routes:
 *   - PUT writes the shared settings to the web chat AND every Shopify chat;
 *     Shopify-only fields (shop, enabled, commerce, privacy, install) untouched;
 *     the Shopify legacy welcome + launcher fields kept in step; bad values normalised
 *   - PUT never creates a place: none → 409 WIDGET_NOT_CREATED, nothing written
 *   - a Shopify-only workspace reads from and writes to its shop(s)
 *   - permissions: read for GET and /install, update for PUT
 *   - assignedEmployee follows the playbook's single path; a branch or a
 *     foreign employee → null
 *   - /install: the snippet, last seen, host; Shopify embed live within a week, uninstalled
 *   - ★ the Shopify heartbeat writes only `install` (it used to write back the
 *     whole config read at bootstrap, undoing a merchant's save)
 *   - the web chat's host comes from Origin, then Referer
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  accounts: [] as any[],
  canvas: null as any,
  agents: [] as any[],
  installs: [] as any[],
  raw: [] as { sql: string; values: any[] }[],
  updates: 0,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const match = (a: any, w: any) => Object.entries(w ?? {}).every(([k, v]) => a[k] === v);
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => { req.perms = String(req.headers["x-perms"] ?? "").split(","); next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "T"; next(); },
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requirePermission: (...need: string[]) => (req: any, res: any, next: any) =>
      need.some((p) => req.perms.includes(p)) ? next() : res.status(403).json({ error: "forbidden" }),
    prisma: {
      channelAccount: {
        findFirst: async (a: any) => H.accounts.find((r) => match(r, a.where)) ?? null,
        findMany: async (a: any) => H.accounts.filter((r) => match(r, a.where)),
        update: async (a: any) => {
          H.updates++;
          const r = H.accounts.find((x) => x.id === a.where.id);
          Object.assign(r, a.data);
          return r;
        },
      },
      flowCanvas: { findUnique: async () => H.canvas },
      aIAgent: { findFirst: async (a: any) => H.agents.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId) ?? null },
      shopifyChatInstallation: { findMany: async () => H.installs },
      $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => { H.raw.push({ sql: strings.join("?"), values }); return 1; },
    },
  };
});

vi.mock("../services/shopify-chat-install.service", () => ({
  activationSnapshot: async (inst: any) => ({ lastHeartbeatAt: inst.lastHeartbeatAt ?? null, themeEditorDeepLink: `https://admin.shopify.com/store/${inst.shopDomain}/themes/current/editor` }),
}));

import router from "../routes/website-widget";
import { recordHeartbeat } from "../services/shopify-live-chat.service";
import { hostOf, shopifyPatchOf } from "../services/website-widget.service";
import { normalizeWebchatConfig, normalizeShopifyLiveChatConfig, readShopifyLiveChatConfig } from "@chatcenter/shared";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/website-widget", router); return a; };
const READ = "channels:manage:read";
const UPDATE = "channels:manage:update";
const get = (url: string, perms = READ) => request(app()).get(url).set("x-perms", perms);
const put = (body: any, perms = UPDATE) => request(app()).put("/api/website-widget").set("x-perms", perms).send(body);

const webchat = (o: any = {}) => ({
  id: "ca_web", tenantId: "T", channel: "WEBCHAT", externalId: "widget_abc", connectionStatus: "PENDING",
  connectedAt: null, lastHealthCheck: null, platformMeta: null,
  credentials: normalizeWebchatConfig({ appearance: { primaryColor: "#112233" } }), createdAt: new Date(1), ...o,
});
const shop = (id: string, domain: string, o: any = {}) => ({
  id, tenantId: "T", channel: "SHOPIFY_LIVE_CHAT", externalId: `pk_${id}`, displayName: domain, connectionStatus: "CONNECTED",
  platformMeta: {
    shopifyLiveChat: {
      ...normalizeShopifyLiveChatConfig({ enabled: true,
      commerce: { productMessagingEnabled: true, addToCartEnabled: true },
      privacy: { consentRequired: true },
      install: { lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(), lastThemeId: "th_1" },
      }),
      // The binding is set at creation, never through the normaliser's patch.
      shopDomain: domain, tenantIntegrationId: "ti_1",
    },
  },
  createdAt: new Date(2), updatedAt: new Date(2), ...o,
});
const cfgOf = (id: string) => readShopifyLiveChatConfig(H.accounts.find((a) => a.id === id).platformMeta);

beforeEach(() => {
  H.accounts = []; H.canvas = null; H.agents = []; H.installs = []; H.raw = []; H.updates = 0;
  process.env.APP_PUBLIC_URL = "https://dev.gotcha.co.il/";
});

describe("★ PUT writes every place, and only the shared settings", () => {
  it("the web chat and both shops get the same settings; Shopify-only fields are untouched", async () => {
    H.accounts = [webchat(), shop("ca_s1", "one.myshopify.com"), shop("ca_s2", "two.myshopify.com")];
    const before = cfgOf("ca_s1");
    const r = await put({
      appearance: { primaryColor: "#0E7C66", language: "he" },
      ux: { welcome: { title: "Hi there", assistantName: "Noa", suggestedQuestions: ["A?", "B?"] }, launcher: { position: "left" } },
      handoff: { allowHumanHandoff: false },
      offline: { message: "Away now" },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.settings).toMatchObject({
      appearance: { primaryColor: "#0e7c66", language: "he" },
      ux: { welcome: { title: "Hi there", assistantName: "Noa" }, launcher: { position: "left" } },
      handoff: { allowHumanHandoff: false },
      offline: { message: "Away now" },
    });
    const web = normalizeWebchatConfig(H.accounts[0].credentials);
    expect(web.appearance.primaryColor).toBe("#0e7c66");
    expect(web.behaviour.allowHumanHandoff).toBe(false);
    expect(web.offline.message).toBe("Away now");
    for (const id of ["ca_s1", "ca_s2"]) {
      const c = cfgOf(id);
      expect(c.appearance.primaryColor).toBe("#0e7c66");
      expect(c.appearance.language).toBe("he");
      expect(c.ux.welcome.title).toBe("Hi there");
      expect(c.routing.allowHumanHandoff).toBe(false);
      expect(c.hours.offlineMessage).toBe("Away now");
      // The legacy blocks the storefront still serves follow ux.
      expect(c.welcome.headline).toBe("Hi there");
      expect(c.welcome.assistantName).toBe("Noa");
      expect(c.appearance.launcherPosition).toBe("left");
    }
    const after = cfgOf("ca_s1");
    expect(after.shopDomain).toBe("one.myshopify.com");
    expect(cfgOf("ca_s2").shopDomain).toBe("two.myshopify.com");
    expect(after.enabled).toBe(before.enabled);
    expect(after.commerce).toEqual(before.commerce);
    expect(after.privacy).toEqual(before.privacy);
    expect(after.install).toEqual(before.install);
    expect(after.tenantIntegrationId).toBe("ti_1");
  });

  it("a partial PUT keeps the rest; bad values fall back instead of 400", async () => {
    H.accounts = [webchat()];
    const r = await put({ appearance: { primaryColor: "red", logoUrl: "http://insecure.example/logo.png" }, offline: { message: "Later" } });
    expect(r.status).toBe(200);
    expect(r.body.data.settings.appearance.primaryColor).toBe("#112233");
    expect(r.body.data.settings.appearance.logoUrl).toBeNull();
    expect(r.body.data.settings.offline.message).toBe("Later");
  });

  it("no place yet → 409 WIDGET_NOT_CREATED and nothing is created", async () => {
    const r = await put({ offline: { message: "x" } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("WIDGET_NOT_CREATED");
    expect(H.updates).toBe(0);
    expect(H.accounts).toEqual([]);
  });

  it("a Shopify-only workspace reads from its shop and writes to it", async () => {
    H.accounts = [shop("ca_s1", "one.myshopify.com")];
    const sh = H.accounts[0].platformMeta.shopifyLiveChat;
    sh.appearance.primaryColor = "#445566";
    const g = await get("/api/website-widget");
    expect(g.body.data.settings.appearance.primaryColor).toBe("#445566");
    expect(g.body.data.places).toEqual({ code: null, shopify: [{ channelId: "ca_s1", shopDomain: "one.myshopify.com" }] });
    const r = await put({ handoff: { allowHumanHandoff: false } });
    expect(r.status).toBe(200);
    expect(cfgOf("ca_s1").routing.allowHumanHandoff).toBe(false);
    expect(cfgOf("ca_s1").appearance.primaryColor).toBe("#445566");
  });

  it("GET with no place answers the defaults, never 404", async () => {
    const r = await get("/api/website-widget");
    expect(r.status).toBe(200);
    expect(r.body.data.places).toEqual({ code: null, shopify: [] });
  });
});

describe("★ permissions", () => {
  it("GET and /install need channels:manage:read; PUT needs channels:manage:update", async () => {
    H.accounts = [webchat()];
    expect((await get("/api/website-widget", "")).status).toBe(403);
    expect((await get("/api/website-widget/install", "")).status).toBe(403);
    expect((await get("/api/website-widget/install", READ)).status).toBe(200);
    expect((await put({ offline: { message: "x" } }, READ)).status).toBe(403);
    expect(H.updates).toBe(0);
  });
});

describe("assignedEmployee: the playbook's single path from the web chat entry", () => {
  const nodes = (target = "ag_1") => [
    { id: "wa", type: "channel_entry", data: { channelType: "whatsapp" } },
    { id: "e", type: "channel_entry", data: { channelType: "WEBCHAT" } },
    { id: "hours", type: "condition", data: {} },
    { id: "r1", type: "route", data: { routeType: "agent", targetId: target } },
    { id: "r2", type: "route", data: { routeType: "agent", targetId: "ag_2" } },
  ];
  beforeEach(() => { H.agents = [{ id: "ag_1", tenantId: "T", name: "Maya" }, { id: "ag_2", tenantId: "T", name: "Dan" }, { id: "ag_x", tenantId: "OTHER", name: "Foreign" }]; });

  it("a single path → that employee (from the web chat entry, not another channel's)", async () => {
    H.canvas = { nodes: nodes(), edges: [{ source: "wa", target: "r2" }, { source: "e", target: "hours" }, { source: "hours", target: "r1" }] };
    expect((await get("/api/website-widget")).body.data.assignedEmployee).toEqual({ id: "ag_1", name: "Maya" });
  });

  it("★ a playbook with only a start node: its route is the web chat's too (as the flow executor enters it)", async () => {
    H.canvas = { nodes: [{ id: "s", type: "start", data: {} }, { id: "r", type: "route_target", data: { routeType: "agent", targetId: "ag_1" } }], edges: [{ source: "s", target: "r" }] };
    expect((await get("/api/website-widget")).body.data.assignedEmployee).toEqual({ id: "ag_1", name: "Maya" });
  });

  it("a branch before any employee → null (it depends)", async () => {
    H.canvas = { nodes: nodes(), edges: [{ source: "e", target: "hours" }, { source: "hours", target: "r1" }, { source: "hours", target: "r2" }] };
    expect((await get("/api/website-widget")).body.data.assignedEmployee).toBeNull();
  });

  it("another tenant's employee id → null", async () => {
    H.canvas = { nodes: nodes("ag_x"), edges: [{ source: "e", target: "r1" }] };
    expect((await get("/api/website-widget")).body.data.assignedEmployee).toBeNull();
  });
});

describe("/install", () => {
  it("the code place: snippet on the public origin, not seen until a page loads it", async () => {
    H.accounts = [webchat()];
    const c = (await get("/api/website-widget/install")).body.data.code;
    expect(c).toMatchObject({ widgetId: "widget_abc", status: "not_seen", firstSeenAt: null, lastSeenAt: null, lastHost: null });
    expect(c.snippet).toContain('widgetId: "widget_abc"');
    expect(c.snippet).toContain('apiUrl: "https://dev.gotcha.co.il"');
    expect(c.snippet).toContain('src="https://dev.gotcha.co.il/widget/chatcenter-widget.js"');
  });

  it("live, with last seen and host, once a page loaded it", async () => {
    H.accounts = [webchat({ connectionStatus: "CONNECTED", connectedAt: new Date("2026-10-01T00:00:00Z"), lastHealthCheck: new Date("2026-10-07T09:00:00Z"), platformMeta: { webchatInstall: { lastHost: "shop.example.com" } } })];
    expect((await get("/api/website-widget/install")).body.data.code).toMatchObject({
      status: "live", firstSeenAt: "2026-10-01T00:00:00.000Z", lastSeenAt: "2026-10-07T09:00:00.000Z", lastHost: "shop.example.com",
    });
  });

  it("Shopify: embed live within a week, stale after; uninstalled wins; Woo uses the code; no install URL", async () => {
    const old = shop("ca_old", "old.myshopify.com");
    old.platformMeta.shopifyLiveChat.install.lastHeartbeatAt = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    H.accounts = [shop("ca_s1", "one.myshopify.com"), old, shop("ca_gone", "gone.myshopify.com")];
    H.installs = [{ channelAccountId: "ca_gone", shopDomain: "gone.myshopify.com", status: "UNINSTALLED" }];
    const d = (await get("/api/website-widget/install")).body.data;
    const by = Object.fromEntries(d.shopify.map((s: any) => [s.channelId, s]));
    expect(by.ca_s1).toMatchObject({ status: "active", embedLive: true });
    expect(by.ca_old).toMatchObject({ status: "active", embedLive: false });
    expect(by.ca_gone.status).toBe("uninstalled");
    expect(by.ca_gone.themeEditorUrl).toContain("gone.myshopify.com");
    expect(d.code).toBeNull();
    // The plugin's sites (none here) and its download (docs/api/woocommerce-plugin-v1.md §5).
    expect(d.woocommerce).toEqual({ status: "use_code", sites: [], downloadUrl: "/api/woocommerce-plugin/download" });
    expect(d).not.toHaveProperty("shopifyInstallUrl");
  });
});

describe("★ heartbeats write only their own part", () => {
  it("the Shopify heartbeat sends only install, never the config read at bootstrap", async () => {
    const cfg = normalizeShopifyLiveChatConfig({ shopDomain: "one.myshopify.com", appearance: { primaryColor: "#000000" }, install: { lastThemeId: "th_1" } });
    await recordHeartbeat("ca_s1", cfg, { themeId: "th_2", path: "/products/x" });
    expect(H.raw).toHaveLength(1);
    const { sql, values } = H.raw[0]!;
    expect(sql).toContain("'install'");
    const json = values.find((v) => typeof v === "string" && v.startsWith("{"));
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(["lastHeartbeatAt", "lastSeenPath", "lastThemeId"]);
    expect(JSON.parse(json)).toMatchObject({ lastThemeId: "th_2", lastSeenPath: "/products/x" });
    expect(values).toContain("ca_s1");
    expect(H.updates).toBe(0);
  });

  it("the web chat host comes from Origin, then Referer; junk is null", () => {
    expect(hostOf("https://Shop.Example.com", "https://other.com/x")).toBe("shop.example.com");
    expect(hostOf(undefined, "https://ref.example.com/page?q=1")).toBe("ref.example.com");
    expect(hostOf("null", "not a url")).toBeNull();
  });

  it("the Shopify patch carries only shared sections", () => {
    const keys = Object.keys(shopifyPatchOf({
      appearance: normalizeWebchatConfig(null).appearance, ux: normalizeWebchatConfig(null).ux,
      handoff: { allowHumanHandoff: true }, offline: { message: "x" },
    })).sort();
    expect(keys).toEqual(["appearance", "hours", "routing", "ux", "welcome"]);
  });
});
