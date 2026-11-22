/**
 * "Leave your number" (W2, 2026-11-22): the widget's one state, the code in the template's button,
 * the limits and the payment signal (lib/whatsapp-phone-handoff.ts), and the stored setting.
 */
import { describe, it, expect, vi } from "vitest";
import {
  waHandoffMode, handoffButtonPayload, handoffRefFromButton, handoffPendingKey, PHONE_HANDOFF_LIMITS, phoneHandoffLimitKeys,
  isPaymentBlockError, paymentBlockedAt, isPaymentBlocked, recordPaymentBlock, clearPaymentBlock, paymentBlockKey, PAYMENT_BLOCK_LAPSE_MS,
  PHONE_HANDOFF_TEMPLATE_NAME, paymentBlockFromStatus,
} from "../lib/whatsapp-phone-handoff";
import { normalizeWhatsapp, defaultWhatsapp } from "../lib/shopify-chat-ux";

const all = { codeAvailable: true, phoneHandoffOn: true, numberConnected: true, templateApproved: true, paymentBlocked: false };

describe("waHandoffMode", () => {
  it("phone only when everything is in place", () => {
    expect(waHandoffMode(all)).toBe("phone");
    expect(waHandoffMode({ ...all, phoneHandoffOn: false })).toBe("code");
    expect(waHandoffMode({ ...all, numberConnected: false })).toBe("code");
    expect(waHandoffMode({ ...all, templateApproved: false })).toBe("code");
    expect(waHandoffMode({ ...all, paymentBlocked: true })).toBe("code");
  });
  it("off when the WhatsApp link itself cannot show", () => {
    expect(waHandoffMode({ ...all, codeAvailable: false })).toBe("off");
  });
});

describe("the code in the button", () => {
  it("round-trips, any case, and refuses anything else", () => {
    expect(handoffButtonPayload("AB3D5F")).toBe("wah_AB3D5F");
    expect(handoffRefFromButton("wah_AB3D5F")).toBe("AB3D5F");
    expect(handoffRefFromButton("wah_ab3d5f")).toBe("AB3D5F");
    for (const bad of [null, undefined, "", "AB3D5F", "apv_AB3D5F", "wah_AB3D5", "wah_AB3D5FG", "wah_AB0D5F", "wah_AB1D5F"]) expect(handoffRefFromButton(bad as any)).toBeNull();
  });
  it("the pending send is keyed by business number and visitor digits", () => {
    expect(handoffPendingKey("ca1", "972501234567")).toBe("wahandoff:pending:ca1:972501234567");
  });
  it("the template's name is fixed", () => {
    expect(PHONE_HANDOFF_TEMPLATE_NAME).toBe("website_chat_handoff");
  });
});

describe("limits", () => {
  it("one per visitor number per business number a day, two per web chat a day, five per address an hour, 200 per business a day", () => {
    expect(PHONE_HANDOFF_LIMITS).toEqual({ perNumberPerDay: 1, perConversationPerDay: 2, perIpPerHour: 5, perBusinessPerDay: 200 });
    const keys = phoneHandoffLimitKeys({ channelAccountId: "ca1", digits: "9725", websiteConversationId: "w1", ip: "1.2.3.4", tenantId: "t1", day: "2026-11-22", hour: "2026-11-22T21" });
    expect(keys.map((k) => [k.key, k.max, k.ttl])).toEqual([
      ["wahandoff:rl:num:ca1:9725", 1, 86400],
      ["wahandoff:rl:conv:w1", 2, 86400],
      ["wahandoff:rl:ip:1.2.3.4:2026-11-22T21", 5, 3600],
      ["wahandoff:rl:biz:t1:2026-11-22", 200, 93600],
    ]);
  });
});

describe("the payment signal", () => {
  const now = new Date("2026-11-22T21:00:00Z");
  it("only Meta 131042 is a payment block", () => {
    expect(isPaymentBlockError({ code: 131042 })).toBe(true);
    expect(isPaymentBlockError({ code: "131042" })).toBe(true);
    for (const c of [131047, 131026, 132001, 470, null, undefined]) expect(isPaymentBlockError({ code: c })).toBe(false);
    expect(isPaymentBlockError(null)).toBe(false);
  });
  it("blocks for 24 hours, then lapses; junk is no block", () => {
    const at = (ms: number) => JSON.stringify({ at: new Date(now.getTime() - ms).toISOString(), code: 131042 });
    expect(PAYMENT_BLOCK_LAPSE_MS).toBe(86_400_000);
    expect(paymentBlockedAt(at(60_000), now)).toBe(true);
    expect(paymentBlockedAt(at(PAYMENT_BLOCK_LAPSE_MS - 1), now)).toBe(true);
    expect(paymentBlockedAt(at(PAYMENT_BLOCK_LAPSE_MS), now)).toBe(false);
    for (const junk of [null, "", "x", "{}", JSON.stringify({ at: "never" })]) expect(paymentBlockedAt(junk, now)).toBe(false);
  });
  it("recorded per number, read back, cleared; the log line never carries a phone number", async () => {
    const store = new Map<string, string>();
    const io = { read: async (_t: string, k: string) => store.get(k) ?? null, write: async (_t: string, k: string, v: string | null) => { if (v === null) store.delete(k); else store.set(k, v); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await recordPaymentBlock("t1", "ca1", 131042, "send", now, io);
    expect(JSON.parse(store.get(paymentBlockKey("ca1"))!)).toEqual({ at: now.toISOString(), code: 131042, phase: "send" });
    expect(await isPaymentBlocked("t1", "ca1", now, io)).toBe(true);
    expect(await isPaymentBlocked("t1", "ca2", now, io)).toBe(false);
    expect(String(warn.mock.calls[0]?.[0])).not.toMatch(/\d{8,}/);
    await clearPaymentBlock("t1", "ca1", io);
    expect(await isPaymentBlocked("t1", "ca1", now, io)).toBe(false);
    warn.mockRestore();
  });
  it("a failed read is no block", async () => {
    expect(await isPaymentBlocked("t1", "ca1", now, { read: async () => { throw new Error("down"); }, write: async () => {} })).toBe(false);
  });
});

describe("the stored setting", () => {
  it("off by default, kept when saved, untouched by a patch that does not name it", () => {
    expect(defaultWhatsapp().phoneHandoff).toBe(false);
    expect(normalizeWhatsapp({}).phoneHandoff).toBe(false);
    const on = normalizeWhatsapp({ enabled: true, phoneHandoff: true });
    expect(on.phoneHandoff).toBe(true);
    expect(normalizeWhatsapp({ enabled: false }, on).phoneHandoff).toBe(true);
    expect(normalizeWhatsapp({ phoneHandoff: false }, on).phoneHandoff).toBe(false);
    expect(normalizeWhatsapp({ phoneHandoff: "yes" }).phoneHandoff).toBe(false);
  });
});

describe("the payment signal at delivery (the webhook)", () => {
  const io = () => { const store = new Map<string, string>(); return { store, read: async (_t: string, k: string) => store.get(k) ?? null, write: async (_t: string, k: string, v: string | null) => { if (v === null) store.delete(k); else store.set(k, v); } }; };
  const handoffMsg = { metadata: { source: "website_phone_handoff", handoff: { channelAccountId: "ca1" } } };
  it("★ a FAILED handoff template with 131042 blocks its number", async () => {
    const s = io();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await paymentBlockFromStatus("t1", handoffMsg, { mapped: "FAILED", error: { code: 131042 } }, new Date(), s)).toBe(true);
    expect(JSON.parse(s.store.get(paymentBlockKey("ca1"))!)).toMatchObject({ code: 131042, phase: "delivery" });
  });
  it("delivered, another code, or another message: nothing", async () => {
    const s = io();
    expect(await paymentBlockFromStatus("t1", handoffMsg, { mapped: "DELIVERED", error: null }, new Date(), s)).toBe(false);
    // Delivered with a code still attached (a stale error on a later status) is not a payment failure.
    expect(await paymentBlockFromStatus("t1", handoffMsg, { mapped: "DELIVERED", status: "delivered", error: { code: 131042 } }, new Date(), s)).toBe(false);
    expect(await paymentBlockFromStatus("t1", handoffMsg, { mapped: "FAILED", error: { code: 131026 } }, new Date(), s)).toBe(false);
    expect(await paymentBlockFromStatus("t1", { metadata: { source: "broadcast" } }, { mapped: "FAILED", error: { code: 131042 } }, new Date(), s)).toBe(false);
    expect(await paymentBlockFromStatus("t1", { metadata: { source: "website_phone_handoff" } }, { mapped: "FAILED", error: { code: 131042 } }, new Date(), s)).toBe(false);
    expect(s.store.size).toBe(0);
  });
});
