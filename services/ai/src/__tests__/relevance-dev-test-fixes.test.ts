/**
 * Dev relevance test 2026-11-18 (integration bbafadd4, gate=shadow, 17 inbounds on Urban Supply):
 * R1 labels lost on the worker's 3s timeout, R2 a cold pitch became reply_to_outbound once the bot answered,
 * R3 the engine answered an away message and a one-time code.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "m", platformPaidScope: { run: (_: any, f: any) => f() } }));
import { classifyConversation, fastRelevance, oneTimeCode, onlyAfterOwnOutbound, relevancePrompt, autoReply } from "../services/conversation-relevance.service";
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

describe("R3 fix: only the business's own voice is a machine; any sign of a person wins", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 10, 18, 10, 0, s));
  const cases: Array<[string, any[], string]> = [
    ["1: a question a minute after the bot's greeting", [{ direction: "INBOUND", body: "היי", createdAt: t(0) }, { direction: "OUTBOUND", body: "היי! איך אפשר לעזור?", createdAt: t(5) }, { direction: "INBOUND", body: "מה שעות הפעילות שלכם?", createdAt: t(60) }], "מה שעות הפעילות שלכם?"],
    ["2: the same without a question mark", [{ direction: "INBOUND", body: "היי", createdAt: t(0) }, { direction: "OUTBOUND", body: "היי! איך אפשר לעזור?", createdAt: t(5) }, { direction: "INBOUND", body: "מה שעות הפעילות שלכם ביום שישי", createdAt: t(60) }], "מה שעות הפעילות שלכם ביום שישי"],
    ["3: a customer's opener, empty history", [], "היי רציתי לדעת מה שעות הפעילות שלכם ביום שישי"],
    ["4: thanks for the message, then an order", [{ direction: "INBOUND", body: "כמה עולה משלוח?", createdAt: t(0) }, { direction: "OUTBOUND", body: "משלוח עולה 30 ש\"ח.", createdAt: t(5) }, { direction: "INBOUND", body: "תודה על ההודעה, אז אני רוצה להזמין את השמלה הכחולה", createdAt: t(60) }], "תודה על ההודעה, אז אני רוצה להזמין את השמלה הכחולה"],
    ["5: we wrote first (a campaign), she asks", [{ direction: "OUTBOUND", body: "מבצע סוף עונה בחנות!", createdAt: t(0) }, { direction: "INBOUND", body: "מה שעות הפעילות של החנות?", createdAt: t(3600) }], "מה שעות הפעילות של החנות?"],
    ["en: what are your opening hours?", [{ direction: "OUTBOUND", body: "Hi! How can I help?", createdAt: t(0) }, { direction: "INBOUND", body: "what are your opening hours?", createdAt: t(30) }], "what are your opening hours?"],
    ["en: thanks for the message, I want to order", [{ direction: "OUTBOUND", body: "Shipping is 30 ILS.", createdAt: t(0) }, { direction: "INBOUND", body: "thanks for the message, I want to order the blue dress", createdAt: t(30) }], "thanks for the message, I want to order the blue dress"],
    ["en: thank you for your message, do you ship abroad", [], "thank you for your message, do you ship abroad"],
    ["a person away, singular", [], "כרגע אני לא זמינה, תתקשרו אחרי 5"],
  ];
  for (const [name, history, incoming] of cases) {
    it(`★ R3 is no machine, unit: ${name}`, () => {
      expect(machineInbound("WHATSAPP", history, incoming)).toBeNull();
      const msgs = [...history, ...(history.some((m: any) => m.body === incoming) ? [] : [{ direction: "INBOUND", body: incoming, createdAt: t(9999) }])];
      const first = msgs[0];
      expect(autoReply({ channel: "WHATSAPP", firstDirection: first?.direction === "OUTBOUND" ? "OUTBOUND" : "INBOUND", messages: msgs })).toBe(false);
    });
  }
  it("★ R3 stays a machine: an away message after our outreach", () => {
    const away = "תודה שפניתם אלינו! נחזור אליכם בהקדם האפשרי.";
    const h = [{ direction: "OUTBOUND", body: "היי, רציתי להציע לכם שירות", createdAt: t(0) }, { direction: "INBOUND", body: away, createdAt: t(4) }];
    expect(machineInbound("WHATSAPP", h, away)).toBe("auto_reply");
    expect(autoReply({ channel: "WHATSAPP", firstDirection: "OUTBOUND", messages: h })).toBe(true);
  });
  it("★ R3 stays a machine: their bot again after our reply, the whole contact side a machine", () => {
    const a = "תודה שפניתם אלינו! נחזור אליכם בהקדם האפשרי.";
    const h = [{ direction: "OUTBOUND", body: "היי, רציתי להציע לכם שירות", createdAt: t(0) }, { direction: "INBOUND", body: a, createdAt: t(4) }, { direction: "OUTBOUND", body: "תודה!", createdAt: t(10) }, { direction: "INBOUND", body: a, createdAt: t(14) }];
    expect(machineInbound("WHATSAPP", h, a)).toBe("auto_reply");
  });
  it("★ R3: one line from a person in view and it is a person", () => {
    const a = "תודה שפניתם אלינו! נחזור אליכם בהקדם האפשרי.";
    const h = [{ direction: "INBOUND", body: "יש לכם משטח למיקסר?", createdAt: t(0) }, { direction: "OUTBOUND", body: "כן!", createdAt: t(5) }, { direction: "INBOUND", body: a, createdAt: t(9) }];
    expect(machineInbound("WHATSAPP", h, a)).toBeNull();
  });
  it("★ R3 English away message after our outreach is a machine", () => {
    const a = "Thank you for contacting us. We are currently closed and we will get back to you tomorrow.";
    const h = [{ direction: "OUTBOUND", body: "Hi, a quick offer for you", createdAt: t(0) }, { direction: "INBOUND", body: a, createdAt: t(4) }];
    expect(machineInbound("WHATSAPP", h, a)).toBe("auto_reply");
  });
});

describe("R3 fix: the branches of autoReply", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 10, 18, 11, 0, s));
  const a = "תודה שפניתם אלינו! נחזור אליכם בהקדם האפשרי.";
  it("★ we wrote first, a person answered, then an away message: a person", () => {
    const h = [{ direction: "OUTBOUND", body: "היי, רציתי להציע לכם שירות", createdAt: t(0) }, { direction: "INBOUND", body: "נשמע מעניין, ספרו לי עוד", createdAt: t(30) }, { direction: "OUTBOUND", body: "בשמחה!", createdAt: t(40) }, { direction: "INBOUND", body: a, createdAt: t(50) }];
    expect(autoReply({ channel: "WHATSAPP", firstDirection: "OUTBOUND", messages: h })).toBe(false);
    expect(machineInbound("WHATSAPP", h, a)).toBeNull();
  });
  it("★ the contact wrote first: a short line in the business's voice is not enough", () => {
    expect(autoReply({ channel: "WHATSAPP", firstDirection: "INBOUND", messages: [{ direction: "INBOUND", body: "נחזור אליכם בהקדם", createdAt: t(0) }] })).toBe(false);
    expect(autoReply({ channel: "WHATSAPP", firstDirection: "INBOUND", messages: [{ direction: "INBOUND", body: a, createdAt: t(0) }] })).toBe(true);
  });
});
