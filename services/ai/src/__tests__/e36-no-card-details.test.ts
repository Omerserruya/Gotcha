/**
 * Smoovee prod 2026-11-15 06:44 to 06:48 (cmwhgsog): the bot asked a customer
 * for her card's last four digits, repeated them back ("ארבע הספרות האחרונות
 * 4155 התקבלו"), and wrote them into the escalation's reason. The bot never
 * asks for card details now, and never writes them anywhere.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripCardAsk, redactCardDetails, redactCardDetailsInArgs, mentionsCardDetails, PAYMENT_CHECK_LINE } from "../services/card-details-guard";

vi.mock("@chatcenter/shared", async (importOriginal) => ({ ...(await importOriginal<any>()) }));

describe("the reply never asks for card details", () => {
  it("her 06:44 ask: the card sentence goes, the screenshot ask stays", () => {
    const t = "אפשר בבקשה לשלוח צילום מסך ברור של אישור התשלום? או לציין את ארבע הספרות האחרונות של הכרטיס?";
    const out = stripCardAsk(t, "he");
    expect(out).toBe("אפשר בבקשה לשלוח צילום מסך ברור של אישור התשלום?");
  });

  it("a reply that is only the card ask becomes the order-number ask", () => {
    expect(stripCardAsk("אפשר לציין את ארבע הספרות האחרונות של הכרטיס?", "he")).toBe(PAYMENT_CHECK_LINE.he);
    expect(stripCardAsk("Could you share the last 4 digits of your credit card?", "en")).toBe(PAYMENT_CHECK_LINE.en);
    expect(stripCardAsk("What is the card number and the CVV?", "en")).toBe(PAYMENT_CHECK_LINE.en);
  });

  it("repeating them back is dropped too (06:45:48)", () => {
    const t = "תודה, ארבע הספרות האחרונות 4155 התקבלו; נדרש אישור קצר מצדנו לפני השלמת ההזמנה.";
    expect(stripCardAsk(t, "he")).not.toMatch(/4155|ספרות/);
  });

  it("orders, payments and prices are not card details", () => {
    for (const t of [
      "אפשר את מספר ההזמנה כדי שנמצא אותה מהר יותר?",
      "שילמתי באשראי, מה מספר ההזמנה?",
      "התשלום באשראי אושר, מספר ההזמנה 97884.",
      "We have store credit for order 1234.",
      "סמובי אלכסה, משטח הזזה 35*28 ס\"מ, ₪143.01",
      "The product card below shows the price.",
    ]) {
      expect(mentionsCardDetails(t)).toBe(false);
      expect(stripCardAsk(t, /[א-ת]/.test(t) ? "he" : "en")).toBe(t);
    }
  });
});

describe("nothing we store or hand on carries card digits", () => {
  it("her escalation reason is masked; the phone and order number stay", () => {
    const reason = "בקשת בדיקת אישור תשלום. טל' +972527907004. ארבע ספרות אחרונות כרטיס: 4155. מספר הזמנה 97112.";
    const out = redactCardDetails(reason);
    expect(out).not.toContain("4155");
    expect(out).toContain("****");
    expect(out).toContain("+972527907004");
    expect(out).toContain("97112");
  });

  it("digits written before the words, a full card number, and English", () => {
    expect(redactCardDetails("4155 זה הספרות האחרונות של כרטיס האשראי")).not.toContain("4155");
    expect(redactCardDetails("card 4580 1234 5678 9012 please")).toContain("[card number removed]");
    expect(redactCardDetails("Customer gave credit card ending 4155")).not.toContain("4155");
    expect(redactCardDetails("Order #1234 for store credit")).toContain("1234");
    // A five-digit order number next to a card word is never partly masked.
    expect(redactCardDetails("הזמנה 97112 שולמה בכרטיס אשראי")).toContain("97112");
    expect(redactCardDetails("כרטיס אשראי, הזמנה 97112")).toContain("97112");
  });

  it("every string in a tool's args is redacted, others untouched", () => {
    const args = { reason: "ארבע ספרות אחרונות כרטיס: 4155", summary: "x", priority: "high", n: 4155, tags: ["last 4 digits 4155"] };
    const out = redactCardDetailsInArgs(args);
    expect(out.reason).not.toContain("4155");
    expect(out.n).toBe(4155);
    expect(out.tags[0]).not.toContain("4155");
    expect(out.priority).toBe("high");
  });

  it("the turn's tool args and its result go through the guard, and the prompt says so", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src.match(/toolArgs = redactCardDetailsInArgs\(JSON\.parse\(tc\.function\?\.arguments \|\| "\{\}"\)\)/g)?.length).toBe(6);
    expect(src).not.toContain('try { toolArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}');
    expect(src).toContain("return guardCardDetails(result, opts.conversationId);");
    expect(src).toContain("return guardCardDetails({ ...r, interimMessages: r.interimMessages }, opts.conversationId);");
    const prompt = readFileSync(join(__dirname, "../services/prompt-builder.service.ts"), "utf8");
    expect(prompt).toContain("13h. **Never ask for payment-card details (CRITICAL)**");
  });
});
