/**
 * ★ W10: the widget follows the customer's language, through the real routes
 * (only the model call is replaced):
 *   - /message answers the language the visitor wrote in
 *   - POST /texts: only texts in another language are translated, all of a
 *     widget's missing texts in ONE metered call, then cached per text and
 *     language (a second visitor costs nothing; an edited text is new)
 *   - a refused / failed / malformed call shows the texts as written and
 *     caches nothing; keys the model invents are dropped
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ kv: new Map<string, string>(), ttl: new Map<string, number>(), calls: [] as any[], answer: null as any, accounts: [] as any[], queued: [] as any[] }));

vi.mock("express-rate-limit", () => ({ default: () => (_q: any, _r: any, n: any) => n() }));
vi.mock("../services/ai.service", () => ({
  getMicroModel: () => "micro",
  generateResponse: async (p: any) => { H.calls.push(p); if (H.answer instanceof Error) throw H.answer; return { content: H.answer, usage: {} }; },
}));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const match = (r: any, w: any) => Object.entries(w ?? {}).every(([k, v]: [string, any]) => v && typeof v === "object" && "in" in v ? v.in.includes(r[k]) : r[k] === v);
  return {
    ...actual,
    withCrossTenantAccess: (fn: any) => fn(),
    incomingMessageQueue: { add: async (_n: string, d: any) => { H.queued.push(d); } },
    getRedis: () => ({
      mget: async (...k: string[]) => k.map((x) => H.kv.get(x) ?? null),
      set: async (k: string, v: string, _ex: string, ttl: number) => { H.kv.set(k, v); H.ttl.set(k, ttl); return "OK"; },
      get: async (k: string) => H.kv.get(k) ?? null,
    }),
    prisma: {
      channelAccount: { findFirst: async (a: any) => H.accounts.find((r) => match(r, a.where)) ?? null },
      conversation: { findUnique: async (a: any) => (a.where.id === "conv1" ? { id: "conv1", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: "tok_1", customerName: "V" } : null) },
    },
  };
});

import { normalizeWebchatConfig } from "@chatcenter/shared";
import chat from "../routes/embedded-chat";
import { textCacheKey, TEXT_CACHE_TTL_SECONDS } from "../services/widget-text-translation.service";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/embedded-chat", chat); return a; };
const texts = (body: any) => request(app()).post("/api/embedded-chat/texts").send(body);
const HE = {
  welcome: { title: "ברוכים הבאים", subtitle: "נשמח לעזור לכם", assistantName: "נועה", suggestedQuestions: ["מה זמני המשלוח?"] },
  launcher: { label: "Chat with us" },
};
const web = (ux: any = HE, offline = "אנחנו לא זמינים כרגע") => ({
  id: "ca_web", tenantId: "T", channel: "WEBCHAT", externalId: "widget-1", connectionStatus: "CONNECTED",
  credentials: normalizeWebchatConfig({ ux, offline: { message: offline } }),
});

beforeEach(() => {
  H.kv.clear(); H.ttl.clear(); H.calls = []; H.queued = [];
  H.accounts = [web()];
  H.answer = JSON.stringify({
    "welcome.title": "Welcome", "welcome.subtitle": "Happy to help", "welcome.suggestedQuestions.0": "What are the delivery times?",
    "offline.message": "We are not available right now", "invented.key": "nope",
  });
});

describe("★ /message says which language the visitor wrote in", () => {
  it("he / en / too short to tell", async () => {
    const send = (body: string) => request(app()).post("/api/embedded-chat/message").send({ sessionId: "conv1", sessionToken: "tok_1", body });
    expect((await send("היי, יש משלוח לאילת?")).body.data.locale).toBe("he");
    expect((await send("Do you ship to Eilat?")).body.data.locale).toBe("en");
    expect((await send("ok")).body.data.locale).toBeNull();
  });
});

describe("★ POST /texts", () => {
  it("only the texts in another language; one batched, metered call; the assistant's name untouched", async () => {
    const r = await texts({ widgetId: "widget-1", locale: "en" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ locale: "en", texts: {
      "welcome.title": "Welcome", "welcome.subtitle": "Happy to help", "welcome.suggestedQuestions.0": "What are the delivery times?",
      "offline.message": "We are not available right now",
    } });
    expect(H.calls).toHaveLength(1);
    expect(H.calls[0]).toMatchObject({ tenantId: "T", model: "micro", reasoningEffort: "minimal", metadata: { type: "widget_text_translation" } });
    // The English launcher label and the name were not sent.
    expect(JSON.parse(H.calls[0].messages[1].content)).toEqual({
      "welcome.title": "ברוכים הבאים", "welcome.subtitle": "נשמח לעזור לכם", "welcome.suggestedQuestions.0": "מה זמני המשלוח?", "offline.message": "אנחנו לא זמינים כרגע",
    });
  });

  it("★ cached per text and language: the next visitor costs nothing; an edited text is translated alone", async () => {
    await texts({ widgetId: "widget-1", locale: "en" });
    expect(H.ttl.get(textCacheKey("en", "ברוכים הבאים"))).toBe(TEXT_CACHE_TTL_SECONDS);
    expect(H.kv.has(textCacheKey("en", "invented.key"))).toBe(false);
    const again = await texts({ widgetId: "widget-1", locale: "en" });
    expect(again.body.data.texts["welcome.title"]).toBe("Welcome");
    expect(H.calls).toHaveLength(1);
    H.accounts = [web({ ...HE, welcome: { ...HE.welcome, title: "שלום וברכה" } })];
    H.answer = JSON.stringify({ "welcome.title": "Hello and welcome" });
    const edited = await texts({ widgetId: "widget-1", locale: "en" });
    expect(H.calls).toHaveLength(2);
    expect(JSON.parse(H.calls[1].messages[1].content)).toEqual({ "welcome.title": "שלום וברכה" });
    expect(edited.body.data.texts).toMatchObject({ "welcome.title": "Hello and welcome", "welcome.subtitle": "Happy to help" });
  });

  it("the other way: an English text for a Hebrew visitor", async () => {
    H.answer = JSON.stringify({ "launcher.label": "דברו איתנו" });
    const r = await texts({ widgetId: "widget-1", locale: "he" });
    expect(JSON.parse(H.calls[0].messages[1].content)).toEqual({ "launcher.label": "Chat with us" });
    expect(r.body.data.texts).toEqual({ "launcher.label": "דברו איתנו" });
  });

  it("★ refused / failed / malformed: shown as written, nothing cached, the next request tries again", async () => {
    for (const answer of [new Error("AI units exhausted"), "not json", JSON.stringify(["a"])]) {
      H.answer = answer;
      const r = await texts({ widgetId: "widget-1", locale: "en" });
      expect(r.status).toBe(200);
      expect(r.body.data.texts).toEqual({});
    }
    expect(H.kv.size).toBe(0);
    expect(H.calls).toHaveLength(3);
  });

  it("nothing to translate makes no call; a bad locale is 400; an unknown widget is empty", async () => {
    H.accounts = [web({ welcome: { title: "Welcome", subtitle: "Happy to help", suggestedQuestions: [] } }, "We are away right now")];
    expect((await texts({ widgetId: "widget-1", locale: "en" })).body.data.texts).toEqual({});
    expect(H.calls).toHaveLength(0);
    expect((await texts({ widgetId: "widget-1", locale: "fr" })).status).toBe(400);
    expect((await texts({ widgetId: "nope", locale: "he" })).body.data).toEqual({ locale: "he", texts: {} });
  });
});

describe("★ a web chat message carries the page it was written on (lookup keys only)", () => {
  it("context → metadata.storefront on the queued message: the Hebrew slug decoded, the product id; nothing else", async () => {
    H.queued = [];
    await request(app()).post("/api/embedded-chat/message").send({ sessionId: "conv1", sessionToken: "tok_1", body: "is this in stock?", context: { pageType: "product", productHandle: encodeURIComponent("מעיל-טרנץ"), productId: "364", price: 1 } });
    const st = H.queued[0].normalizedMessage.metadata.storefront;
    expect(st).toMatchObject({ pageType: "product", productHandle: "מעיל-טרנץ", productId: "364" });
    expect(JSON.stringify(st)).not.toContain("price");
    H.queued = [];
    await request(app()).post("/api/embedded-chat/message").send({ sessionId: "conv1", sessionToken: "tok_1", body: "hi there" });
    expect(H.queued[0].normalizedMessage).not.toHaveProperty("metadata");
  });
});
