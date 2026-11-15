/**
 * The SYSTEM_ADMIN console for GOTCHA's own WhatsApp alerts number
 * (2026-11-15), through the real router and the real shared store; only
 * Graph (axios), Postgres and Redis are doubled. Dev E2E uses fakes only: no
 * real number is connected anywhere by these tests.
 *
 *   - connect refuses a workspace's number (the GOTCHA sales number's shape,
 *     active or not) and a WABA a workspace uses; one number only
 *   - the PIN is random, never 000000, and stored encrypted; no response or
 *     log carries the token or the PIN
 *   - a failed subscribe is PENDING_WEBHOOK
 *   - every route is SYSTEM_ADMIN only
 *   - template edit rules, the verification template is not editable
 *   - an alert switches on only with both languages APPROVED and a number
 *   - disconnect unlinks locally; deregister only when asked
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.META_APP_ID = "app_1";
  process.env.META_APP_SECRET = "secret_1";
  process.env.FRONTEND_URL = "https://app.example.test";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
  delete process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN;
});
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } async del() { return 0; } } }));

const TOKEN = "PLANTED_platform_business_token_123";
const H = vi.hoisted(() => ({
  role: "SYSTEM_ADMIN",
  sender: null as any,
  templates: [] as any[],
  accounts: [] as any[],
  numbers: [] as any[],
  audits: [] as any[],
  graph: [] as Array<[string, string, any]>,
  phones: ["pn_alerts"] as string[],
  scopes: ["waba_alerts"] as string[],
  subscribeFails: false,
  metaCreate: { id: "meta_t1", status: "PENDING" } as any,
  metaFail: null as any,
  listed: [] as any[],
  subscribedApps: [] as any[],
  tokenDead: false,
}));

vi.mock("axios", () => {
  const rec = (m: string, url: string, d: any) => H.graph.push([m, url, d ?? null]);
  const metaErr = (message: string, code = 100) => Object.assign(new Error(message), { response: { data: { error: { message, code } } } });
  return {
    default: {
      get: async (url: string, cfg?: any) => {
        rec("GET", url, cfg?.params);
        if (H.tokenDead) throw metaErr("Session has expired", 190);
        if (url.endsWith("/oauth/access_token")) return { data: { access_token: "PLANTED_platform_business_token_123" } };
        if (url.endsWith("/debug_token")) return { data: { data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: H.scopes }] } } };
        if (url.endsWith("/phone_numbers")) return { data: { data: H.phones.map((id) => ({ id })) } };
        if (url.endsWith("/subscribed_apps")) return { data: { data: H.subscribedApps } };
        if (url.endsWith("/message_templates")) return { data: { data: H.listed } };
        const id = url.split("/").pop();
        return { data: { id, display_phone_number: id === "pn_sales" ? "+972 55-263-3304" : "+972 50-111-2222", verified_name: "GOTCHA", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" } };
      },
      post: async (url: string, data?: any) => {
        rec("POST", url, data);
        if (url.endsWith("/subscribed_apps") && H.subscribeFails) throw metaErr("refused");
        if (url.endsWith("/message_templates") || /\/meta_t\d+$/.test(url)) {
          if (H.metaFail) throw H.metaFail;
          return { data: H.metaCreate };
        }
        return { data: { success: true } };
      },
      delete: async (url: string) => { rec("DELETE", url, null); return { data: { success: true } }; },
    },
  };
});

// One in-memory database for the routes and the shared store alike.
vi.mock("@chatcenter/shared/src/lib/prisma", async (orig) => {
  const actual: any = await orig();
  const match = (r: any, w: any): boolean => Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((x: any) => match(r, x));
    if (v && typeof v === "object" && "in" in v) return v.in.includes(r[k]);
    if (v && typeof v === "object" && "not" in v) return r[k] !== v.not;
    return r[k] === v;
  });
  const pick = (r: any, select: any) => (r && select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r);
  return {
    ...actual,
    prisma: {
      platformWhatsAppSender: {
        findUnique: async () => H.sender,
        upsert: async ({ create, update }: any) => { H.sender = H.sender ? { ...H.sender, ...update } : { alertsEnabled: {}, ...create }; return H.sender; },
        update: async ({ data }: any) => { Object.assign(H.sender, data); return H.sender; },
        updateMany: async ({ data }: any) => { if (!H.sender) return { count: 0 }; Object.assign(H.sender, data); return { count: 1 }; },
      },
      platformWhatsAppTemplate: {
        findMany: async (a: any) => H.templates.filter((t) => match(t, a?.where)),
        findUnique: async ({ where }: any) => H.templates.find((t) => t.eventType === where.eventType_language.eventType && t.language === where.eventType_language.language) ?? null,
        count: async ({ where }: any) => H.templates.filter((t) => match(t, where)).length,
        upsert: async ({ where, create, update }: any) => {
          const k = where.eventType_language;
          const t = H.templates.find((x) => x.eventType === k.eventType && x.language === k.language);
          if (t) { Object.assign(t, update); return t; }
          const n = { id: `t${H.templates.length}`, status: "NOT_SUBMITTED", rejectedReason: null, metaTemplateId: null, draftBody: null, submittedAt: null, lastSyncedAt: null, ...create };
          H.templates.push(n); return n;
        },
        update: async ({ where, data }: any) => {
          const t = where.id ? H.templates.find((x) => x.id === where.id) : H.templates.find((x) => x.eventType === where.eventType_language.eventType && x.language === where.eventType_language.language);
          Object.assign(t, data); return t;
        },
      },
      channelAccount: {
        findFirst: async ({ where, select }: any) => pick(H.accounts.find((a) => match(a, where)) ?? null, select),
        findMany: async ({ where, select }: any) => H.accounts.filter((a) => match(a, where)).map((a) => pick(a, select)),
      },
      whatsAppNumber: {
        findFirst: async ({ where, select }: any) => pick(H.numbers.find((n) => match(n, where)) ?? null, select),
        findMany: async ({ where, select }: any) => H.numbers.filter((n) => match(n, where)).map((n) => pick(n, select)),
      },
      user: { findUnique: async ({ where }: any) => ({ id: where.id, name: "Omer" }) },
      auditLog: { create: async ({ data }: any) => { H.audits.push(data); return data; } },
    },
  };
});
vi.mock("@chatcenter/shared/src/lib/redis", () => ({ closeRedis: async () => undefined, getRedis: () => ({ status: "ready", get: async () => "1", incr: async () => 2, set: async () => "OK", del: async () => 0 }) }));
vi.mock("@chatcenter/shared", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    prisma: (await import("@chatcenter/shared/src/lib/prisma")).prisma,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "admin_1", role: H.role }; n(); },
  };
});

import { encryptCredentials, decryptCredentials, clearPlatformSenderCache } from "@chatcenter/shared";
import router from "../routes/platform-whatsapp";

const app = express();
app.use(express.json());
app.use("/api/system", router);
const api = () => request(app);
const P = "/api/system/platform-whatsapp";
const enc = (s: string) => encodeURIComponent(s);
const logs: string[] = [];

const connected = (o: any = {}) => ({
  id: "platform", status: "CONNECTED", wabaId: "waba_alerts", phoneNumberId: "pn_alerts", displayPhoneNumber: "+972 50-111-2222",
  credentials: encryptCredentials({ accessToken: TOKEN, pin: "719204" }), alertsEnabled: {}, connectedBy: "admin_1", connectedAt: new Date(), ...o,
});
const approve = (eventType: string) => H.templates.filter((t) => t.eventType === eventType).forEach((t) => (t.status = "APPROVED"));

beforeEach(() => {
  H.role = "SYSTEM_ADMIN"; H.sender = null; H.templates = []; H.accounts = []; H.numbers = []; H.audits = []; H.graph = [];
  H.phones = ["pn_alerts"]; H.scopes = ["waba_alerts"]; H.subscribeFails = false; H.metaCreate = { id: "meta_t1", status: "PENDING" };
  H.metaFail = null; H.listed = []; H.subscribedApps = []; H.tokenDead = false;
  clearPlatformSenderCache();
  logs.length = 0;
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: any[]) => { logs.push(a.map(String).join(" ")); });
});

const everyResponseAndLogClean = (bodies: any[]) => {
  const all = JSON.stringify(bodies) + logs.join("\n");
  expect(all).not.toContain(TOKEN);
  const pin = H.sender?.credentials ? decryptCredentials(H.sender.credentials).pin : null;
  if (pin) expect(all).not.toContain(`"${pin}"`);
};

describe("only a SYSTEM_ADMIN", () => {
  it.each([
    ["get", P], ["post", `${P}/connect`], ["post", `${P}/recheck`], ["post", `${P}/disconnect`], ["get", `${P}/templates`],
    ["post", `${P}/templates/sync`], ["put", `${P}/templates/${enc("credit.exhausted")}/he`], ["post", `${P}/templates/${enc("credit.exhausted")}/he/submit`],
    ["put", `${P}/alerts/${enc("credit.exhausted")}`],
  ])("a tenant ADMIN gets 403 on %s %s", async (m, path) => {
    H.role = "ADMIN";
    const r = await (api() as any)[m](path).send({});
    expect(r.status).toBe(403);
    expect(H.graph).toHaveLength(0);
  });
});

describe("status", () => {
  it("nothing connected: DISCONNECTED, source none, the shared ES launch", async () => {
    const r = await api().get(P);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "DISCONNECTED", source: "none", envPresent: false, number: null, lastErrorCode: null });
    expect(r.body.launch).toBeDefined();
  });
  it("connected: source db, the number, who connected it; never a token", async () => {
    H.sender = connected();
    const r = await api().get(P);
    expect(r.body).toMatchObject({ status: "CONNECTED", source: "db", number: { phoneNumberId: "pn_alerts", wabaId: "waba_alerts", display: "+972 50-111-2222" }, connectedBy: { id: "admin_1", name: "Omer" } });
    expect(JSON.stringify(r.body)).not.toContain("credentials");
    everyResponseAndLogClean([r.body]);
  });
  it("env set and a row connected: db, env reported as overridden", async () => {
    process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID = "pn_env"; process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN = "tok_env";
    try {
      H.sender = connected();
      expect((await api().get(P)).body).toMatchObject({ source: "db", envPresent: true });
      H.sender = connected({ status: "TOKEN_INVALID", lastError: "[TOKEN_INVALID] Session has expired" });
      expect((await api().get(P)).body).toMatchObject({ source: "env", status: "TOKEN_INVALID", lastErrorCode: "TOKEN_INVALID", lastError: "Session has expired" });
    } finally {
      delete process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID; delete process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN;
    }
  });
});

describe("connect", () => {
  const connect = (body: any = { code: "c1", wabaId: "waba_alerts", phoneNumberId: "pn_alerts" }) => api().post(`${P}/connect`).send(body);

  it("a new number: CONNECTED, random encrypted PIN (not 000000), 16 template rows, audited", async () => {
    const r = await connect();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "CONNECTED", source: "db", number: { phoneNumberId: "pn_alerts" } });
    const reg = H.graph.find(([m, u]) => m === "POST" && u.endsWith("/pn_alerts/register"))!;
    const creds = decryptCredentials(H.sender.credentials);
    expect(creds.accessToken).toBe(TOKEN);
    expect(creds.pin).toMatch(/^\d{6}$/);
    expect(reg[2]).toEqual({ messaging_product: "whatsapp", pin: creds.pin });
    expect(H.templates).toHaveLength(16);
    expect(H.audits).toEqual([expect.objectContaining({ tenantId: "platform", actorId: "admin_1", action: "platform_whatsapp.connected", targetId: "pn_alerts" })]);
    everyResponseAndLogClean([r.body]);
  });

  it("the PIN differs between connects and is never 000000", async () => {
    const pins = new Set<string>();
    for (let i = 0; i < 6; i++) { H.sender = null; await connect(); pins.add(decryptCredentials(H.sender.credentials).pin); }
    expect(pins.has("000000")).toBe(false);
    expect(pins.size).toBeGreaterThan(1);
  });

  it.each([
    ["an active tenant ChannelAccount", () => H.accounts.push({ id: "ca_sales", tenantId: "gotcha_sales", channel: "WHATSAPP", externalId: "pn_sales", isActive: true, credentials: encryptCredentials({ wabaId: "waba_sales" }) })],
    ["an inactive one", () => H.accounts.push({ id: "ca_sales", tenantId: "gotcha_sales", channel: "WHATSAPP", externalId: "pn_sales", isActive: false, credentials: encryptCredentials({ wabaId: "waba_sales" }) })],
    // No display number on the row, so only the phone id can catch it.
    ["a WhatsAppNumber row", () => H.numbers.push({ id: "n1", tenantId: "gotcha_sales", phoneNumberId: "pn_sales", wabaId: "waba_sales", displayPhoneNumber: null })],
  ])("the GOTCHA sales number on %s: 409 number_belongs_to_workspace, nothing at Meta changed", async (_n, set) => {
    (set as () => void)();
    const r = await connect({ code: "c1", wabaId: "waba_alerts", phoneNumberId: "pn_sales" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("number_belongs_to_workspace");
    expect(H.graph.some(([m, u]) => m === "POST" && (u.endsWith("/register") || u.endsWith("/subscribed_apps")))).toBe(false);
    expect(H.sender).toBeNull();
  });

  it("the sales number by its display number alone (another phone id): still refused", async () => {
    H.numbers.push({ id: "n1", tenantId: "gotcha_sales", phoneNumberId: "pn_other", wabaId: "waba_sales", displayPhoneNumber: "055-263-3304" });
    const r = await connect({ code: "c1", wabaId: "waba_alerts", phoneNumberId: "pn_sales" });
    expect(r.body.error).toBe("number_belongs_to_workspace");
  });

  it("a WABA a workspace uses: 409 waba_belongs_to_workspace", async () => {
    H.accounts.push({ id: "ca_sales", tenantId: "gotcha_sales", channel: "WHATSAPP", externalId: "pn_sales", isActive: true, credentials: encryptCredentials({ wabaId: "waba_sales" }) });
    const r = await connect({ code: "c1", wabaId: "waba_sales", phoneNumberId: "pn_alerts" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("waba_belongs_to_workspace");
  });

  it("several numbers and none chosen: 422 choose_one_number", async () => {
    H.phones = ["pn_alerts", "pn_two"];
    const r = await connect({ code: "c1", wabaId: "waba_alerts" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("choose_one_number");
  });

  it("several WABAs in the token and none chosen: 422", async () => {
    H.scopes = ["waba_a", "waba_b"];
    expect((await connect({ code: "c1" })).body.error).toBe("choose_one_number");
  });

  it("no session ids, one WABA and one number: discovered and connected", async () => {
    const r = await connect({ code: "c1" });
    expect(r.status).toBe(201);
    expect(H.sender).toMatchObject({ wabaId: "waba_alerts", phoneNumberId: "pn_alerts" });
  });

  it("subscribe refused: PENDING_WEBHOOK with SUBSCRIBE_FAILED", async () => {
    H.subscribeFails = true;
    const r = await connect();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "PENDING_WEBHOOK", lastErrorCode: "SUBSCRIBE_FAILED", source: "db" });
  });

  it("a bad code: 400 code_exchange_failed", async () => {
    H.tokenDead = true;
    const r = await connect();
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("code_exchange_failed");
  });

  it("a reconnect keeps the alert switches", async () => {
    H.sender = connected({ status: "DISCONNECTED", credentials: null, alertsEnabled: { "credit.exhausted": true } });
    await connect();
    expect(H.sender.alertsEnabled).toEqual({ "credit.exhausted": true });
    expect(H.sender.status).toBe("CONNECTED");
  });
});

describe("recheck", () => {
  it("our app missing from subscribed_apps: re-subscribes, CONNECTED, limit tier read", async () => {
    H.sender = connected({ status: "PENDING_WEBHOOK" });
    const r = await api().post(`${P}/recheck`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "CONNECTED", number: { messagingLimitTier: "TIER_1K" } });
    expect(H.graph.some(([m, u]) => m === "POST" && u.endsWith("/waba_alerts/subscribed_apps"))).toBe(true);
  });
  it("a dead token: TOKEN_INVALID", async () => {
    H.sender = connected();
    H.tokenDead = true;
    const r = await api().post(`${P}/recheck`);
    expect(r.body).toMatchObject({ status: "TOKEN_INVALID", lastErrorCode: "TOKEN_INVALID" });
  });
  it("nothing connected: 409 no_platform_number", async () => {
    expect((await api().post(`${P}/recheck`)).body.error).toBe("no_platform_number");
  });
});

describe("disconnect", () => {
  it("default: unsubscribe and local unlink, no deregister; token gone; rows kept", async () => {
    H.sender = connected();
    await api().get(`${P}/templates`);
    const r = await api().post(`${P}/disconnect`).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "DISCONNECTED", source: "none" });
    expect(H.sender.credentials).toBeNull();
    expect(H.graph.filter(([m]) => m !== "GET")).toEqual([["DELETE", expect.stringContaining("/waba_alerts/subscribed_apps"), null]]);
    expect(H.templates).toHaveLength(16);
  });
  it("deregister: true also deregisters the number", async () => {
    H.sender = connected();
    await api().post(`${P}/disconnect`).send({ deregister: true });
    expect(H.graph.some(([m, u]) => m === "POST" && u.endsWith("/pn_alerts/deregister"))).toBe(true);
  });
});

describe("templates", () => {
  it("the list: eight, both languages, seeded from code", async () => {
    const r = await api().get(`${P}/templates`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(8);
    expect(r.body.data[0].languages.he.status).toBe("NOT_SUBMITTED");
  });
  it("an edit is a draft; a bad body is 422 with the reason; verification is 405; unknown is 404", async () => {
    const ok = await api().put(`${P}/templates/${enc("credit.threshold")}/he`).send({ body: "נוצלו {{1}} אחוז מהקרדיט שלכם." });
    expect(ok.status).toBe(200);
    expect(ok.body.data.languages.he).toMatchObject({ draftBody: "נוצלו {{1}} אחוז מהקרדיט שלכם.", status: "NOT_SUBMITTED" });
    const bad = await api().put(`${P}/templates/${enc("credit.threshold")}/he`).send({ body: "{{1}} percent used" });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("template_body_invalid");
    expect((await api().put(`${P}/templates/verification/en`).send({ body: "x {{1}} y" })).status).toBe(405);
    expect((await api().put(`${P}/templates/${enc("no.such")}/en`).send({ body: "x {{1}} y" })).status).toBe(404);
    expect((await api().put(`${P}/templates/${enc("credit.threshold")}/fr`).send({ body: "x {{1}} y" })).status).toBe(404);
  });
  it("submit with no number: 409 no_platform_number", async () => {
    expect((await api().post(`${P}/templates/${enc("credit.exhausted")}/en/submit`)).body.error).toBe("no_platform_number");
  });
  it("submit creates at Meta with code's name, category and buttons, then PENDING", async () => {
    H.sender = connected();
    await api().put(`${P}/templates/${enc("conversation.waiting")}/en`).send({ body: "A customer waited {{1}} minutes on {{2}}. Please answer." });
    const r = await api().post(`${P}/templates/${enc("conversation.waiting")}/en/submit`);
    expect(r.status).toBe(200);
    const [, url, data] = H.graph.find(([m, u]) => m === "POST" && u.endsWith("/waba_alerts/message_templates"))!;
    expect(url).toContain("/waba_alerts/message_templates");
    expect(data).toMatchObject({ name: "gotcha_customer_waiting", language: "en", category: "UTILITY" });
    expect(data.components[0]).toMatchObject({ type: "BODY", text: "A customer waited {{1}} minutes on {{2}}. Please answer." });
    expect(data.components[0].example.body_text[0]).toHaveLength(2);
    expect(data.components[1].buttons[0]).toMatchObject({ type: "URL", url: "https://app.example.test/en/inbox?c={{1}}" });
    expect(r.body.data.languages.en).toMatchObject({ status: "PENDING", metaTemplateId: "meta_t1", draftBody: null, body: "A customer waited {{1}} minutes on {{2}}. Please answer." });
  });
  it("the approval template carries its two quick replies; verification its copy-code button", async () => {
    H.sender = connected();
    await api().post(`${P}/templates/${enc("tool.approval_required")}/he/submit`);
    const appr = H.graph.filter(([m, u]) => m === "POST" && u.endsWith("/message_templates")).pop()![2];
    expect(appr.components[1].buttons.map((b: any) => b.type)).toEqual(["QUICK_REPLY", "QUICK_REPLY"]);
    await api().post(`${P}/templates/verification/he/submit`);
    const ver = H.graph.filter(([m, u]) => m === "POST" && u.endsWith("/message_templates")).pop()![2];
    expect(ver).toMatchObject({ name: "gotcha_verification_code", category: "AUTHENTICATION" });
    expect(ver.components.find((c: any) => c.type === "BUTTONS").buttons[0]).toMatchObject({ type: "OTP", otp_type: "COPY_CODE" });
  });
  it("a resubmit edits by Meta's id; Meta's edit limit is 409 meta_edit_limit", async () => {
    H.sender = connected();
    await api().post(`${P}/templates/${enc("credit.exhausted")}/en/submit`);
    H.metaFail = Object.assign(new Error("x"), { response: { data: { error: { code: 100, message: "You can only edit a template once in 24 hours" } } } });
    const r = await api().post(`${P}/templates/${enc("credit.exhausted")}/en/submit`);
    expect(H.graph.some(([m, u]) => m === "POST" && u.endsWith("/meta_t1"))).toBe(true);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("meta_edit_limit");
  });
  it("any other Meta refusal: 502 meta_error with Meta's words", async () => {
    H.sender = connected();
    H.metaFail = Object.assign(new Error("x"), { response: { data: { error: { code: 100, message: "Invalid parameter" } } } });
    const r = await api().post(`${P}/templates/${enc("credit.exhausted")}/en/submit`);
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "meta_error", message: "Meta refused the request.", meta: { code: 100, message: "Invalid parameter" } });
  });
  it("sync maps Meta's status and rejected_reason, ignoring other templates", async () => {
    H.sender = connected();
    H.listed = [
      { id: "m1", name: "gotcha_credit_low", language: "he", status: "APPROVED" },
      { id: "m2", name: "gotcha_credit_low", language: "en", status: "REJECTED", rejected_reason: "INVALID_FORMAT" },
      { id: "m3", name: "shop_promo", language: "he", status: "APPROVED" },
    ];
    const r = await api().post(`${P}/templates/sync`);
    const low = r.body.data.find((v: any) => v.eventType === "credit.threshold");
    expect(low.languages.he).toMatchObject({ status: "APPROVED", metaTemplateId: "m1" });
    expect(low.languages.en).toMatchObject({ status: "REJECTED", rejectedReason: "INVALID_FORMAT" });
    expect(H.templates.some((t) => t.name === "shop_promo")).toBe(false);
  });
});

describe("the alert switch", () => {
  const toggle = (e: string, enabled: boolean) => api().put(`${P}/alerts/${enc(e)}`).send({ enabled });

  it("no number: 409 no_platform_number", async () => {
    expect((await toggle("credit.exhausted", true)).body.error).toBe("no_platform_number");
  });
  it("one language approved: 409 template_not_approved; both: on, audited", async () => {
    H.sender = connected();
    await api().get(`${P}/templates`);
    H.templates.find((t) => t.eventType === "credit.exhausted" && t.language === "he").status = "APPROVED";
    const r1 = await toggle("credit.exhausted", true);
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe("template_not_approved");
    approve("credit.exhausted");
    const r2 = await toggle("credit.exhausted", true);
    expect(r2.status).toBe(200);
    expect(r2.body.data).toMatchObject({ alertEnabled: true, canEnable: true });
    expect(H.sender.alertsEnabled).toEqual({ "credit.exhausted": true });
    expect(H.audits.some((a) => a.action === "platform_whatsapp.alert_toggled" && a.metadata.enabled === true)).toBe(true);
  });
  it("switching off is always allowed", async () => {
    const r = await toggle("credit.exhausted", false);
    expect(r.status).toBe(200);
    expect(r.body.data.alertEnabled).toBe(false);
  });
  it("verification and the review variant have no switch: 404", async () => {
    H.sender = connected();
    expect((await toggle("verification", true)).status).toBe(404);
    expect((await toggle("tool.approval_required.review", true)).status).toBe(404);
  });
});

describe("before the migration", () => {
  it("the table missing: 503 platform_store_unavailable", async () => {
    const { prisma } = await import("@chatcenter/shared/src/lib/prisma");
    const orig = (prisma as any).platformWhatsAppSender.findUnique;
    (prisma as any).platformWhatsAppSender.findUnique = async () => { throw Object.assign(new Error("relation does not exist"), { code: "P2021" }); };
    try {
      const r = await api().get(P);
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("platform_store_unavailable");
    } finally {
      (prisma as any).platformWhatsAppSender.findUnique = orig;
    }
  });
});
