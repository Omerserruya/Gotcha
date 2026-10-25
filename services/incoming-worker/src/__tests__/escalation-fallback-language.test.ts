/**
 * ★ The static handoff line goes out in the customer's language (2026-10-25).
 * A Hebrew conversation on omer-onb-2 got "Let me connect you with a team
 * member..." when the AI service was down: the oneshot that writes the line in
 * the conversation's language failed, and the stock English default went out.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { localizedFallback, STOCK_ESCALATION_EN, STOCK_ESCALATION_HE } from "../services/escalation-language";

describe("★ the stock escalation line follows the conversation's language", () => {
  it("a Hebrew conversation gets the Hebrew stock line", () => {
    expect(localizedFallback(STOCK_ESCALATION_EN, "יש את המעיל במידה M?")).toBe(STOCK_ESCALATION_HE);
  });

  it("an English conversation, or one with no customer text, keeps the English line", () => {
    expect(localizedFallback(STOCK_ESCALATION_EN, "Do you have the coat in M?")).toBe(STOCK_ESCALATION_EN);
    expect(localizedFallback(STOCK_ESCALATION_EN, "")).toBe(STOCK_ESCALATION_EN);
  });

  it("an owner's own wording goes out as written, in any conversation", () => {
    expect(localizedFallback("A person from Acme will reply soon.", "שלום")).toBe("A person from Acme will reply soon.");
  });

  it("the English line is exactly the one employees are created with, and the Hebrew one has no dash or gendered verb", () => {
    const defaults = readFileSync(join(__dirname, "../../../ai/src/services/ai-agent-defaults.ts"), "utf-8");
    expect(defaults).toContain(`escalationMessage: "${STOCK_ESCALATION_EN}"`);
    expect(STOCK_ESCALATION_HE).not.toMatch(/[–—־-]/);
  });

  it("every fallback after the customer's text is read goes through it", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf-8");
    const fn = src.slice(src.indexOf("async function generateEscalationHandoff"), src.indexOf("// ─── One-shot reply"));
    expect(fn).toMatch(/return localizedFallback\(fallback, inboundSample\);\n}/);
    expect(src).toContain('import { localizedFallback } from "./escalation-language";');
  });
});
