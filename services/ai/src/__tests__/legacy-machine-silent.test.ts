/**
 * The legacy bot never answers a machine (2026-11-18, the dev relevance run: Urban Supply's legacy bot answered a
 * verification code, an away message, an invoice and an out-of-office mail). The engine's own rules.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const SRC = readFileSync("src/services/ai-bot.service.ts", "utf8");
const t = (s: number) => new Date(Date.UTC(2026, 10, 18, 14, 0, s));
const dbOf = (channel: string, customerExternalId: string, history: any[]) => ({
  conversation: { findFirst: async () => ({ channel, customerExternalId }) },
  // The service asks newest first.
  message: { findMany: async () => [...history].reverse() },
});
const silence = async (channel: string, sender: string, history: any[], incoming: string) => {
  const { legacyMachineSilence } = await import("../services/ai-bot.service");
  return legacyMachineSilence({ tenantId: "t1", conversationId: "c1", incomingMessage: incoming }, dbOf(channel, sender, history));
};

describe("the legacy bot stays silent on machines", () => {
  it("★ a one-time code on WhatsApp", async () => {
    const code = "Your verification code is 482913";
    expect(await silence("WHATSAPP", "972500000001", [{ direction: "INBOUND", body: code, createdAt: t(0) }], code)).toBe("one_time_code");
  }, 120_000);
  it("★ an away message after our outreach on WhatsApp", async () => {
    const away = "תודה שפניתם אלינו! נחזור אליכם בהקדם האפשרי.";
    const h = [{ direction: "OUTBOUND", body: "היי, רציתי להציע לכם שירות", createdAt: t(0) }, { direction: "INBOUND", body: away, createdAt: t(4) }];
    expect(await silence("WHATSAPP", "972500000001", h, away)).toBe("auto_reply");
  });
  it("★ a short away message after our outreach (the conversation read oldest first: ours was first)", async () => {
    const away = "תודה שפניתם, נחזור אליכם";
    const h = [{ direction: "OUTBOUND", body: "היי, רציתי להציע לכם שירות", createdAt: t(0) }, { direction: "INBOUND", body: away, createdAt: t(4) }];
    expect(await silence("WHATSAPP", "972500000001", h, away)).toBe("auto_reply");
  });
  it("★ an automated mail on Gmail", async () => {
    const mail = "Your order has shipped. Track it in your account.";
    expect(await silence("GMAIL", "no-reply@shop.example", [{ direction: "INBOUND", body: mail, createdAt: t(0) }], mail)).toBe("no_reply_sender");
  });
});

describe("the legacy bot still answers people", () => {
  it("★ a customer's היי", async () => {
    expect(await silence("WHATSAPP", "972500000001", [{ direction: "INBOUND", body: "היי", createdAt: t(0) }], "היי")).toBeNull();
  });
  it("★ a customer mid-conversation: \"I'm away, will answer tomorrow\"", async () => {
    const msg = "I'm away, will answer tomorrow";
    const h = [{ direction: "INBOUND", body: "do you ship to Eilat?", createdAt: t(0) }, { direction: "OUTBOUND", body: "Yes, 3 business days.", createdAt: t(10) }, { direction: "INBOUND", body: msg, createdAt: t(60) }];
    expect(await silence("WHATSAPP", "972500000001", h, msg)).toBeNull();
  });
  it("★ a customer quoting the business's promise", async () => {
    const msg = "פניתי אליכם אתמול ואמרו לי נחזור אליך ואף אחד לא חזר";
    expect(await silence("WHATSAPP", "972500000001", [{ direction: "INBOUND", body: msg, createdAt: t(0) }], msg)).toBeNull();
  });
  it("★ a person's mail on Gmail", async () => {
    const msg = "היי, אפשר לקבל מחיר למשטח?";
    expect(await silence("GMAIL", "dana@gmail.com", [{ direction: "INBOUND", body: msg, createdAt: t(0) }], msg)).toBeNull();
  });
});

describe("where it sits", () => {
  it("★ after the engine block, before the agent loop and the planner; no reply and nothing else; never on the relevance switches", () => {
    const gate = SRC.indexOf("const machine = await legacyMachineSilence(opts)");
    expect(gate).toBeGreaterThan(SRC.indexOf("const r = await runReplyEngineTurn(opts, \"autonomous\", turn.signal);"));
    expect(gate).toBeLessThan(SRC.indexOf("const loopMode = opts.onboardingTest ? \"off\" : agentLoopMode(opts.tenantId);"));
    expect(gate).toBeLessThan(SRC.indexOf("const result = await generateAIBotReplyInner(opts, turn.signal);"));
    const block = SRC.slice(gate, gate + 400);
    expect(block).toMatch(/return \{ reply: null, escalation: null, awaitingApproval: null, toolCallLog: \[\], modelUsed: "none", totalTokens: 0 \}/);
    // One log line: the conversation and the reason, never the body.
    expect(block).toMatch(/console\.log\(`\[ai-bot\] conv=\$\{opts\.conversationId\}: not answered \(automated:\$\{machine\}\)`\)/);
    const fn = SRC.slice(SRC.indexOf("export async function legacyMachineSilence"), SRC.indexOf("/** The email channels the AI does not answer"));
    expect(fn).not.toMatch(/RELEVANCE_GATE|relevanceFilterEnabled|relevanceGateMode/);
  });
});
