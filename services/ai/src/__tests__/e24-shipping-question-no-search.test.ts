/**
 * P3 (Tehila prod 2026-11-05 15:38): "וכמה עולה שליח עד הבית" ran
 * list_products({in_stock:true, per_page:3}) and got three scarves; the same
 * question again got the answer (35 ש"ח). A shipping, delivery or pickup
 * question never runs a product search; one that names a product still can.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shippingQuestion, storeQuestion } from "../services/woo-chat-turn.service";

describe("a shipping question is not a product ask", () => {
  it("her question and its kin", () => {
    for (const t of ["וכמה עולה שליח עד הבית", "כמה עולה משלוח?", "תוך כמה זמן זה יגיע?", "אפשר איסוף עצמי?", "do you ship abroad?", "how much is delivery"]) {
      expect(shippingQuestion(t)).toBe(true);
      expect(storeQuestion(t)).toBe(true);
    }
  });
  it("a product question stays one", () => {
    for (const t of ["כמה עולה המטפחת?", "יש לכם מטפחות?", "כמה עולה משלוח לשמלה הזו?", "מה יש כרגע במלאי"]) expect(shippingQuestion(t)).toBe(false);
  });
  it("the bot removes the product search on such a turn, and recommend-now never fires on a store question", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain("if (wooTurn && shippingQuestion(opts.incomingMessage)) {");
    expect(src).toContain('const SEARCH = new Set(["woocommerce.list_products", "woocommerce.complementary_products"]);');
    expect(src).toMatch(/const recommendNow = !!wooTurn && toolFunctionNames\.includes\("woocommerce\.list_products"\) && !storeQuestion\(opts\.incomingMessage\)/);
    // The drop happens before the turn's tool names are read.
    expect(src.indexOf("if (wooTurn && shippingQuestion(opts.incomingMessage)) {")).toBeLessThan(src.indexOf("let toolFunctionNames: string[] = (tools as any[])"));
  });
});
