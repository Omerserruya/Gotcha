/**
 * P1 and P2 (dev 2026-10-27, after urban-e26):
 *   P1 - a choice and nothing else is answered with the acknowledgement and the
 *        add-ons, no model round; anything more goes the model's way.
 *   P2 - a re-search turn's predictable search runs ahead, in the prompt, not
 *        forced; hit or miss logged per turn. Behind AI_PRESEARCH2 (dev only).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pureChoice, audienceOf, budgetOf, predictedSearch } from "../services/woo-chat-turn.service";
import { preSearch2Enabled } from "../services/discovery-integration.service";

describe("P1: a choice and nothing else", () => {
  for (const t of ["אני לוקח את מעיל הצמר", "אני לוקחת אותו", "סגור, אזמין את המעיל", "I'll take it"]) it(t, () => expect(pureChoice(t)).toBe(true));
  for (const t of ["אני לוקח, יש משלוח מהיר", "אני לוקח את המעיל, מתי זה מגיע", "אקח במידה M", "אני לוקח את המעיל?", "I'll take it, is shipping free", "אני מחפש מעיל"]) {
    it(`not: ${t}`, () => expect(pureChoice(t)).toBe(false));
  }
  it("wired: no model round only when the add-ons resolved; otherwise the model's path", () => {
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot).toContain("if (wooTurn?.suggestComplementary && !pendingApprovals.length && pureChoice(opts.incomingMessage)) {");
    expect(bot).toContain("for (let round = 0; round < (choiceShortCircuit ? 0 : 3); round++) {");
    const i = bot.indexOf("choiceShortCircuit = true;");
    expect(bot.slice(i - 400, i)).toContain("if (record) {");
    expect(bot.slice(i, i + 400)).toContain("await releaseCrossSell(opts.conversationId, anchorId);");
  });
});

describe("P2: the predicted re-search", () => {
  const last = { query: "coat", per_page: 10, in_stock: true };
  it("who it is for, only when said outright", () => {
    expect(audienceOf("בשבילי לגבר")).toBe("men");
    expect(audienceOf("מתנה לאחותי")).toBe("women");
    expect(audienceOf("בשבילי")).toBeNull();
    expect(audienceOf("לאבא ולאמא")).toBeNull();
  });
  it("a budget", () => {
    expect(budgetOf("משהו עד 300 שקל")).toBe(300);
    expect(budgetOf("under ₪250")).toBe(250);
    expect(budgetOf("מעיל")).toBeNull();
  });
  it("the last search with what this message adds", () => {
    expect(predictedSearch("בשבילי לגבר", last, { showMe: false, namesProduct: false })).toEqual({ query: "coat", per_page: 10, in_stock: true, audience: "men" });
    expect(predictedSearch("לא יודע תראה לי", { ...last, audience: "men" }, { showMe: true, namesProduct: false })).toEqual({ query: "coat", per_page: 10, in_stock: true, audience: "men" });
    expect(predictedSearch("עד 500", last, { showMe: false, namesProduct: false })).toEqual({ query: "coat", per_page: 10, in_stock: true, price_max: 500 });
  });
  it("nothing to predict: no trigger, no last search, or another product named", () => {
    expect(predictedSearch("סבבה", last, { showMe: false, namesProduct: false })).toBeNull();
    expect(predictedSearch("תראה לי", null, { showMe: true, namesProduct: false })).toBeNull();
    expect(predictedSearch("תראה לי צעיפים", last, { showMe: true, namesProduct: true })).toBeNull();
  });
  it("the flag: AI_PRESEARCH2=1/0; unset, dev only", () => {
    expect(preSearch2Enabled({ NODE_ENV: "development" } as any)).toBe(true);
    expect(preSearch2Enabled({ NODE_ENV: "production" } as any)).toBe(false);
    expect(preSearch2Enabled({ NODE_ENV: "development", AI_PRESEARCH2: "0" } as any)).toBe(false);
    expect(preSearch2Enabled({ NODE_ENV: "production", AI_PRESEARCH2: "1" } as any)).toBe(true);
  });
  it("wired: not forced, results in the prompt, hit or miss logged", () => {
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot).toContain("[ai-bot][presearch2] predicted=${JSON.stringify(presearch2.args)} used=${used ? \"yes\" : \"no\"}");
    expect(bot).toContain("call a tool only for a different search.");
    const i = bot.indexOf("let presearch2:");
    expect(bot.slice(i, i + 3000)).not.toContain("toolChoice");
  });
});
