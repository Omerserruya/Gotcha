/**
 * Email is not answered by the AI for an engine tenant yet, on purpose (2026-11-18, Omer): Smoovee's Gmail.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const SRC = readFileSync("src/services/ai-bot.service.ts", "utf8");

describe("an engine tenant's email gets no AI reply", () => {
  it("★ the three email channels, off unless REPLY_ENGINE_EMAIL is on", async () => {
    const { EMAIL_CHANNELS, emailRepliesOn } = await import("../services/ai-bot.service");
    expect([...EMAIL_CHANNELS].sort()).toEqual(["EMAIL", "GMAIL", "OUTLOOK"]);
    expect(emailRepliesOn({} as any)).toBe(false);
    expect(emailRepliesOn({ REPLY_ENGINE_EMAIL: "on" } as any)).toBe(true);
    expect(emailRepliesOn({ REPLY_ENGINE_EMAIL: "off" } as any)).toBe(false);
  }, 120_000);
  it("★ the skip comes before the engine AND the legacy path, and returns no reply", () => {
    const gate = SRC.indexOf("if (engineMode !== \"off\" && !emailRepliesOn() && EMAIL_CHANNELS.has(");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(SRC.indexOf("const r = await runReplyEngineTurn(opts, \"autonomous\", turn.signal);"));
    expect(gate).toBeLessThan(SRC.indexOf("const loopMode = opts.onboardingTest ? \"off\" : agentLoopMode(opts.tenantId);"));
    expect(SRC.slice(gate, gate + 700)).toMatch(/return \{ reply: null, escalation: null, awaitingApproval: null/);
  });
});
