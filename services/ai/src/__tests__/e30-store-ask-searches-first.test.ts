/**
 * Smoovee prod 2026-11-08 (cmw7ugbvb, 13:04-13:06): "ומה יש לכם לתמי 4" was
 * answered "סמובי אדם מתאים לתמי 4" from the knowledge text (wrong: it is the
 * Alexa), and "נגיד 20*40" got "אין משטח" (wrong: Christina 23x40 fits), with
 * no search and no card. A product, fit or stock ask is searched before the
 * model writes, in the customer's words, with their base size.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { storeProductAsk } from "../services/woo-chat-turn.service";

const asked = [{ direction: "INBOUND", body: "יש לי מיקסר קיצנאייד" }, { direction: "OUTBOUND", body: "מה מידות הבסיס?" }];

describe("a product, fit or stock ask", () => {
  it("her asks", () => {
    for (const t of ["ומה יש לכם לתמי 4", "נגיד 20*40", "מה יש כרגע במלאי?", "יש לכם משטח למכונת קפה?", "מה מתאים לנינג'ה?", "יש לי מיקסר קיצנאייד, איזה משטח מתאים?"]) expect(storeProductAsk(asked, t)).toBe(true);
  });
  it("not a store question or chatter", () => {
    for (const t of ["כמה עולה משלוח?", "יש לכם קוד קופון?", "תודה רבה", "היי", "אפשר להחזיר?"]) expect(storeProductAsk([], t)).toBe(false);
  });
});

describe("the bot searches before the model writes", () => {
  const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  const at = src.indexOf("let storeAskSearched = false;");
  const block = src.slice(at, at + 4000);
  it("with the customer's words, their size and the conversation's language", () => {
    expect(at).toBeGreaterThan(0);
    expect(block).toContain("storeProductAsk(messages as any[], opts.incomingMessage)");
    expect(block).toContain("query: words, per_page: 10, lang: conversationLang(), ...(size ? { fits_cm: size } : {})");
    expect(block).toMatch(/Answer ONLY from these results, never from the knowledge text, and do NOT work out sizes or fits yourself/);
  });
  it("nothing found is told only for a size; otherwise the model searches as before (urban)", () => {
    expect(block).toContain('envlp.status !== "error" && (envlp.candidates.length > 0 || size)');
  });
  it("before the model's first round, and its results are carded even when the reply names none", () => {
    expect(at).toBeLessThan(src.indexOf("for (let round = 0;") > 0 ? src.indexOf("for (let round = 0;") : Number.MAX_SAFE_INTEGER);
    expect(src).toContain("(discoveryRecommend || discoveryLookup || storeAskSearched || SHOW_ME.test(");
    expect(src).toContain(": storeAskSearched ? 3 : 1,");
  });
});
