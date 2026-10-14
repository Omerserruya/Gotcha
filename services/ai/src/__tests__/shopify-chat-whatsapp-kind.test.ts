/**
 * ★ The WhatsApp kind on the Shopify storefront, through the real routes:
 *   - the bootstrap says whether the WhatsApp button can work; the WhatsApp
 *     kind whose number cannot take it is not served at all
 *   - POST /whatsapp-start: a signed visitor only; wa.me pre-filled with the
 *     shopper's words and a code; no storefront conversation; the code
 *     carries the page (product handle) and nothing price-shaped
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-that-is-long-enough";
});
vi.mock("express-rate-limit", () => ({ default: () => (_q: any, _r: any, n: any) => n() }));
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); subscribe = vi.fn(); on = vi.fn(); quit = vi.fn(); } }));

const SHOP = "urban-supply-gotcha-demo.myshopify.com";
const H = vi.hoisted(() => ({ kv: new Map<string, string>(), ttl: new Map<string, number>(), target: null as any, ux: {} as any, created: [] as any[], calls: [] as any[] }));

vi.mock("../services/ai.service", () => ({
  getMicroModel: () => "micro",
  generateResponse: async (p: any) => { H.calls.push(p); return { content: JSON.stringify({ "welcome.title": "Welcome" }), usage: {} }; },
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      message: { create: async (a: any) => { H.created.push(a); return a.data; } },
      conversation: { create: async (a: any) => { H.created.push(a); return a.data; } },
      businessProfile: { findUnique: async () => ({ organizationName: "Urban Supply" }) },
      tenant: { findUnique: async () => null },
    },
    withCrossTenantAccess: (fn: any) => fn(),
    analyticsQueue: { add: vi.fn(async () => undefined) },
    incomingMessageQueue: { add: vi.fn() },
    publishEvent: vi.fn(async () => undefined),
    getRedis: () => ({
      set: async (k: string, v: string, ...a: any[]) => { if (a.includes("NX") && H.kv.has(k)) return null; H.kv.set(k, v); if (a[0] === "EX") H.ttl.set(k, a[1]); return "OK"; },
      get: async (k: string) => H.kv.get(k) ?? null,
      mget: async (...k: string[]) => k.map((x) => H.kv.get(x) ?? null),
    }),
  };
});

function channel() {
  // The real normaliser, so the kind is read exactly as production reads it.
  return {
    id: "c1", tenantId: "T", connectionStatus: "CONNECTED",
    config: readShopifyLiveChatConfig({ shopifyLiveChat: { enabled: true, shopDomain: SHOP, ux: H.ux } }),
  };
}

vi.mock("../services/shopify-live-chat.service", () => ({
  resolveForBootstrap: async () => ({ ok: true, channel: channel(), availability: "online", productMessagingEnabled: false }),
  loadChannel: async () => channel(),
  recordHeartbeat: async () => undefined,
}));
vi.mock("../services/shopify-chat-install.service", () => ({
  findLiveInstallation: async () => null,
  recordInstallationHeartbeat: async () => undefined,
  clearStaleUninstalledError: async () => undefined,
  isKnownStorefrontOrigin: async () => true,
}));
vi.mock("../services/website-widget.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, handoffTarget: async () => H.target };
});

import { signVisitorSession, handoffMessage, readShopifyLiveChatConfig } from "@chatcenter/shared";
import router from "../routes/shopify-chat-public";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/shopify-chat", router); return a; };
const token = () => signVisitorSession({ tenantId: "T", channelAccountId: "c1", visitorId: "v_1", customerId: null, shopDomain: SHOP });
const boot = () => request(app()).post("/api/shopify-chat/bootstrap").set("origin", `https://${SHOP}`).send({ shopDomain: SHOP });
const start = (body: any) => request(app()).post("/api/shopify-chat/whatsapp-start").set("origin", `https://${SHOP}`).send(body);

beforeEach(() => {
  H.kv.clear(); H.ttl.clear(); H.created = []; H.calls = [];
  H.ux = { kind: "whatsapp", whatsapp: { enabled: true, channelAccountId: "wa_1" } };
  H.target = { channelAccountId: "wa_1", digits: "972525551234" };
});

describe("★ bootstrap", () => {
  it("the WhatsApp kind is served in the WhatsApp look, with the button on and no number", async () => {
    const r = await boot();
    expect(r.status).toBe(200);
    const w = r.body.data.widget;
    expect(w.ux).toMatchObject({ kind: "whatsapp", look: "whatsapp" });
    expect(w.features.whatsappHandoff).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/wa_1|972525551234/);
  });

  it("the WhatsApp kind whose number cannot take it is not served", async () => {
    H.target = null;
    expect((await boot()).status).toBe(403);
  });

  it("the chat kind: served, the button off when it cannot work", async () => {
    H.ux = { kind: "chat" };
    H.target = null;
    const r = await boot();
    expect(r.status).toBe(200);
    expect(r.body.data.widget.features.whatsappHandoff).toBe(false);
    expect(r.body.data.widget.ux.kind).toBe("chat");
  });
});

describe("★ POST /whatsapp-start", () => {
  it("wa.me with the shopper's words + code; the page in the code; nothing stored as a conversation", async () => {
    const r = await start({ sessionToken: token(), text: "Does it come in blue?", context: { pageType: "product", productHandle: "oak-lamp", path: "/products/oak-lamp", price: 99 } });
    expect(r.status).toBe(200);
    const { url, ref } = r.body.data;
    expect(url).toBe(`https://wa.me/972525551234?text=${encodeURIComponent(`Does it come in blue? (${ref})`)}`);
    const rec = JSON.parse(H.kv.get(`wahandoff:ref:${ref}`)!);
    expect(rec).toMatchObject({ tenantId: "T", conversationId: null, whatsappChannelAccountId: "wa_1", context: { pageType: "product", productHandle: "oak-lamp", path: "/products/oak-lamp" } });
    expect(JSON.stringify(rec)).not.toMatch(/99|price/);
    expect(H.created).toEqual([]);
    const d = (await start({ sessionToken: token(), locale: "he" })).body.data;
    expect(d.url).toBe(`https://wa.me/972525551234?text=${encodeURIComponent(handoffMessage(d.ref, "he"))}`);
  });

  it("refused: no session (401), the chat kind (404), a number that cannot take it (404)", async () => {
    expect((await start({ text: "hi" })).status).toBe(401);
    H.ux = { kind: "chat", whatsapp: { enabled: true, channelAccountId: "wa_1" } };
    expect((await start({ sessionToken: token(), text: "hi" })).status).toBe(404);
    H.ux = { kind: "whatsapp", whatsapp: { enabled: true, channelAccountId: "wa_1" } };
    H.target = null;
    expect((await start({ sessionToken: token(), text: "hi" })).status).toBe(404);
    expect([...H.kv.keys()]).toEqual([]);
  });
});

describe("★ POST /texts (W10)", () => {
  it("a signed shopper gets the merchant's texts in their language; no session is 401", async () => {
    H.ux = { kind: "chat", welcome: { title: "ברוכים הבאים", subtitle: "Happy to help", suggestedQuestions: [] } };
    const r = await request(app()).post("/api/shopify-chat/texts").set("origin", `https://${SHOP}`).send({ sessionToken: token(), locale: "en" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ locale: "en", texts: { "welcome.title": "Welcome" } });
    expect(H.calls).toHaveLength(1);
    expect(H.calls[0].metadata).toEqual({ type: "widget_text_translation" });
    expect((await request(app()).post("/api/shopify-chat/texts").send({ locale: "en" })).status).toBe(401);
    expect((await request(app()).post("/api/shopify-chat/texts").set("origin", `https://${SHOP}`).send({ sessionToken: token(), locale: "de" })).status).toBe(400);
  });
});

describe("★ the wordmark on the storefront too", () => {
  it("the Shopify bootstrap carries brand { name, initial }", async () => {
    H.ux = { kind: "chat" };
    expect((await boot()).body.data.widget.brand).toEqual({ name: "Urban Supply", initial: "U" });
  });
});
