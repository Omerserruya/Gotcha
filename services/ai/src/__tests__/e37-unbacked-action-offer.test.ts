/**
 * Smoovee prod 2026-11-14 19:19 (cmwgscs7): "מובן, לאשר הוספת 1 יחידה של
 * 'סמובי אלכסה' (שחור) להזמנה מס' 97828?". No tool adds an item to an
 * order; the customer said "כן" and was handed over. ACTION-HONESTY only
 * logged it. An offer no tool can keep is rewritten now: the team does it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteUnbackedActionOffers, unbackedActionOffers, TEAM_DOES_IT } from "../services/action-honesty.service";

// Smoovee's surface that turn (Woo reads, notes, status, cancel; and the handover).
const SMOOVEE = [
  "woocommerce.list_products", "woocommerce.get_order", "woocommerce.list_customer_orders", "woocommerce.add_order_note",
  "woocommerce.update_order_status", "woocommerce.cancel_order", "escalate_to_human",
];

describe("an offer no tool can keep", () => {
  it("her add-to-order confirm question becomes the team offer", () => {
    const t = "מובן, לאשר הוספת 1 יחידה של \"סמובי אלכסה\" (שחור) להזמנה מס' 97828?";
    expect(unbackedActionOffers(t, SMOOVEE)).toEqual(["add_to_order"]);
    expect(rewriteUnbackedActionOffers(t, SMOOVEE, "he")).toBe(TEAM_DOES_IT.offer.he);
    // An acknowledgement left alone ("מובן.") is not kept in front of the line.
    expect(rewriteUnbackedActionOffers("מובן. לאשר הוספת אלכסה להזמנה 97828?", SMOOVEE, "he")).toBe(TEAM_DOES_IT.offer.he);
  });

  it("the rest of the reply stays; without a handover tool there is no offer to pass it on", () => {
    const t = "מצאתי את ההזמנה 97828. רוצה שאוסיף את אלכסה השחור להזמנה?";
    const out = rewriteUnbackedActionOffers(t, SMOOVEE.filter((n) => n !== "escalate_to_human"), "he");
    expect(out).toBe(`מצאתי את ההזמנה 97828.\n${TEAM_DOES_IT.plain.he}`);
  });

  it("English too", () => {
    expect(rewriteUnbackedActionOffers("Shall I add the black Alexa to your order 97828?", SMOOVEE, "en")).toBe(TEAM_DOES_IT.offer.en);
  });

  it("kept when a tool can do it: cancel on Smoovee, add on a store with an order-edit tool", () => {
    expect(rewriteUnbackedActionOffers("לאשר ביטול של ההזמנה 97828?", SMOOVEE, "he")).toBeNull();
    expect(rewriteUnbackedActionOffers("לאשר הוספת אלכסה להזמנה 97828?", [...SMOOVEE, "shopify.edit_order"], "he")).toBeNull();
  });

  it("refund and address offers with no tool are rewritten", () => {
    expect(unbackedActionOffers("לאשר החזר כספי על ההזמנה?", SMOOVEE)).toEqual(["refund"]);
    expect(unbackedActionOffers("לעדכן את הכתובת בהזמנה?", SMOOVEE)).toEqual(["change_address"]);
  });

  it("plain talk about an order is not an offer", () => {
    for (const t of [
      "מצאתי את ההזמנה מס' 97828 על שם מיכל פרל (מצב: בהכנה).",
      "איזה פריט תרצו להוסיף? ציינו שם משטח.",
      "אפשר להוסיף את אלכסה לסל באתר.",
      "המעצור לא רלוונטי לבר מים.",
    ]) expect(rewriteUnbackedActionOffers(t, SMOOVEE, "he")).toBeNull();
  });

  it("the turn runs it after ACTION-HONESTY, with the turn's own tool surface", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain("const rewritten = rewriteUnbackedActionOffers(replyText, toolFunctionNames, replyLocale);");
    expect(src.indexOf("rewriteUnbackedActionOffers(replyText")).toBeGreaterThan(src.indexOf("const honesty = validateActionHonesty(replyText"));
  });
});
