import { describe, it, expect } from "vitest";
import { guardCustomerReply } from "../services/reply-guard.service";

/**
 * Every input here is a real sentence Maya sent to Matan Amran on 2026-07-31,
 * or a close variant. The prompt already forbade all of it.
 *
 * The counter-tests matter as much as the removals: a guard that mangles
 * ordinary customer service replies gets switched off within a week, and then
 * protects nothing.
 */

const HE = { locale: "he" };

describe("tool names never reach the customer", () => {
  it("removes a tool name that actually ran this turn", () => {
    const r = guardCustomerReply(
      "בדקתי גם עבור check_delivery_eta, לא נמצא תיעוד של תאריך הגעה משוער.",
      { ...HE, invokedTools: ["shopify.check_delivery_eta"] },
    );
    expect(r.text).not.toContain("check_delivery_eta");
    expect(r.findings.some((f) => f.kind === "tool_name_leak")).toBe(true);
  });

  it("removes the fully-qualified name too", () => {
    const r = guardCustomerReply("I called shopify.get_fulfillment_status for you.", {
      invokedTools: ["shopify.get_fulfillment_status"],
    });
    expect(r.text).not.toContain("shopify.get_fulfillment_status");
  });

  it("leaves a reply alone when no tool name appears in it", () => {
    const clean = "בדקתי את ההזמנה שלך, היא עדיין לא נשלחה.";
    const r = guardCustomerReply(clean, { ...HE, invokedTools: ["shopify.check_delivery_eta"] });
    expect(r.text).toBe(clean);
    expect(r.changed).toBe(false);
  });
});

describe("provider errors never reach the customer", () => {
  it("strips a raw Shopify status code", () => {
    const r = guardCustomerReply("הפעולה נכשלה: shopify_400.", HE);
    expect(r.text).not.toMatch(/shopify_400/i);
    expect(r.findings.some((f) => f.kind === "provider_error_leak")).toBe(true);
  });

  it("strips the internal no_eta reason", () => {
    // The literal string the tool returned in the real conversation.
    const r = guardCustomerReply("The result was no_eta for this order.", {});
    expect(r.text).not.toContain("no_eta");
  });

  it("strips an HTTP status phrase", () => {
    const r = guardCustomerReply("We got a 404 Not Found from the provider.", {});
    expect(r.text).not.toMatch(/404 Not Found/);
  });
});

describe("internal mechanics never reach the customer", () => {
  it("removes the fulfillment-line sentence Maya actually sent", () => {
    const r = guardCustomerReply(
      "עדכון קצר: ההזמנה עדיין לא נשלחה. ניסיתי להוסיף הערה/תג לשורת המילוי, אבל נתקלה שגיאת מערכת.",
      HE,
    );
    expect(r.text).not.toContain("שורת המילוי");
    expect(r.text).not.toContain("שגיאת מערכת");
    // The legitimate half of the message survives.
    expect(r.text).toContain("ההזמנה עדיין לא נשלחה");
  });

  it("removes the tool-call count", () => {
    const r = guardCustomerReply("עשיתי עכשיו שתי בדיקות. ההזמנה עדיין לא נשלחה.", HE);
    expect(r.text).not.toContain("שתי בדיקות");
    expect(r.text).toContain("ההזמנה עדיין לא נשלחה");
    expect(r.findings.some((f) => f.kind === "tool_count_narration")).toBe(true);
  });

  it("does not touch the ordinary word 'בדקתי'", () => {
    // "I checked" is normal service language; only COUNTING tool calls is not.
    const clean = "בדקתי את ההזמנה עבורך.";
    expect(guardCustomerReply(clean, HE).text).toBe(clean);
  });
});

describe("promises need evidence", () => {
  it("removes 'I'll update you' when nothing was scheduled", () => {
    // Maya promised this at least four times. Zero scheduled messages exist.
    const r = guardCustomerReply(
      "ההזמנה עדיין לא נשלחה. אעדכן אותך כאן בוואטסאפ ברגע שההזמנה תצא לדרך.",
      { ...HE, evidence: {} },
    );
    expect(r.text).not.toContain("אעדכן אותך");
    expect(r.text).toContain("ההזמנה עדיין לא נשלחה");
    expect(r.findings.some((f) => f.kind === "unsupported_promise")).toBe(true);
  });

  it("KEEPS the same promise when a follow-up really was scheduled", () => {
    const promise = "אעדכן אותך כאן בוואטסאפ ברגע שההזמנה תצא לדרך.";
    const r = guardCustomerReply(promise, { ...HE, evidence: { followUpScheduled: true } });
    expect(r.text).toBe(promise);
    expect(r.changed).toBe(false);
  });

  it("removes 'I'm contacting the shipping team' with no task or assignment", () => {
    const r = guardCustomerReply(
      "כרגע אין צפי להגעה. אני פונה לצוות המשלוחים ואבדוק מועד משוער.",
      { ...HE, evidence: {} },
    );
    expect(r.text).not.toContain("פונה לצוות המשלוחים");
    expect(r.text).toContain("אין צפי להגעה");
  });

  it("KEEPS it when a real task was created", () => {
    const r = guardCustomerReply("אני פונה לצוות המשלוחים ואעדכן.", {
      ...HE, evidence: { taskCreated: true, followUpScheduled: true },
    });
    expect(r.text).toContain("פונה לצוות המשלוחים");
  });

  it("a Shopify note/tag write is NOT evidence of contacting a team", () => {
    // The heart of it. `update_order_fulfillment` succeeding proves a note was
    // written, nothing more - so the promise still has to go.
    const r = guardCustomerReply("סימנתי את זה לצוות המשלוחים.", {
      ...HE,
      evidence: { /* note/tag success is deliberately not an evidence field */ },
    });
    expect(r.text).not.toContain("לצוות המשלוחים");
  });

  it("NEVER allows a carrier-contact claim, whatever the evidence", () => {
    // No carrier integration exists, so no evidence can make this true.
    const r = guardCustomerReply("אני פונה לחברת השליחויות עכשיו.", {
      ...HE,
      evidence: { taskCreated: true, notificationSent: true, handoffCreated: true },
    });
    expect(r.text).not.toContain("חברת השליחויות");
  });

  it("leaves an OFFER intact - it is not a commitment", () => {
    // "Would you like me to update you?" promises nothing.
    const offer = "רוצה שאעדכן אותך כאן ברגע שיש מעקב?";
    const r = guardCustomerReply(offer, { ...HE, evidence: {} });
    expect(r.text).toContain("רוצה שאעדכן אותך");
  });
});

describe("when nothing survives", () => {
  it("substitutes an honest Hebrew fallback rather than sending an empty message", () => {
    const r = guardCustomerReply(
      "ניסיתי להוסיף הערה/תג לשורת המילוי אבל נתקלה שגיאת מערכת. אעדכן אותך בהמשך.",
      { ...HE, evidence: {} },
    );
    expect(r.emptied).toBe(true);
    expect(r.text).toContain("נציג אנושי");
    expect(r.text).not.toContain("שורת המילוי");
  });

  it("uses an English fallback for an English conversation", () => {
    const r = guardCustomerReply("I'll update you shortly.", { locale: "en", evidence: {} });
    expect(r.emptied).toBe(true);
    expect(r.text).toMatch(/colleague|could not complete/i);
  });
});

describe("it does not damage normal conversation", () => {
  const NORMAL = [
    "היי מתן! אני מיה מצוות Urban Supply, במה אפשר לעזור?",
    "ההזמנה #1006 התקבלה ועדיין לא נשלחה.",
    "אפשר לבצע את הביטול עכשיו?",
    "Your order has shipped and should arrive within three business days.",
    "I checked your order and it is still being prepared.",
    "מצטערת על העיכוב, אני כאן לכל שאלה.",
  ];

  it.each(NORMAL)("leaves %j untouched", (line) => {
    const r = guardCustomerReply(line, {
      ...HE,
      invokedTools: ["shopify.get_order", "shopify.check_delivery_eta"],
      evidence: {},
    });
    expect(r.text).toBe(line);
    expect(r.changed).toBe(false);
  });
});
