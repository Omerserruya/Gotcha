/**
 * A slow AI turn is not a failure (Tehila, 2026-11-02: an 81s turn met a 60s
 * timeout and a product question was handed to a person).
 *   - past holdingAfterMs the customer gets ONE holding line, then the real reply
 *   - a fast reply sends no holding line
 *   - a real failure still reaches the caller (which hands off), holding or not
 */
import { describe, it, expect, vi } from "vitest";
import { withHolding, holdingLine, aiReplyTimeoutMs, holdingAfterMs } from "../services/ai-bot.service";

const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

describe("withHolding", () => {
  it("a slow reply: the holding line once, then the reply itself", async () => {
    const onHolding = vi.fn();
    const r = await withHolding(() => later(120, { reply: "products" }), onHolding, 30);
    expect(r).toEqual({ reply: "products" });
    expect(onHolding).toHaveBeenCalledTimes(1);
  });

  it("a fast reply: no holding line", async () => {
    const onHolding = vi.fn();
    await withHolding(() => later(5, "ok"), onHolding, 60);
    await later(80, null);
    expect(onHolding).not.toHaveBeenCalled();
  });

  it("a real failure still throws to the caller, and nothing is sent after it", async () => {
    const onHolding = vi.fn();
    await expect(withHolding(() => Promise.reject(new Error("ai down")), onHolding, 30)).rejects.toThrow("ai down");
    await later(60, null);
    expect(onHolding).not.toHaveBeenCalled();
  });
});

describe("the numbers and the words", () => {
  it("the worker waits 150s for the AI (an 81s turn is not a failure), holding at 30s", () => {
    expect(aiReplyTimeoutMs({} as any)).toBe(150_000);
    expect(aiReplyTimeoutMs({} as any)).toBeGreaterThan(81_725);
    expect(holdingAfterMs({} as any)).toBe(30_000);
  });
  it("the holding line: neutral, in the conversation's language, no dash", () => {
    expect(holdingLine(true)).toBe("רגע אחד, בודקים את זה בשבילך.");
    expect(holdingLine(false)).toBe("One moment, checking that for you.");
    expect(holdingLine(true) + holdingLine(false)).not.toMatch(/[–—־]/);
  });
});
