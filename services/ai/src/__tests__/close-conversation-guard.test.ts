/**
 * Eval A05 (2026-11-15, gpt-5-mini; gpt-6-luna "low" 9 times): "יש גרביים?"
 * was answered "out of stock" and the model closed the conversation, so
 * "מתי יחזרו למלאי?" landed on a CLOSED conversation and got no reply. The
 * model may close only on the customer's explicit end after an answer;
 * otherwise the call is refused and the model answers and continues.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeAllowed, closeRefusal, MAX_END_WORDS } from "../lib/close-intent";

describe("A05: a question is never an end", () => {
  it("turn 1, the first message, a question: refused (no reply yet, and a question)", () => {
    expect(closeAllowed("יש גרביים?", 0)).toEqual({ allowed: false, reason: "no_reply_yet" });
    expect(closeAllowed("יש גרביים?", 1)).toEqual({ allowed: false, reason: "question" });
  });
  it("turn 2, the follow-up: refused", () => {
    expect(closeAllowed("מתי יחזרו למלאי?", 2).allowed).toBe(false);
    expect(closeAllowed("מתי יחזרו למלאי", 2)).toEqual({ allowed: false, reason: "new_need" });
  });
  it("the refusal tells the model to answer and keep the conversation open", () => {
    const r = JSON.parse(closeRefusal(closeAllowed("יש גרביים?", 1)));
    expect(r).toMatchObject({ ok: false, error: "close_not_allowed", reason: "question" });
    expect(r.instruction).toContain("Do NOT close");
    expect(r.instruction).toContain("Answer their latest message");
  });
});

describe("an explicit end after an answer may close", () => {
  it.each([
    "תודה רבה!", "תודה, זה הכל", "זהו, תודה", "ביי", "להתראות", "מעולה תודה", "אין צורך, תודה", "שבת שלום",
    "Thanks!", "thank you, that's all", "That’s all", "ok bye", "شكرا", "מעולה, הכל ברור",
  ])("%s", (text) => {
    expect(closeAllowed(text, 1)).toEqual({ allowed: true });
  });
});

describe("not an end", () => {
  it("an end phrase with no answer yet (the first message) is refused", () => {
    expect(closeAllowed("תודה", 0)).toEqual({ allowed: false, reason: "no_reply_yet" });
  });
  it("thanks with a new need", () => {
    expect(closeAllowed("תודה, אבל יש לכם גם במידה L", 1)).toEqual({ allowed: false, reason: "new_need" });
    expect(closeAllowed("thanks, but how long is shipping", 1)).toEqual({ allowed: false, reason: "new_need" });
    expect(closeAllowed("תודה! אפשר לקבל קישור", 1)).toEqual({ allowed: false, reason: "new_need" });
    expect(closeAllowed("شكرا، متى يصل", 1)).toEqual({ allowed: false, reason: "new_need" });
  });
  it("a long message is not an end, even with thanks in it", () => {
    // Eight words may end; nine may not.
    const words = (n: number) => "תודה " + Array.from({ length: n - 1 }, (_, i) => `מילה${i}`).join(" ");
    expect(MAX_END_WORDS).toBe(8);
    expect(closeAllowed(words(9), 1)).toEqual({ allowed: false, reason: "too_long" });
    expect(closeAllowed(words(8), 1)).toEqual({ allowed: true });
  });
  it("a statement with no end phrase", () => {
    expect(closeAllowed("אני מחפשת שמלה שחורה", 1)).toEqual({ allowed: false, reason: "not_an_end" });
    expect(closeAllowed("ok", 1)).toEqual({ allowed: false, reason: "not_an_end" });
    expect(closeAllowed("", 1)).toEqual({ allowed: false, reason: "not_an_end" });
  });
  it("the Arabic question mark is a question", () => {
    expect(closeAllowed("شكرا؟", 1)).toEqual({ allowed: false, reason: "question" });
  });
});

describe("the bot's dispatch applies it", () => {
  const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  it("on close_conversation, from the latest inbound and the bot's earlier replies, before the exit-criteria gate", () => {
    const gate = src.indexOf('const closeVerdict = closeAllowed(latestInbound, messages.filter((m) => m.direction === "OUTBOUND").length);');
    expect(gate).toBeGreaterThan(0);
    expect(src.lastIndexOf('if (toolName === "close_conversation") {', gate)).toBeGreaterThan(gate - 200);
    expect(gate).toBeLessThan(src.indexOf("const exitGate = checkExitCriteriaGate("));
  });
  it("a refusal is logged, audited, answered to the model, and skips the dispatch", () => {
    const block = src.slice(src.indexOf("const closeVerdict = closeAllowed("), src.indexOf("const exitGate = checkExitCriteriaGate("));
    expect(block).toContain('decision: "close_not_allowed"');
    expect(block).toContain('action: "ai.close_not_allowed"');
    expect(block).toContain('chatMessages.push({ role: "tool", tool_call_id: tc.id, content: gateContent });\n            continue;');
  });
});
