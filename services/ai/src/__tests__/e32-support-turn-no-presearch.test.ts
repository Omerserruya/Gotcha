/**
 * Demo Factory 2026-11-10 (GOTCHA Demo): "התקנתי את הסוויצ'ר והאפליקציה לא
 * מוצאת אותו" got good troubleshooting, then a five-product carousel from the
 * pre-search (decision presearch2). A support turn is never searched for
 * before the model writes, nor pressed to search; shopping asks still are.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { supportTurn, storeProductAsk } from "../services/woo-chat-turn.service";

describe("a support turn", () => {
  it("the Demo repro, faults, setting up, an order, a return: support", () => {
    for (const t of [
      "התקנתי את הסוויצ'ר והאפליקציה לא מוצאת אותו",
      "המתג לא עובד",
      "זה לא מתחבר לוויי פיי",
      "יש תקלה במכשיר",
      "איך להתקין את המתג?",
      "איפה ההזמנה שלי?",
      "מספר הזמנה 1234 לא הגיע",
      "אני רוצה להחזיר את המשטח",
      "אפשר לבטל את ההזמנה?",
      "the switch is not working",
      "where is my order",
      "I want a refund",
      "it won't connect",
    ]) expect(supportTurn(t), t).toBe(true);
  });
  it("Smoovee's real shopping asks (prod 2026-11-08) and plain product asks: not support, and still searched", () => {
    const shopping = [
      "מה יש לך לתמי 4?",
      "מה יתאים למכונת קפה של נספרסו?",
      "ולגבי מיקסר של קיטצן איד ? 40*20",
      "מה יש כרגע במלאי?",
      "איזה מוצר מתאים למכונת קפה של נינג'ה",
      "יש לכם משטח לבן?",
      "do you have a white mat?",
    ];
    for (const t of shopping) {
      expect(supportTurn(t), t).toBe(false);
    }
    // The ones prod's log shows as store-ask searches still are.
    for (const t of ["מה יש לך לתמי 4?", "מה יש כרגע במלאי?", "איזה מוצר מתאים למכונת קפה של נינג'ה", "יש לכם משטח לבן?"]) expect(storeProductAsk([], t), t).toBe(true);
  });
});

describe("wired into every pre-search path", () => {
  const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  it("presearch2, the store-ask search, the 'search now' nudge and the discovery force all step aside", () => {
    expect(src).toContain("&& !storeQuestion(opts.incomingMessage)\n    && !supportTurn(opts.incomingMessage)\n    // A colour or a size");
    expect(src).toContain("storeProductAsk(messages as any[], opts.incomingMessage)\n    && !supportTurn(opts.incomingMessage)) {");
    expect(src).toContain("namesProduct(opts.incomingMessage ?? \"\") && !storeQuestion(opts.incomingMessage)\n    && !supportTurn(opts.incomingMessage)) {");
    expect(src).toContain("if (!supportAsk) try {\n    const disc = await runProductDiscoveryTurn({");
  });
});
