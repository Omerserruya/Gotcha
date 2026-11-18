/**
 * Dev relevance test 2026-11-18 (integration bbafadd4, gate=shadow, 17 inbounds on Urban Supply):
 * R1 labels lost on the worker's 3s timeout, R2 a cold pitch became reply_to_outbound once the bot answered,
 * R3 the engine answered an away message and a one-time code.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "m", platformPaidScope: { run: (_: any, f: any) => f() } }));
import { classifyConversation, fastRelevance, oneTimeCode, onlyAfterOwnOutbound, relevancePrompt } from "../services/conversation-relevance.service";
import { runRelevanceJob, workerTimeoutMs, processRelevanceJob } from "../workers/relevance/worker";
import { machineInbound } from "../services/reply-engine/engine";
import { enqueueRelevanceClassification, RELEVANCE_ATTEMPTS } from "@chatcenter/shared";

const now = new Date("2026-11-18T12:00:00Z");

describe("R1: the worker's own timeout, retries, and the failure logged on the last try", () => {
  it("★ 20s by default, the env can set it; the inline gate keeps its 3s", () => {
    expect(workerTimeoutMs({})).toBe(20_000);
    expect(workerTimeoutMs({ RELEVANCE_WORKER_TIMEOUT_MS: "30000" })).toBe(30_000);
    expect(workerTimeoutMs({ RELEVANCE_WORKER_TIMEOUT_MS: "5" })).toBe(20_000);
  });
  it("★ the job is queued with 3 attempts and a backoff", async () => {
    const prev = process.env.RELEVANCE_CLASSIFY_TENANTS;
    process.env.RELEVANCE_CLASSIFY_TENANTS = "*";
    try {
      const added: any[] = [];
      await enqueueRelevanceClassification("t1", "c1", { add: async (...a: any[]) => { added.push(a); } });
      expect(RELEVANCE_ATTEMPTS).toBe(3);
      expect(added[0][2]).toMatchObject({ attempts: 3, backoff: { type: "exponential" } });
    } finally { if (prev === undefined) delete process.env.RELEVANCE_CLASSIFY_TENANTS; else process.env.RELEVANCE_CLASSIFY_TENANTS = prev; }
  });
  it("★ a failed label throws for a retry, and is logged as failed only on the last try", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = async () => ({ mode: "shadow", category: null, confidence: null, source: "error", hold: false } as any);
    await expect(runRelevanceJob({ data: { tenantId: "t1", conversationId: "c1" }, attemptsMade: 0, opts: { attempts: 3 } }, failing)).rejects.toThrow(/try 1 of 3/);
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/label failed conv=c1/));
    await expect(runRelevanceJob({ data: { tenantId: "t1", conversationId: "c1" }, attemptsMade: 2, opts: { attempts: 3 } }, failing)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/label failed conv=c1 after 3 tries/));
    const ok = async () => ({ mode: "shadow", category: "business", confidence: 0.9, source: "model", hold: false } as any);
    await expect(runRelevanceJob({ data: { tenantId: "t1", conversationId: "c1" }, attemptsMade: 0, opts: { attempts: 3 } }, ok)).resolves.toBeUndefined();
    warn.mockRestore();
  });
  it("★ the worker passes its own timeout to the classify call", async () => {
    const prev = process.env.RELEVANCE_CLASSIFY_TENANTS;
    process.env.RELEVANCE_CLASSIFY_TENANTS = "*";
    try {
      let seen = 0;
      const db = {
        conversation: { findFirst: async () => ({ id: "c1", tenantId: "t1", channel: "WHATSAPP", customerExternalId: "972500", relevanceCategory: null, relevanceOverriddenBy: null }) },
        message: { findMany: async () => [{ direction: "INBOUND", body: "hi", createdAt: now }], findFirst: async () => ({ direction: "INBOUND" }) },
        user: { findMany: async () => [] },
        channelAccount: { findFirst: async () => null },
      };
      // A classify that takes 3.5s: past the inline 3s, inside the worker's 20s.
      const classify: any = () => new Promise((res) => setTimeout(() => { seen++; res({ category: "business", confidence: 0.9, reason: "r", source: "model", classifiedAt: now.toISOString() }); }, 3500));
      const r = await processRelevanceJob({ tenantId: "t1", conversationId: "c1" }, { db, classify, write: async () => {}, company: async () => null } as any);
      expect(seen).toBe(1);
      expect(r?.source).toBe("model");
    } finally { if (prev === undefined) delete process.env.RELEVANCE_CLASSIFY_TENANTS; else process.env.RELEVANCE_CLASSIFY_TENANTS = prev; }
  }, 10_000);
});

describe("R2: reply_to_outbound only when the first message is the business's own", () => {
  const pitch = { channel: "GMAIL", customerExternalId: "sales@seoboost.example", firstDirection: "INBOUND" as const, messages: [
    { direction: "INBOUND", body: "Hi, I'm reaching out from SEOBoost to offer our services.", createdAt: now },
    { direction: "OUTBOUND", body: "תודה על הפנייה", createdAt: now },
  ] };
  it("★ the model's reply_to_outbound on a contact's opener is unclear, decided in code", async () => {
    const generate: any = vi.fn(async () => ({ content: JSON.stringify({ category: "reply_to_outbound", confidence: 0.99, reason: "the business replied to that unsolicited offer" }) }));
    const r = await classifyConversation("t1", null, pitch, { generate, now: () => now });
    expect(r.category).toBe("unclear");
    expect(r.confidence).toBe(0);
  });
  it("★ the business wrote first: reply_to_outbound stands", () => {
    expect(onlyAfterOwnOutbound({ category: "reply_to_outbound", confidence: 0.9, reason: "r" }, { ...pitch, firstDirection: "OUTBOUND" }).category).toBe("reply_to_outbound");
    expect(onlyAfterOwnOutbound({ category: "marketing", confidence: 0.9, reason: "r" }, pitch).category).toBe("marketing");
  });
  it("★ the prompt tells the model the contact wrote first, so not reply_to_outbound", () => {
    expect(relevancePrompt(null, pitch)[1].content).toMatch(/the contact \(so NOT reply_to_outbound/);
  });
});

describe("R3 and the notices: one-time codes and away messages, by fast rules", () => {
  it("★ a one-time code is a notice with no model call; a customer's complaint about a code is not", () => {
    expect(oneTimeCode("קוד האימות שלך הוא 482913")).toBe(true);
    expect(oneTimeCode("Your verification code is 482913")).toBe(true);
    expect(oneTimeCode("קוד האימות 482913 לא עובד")).toBe(false);
    expect(oneTimeCode("לא קיבלתי קוד אימות")).toBe(false);
    expect(oneTimeCode("מה הקוד?")).toBe(false);
    const f = fastRelevance({ channel: "WHATSAPP", firstDirection: "INBOUND", messages: [{ direction: "INBOUND", body: "Your verification code is 482913", createdAt: now }] }, now);
    expect(f).toMatchObject({ category: "notice", source: "fast" });
  });
  it("★ the engine stays silent on a code and on an away message, with the gate off", () => {
    expect(machineInbound("WHATSAPP", [], "Your verification code is 482913")).toBe("one_time_code");
    const away = "תודה שפנית אלינו! אנחנו לא זמינים כרגע ונחזור אליך בהקדם האפשרי.";
    expect(machineInbound("WHATSAPP", [{ direction: "INBOUND", body: away, createdAt: now }], away)).toBe("auto_reply");
    expect(machineInbound("WHATSAPP", [{ direction: "INBOUND", body: "יש לכם משטח למיקסר?", createdAt: now }], "יש לכם משטח למיקסר?")).toBeNull();
  });
});

describe("R3 safety: a customer is never taken for a machine", () => {
  it("★ R3a: a customer's opening statement of 6+ words, no question, not away-shaped, is no machine", () => {
    const s = "אני מחפשת משטח הזזה למיקסר החדש שקניתי השבוע";
    expect(machineInbound("WHATSAPP", [{ direction: "INBOUND", body: s, createdAt: now }], s)).toBeNull();
  });
  it("★ R3b: a customer quoting a code and complaining is no machine", () => {
    for (const s of ["הקוד 123456 לא הגיע לי", "קיבלתי קוד 4821 מה עושים איתו", "קוד האימות 482913 לא עובד", "My verification code 482913 doesn't work"]) {
      expect(oneTimeCode(s)).toBe(false);
      expect(machineInbound("WHATSAPP", [{ direction: "INBOUND", body: s, createdAt: now }], s)).toBeNull();
    }
  });
  it("★ R3c: an order number or a coupon code next to the word קוד is no machine", () => {
    for (const s of ["קוד קופון 2024", "קוד הזמנה 97837", "יש לי קוד הנחה 5050 אפשר להשתמש בו", "הטלפון שלי 0501234 וקוד הזמנה 97837"]) {
      expect(oneTimeCode(s)).toBe(false);
      expect(machineInbound("WHATSAPP", [{ direction: "INBOUND", body: s, createdAt: now }], s)).toBeNull();
    }
  });
});
