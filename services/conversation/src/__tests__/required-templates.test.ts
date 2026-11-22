/**
 * WhatsApp required templates and the read from Meta (B9, 2026-10-13),
 * through the real routes. Meta is a stubbed fetch: nothing here reaches the
 * network, and on dev nothing is submitted without Omer's specific OK.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  templates: [] as any[],
  accounts: [] as any[],
  locale: "he",
  seq: 0,
  fetches: [] as Array<{ url: string; init?: any }>,
  metaPages: [] as any[],
  voiceInUse: false,
  voiceWhere: null as any,
}));

const matches = (row: any, where: any): boolean => {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === "OR") { if (!(v as any[]).some((w) => matches(row, w))) return false; continue; }
    if (k === "AND") { if (!(v as any[]).every((w) => matches(row, w))) return false; continue; }
    if (v && typeof v === "object" && "in" in (v as any)) { if (!(v as any).in.includes(row[k])) return false; continue; }
    if (v && typeof v === "object" && "not" in (v as any)) { if (row[k] === (v as any).not) return false; continue; }
    if ((row[k] ?? null) !== v) return false;
  }
  return true;
};

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requireOnboardingOrActiveTenant: () => pass,
    requireRole: () => pass,
    decryptCredentials: () => ({ accessToken: "tok", wabaId: "waba1" }),
    prisma: {
      tenant: { findUnique: async () => ({ defaultLocale: H.locale }) },
      voiceChannel: { findFirst: async (a: any) => { H.voiceWhere = a.where; return H.voiceInUse ? { id: "vc1" } : null; } },
      channelAccount: { findFirst: async (a: any) => H.accounts.find((x) => matches(x, a.where)) ?? null },
      messageTemplate: {
        findMany: async (a: any) => H.templates.filter((t) => matches(t, a.where)),
        findFirst: async (a: any) => H.templates.find((t) => matches(t, a.where)) ?? null,
        create: async (a: any) => { const t = { id: `t${++H.seq}`, metaTemplateId: null, rejectionReason: null, headerType: null, headerContent: null, ...a.data }; H.templates.push(t); return t; },
        update: async (a: any) => { const t = H.templates.find((x) => x.id === a.where.id); Object.assign(t, a.data); return t; },
      },
    },
  };
});

import templatesRouter from "../routes/templates";
const app = express();
app.use(express.json());
app.use("/api/templates", templatesRouter);

beforeEach(() => {
  H.seq = 0; H.locale = "he"; H.fetches = []; H.metaPages = []; H.voiceInUse = false; H.voiceWhere = null;
  vi.stubEnv("VOICE_PUBLIC_URL", "https://voice.example.co.il");
  H.accounts = [
    { id: "ca1", tenantId: "T", channel: "WHATSAPP", connectionStatus: "CONNECTED", isActive: true, credentials: "enc" },
    { id: "ca2", tenantId: "T", channel: "WHATSAPP", connectionStatus: "PENDING", isActive: true, credentials: "enc" },
    { id: "theirs", tenantId: "OTHER", channel: "WHATSAPP", connectionStatus: "CONNECTED", isActive: true, credentials: "enc" },
  ];
  H.templates = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    H.fetches.push({ url, init });
    if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "meta-777", status: "PENDING" }) };
    const page = H.metaPages.shift() ?? { data: [] };
    return { ok: true, status: 200, json: async () => page };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const getRequired = (acc = "ca1") => request(app).get(`/api/templates/required?channelAccountId=${acc}`);
const save = (body: any) => request(app).post("/api/templates/required").send({ channelAccountId: "ca1", role: "reopen", language: "he", ...body });

describe("GET /required", () => {
  it("★ both roles in the workspace's language, missing, with the suggested Hebrew text", async () => {
    const r = await getRequired();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ channelAccountId: "ca1", connectionStatus: "CONNECTED", canSubmit: true, languages: ["he"] });
    expect(r.body.data.items.map((i: any) => [i.role, i.name, i.language, i.state])).toEqual([
      ["reopen", "gotcha_reopen", "he", "missing"],
      ["followup", "gotcha_followup", "he", "missing"],
    ]);
    expect(r.body.data.items[0].body).toMatch(/^היי \{\{1\}\}/);
    expect(r.body.data.items[0].buttons).toEqual([{ type: "QUICK_REPLY", text: "להמשך השיחה" }]);
  });

  it("an English workspace gets English", async () => {
    H.locale = "en";
    const r = await getRequired();
    expect(r.body.data.languages).toEqual(["en"]);
    expect(r.body.data.items[1].body).toMatch(/didn't hear back/);
  });

  it("★ ?language=he on an English workspace: Hebrew items, default still reported as en", async () => {
    H.locale = "English";
    const r = await request(app).get("/api/templates/required?channelAccountId=ca1&language=he");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ languages: ["he"], defaultLanguage: "en" });
    expect(r.body.data.items.map((i: any) => [i.role, i.language, i.state])).toEqual([["reopen", "he", "missing"], ["followup", "he", "missing"]]);
    expect(r.body.data.items[0].body).toMatch(/^היי \{\{1\}\}/);
  });

  it("without ?language the default is unchanged; an existing row in the other language is not this one", async () => {
    H.locale = "English";
    H.templates = [{ id: "x1", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca1", name: "gotcha_reopen", language: "en", status: "APPROVED" }];
    const en = await getRequired();
    expect(en.body.data).toMatchObject({ languages: ["en"], defaultLanguage: "en" });
    expect(en.body.data.items[0]).toMatchObject({ language: "en", state: "approved", templateId: "x1" });
    const he = await request(app).get("/api/templates/required?channelAccountId=ca1&language=he");
    expect(he.body.data.items[0]).toMatchObject({ language: "he", state: "missing", templateId: null });
  });

  it("a language other than he|en is 400 BAD_LANGUAGE", async () => {
    for (const q of ["fr", "HE", ""]) {
      const r = await request(app).get(`/api/templates/required?channelAccountId=ca1&language=${q}`);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("BAD_LANGUAGE");
    }
  });

  it("the state of this number's row, else an unbound one; another number's is not it", async () => {
    H.templates = [
      { id: "a", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca1", name: "gotcha_reopen", language: "he", status: "APPROVED", body: "x", buttons: [] },
      { id: "b", tenantId: "T", channel: "WHATSAPP", channelAccountId: null, name: "gotcha_followup", language: "he", status: "REJECTED", rejectionReason: "[PAUSED] Low quality", body: "y", buttons: [] },
      { id: "c", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca2", name: "gotcha_followup", language: "he", status: "APPROVED", body: "z", buttons: [] },
    ];
    const items = (await getRequired()).body.data.items;
    expect(items.map((i: any) => [i.role, i.state, i.templateId, i.reason])).toEqual([
      ["reopen", "approved", "a", null],
      ["followup", "rejected", "b", "[PAUSED] Low quality"],
    ]);
  });

  it("★ this number's own row wins over an unbound one of the same role and language", async () => {
    H.templates = [
      { id: "unbound1", tenantId: "T", channel: "WHATSAPP", channelAccountId: null, name: "gotcha_reopen", language: "he", status: "REJECTED", body: "u", buttons: [] },
      { id: "mine", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca1", name: "gotcha_reopen", language: "he", status: "APPROVED", body: "m", buttons: [] },
      { id: "unbound2", tenantId: "T", channel: "WHATSAPP", channelAccountId: null, name: "gotcha_reopen", language: "he", status: "DRAFT", body: "v", buttons: [] },
    ];
    const items = (await getRequired()).body.data.items;
    expect(items[0]).toMatchObject({ role: "reopen", templateId: "mine", state: "approved" });
  });

  it("a number still connecting cannot submit yet; another tenant's number is 404", async () => {
    expect((await getRequired("ca2")).body.data.canSubmit).toBe(false);
    expect((await getRequired("theirs")).status).toBe(404);
  });
});

describe("POST /required", () => {
  it("★ saves a DRAFT on this number, nothing sent to Meta", async () => {
    const r = await save({});
    expect(r.status).toBe(201);
    expect(r.body.submitted).toBe(false);
    expect(H.templates).toHaveLength(1);
    expect(H.templates[0]).toMatchObject({ tenantId: "T", channelAccountId: "ca1", name: "gotcha_reopen", language: "he", category: "UTILITY", status: "DRAFT", variables: [{ key: "1", sample: "דנה" }] });
    expect(H.fetches).toHaveLength(0);
  });

  it("an edit replaces the text of the same draft, not a second row", async () => {
    await save({});
    const r = await save({ body: "שלום {{1}}, חזרנו אליך. אפשר להמשיך כאן.", button: null });
    expect(r.status).toBe(200);
    expect(H.templates).toHaveLength(1);
    expect(H.templates[0]).toMatchObject({ body: "שלום {{1}}, חזרנו אליך. אפשר להמשיך כאן.", buttons: [] });
  });

  it("an approved or pending one is not changed here", async () => {
    H.templates = [{ id: "a", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca1", name: "gotcha_reopen", language: "he", status: "PENDING_APPROVAL", body: "x" }];
    const r = await save({ body: "new" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ALREADY_SUBMITTED");
    expect(H.templates[0].body).toBe("x");
  });

  it("★ submit on a number still connecting: saved, 409, nothing sent", async () => {
    const r = await save({ channelAccountId: "ca2", submit: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("NUMBER_NOT_CONNECTED");
    expect(H.templates).toHaveLength(1);
    expect(H.fetches).toHaveLength(0);
  });

  it("submit on a connected number goes through the one submit path (stubbed Meta)", async () => {
    const r = await save({ submit: true });
    expect(r.status).toBe(200);
    expect(r.body.submitted).toBe(true);
    const post = H.fetches.find((f) => f.init?.method === "POST")!;
    expect(post.url).toMatch(/\/waba1\/message_templates$/);
    const payload = JSON.parse(post.init.body);
    expect(payload).toMatchObject({ name: "gotcha_reopen", category: "UTILITY", language: "he" });
    expect(H.templates[0]).toMatchObject({ status: "PENDING_APPROVAL", metaTemplateId: "meta-777" });
  });

  it("★ Hebrew on an English workspace: saved and submitted in he, beside an approved en row of the same name", async () => {
    H.locale = "English";
    H.templates = [{ id: "x1", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca1", name: "gotcha_reopen", language: "en", status: "APPROVED", body: "Hi {{1}}" }];
    const r = await save({ language: "he", submit: true });
    expect(r.status).toBe(200);
    expect(r.body.submitted).toBe(true);
    const payload = JSON.parse(H.fetches.find((f) => f.init?.method === "POST")!.init.body);
    expect(payload).toMatchObject({ name: "gotcha_reopen", language: "he" });
    expect(H.templates).toHaveLength(2);
    expect(H.templates.find((t) => t.language === "he")).toMatchObject({ status: "PENDING_APPROVAL", body: expect.stringMatching(/^היי/) });
    expect(H.templates.find((t) => t.id === "x1")).toMatchObject({ language: "en", status: "APPROVED", body: "Hi {{1}}" });
  });

  it("refuses an unknown role, a bad language, an empty body", async () => {
    expect((await save({ role: "promo" })).body.code).toBe("UNKNOWN_ROLE");
    expect((await save({ language: "fr" })).body.code).toBe("BAD_LANGUAGE");
    expect((await save({ body: "   " })).body.code).toBe("BAD_BODY");
    expect(H.templates).toHaveLength(0);
  });
});

describe("POST /sync: read the number's templates from Meta", () => {
  it("★ updates known rows, adds new ones, follows paging, maps PAUSED; writes nothing to Meta", async () => {
    H.templates = [{ id: "a", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca1", name: "gotcha_reopen", language: "he", status: "PENDING_APPROVAL", category: "UTILITY", metaTemplateId: null, body: "x" }];
    H.metaPages = [
      { data: [{ id: "m1", name: "gotcha_reopen", language: "he", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "x" }] }], paging: { next: "https://graph.facebook.com/next-page" } },
      { data: [
        { id: "m2", name: "order_update", language: "en", status: "PAUSED", category: "UTILITY", rejected_reason: "NONE", components: [{ type: "HEADER", format: "TEXT", text: "Order {{1}}" }, { type: "BODY", text: "Your order shipped" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://x/{{1}}" }] }] },
        { id: "m3", name: "odd", language: "en", status: "LIMIT_EXCEEDED" },
      ] },
    ];
    const r = await request(app).post("/api/templates/sync").send({ channelAccountId: "ca1" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ seen: 3, created: 1, updated: 1, skipped: 1 });
    expect(H.templates.find((t) => t.id === "a")).toMatchObject({ status: "APPROVED", metaTemplateId: "m1", rejectionReason: null });
    expect(H.templates.find((t) => t.name === "order_update")).toMatchObject({
      channelAccountId: "ca1", status: "REJECTED", rejectionReason: "[PAUSED]", body: "Your order shipped", headerType: "TEXT", headerContent: "Order {{1}}",
      buttons: [{ type: "URL", text: "Track", url: "https://x/{{1}}" }],
    });
    expect(H.fetches.every((f) => !f.init?.method || f.init.method === "GET")).toBe(true);
    expect(H.fetches[1].url).toBe("https://graph.facebook.com/next-page");
  });

  it("a number that is not connected cannot be read", async () => {
    const r = await request(app).post("/api/templates/sync").send({ channelAccountId: "ca2" });
    expect(r.status).toBe(409);
    expect(H.fetches).toHaveLength(0);
  });
});

describe("missed_call: required only while a voice number uses it (B1)", () => {
  const CB = "https://voice.example.co.il/api/voice-copilot/callbacks/click/";

  it("★ not listed while no voice number forwards to an agent and calls back agent-first", async () => {
    const r = await getRequired();
    expect(r.body.data.items.map((i: any) => i.role)).toEqual(["reopen", "followup"]);
    // The question asked is exactly those two modes, in this tenant.
    expect(H.voiceWhere).toMatchObject({ inboundMode: "FORWARD_TO_AGENT", outboundMode: "AGENT_FIRST", parent: { tenantId: "T" } });
  });

  it("★ listed while in use: conditional, Hebrew, with the callback URL button", async () => {
    H.voiceInUse = true;
    const items = (await getRequired()).body.data.items;
    expect(items.map((i: any) => [i.role, i.conditional])).toEqual([["reopen", false], ["followup", false], ["missed_call", true]]);
    const m = items[2];
    expect(m).toMatchObject({ name: "missed_call_callback", language: "he", state: "missing", category: "UTILITY" });
    expect(m.body).toMatch(/^\{\{1\}\} ניסה ליצור איתך קשר/);
    expect(m.buttons).toEqual([{ type: "URL", text: "להתקשר בחזרה", url: `${CB}{{1}}`, example: `${CB}examplepayload.examplesignature` }]);
  });

  it("★ approving it saves a DRAFT with the URL button; nothing reaches Meta", async () => {
    H.voiceInUse = true;
    const r = await save({ role: "missed_call", button: null });
    expect(r.status).toBe(201);
    expect(H.templates[0]).toMatchObject({ name: "missed_call_callback", status: "DRAFT", variables: [{ key: "1", sample: "דנה כהן" }] });
    // The button cannot be removed: the template exists for it.
    expect(H.templates[0].buttons).toEqual([{ type: "URL", text: "להתקשר בחזרה", url: `${CB}{{1}}`, example: `${CB}examplepayload.examplesignature` }]);
    expect(H.fetches).toHaveLength(0);
  });

  it("★ submitted by the person: the URL button carries Meta's required example", async () => {
    H.voiceInUse = true;
    const r = await save({ role: "missed_call", submit: true });
    expect(r.status).toBe(200);
    const payload = JSON.parse(H.fetches.find((f) => f.init?.method === "POST")!.init.body);
    const buttons = payload.components.find((c: any) => c.type === "BUTTONS").buttons;
    expect(buttons).toEqual([{ type: "URL", text: "להתקשר בחזרה", url: `${CB}{{1}}`, example: [`${CB}examplepayload.examplesignature`] }]);
  });

  it("no public voice address in production: 409 VOICE_PUBLIC_URL_MISSING, nothing saved", async () => {
    vi.stubEnv("VOICE_PUBLIC_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    const r = await save({ role: "missed_call" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("VOICE_PUBLIC_URL_MISSING");
    expect(H.templates).toHaveLength(0);
  });
});

describe("website_handoff: required only on the number the widget's \"leave your number\" uses, while on (W2)", () => {
  const webchat = (wa: any) => ({ id: "wc1", tenantId: "T", channel: "WEBCHAT", connectionStatus: "CONNECTED", isActive: true, credentials: { v: 2, ux: { whatsapp: wa } } });
  const HE = "שלום, תודה שפניתם אלינו באתר. אפשר להמשיך כאן את השיחה בוואטסאפ: כתבו לנו, ונשמח לעזור מאותה נקודה.";
  const EN = "Hello, thank you for contacting us on our website. You can continue the conversation here on WhatsApp: write to us and we'll gladly pick up from the same point.";

  it("★ not listed while the option is off, on another number, or the handoff itself is off", async () => {
    for (const wa of [
      { enabled: true, channelAccountId: "ca1", phoneHandoff: false },
      { enabled: true, channelAccountId: "ca2", phoneHandoff: true },
      { enabled: false, channelAccountId: "ca1", phoneHandoff: true },
    ]) {
      H.accounts.push(webchat(wa));
      expect((await getRequired()).body.data.items.map((i: any) => i.role)).toEqual(["reopen", "followup"]);
      H.accounts.pop();
    }
  });

  it("★ listed while on for this number: conditional, Omer's exact Hebrew wording, the quick-reply button, no variables", async () => {
    H.accounts.push(webchat({ enabled: true, channelAccountId: "ca1", phoneHandoff: true }));
    const items = (await getRequired()).body.data.items;
    expect(items.map((i: any) => [i.role, i.conditional])).toEqual([["reopen", false], ["followup", false], ["website_handoff", true]]);
    expect(items[2]).toMatchObject({ name: "website_chat_handoff", language: "he", category: "UTILITY", state: "missing", body: HE, buttons: [{ type: "QUICK_REPLY", text: "להמשך השיחה" }] });
  });

  it("★ no dead end: a REJECTED template stays listed with its reason after the option is switched off", async () => {
    H.accounts.push(webchat({ enabled: true, channelAccountId: "ca1", phoneHandoff: false }));
    H.templates = [{ id: "x9", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca1", name: "website_chat_handoff", language: "he", status: "REJECTED", rejectionReason: "INVALID_FORMAT", body: HE, buttons: [] }];
    const item = (await getRequired()).body.data.items.find((i: any) => i.role === "website_handoff");
    expect(item).toMatchObject({ state: "rejected", reason: "INVALID_FORMAT", templateId: "x9" });
  });

  it("another number's template does not list it here", async () => {
    H.templates = [{ id: "x9", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca2", name: "website_chat_handoff", language: "he", status: "REJECTED" }];
    expect((await getRequired()).body.data.items.map((i: any) => i.role)).toEqual(["reopen", "followup"]);
  });

  it("an English workspace gets the matching English wording", async () => {
    H.locale = "en";
    H.accounts.push(webchat({ enabled: true, channelAccountId: "ca1", phoneHandoff: true }));
    const item = (await getRequired()).body.data.items[2];
    expect(item).toMatchObject({ body: EN, buttons: [{ type: "QUICK_REPLY", text: "Continue the chat" }] });
  });

  it("★ approved by the person: a DRAFT with the button, which cannot be removed (it carries the code); nothing reaches Meta", async () => {
    H.accounts.push(webchat({ enabled: true, channelAccountId: "ca1", phoneHandoff: true }));
    const r = await save({ role: "website_handoff", button: null });
    expect(r.status).toBe(201);
    expect(H.templates[0]).toMatchObject({ name: "website_chat_handoff", status: "DRAFT", body: HE, variables: [], channelAccountId: "ca1" });
    expect(H.templates[0].buttons).toEqual([{ type: "QUICK_REPLY", text: "להמשך השיחה" }]);
    expect(H.fetches).toHaveLength(0);
  });

  it("submitted only when the person says so (Meta doubled here)", async () => {
    H.accounts.push(webchat({ enabled: true, channelAccountId: "ca1", phoneHandoff: true }));
    const r = await save({ role: "website_handoff", submit: true });
    expect(r.status).toBe(200);
    const payload = JSON.parse(H.fetches.find((f) => f.init?.method === "POST")!.init.body);
    expect(payload).toMatchObject({ name: "website_chat_handoff", category: "UTILITY", language: "he" });
  });
});
