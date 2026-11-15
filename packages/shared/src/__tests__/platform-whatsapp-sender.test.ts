/**
 * GOTCHA's own WhatsApp alerts number (2026-11-15): which number is in effect,
 * which inbound ids are ours, and the template rows behind the console.
 *
 *   - the console's row (CONNECTED / PENDING_WEBHOOK) wins over env; a
 *     DISCONNECTED or TOKEN_INVALID row falls back to env; none is null
 *   - inbound recognises both ids during a switch
 *   - a missing table or a down Redis never blocks a send
 *   - a dead token marks the row TOKEN_INVALID
 *   - seeding never overwrites an edited body; Meta pausing a template
 *     switches its alert off; the body rules Meta enforces
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  row: null as any,
  templates: [] as any[],
  tableMissing: false,
  redisReady: true,
  redisHangs: false,
  version: "1",
  reads: 0,
  redisGets: 0,
  audits: [] as any[],
  updates: [] as any[],
}));

vi.mock("../lib/redis", () => ({
  getRedis: () => ({
    get status() { return H.redisReady ? "ready" : "reconnecting"; },
    get: async () => { H.redisGets++; return H.redisHangs ? new Promise(() => undefined) : H.version; },
    incr: async () => { H.version = String(Number(H.version) + 1); return Number(H.version); },
  }),
}));
vi.mock("../lib/audit", () => ({
  writeAudit: async (e: any) => { H.audits.push(e); },
  AuditAction: { PLATFORM_WHATSAPP_ALERT_AUTO_DISABLED: "platform_whatsapp.alert_auto_disabled" },
}));
vi.mock("../lib/prisma", () => {
  const match = (r: any, w: any): boolean => Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((x: any) => match(r, x));
    if (v && typeof v === "object" && "in" in v) return v.in.includes(r[k]);
    return r[k] === v;
  });
  return {
    prisma: {
      platformWhatsAppSender: {
        findUnique: async () => { H.reads++; if (H.tableMissing) throw Object.assign(new Error("relation \"platform_whatsapp_senders\" does not exist"), { code: "P2021" }); return H.row; },
        update: async ({ data }: any) => { H.updates.push(data); Object.assign(H.row, data); return H.row; },
        updateMany: async ({ where, data }: any) => {
          if (!H.row || (where.status?.in && !where.status.in.includes(H.row.status))) return { count: 0 };
          H.updates.push(data); Object.assign(H.row, data); return { count: 1 };
        },
      },
      platformWhatsAppTemplate: {
        count: async ({ where }: any) => H.templates.filter((t) => match(t, where)).length,
        findMany: async (a: any) => H.templates.filter((t) => match(t, a?.where)),
        upsert: async ({ where, create, update }: any) => {
          const k = where.eventType_language;
          const t = H.templates.find((x) => x.eventType === k.eventType && x.language === k.language);
          if (t) { Object.assign(t, update); return t; }
          const n = { id: `t${H.templates.length}`, status: "NOT_SUBMITTED", rejectedReason: null, metaTemplateId: null, draftBody: null, ...create };
          H.templates.push(n); return n;
        },
        update: async ({ where, data }: any) => { const t = H.templates.find((x) => x.id === where.id); Object.assign(t, data); return t; },
      },
    },
  };
});

import { encryptCredentials } from "../lib/encryption";
import {
  resolvePlatformWhatsAppSender,
  isPlatformPhoneNumberId,
  isPlatformWaba,
  markPlatformTokenInvalid,
  isMetaTokenError,
  platformTemplateSendable,
  clearPlatformSenderCache,
  readPlatformSenderRow,
  bumpPlatformSenderVersion,
} from "../whatsapp/platform-sender";
import {
  seedPlatformTemplateRows,
  applyPlatformTemplateStatus,
  metaTemplateStatus,
  platformBodyProblem,
  buildPlatformTemplateViews,
} from "../whatsapp/platform-store";
import { platformTemplateCatalogue } from "../whatsapp/platform-templates";

const ENV = { PLATFORM_WHATSAPP_PHONE_NUMBER_ID: "pn_env", PLATFORM_WHATSAPP_ACCESS_TOKEN: "tok_env" } as any;
const row = (o: any = {}) => ({
  id: "platform", status: "CONNECTED", wabaId: "waba_p", phoneNumberId: "pn_db",
  credentials: encryptCredentials({ accessToken: "tok_db", pin: "482913" }), alertsEnabled: {}, ...o,
});

beforeEach(() => {
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
  H.row = null; H.templates = []; H.tableMissing = false; H.redisReady = true; H.redisHangs = false;
  H.version = "1"; H.reads = 0; H.redisGets = 0; H.audits = []; H.updates = [];
  clearPlatformSenderCache();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("which number sends", () => {
  it("a CONNECTED row wins over env", async () => {
    H.row = row();
    expect(await resolvePlatformWhatsAppSender(ENV)).toEqual({ externalId: "pn_db", accessToken: "tok_db", wabaId: "waba_p", source: "db" });
  });
  it("PENDING_WEBHOOK still sends from the row", async () => {
    H.row = row({ status: "PENDING_WEBHOOK" });
    expect((await resolvePlatformWhatsAppSender(ENV))?.source).toBe("db");
  });
  it.each(["DISCONNECTED", "TOKEN_INVALID"])("%s falls back to env", async (status) => {
    H.row = row({ status });
    expect(await resolvePlatformWhatsAppSender(ENV)).toEqual({ externalId: "pn_env", accessToken: "tok_env", wabaId: null, source: "env" });
  });
  it("no row and no env: null", async () => {
    expect(await resolvePlatformWhatsAppSender({} as any)).toBeNull();
  });
  it("a row with no token (credentials cleared) falls back to env", async () => {
    H.row = row({ credentials: null });
    expect((await resolvePlatformWhatsAppSender(ENV))?.source).toBe("env");
  });
  it("the table not migrated yet: env, no throw", async () => {
    H.tableMissing = true;
    expect((await resolvePlatformWhatsAppSender(ENV))?.source).toBe("env");
    expect(await resolvePlatformWhatsAppSender({} as any)).toBeNull();
  });
});

describe("the cache", () => {
  it("one read within 30s at the same version; a bump re-reads", async () => {
    H.row = row();
    await readPlatformSenderRow(1_000);
    await readPlatformSenderRow(20_000);
    expect(H.reads).toBe(1);
    H.version = "2"; // another process wrote
    await readPlatformSenderRow(21_000);
    expect(H.reads).toBe(2);
    await readPlatformSenderRow(52_000); // 31s later
    expect(H.reads).toBe(3);
  });
  it("this process's own bump clears it at once", async () => {
    H.row = row();
    await readPlatformSenderRow();
    await bumpPlatformSenderVersion();
    await readPlatformSenderRow();
    expect(H.reads).toBe(2);
  });
  it("Redis down or hanging never blocks: the row is still read", async () => {
    H.row = row();
    H.redisReady = false;
    expect((await resolvePlatformWhatsAppSender(ENV))?.source).toBe("db");
    expect(H.redisGets).toBe(0); // a disconnected client is not even asked (it would queue forever)
    clearPlatformSenderCache();
    H.redisReady = true; H.redisHangs = true;
    const t0 = Date.now();
    expect((await resolvePlatformWhatsAppSender(ENV))?.source).toBe("db");
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("inbound: which ids are ours", () => {
  it("both the row's and the env's during a switch", async () => {
    H.row = row();
    expect(await isPlatformPhoneNumberId("pn_db", ENV)).toBe(true);
    expect(await isPlatformPhoneNumberId("pn_env", ENV)).toBe(true);
    expect(await isPlatformPhoneNumberId("pn_tenant", ENV)).toBe(false);
    expect(await isPlatformPhoneNumberId("", ENV)).toBe(false);
  });
  it("a TOKEN_INVALID row's id is still ours (a tap must not reach a tenant); a DISCONNECTED one is not", async () => {
    H.row = row({ status: "TOKEN_INVALID" });
    expect(await isPlatformPhoneNumberId("pn_db", {} as any)).toBe(true);
    clearPlatformSenderCache();
    H.row = row({ status: "DISCONNECTED" });
    expect(await isPlatformPhoneNumberId("pn_db", {} as any)).toBe(false);
  });
  it("the WABA", async () => {
    H.row = row();
    expect(await isPlatformWaba("waba_p")).toBe(true);
    expect(await isPlatformWaba("waba_sales")).toBe(false);
    expect(await isPlatformWaba(null)).toBe(false);
  });
});

describe("a dead token", () => {
  it("190 (and 102, and subcodes 463/467) in every error shape", () => {
    expect(isMetaTokenError({ response: { data: { error: { code: 190 } } } })).toBe(true);
    expect(isMetaTokenError({ provider: { code: 190, subcode: 463 } })).toBe(true);
    expect(isMetaTokenError({ code: 102 })).toBe(true);
    expect(isMetaTokenError({ provider: { code: 100, subcode: 467 } })).toBe(true);
    expect(isMetaTokenError({ provider: { code: 131026 } })).toBe(false);
    expect(isMetaTokenError(new Error("timeout"))).toBe(false);
  });
  it("marks the row TOKEN_INVALID with a coded error; anything else changes nothing", async () => {
    H.row = row();
    expect(await markPlatformTokenInvalid({ provider: { code: 131026, message: "undeliverable" } })).toBe(false);
    expect(H.row.status).toBe("CONNECTED");
    expect(await markPlatformTokenInvalid({ provider: { code: 190, message: "[190] Session has expired" } })).toBe(true);
    expect(H.row.status).toBe("TOKEN_INVALID");
    expect(H.row.lastError).toBe("[TOKEN_INVALID] [190] Session has expired");
  });
});

describe("may a template send", () => {
  const approved = (eventType: string, langs = ["he", "en"]) => langs.forEach((language) => H.templates.push({ eventType, language, status: "APPROVED" }));
  it("env source: every template, as before the console", async () => {
    expect(await platformTemplateSendable("credit.exhausted", "credit.exhausted", "env")).toEqual({ ok: true });
  });
  it("db source: the alert on AND both languages APPROVED", async () => {
    H.row = row({ alertsEnabled: { "credit.exhausted": true } });
    approved("credit.exhausted", ["he"]);
    expect(await platformTemplateSendable("credit.exhausted", "credit.exhausted", "db")).toEqual({ ok: false, reason: "template_not_approved" });
    approved("credit.exhausted", ["en"]);
    expect(await platformTemplateSendable("credit.exhausted", "credit.exhausted", "db")).toEqual({ ok: true });
  });
  it("a stale switch never sends: approved but off", async () => {
    H.row = row({ alertsEnabled: { "credit.exhausted": false } });
    approved("credit.exhausted");
    expect(await platformTemplateSendable("credit.exhausted", "credit.exhausted", "db")).toEqual({ ok: false, reason: "alert_disabled" });
  });
  it("verification has no switch: approved is enough", async () => {
    H.row = row();
    approved("verification");
    expect(await platformTemplateSendable("verification", null, "db")).toEqual({ ok: true });
  });
});

describe("template rows", () => {
  it("seeding creates 16 rows from code and never overwrites an edited body", async () => {
    await seedPlatformTemplateRows();
    expect(H.templates).toHaveLength(16);
    const t = H.templates.find((x) => x.eventType === "credit.exhausted" && x.language === "he");
    t.body = "edited and submitted";
    await seedPlatformTemplateRows();
    expect(H.templates).toHaveLength(16);
    expect(t.body).toBe("edited and submitted");
  });
  it("Meta's status words", () => {
    expect(metaTemplateStatus("REINSTATED")).toBe("APPROVED");
    expect(metaTemplateStatus("PAUSED")).toBe("PAUSED");
    expect(metaTemplateStatus("DELETED")).toBe("NOT_SUBMITTED");
    expect(metaTemplateStatus("FLAGGED")).toBeNull();
  });
  it("Meta pausing a template turns its alert off, audited; approval does not", async () => {
    await seedPlatformTemplateRows();
    H.row = row({ alertsEnabled: { "conversation.waiting": true, "credit.low": true } });
    await applyPlatformTemplateStatus({ name: "gotcha_customer_waiting", language: "en", metaTemplateId: "m1", status: "APPROVED", source: "webhook" });
    expect(H.row.alertsEnabled["conversation.waiting"]).toBe(true);
    await applyPlatformTemplateStatus({ name: "gotcha_customer_waiting", language: "he", metaTemplateId: "m2", status: "PAUSED", rejectedReason: "LOW_QUALITY", source: "webhook" });
    expect(H.row.alertsEnabled["conversation.waiting"]).toBe(false);
    const he = H.templates.find((x) => x.eventType === "conversation.waiting" && x.language === "he");
    expect(he).toMatchObject({ status: "PAUSED", rejectedReason: "LOW_QUALITY", metaTemplateId: "m2" });
    expect(H.audits).toEqual([expect.objectContaining({ tenantId: "platform", action: "platform_whatsapp.alert_auto_disabled", targetId: "conversation.waiting" })]);
  });
  it("the review variant's rejection turns off the approval alert it shares", async () => {
    await seedPlatformTemplateRows();
    H.row = row({ alertsEnabled: { "tool.approval_required": true } });
    await applyPlatformTemplateStatus({ name: "gotcha_approval_required", language: "en_US", metaTemplateId: null, status: "REJECTED", source: "sync" });
    expect(H.row.alertsEnabled["tool.approval_required"]).toBe(false);
  });
  it("by Meta's id, the English status never lands on the Hebrew row", async () => {
    await seedPlatformTemplateRows();
    await applyPlatformTemplateStatus({ name: "gotcha_credit_low", language: "en", metaTemplateId: "e1", status: "APPROVED", source: "webhook" });
    const byLang = Object.fromEntries(H.templates.filter((x) => x.name === "gotcha_credit_low").map((x) => [x.language, x.status]));
    expect(byLang).toEqual({ he: "NOT_SUBMITTED", en: "APPROVED" });
  });
  it("the view: eight in order, both languages, canEnable only when connected and both approved", async () => {
    await seedPlatformTemplateRows();
    H.templates.filter((x) => x.eventType === "credit.exhausted").forEach((x) => (x.status = "APPROVED"));
    const v = buildPlatformTemplateViews(H.templates, row());
    expect(v.map((x) => x.eventType)).toEqual(platformTemplateCatalogue().map((d) => d.eventType));
    expect(v).toHaveLength(8);
    expect(v.find((x) => x.eventType === "credit.exhausted")!.canEnable).toBe(true);
    expect(v.find((x) => x.eventType === "credit.threshold")!.canEnable).toBe(false);
    expect(buildPlatformTemplateViews(H.templates, row({ status: "DISCONNECTED" })).find((x) => x.eventType === "credit.exhausted")!.canEnable).toBe(false);
    const ver = v.find((x) => x.eventType === "verification")!;
    expect(ver).toMatchObject({ toggleable: false, editable: false, category: "AUTHENTICATION", alertEnabled: true });
    expect(v.find((x) => x.eventType === "tool.approval_required.review")).toMatchObject({ toggleable: false, editable: true });
  });
});

describe("body rules", () => {
  it("every code default passes", () => {
    for (const d of platformTemplateCatalogue().filter((x) => x.editable)) {
      for (const l of ["he", "en"] as const) expect(platformBodyProblem(d.body[l], d.parameterCount), `${d.eventType} ${l}`).toBeNull();
    }
  });
  it.each([
    ["Hi {{1}} and {{2}} here.", 1],
    ["Hi there, nothing here.", 1],
    ["Hi {{1}} and {{1}} again.", 2],
    ["Hi {{2}} and {{3}} here.", 2],
    ["{{1}} starts it.", 1],
    ["It ends with {{1}}.", 1],
    ["Hi {{name}} and {{1}} here.", 1],
    ["   ", 0],
    ["A {{1}} in a template with none.", 0],
  ])("%j with %i variables is refused", (body, n) => {
    expect(platformBodyProblem(body, n as number)).not.toBeNull();
  });
  it("valid ones pass", () => {
    expect(platformBodyProblem("Waiting {{1}} minutes on {{2}} now.", 2)).toBeNull();
    expect(platformBodyProblem("No variables at all.", 0)).toBeNull();
  });
});
