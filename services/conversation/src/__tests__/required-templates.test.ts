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
    requireRole: () => pass,
    decryptCredentials: () => ({ accessToken: "tok", wabaId: "waba1" }),
    prisma: {
      tenant: { findUnique: async () => ({ defaultLocale: H.locale }) },
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
  H.seq = 0; H.locale = "he"; H.fetches = []; H.metaPages = [];
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
afterEach(() => vi.unstubAllGlobals());

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
