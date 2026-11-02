/**
 * WhatsApp notifications from GOTCHA's own number (2026-11-02).
 *   - personal: on only with a number confirmed by code; per event; quiet hours
 *   - delivery: the event's template, its parameters and link; nothing (and a
 *     reason) without the platform number; never a workspace's number
 *   - the opt-in code: rate limit, tries, expiry, the number must match
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({ kv: new Map<string, string>(), sent: [] as any[], logs: [] as any[], prefs: new Map<string, any>() }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getRedis: () => ({
      set: async (k: string, v: string, ...a: any[]) => { if (a.includes("NX") && H.kv.has(k)) return null; H.kv.set(k, v); return "OK"; },
      get: async (k: string) => H.kv.get(k) ?? null,
      del: async (k: string) => { H.kv.delete(k); return 1; },
      incr: async (k: string) => { const n = Number(H.kv.get(k) ?? 0) + 1; H.kv.set(k, String(n)); return n; },
      expire: async () => 1,
    }),
    getOutboundAdapter: () => ({ sendTemplateMessage: async (...a: any[]) => { H.sent.push(a); return "wamid.1"; } }),
    resolveEffectiveLocale: async () => ({ effective: "he" }),
    prisma: {
      notificationLog: { create: async ({ data }: any) => { H.logs.push(data); return data; } },
      userNotificationPreference: { upsert: async ({ where, create, update }: any) => { const cur = H.prefs.get(where.userId); H.prefs.set(where.userId, cur ? { ...cur, ...update } : create); } },
    },
  };
});

import { personalAllows, PERSONAL_DEFAULTS } from "../services/personal-preferences.service";
import { deliverWhatsAppNotice, wantsWhatsApp } from "../services/whatsapp-notice.service";
import { startVerification, confirmVerification } from "../services/whatsapp-verify.service";

const ME = { userId: "u1", tenantId: "T" };
const env = { id: process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID, tok: process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN };
const platformOn = () => { process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID = "pn_1"; process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN = "tok"; };
beforeEach(() => { H.kv.clear(); H.sent = []; H.logs = []; H.prefs.clear(); delete process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID; delete process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN; });
afterEach(() => { if (env.id) process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID = env.id; if (env.tok) process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN = env.tok; });

describe("personal: who may get WhatsApp", () => {
  const ev = { type: "conversation.waiting", data: {} };
  const on = { ...PERSONAL_DEFAULTS, whatsapp: true, whatsappPhone: "+972521234567", whatsappOptedInAt: new Date() };
  it("on, confirmed, outside quiet hours: yes", () => expect(personalAllows(on, "whatsapp", ev, "12:00")).toBe(true));
  it("on without a confirmed number: no", () => {
    expect(personalAllows({ ...on, whatsappOptedInAt: null }, "whatsapp", ev, "12:00")).toBe(false);
    expect(personalAllows({ ...on, whatsappPhone: null }, "whatsapp", ev, "12:00")).toBe(false);
  });
  it("this event switched off, or quiet hours: no", () => {
    expect(personalAllows({ ...on, events: { "conversation.waiting": { whatsapp: false } } }, "whatsapp", ev, "12:00")).toBe(false);
    expect(personalAllows({ ...on, quietHoursFrom: "22:00", quietHoursTo: "07:00" }, "whatsapp", ev, "23:00")).toBe(false);
  });
  it("which events go out on WhatsApp: templated ones, never the approval request (it has its own buttons)", () => {
    expect(wantsWhatsApp("conversation.waiting")).toBe(true);
    expect(wantsWhatsApp("conversation.escalated")).toBe(true);
    expect(wantsWhatsApp("tool.approval_required")).toBe(false);
    expect(wantsWhatsApp("lead.created")).toBe(false);
  });
});

describe("delivery", () => {
  const event = { type: "conversation.waiting", data: { minutes: 42, channel: "WEBCHAT", conversationId: "c9" }, metadata: { conversationId: "c9" } };
  it("no platform number: skipped with the reason, nothing sent", async () => {
    expect(await deliverWhatsAppNotice({ user: ME, event, phone: "+972521234567" })).toBe("skipped");
    expect(H.sent).toEqual([]);
    expect(H.logs[0]).toMatchObject({ channel: "whatsapp", status: "skipped", error: "no_platform_number" });
  });
  it("with it: the event's template from GOTCHA's number, in the person's language, with the parameters and the link", async () => {
    platformOn();
    expect(await deliverWhatsAppNotice({ user: ME, event, phone: "+972521234567" })).toBe("sent");
    const [creds, from, to, name, locale, components] = H.sent[0];
    expect([creds.accessToken, from, to, name, locale]).toEqual(["tok", "pn_1", "972521234567", "gotcha_customer_waiting", "he"]);
    expect(components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "42" }, { type: "text", text: "צ'אט האתר" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "c9" }] },
    ]);
    expect(H.logs.at(-1)).toMatchObject({ status: "sent", recipient: "+972521234567" });
  });
  it("no confirmed number: skipped", async () => {
    platformOn();
    expect(await deliverWhatsAppNotice({ user: ME, event, phone: null })).toBe("skipped");
  });
});

describe("the opt-in code", () => {
  it("no platform number: unavailable; a bad number: invalid", async () => {
    expect(await startVerification(ME, "+972521234567")).toEqual({ ok: false, code: "whatsapp_unavailable" });
    platformOn();
    expect(await startVerification(ME, "call me")).toEqual({ ok: false, code: "whatsapp_phone_invalid" });
  });
  it("sent by the authentication template; the right code confirms and switches WhatsApp on", async () => {
    platformOn();
    expect(await startVerification(ME, "052-1234567", () => "123456")).toEqual({ ok: true, expiresInSeconds: 600 });
    expect(H.sent[0][3]).toBe("gotcha_verification_code");
    expect(H.sent[0][2]).toBe("972521234567");
    expect(await confirmVerification(ME, "+972521234567", "123456")).toEqual({ ok: true });
    expect(H.prefs.get("u1")).toMatchObject({ whatsappPhone: "+972521234567", whatsapp: true });
    expect(H.prefs.get("u1").whatsappOptedInAt).toBeInstanceOf(Date);
  });
  it("a resend within a minute is refused", async () => {
    platformOn();
    await startVerification(ME, "052-1234567", () => "111111");
    expect(await startVerification(ME, "052-1234567")).toEqual({ ok: false, code: "whatsapp_rate_limited" });
  });
  it("a wrong code, or the code for another number: invalid; five wrong tries: expired", async () => {
    platformOn();
    await startVerification(ME, "052-1234567", () => "123456");
    expect(await confirmVerification(ME, "+972521234567", "000000")).toEqual({ ok: false, code: "whatsapp_code_invalid" });
    expect(await confirmVerification(ME, "+972529999999", "123456")).toEqual({ ok: false, code: "whatsapp_code_invalid" });
    for (let i = 0; i < 3; i++) await confirmVerification(ME, "+972521234567", "000000");
    expect(await confirmVerification(ME, "+972521234567", "123456")).toEqual({ ok: false, code: "whatsapp_code_expired" });
    expect(H.prefs.has("u1")).toBe(false);
  });
  it("no code sent: expired", async () => {
    expect(await confirmVerification(ME, "+972521234567", "123456")).toEqual({ ok: false, code: "whatsapp_code_expired" });
  });
});
