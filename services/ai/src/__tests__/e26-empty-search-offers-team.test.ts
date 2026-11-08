/**
 * P7 (Smoovee cmw7p00cq 10:33): an empty search ended at "לא מצאתי משטח בשם
 * שמתאים לתמי 4. חיפוש לפי צבע ... עשוי לעזור." The checker flagged
 * false_absence, and "the model's reply stands". Now the empty result tells
 * the model to offer the team (no refinement, no preorder), and a reply with no
 * question gets the team offer when the turn can hand over.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildKeyedModelSummary } from "../services/product-search.service";
import { withTeamOffer } from "../services/knowledge.service";

const empty = { provider: "woocommerce", tool: "woocommerce_product_search", status: "no_results", candidates: [], appliedFilters: ["query"], unavailableFilters: [], safeModelSummary: "" } as any;

describe("an empty search", () => {
  it("tells the model to offer the team, never a colour search or a preorder", () => {
    const s = buildKeyedModelSummary(empty, "he", true);
    expect(s).toMatch(/offer to pass the question to the team/);
    expect(s).toMatch(/never that the store lacks it/);
    expect(s).toMatch(/do NOT offer a preorder/);
    expect(s).not.toMatch(/Offer ONE controlled refinement/);
  });
  it("a budgeted empty search still asks for the real lowest price", () => {
    expect(buildKeyedModelSummary({ ...empty, appliedFilters: ["query", "budget"], budget: { currency: "ILS", target: 100 } }, "he", true)).toMatch(/WITHOUT price_max/);
  });
  it("her reply gets the team offer", () => {
    const r = withTeamOffer("לא מצאתי משטח בשם שמתאים לתמי 4. חיפוש לפי צבע עשוי לעזור.", "he");
    expect(r).toMatch(/רוצים שאעביר את השאלה לצוות שיחזור אליכם\?$/);
  });
  it("the bot adds it on an empty search, only when it can hand over", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    const at = src.indexOf("empty product search: the model's reply stands");
    const block = src.slice(at, at + 700);
    expect(block).toContain('toolFunctionNames.includes("escalate_to_human")');
    expect(block).toContain("withTeamOffer(replyText, replyLocale)");
  });
});
