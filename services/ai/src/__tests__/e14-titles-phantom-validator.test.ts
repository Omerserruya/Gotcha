/**
 * Eval e14 on f9391efa (2026-10-26), the AD batch: English titles still in the
 * Hebrew sentence beside the cards, "רשמנו את המספר" with nothing recorded, a
 * right answer ("לא מצאנו את ההזמנה 1043 במערכת שלנו") blocked into "לא הבנתי",
 * "הסתכל" and "מציג", card narration, and an effort switch for the reply call.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { checkReplyStyle, polishReply, phantomActions } from "../services/reply-style-check.service";
import { validateAssistantOutput } from "../services/output-validator.service";
import { deliverableReply, replyReasoningEffort } from "../services/ai-bot.service";

const he = (t: string, o: any = {}) => polishReply(t, { locale: "he", ...o });
const ctx = (o: any = {}) => ({ locale: "he" as const, isFirstReply: false, incomingMessage: "", productFactsAvailable: true, shopFloor: true, toolsOffered: ["woocommerce.list_products", "link_customer_identifier", "escalate_to_human"], customerClosing: false, ...o });

describe("AD1: with cards out, a title followed by its Hebrew description loses the title", () => {
  const titles = ["Cotton Trench Coat", "Chunky Cardigan"];
  it("B04 / K01, the store titles from the search", () => {
    expect(he("שתי אפשרויות: Cotton Trench Coat, טרנץ' כותנה קל לשכבות, Chunky Cardigan, סריג עבה ונוח ליום-יום. טרנץ' או סריג?", { productTitles: titles, cardsShown: true }))
      .toBe("שתי אפשרויות: טרנץ' כותנה קל לשכבות, סריג עבה ונוח ליום-יום. טרנץ' או סריג?");
  });
  it("titles the search did not return (a card the model sent itself)", () => {
    expect(he("Oxford Button-Down Shirt, חולצה קלאסית, Relaxed Linen Shirt, פשתן קליל.", { cardsShown: true }))
      .toBe("חולצה קלאסית, פשתן קליל.");
  });
  it("no cards, or one title: the name stays (it is the only place it is said)", () => {
    const t = "Cotton Trench Coat, טרנץ' כותנה קל, Chunky Cardigan, סריג עבה.";
    expect(he(t, { productTitles: titles })).toBe(t);
    expect(he("ה-Chunky Cardigan, סריג עבה, עולה ₪529.", { productTitles: titles, cardsShown: true })).toBe("ה-Chunky Cardigan, סריג עבה, עולה ₪529.");
  });
});

describe("AD2: \"רשמנו את המספר\" with nothing recorded is a phantom on the shop floor", () => {
  it("C02 turn 2", () => {
    expect(phantomActions("רשמנו את המספר 0521234567. מתי נוח?", { toolsOffered: ctx().toolsOffered, incomingMessage: "0521234567", toolsCalled: [], shopFloor: true })).toContain("רשמנו");
    expect(checkReplyStyle("רשמנו את המספר 0521234567.", ctx({ toolsCalled: [] })).map((v) => v.kind)).toContain("phantom_action");
  });
  it("recorded for real this turn: not a phantom", () => {
    expect(phantomActions("רשמנו את המספר.", { toolsOffered: ctx().toolsOffered, incomingMessage: "", toolsCalled: ["link_customer_identifier"], shopFloor: true })).toEqual([]);
  });
  it("a sales employee's \"רשמתי את המייל\" (Quality Contract 2a) with a CRM to write to is not flagged", () => {
    expect(phantomActions("מעולה, רשמתי את המייל.", { toolsOffered: ["create_lead"], incomingMessage: "a@b.co", toolsCalled: [], shopFloor: false })).toEqual([]);
  });
});

describe("AD3: a lookup result \"במערכת שלנו\" is not an internal-ops leak", () => {
  it("C04's real answer passes the validator", () => {
    expect(validateAssistantOutput("לא מצאנו את ההזמנה 1043 במערכת שלנו.", { tenantId: "t", conversationId: "c" }).ok).toBe(true);
  });
  it("recording into the system still is", () => {
    expect(validateAssistantOutput("רשמתי את הפרטים שלך במערכת.", { tenantId: "t", conversationId: "c" }).ok).toBe(false);
    expect(validateAssistantOutput("עדכנו את זה ב-CRM.", { tenantId: "t", conversationId: "c" }).ok).toBe(false);
  });
  it("and if the deflection still comes back after a 404 lookup, the order line goes instead", () => {
    const miss = { tool: "woocommerce.get_order", args: { order_id: "1043" }, result: '{"ok":false,"reason":"woocommerce_404"}' };
    expect(deliverableReply({ safeReply: "סליחה, לא הבנתי עד הסוף. אפשר לפרט קצת?", pendingEscalation: false, awaitingApproval: false, toolCallLog: [miss], locale: "he" }))
      .toBe("לא מצאנו הזמנה עם המספר 1043. אפשר לבדוק את המספר ולשלוח שוב?");
    expect(deliverableReply({ safeReply: "סליחה, לא הבנתי עד הסוף. אפשר לפרט קצת?", pendingEscalation: false, awaitingApproval: false, toolCallLog: [], locale: "he" }))
      .toBe("סליחה, לא הבנתי עד הסוף. אפשר לפרט קצת?");
  });
});

describe("AD4: \"הסתכל\" and a masculine \"מציג\" from a female persona", () => {
  it("E05 \"הסתכל על\"", () => {
    expect(checkReplyStyle("הסתכל על הכרטיס.", ctx()).map((v) => v.kind)).toContain("gendered_address");
    expect(checkReplyStyle("תסתכלי על הצבעים.", ctx()).map((v) => v.kind)).toContain("gendered_address");
  });
  it("F01 \"מציג\" opening a sentence", () => {
    expect(checkReplyStyle("מציג את החולצה בלבן.", ctx({ employeeGender: "feminine" })).map((v) => v.kind)).toContain("self_gender");
    expect(checkReplyStyle("הנה החולצה בלבן.", ctx({ employeeGender: "feminine" })).map((v) => v.kind)).not.toContain("self_gender");
    expect(checkReplyStyle("הכרטיס מציג את המחיר.", ctx({ employeeGender: "feminine" })).map((v) => v.kind)).not.toContain("self_gender");
  });
});

describe("AD5: card narration and \"מכופרת\"", () => {
  it("a sentence narrating the cards goes, the answer stays", () => {
    expect(he("יש בלבן במידה M. הצגתי אותה עבורך למטה.")).toBe("יש בלבן במידה M.");
    expect(he("שתי חולצות מתאימות. מציגים אותן למטה.")).toBe("שתי חולצות מתאימות.");
  });
  it("a reply that is only narration is left for the checker", () => {
    expect(he("הצגתי אותה עבורך למטה.")).toBe("הצגתי אותה עבורך למטה.");
  });
  it("מכופרת is מכופתרת", () => {
    expect(he("חולצה מכופרת לבנה.")).toBe("חולצה מכופתרת לבנה.");
    expect(he("חולצות מכופרות.")).toBe("חולצות מכופתרות.");
  });
});

describe("AD6: the reply call's reasoning effort is an env switch", () => {
  it("only values the model accepts; unset is the default", () => {
    expect(replyReasoningEffort("medium")).toBe("medium");
    expect(replyReasoningEffort(" LOW ")).toBe("low");
    expect(replyReasoningEffort(undefined)).toBeUndefined();
    expect(replyReasoningEffort("max")).toBeUndefined();
  });
  it("wired to the main reply call only, recorded on the audit, and logged per turn", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    // The answer round may take AI_ANSWER_EFFORT instead (urban-e25 trial); otherwise replyEffort.
    expect(src.match(/: replyEffort \? \{ reasoningEffort: replyEffort \} : \{\}\)/g)).toHaveLength(1);
    expect(src).toContain('replyEffort: replyEffort ?? (process.env.OPENAI_REASONING_EFFORT || "low"),');
    expect(src).toMatch(/\[ai-bot\]\[latency\] conv=/);
  });
});
