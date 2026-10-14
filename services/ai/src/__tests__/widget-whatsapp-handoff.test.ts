/**
 * ★ "Continue on WhatsApp" (website widget, stage B), through the real routes:
 *   - the bootstrap shows the button only when it is on AND its number can
 *     take it (connected, phone known); the number never reaches the page
 *   - POST /whatsapp-handoff: the wa.me link with the code in the pre-filled
 *     message; the same conversation keeps the same code; refused (404) when
 *     off, the number is unavailable, the token is wrong or it is not a web chat
 *   - settings: the numbers with why one cannot take it; a number of another
 *     workspace is refused (422)
 *   - the shared code: unambiguous alphabet, found in the inbound text
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import crypto from "node:crypto";
import request from "supertest";

const H = vi.hoisted(() => ({
  kv: new Map<string, any>(),
  ttl: new Map<string, number>(),
  accounts: [] as any[],
  numbers: [] as any[],
  conversations: [] as any[],
  created: [] as any[],
}));

// The public routes' rate limits have their own tests; here they would only
// count this file's calls against one in-memory window.
vi.mock("express-rate-limit", () => ({ default: () => (_q: any, _r: any, n: any) => n() }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const match = (r: any, w: any) => Object.entries(w ?? {}).every(([k, v]: [string, any]) =>
    v && typeof v === "object" && "in" in v ? v.in.includes(r[k]) : r[k] === v);
  return {
    ...actual,
    withCrossTenantAccess: (fn: any) => fn(),
    readDurableSetting: async () => null,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _r: any, n: any) => n(),
    requirePermission: () => (_q: any, _r: any, n: any) => n(),
    getRedis: () => ({
      get: async (k: string) => H.kv.get(k) ?? null,
      set: async (k: string, v: string, ...a: any[]) => { if (a.includes("NX") && H.kv.has(k)) return null; H.kv.set(k, v); if (a[0] === "EX") H.ttl.set(k, a[1]); return "OK"; },
    }),
    prisma: {
      channelAccount: {
        findFirst: async (a: any) => H.accounts.find((r) => match(r, a.where)) ?? null,
        findMany: async (a: any) => H.accounts.filter((r) => match(r, a.where)),
        update: async (a: any) => { const r = H.accounts.find((x) => x.id === a.where.id); Object.assign(r, a.data); return r; },
      },
      whatsAppNumber: { findMany: async (a: any) => H.numbers.filter((r) => match(r, a.where)) },
      conversation: { findUnique: async (a: any) => H.conversations.find((c) => c.id === a.where.id) ?? null },
      message: { create: async (a: any) => { H.created.push(a.data); return { id: "m1", ...a.data }; } },
      flowCanvas: { findUnique: async () => null },
      shopifyChatInstallation: { findMany: async () => [] },
      $executeRaw: async () => 1,
    },
  };
});

import { normalizeWebchatConfig, findHandoffRef, newHandoffRef, HANDOFF_REF_ALPHABET, waMeDigits, handoffMessage } from "@chatcenter/shared";
import chat from "../routes/embedded-chat";
import widget from "../routes/website-widget";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/embedded-chat", chat); a.use("/api/website-widget", widget); return a; };
const web = (ux: any = {}, lang = "en") => ({
  id: "ca_web", tenantId: "T", channel: "WEBCHAT", externalId: "widget-1", connectionStatus: "CONNECTED", platformMeta: null, lastHealthCheck: new Date(),
  credentials: normalizeWebchatConfig({ appearance: { language: lang }, ux }),
});
const wa = (id: string, o: any = {}) => ({ id, tenantId: "T", channel: "WHATSAPP", displayName: `WA ${id}`, connectionStatus: "CONNECTED", isActive: true, ...o });
const boot = async () => (await request(app()).post("/api/embedded-chat/bootstrap").send({ widgetId: "widget-1" })).body.data.widget;
const handoff = (body: any = { sessionId: "conv_web", sessionToken: "sess_abc" }) => request(app()).post("/api/embedded-chat/whatsapp-handoff").send(body);

beforeEach(() => {
  H.kv.clear(); H.ttl.clear(); H.created = [];
  H.accounts = [web({ whatsapp: { enabled: true, channelAccountId: "wa_1" } }), wa("wa_1"), wa("wa_old"), wa("wa_off", { connectionStatus: "DISCONNECTED" }), { ...wa("wa_x"), tenantId: "OTHER" }];
  H.numbers = [{ tenantId: "T", channelAccountId: "wa_1", displayPhoneNumber: "+972 52-555-1234" }, { tenantId: "T", channelAccountId: "wa_off", displayPhoneNumber: "+972 52-555-9999" }];
  H.conversations = [
    { id: "conv_web", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: "sess_abc" },
    { id: "conv_wa", tenantId: "T", channel: "WHATSAPP", channelAccountId: "wa_1", customerExternalId: "972500000000" },
  ];
});

describe("★ the button shows only when it can work", () => {
  it("on + a connected number with a known phone: shown, with no number in the page", async () => {
    const w = await boot();
    expect(w.features.whatsappHandoff).toBe(true);
    expect(w.whatsapp).toEqual({ label: "Continue on WhatsApp" });
    expect(JSON.stringify(w)).not.toMatch(/wa_1|5551234|972/);
  });

  it("the look reaches the page", async () => {
    H.accounts[0] = web({ look: "whatsapp", whatsapp: { enabled: true, channelAccountId: "wa_1" } });
    expect((await boot()).ux.look).toBe("whatsapp");
  });

  it("off, a number with no known phone, a disconnected number: hidden", async () => {
    for (const ux of [{ whatsapp: { enabled: false, channelAccountId: "wa_1" } }, { whatsapp: { enabled: true, channelAccountId: "wa_old" } }, { whatsapp: { enabled: true, channelAccountId: "wa_off" } }]) {
      H.accounts[0] = web(ux);
      const w = await boot();
      expect(w.features.whatsappHandoff).toBe(false);
      expect(w).not.toHaveProperty("whatsapp");
    }
  });

  it("the label follows the widget's language", async () => {
    H.accounts[0] = web({ whatsapp: { enabled: true, channelAccountId: "wa_1" } }, "he");
    expect((await boot()).whatsapp.label).toBe("המשך בוואטסאפ");
  });
});

describe("★ POST /whatsapp-handoff", () => {
  it("the wa.me link carries the code; the same conversation keeps it", async () => {
    const r = await handoff({ sessionId: "conv_web", sessionToken: "sess_abc", locale: "he" });
    expect(r.status).toBe(200);
    const { url, ref } = r.body.data;
    expect(ref).toMatch(new RegExp(`^[${HANDOFF_REF_ALPHABET}]{6}$`));
    expect(url).toBe(`https://wa.me/972525551234?text=${encodeURIComponent(handoffMessage(ref, "he"))}`);
    expect(JSON.parse(H.kv.get(`wahandoff:ref:${ref}`))).toMatchObject({ tenantId: "T", conversationId: "conv_web", whatsappChannelAccountId: "wa_1" });
    expect(H.ttl.get(`wahandoff:ref:${ref}`)).toBe(7 * 24 * 3600);
    expect((await handoff()).body.data.ref).toBe(ref);
  });

  it("★ the WhatsApp look's own words: kept in the website chat (not queued for a website answer), pre-filled with the code", async () => {
    const r = await handoff({ sessionId: "conv_web", sessionToken: "sess_abc", text: "  Is the oak lamp in stock?  " });
    const { url, ref } = r.body.data;
    expect(url).toBe(`https://wa.me/972525551234?text=${encodeURIComponent(`Is the oak lamp in stock? (${ref})`)}`);
    expect(H.created).toEqual([expect.objectContaining({ conversationId: "conv_web", direction: "INBOUND", body: "Is the oak lamp in stock?", metadata: { source: "whatsapp_handoff" } })]);
    // Without text nothing is recorded.
    H.created = [];
    await handoff();
    expect(H.created).toEqual([]);
  });

  it("refused when the token is wrong, it is not a web chat, it is off or the number cannot take it", async () => {
    expect((await handoff({ sessionId: "conv_web", sessionToken: "guess" })).status).toBe(404);
    expect((await handoff({ sessionId: "conv_wa", sessionToken: "972500000000" })).status).toBe(404);
    // A web chat conversation that lost its account (deleted widget) is not this widget's.
    H.conversations.push({ id: "conv_orphan", tenantId: "T", channel: "WEBCHAT", channelAccountId: null, customerExternalId: "sess_orphan" });
    expect((await handoff({ sessionId: "conv_orphan", sessionToken: "sess_orphan" })).status).toBe(404);
    H.accounts[0] = web({ whatsapp: { enabled: false, channelAccountId: "wa_1" } });
    expect((await handoff()).status).toBe(404);
    H.accounts[0] = web({ whatsapp: { enabled: true, channelAccountId: "wa_old" } });
    expect((await handoff()).status).toBe(404);
    expect([...H.kv.keys()]).toEqual([]);
  });
});

describe("settings", () => {
  it("lists the numbers with why one cannot take it", async () => {
    const d = (await request(app()).get("/api/website-widget")).body.data;
    expect(d.whatsappNumbers).toEqual([
      { channelId: "wa_1", name: "WA wa_1", phone: "+972 52-555-1234", available: true },
      { channelId: "wa_old", name: "WA wa_old", phone: null, available: false, reason: "number_unknown" },
      { channelId: "wa_off", name: "WA wa_off", phone: "+972 52-555-9999", available: false, reason: "not_connected" },
    ]);
    expect(d.settings.ux).toMatchObject({ look: "gotcha", whatsapp: { enabled: true, channelAccountId: "wa_1" } });
  });

  it("saves the look and the number; another workspace's number is 422", async () => {
    const ok = await request(app()).put("/api/website-widget").send({ ux: { look: "whatsapp", whatsapp: { enabled: true, channelAccountId: "wa_old" } } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.settings.ux).toMatchObject({ look: "whatsapp", whatsapp: { channelAccountId: "wa_old" } });
    const bad = await request(app()).put("/api/website-widget").send({ ux: { whatsapp: { enabled: true, channelAccountId: "wa_x" } } });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: "WHATSAPP_NUMBER_NOT_FOUND", field: "ux.whatsapp.channelAccountId" });
  });

  it("an unknown look falls back (normalised, never 400)", async () => {
    const r = await request(app()).put("/api/website-widget").send({ ux: { look: "neon" } });
    expect(r.body.data.settings.ux.look).toBe("gotcha");
  });
});

describe("the shared code", () => {
  it("no confusable characters; found in the inbound text, any case; wa.me digits", () => {
    for (let i = 0; i < 200; i++) expect(newHandoffRef((n) => crypto.randomBytes(n))).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(findHandoffRef("Hi, continuing our chat from the website (k7Q2MX)")).toBe("K7Q2MX");
    expect(findHandoffRef("היי, ממשיכים את השיחה מהאתר (K7Q2MX)")).toBe("K7Q2MX");
    expect(findHandoffRef("hello (K7Q2M)")).toBeNull();
    expect(findHandoffRef("no code")).toBeNull();
    expect(waMeDigits("+972 52-555-1234")).toBe("972525551234");
    expect(waMeDigits("call me")).toBeNull();
  });
});

describe("★ the WhatsApp kind (no on-site chat)", () => {
  const start = (body: any) => request(app()).post("/api/embedded-chat/whatsapp-start").send(body);

  it("served with the kind and always the WhatsApp look", async () => {
    H.accounts[0] = web({ kind: "whatsapp", look: "gotcha", whatsapp: { enabled: true, channelAccountId: "wa_1" } });
    const w = await boot();
    expect(w.ux).toMatchObject({ kind: "whatsapp", look: "whatsapp" });
    expect(w.features.whatsappHandoff).toBe(true);
  });

  it("a stored WhatsApp kind whose number cannot take it draws nothing", async () => {
    H.accounts[0] = web({ kind: "whatsapp", whatsapp: { enabled: true, channelAccountId: "wa_off" } });
    const r = await request(app()).post("/api/embedded-chat/bootstrap").send({ widgetId: "widget-1" });
    expect(r.body).toEqual({ data: {} });
  });

  it("start: wa.me with the visitor's words + code; no website conversation, the page in the code", async () => {
    H.accounts[0] = web({ kind: "whatsapp", whatsapp: { enabled: true, channelAccountId: "wa_1" } });
    const r = await start({ widgetId: "widget-1", text: " Is the oak lamp in stock? ", context: { pageType: "product", productHandle: "Oak-Lamp", path: "/products/oak-lamp?utm=x", price: 1 } });
    expect(r.status).toBe(200);
    const { url, ref } = r.body.data;
    expect(url).toBe(`https://wa.me/972525551234?text=${encodeURIComponent(`Is the oak lamp in stock? (${ref})`)}`);
    const rec = JSON.parse(H.kv.get(`wahandoff:ref:${ref}`));
    expect(rec).toMatchObject({ tenantId: "T", conversationId: null, whatsappChannelAccountId: "wa_1", context: { pageType: "product", productHandle: "oak-lamp", path: "/products/oak-lamp" } });
    expect(JSON.stringify(rec)).not.toMatch(/price|utm/);
    expect(H.ttl.get(`wahandoff:ref:${ref}`)).toBe(7 * 24 * 3600);
    expect(H.created).toEqual([]);
    // No text: the default message, in the asked language.
    const d = (await start({ widgetId: "widget-1", locale: "he" })).body.data;
    expect(d.url).toBe(`https://wa.me/972525551234?text=${encodeURIComponent(handoffMessage(d.ref, "he"))}`);
  });

  it("refused (404) for the chat kind, an unknown widget, or a number that cannot take it", async () => {
    expect((await start({ widgetId: "widget-1", text: "hi" })).status).toBe(404);
    H.accounts[0] = web({ kind: "whatsapp", whatsapp: { enabled: true, channelAccountId: "wa_1" } });
    expect((await start({ widgetId: "nope", text: "hi" })).status).toBe(404);
    H.accounts[0] = web({ kind: "whatsapp", whatsapp: { enabled: true, channelAccountId: "wa_off" } });
    expect((await start({ widgetId: "widget-1", text: "hi" })).status).toBe(404);
    expect([...H.kv.keys()]).toEqual([]);
  });

  it("saving the WhatsApp kind needs a number that can take it (422); a later colour save is not blocked", async () => {
    const bad = await request(app()).put("/api/website-widget").send({ ux: { kind: "whatsapp", whatsapp: { enabled: true, channelAccountId: "wa_off" } } });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: "WHATSAPP_KIND_NEEDS_NUMBER", field: "ux.kind" });
    const off = await request(app()).put("/api/website-widget").send({ ux: { kind: "whatsapp", whatsapp: { enabled: false } } });
    expect(off.status).toBe(422);
    const ok = await request(app()).put("/api/website-widget").send({ ux: { kind: "whatsapp" } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.settings.ux.kind).toBe("whatsapp");
    // The number disconnects; saving a colour still works.
    H.accounts.find((a) => a.id === "wa_1").connectionStatus = "DISCONNECTED";
    const colour = await request(app()).put("/api/website-widget").send({ appearance: { primaryColor: "#112233" } });
    expect(colour.status).toBe(200);
  });

  it("an unknown kind falls back to chat", async () => {
    const r = await request(app()).put("/api/website-widget").send({ ux: { kind: "sms" } });
    expect(r.body.data.settings.ux.kind).toBe("chat");
  });
});
