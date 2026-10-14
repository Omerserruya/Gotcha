/**
 * ★ W10: which language a customer wrote in, and which merchant texts need
 * translating into it.
 */
import { describe, it, expect } from "vitest";
import { visitorLocaleOf, textLocaleOf, textsToTranslate, widgetTextsOf } from "../widget-language";
import { normalizeShopifyChatUx } from "../shopify-chat-ux";

describe("★ the customer's language", () => {
  it("Hebrew by any Hebrew letter; English by two words; too short to tell is null", () => {
    expect(visitorLocaleOf("היי, יש לכם משלוחים?")).toBe("he");
    expect(visitorLocaleOf("Do you ship to Eilat?")).toBe("en");
    expect(visitorLocaleOf("hi there")).toBe("en");
    for (const t of ["ok", "👍", "12345", "", null, "?"]) expect(visitorLocaleOf(t as any)).toBeNull();
  });
});

describe("★ which texts to translate", () => {
  it("a text in the other language is translated; one already in it, or too short to tell, is not", () => {
    const texts = { a: "שלום! איך אפשר לעזור?", b: "How can we help?", c: "Hi", d: "🙂", e: "Привет, чем помочь?" };
    expect(textsToTranslate(texts, "en")).toEqual({ a: texts.a, e: texts.e });
    expect(textsToTranslate(texts, "he")).toEqual({ b: texts.b, e: texts.e });
    expect(textLocaleOf("Hi")).toBeNull();
  });

  it("the merchant's texts by key; the assistant's name is never among them", () => {
    const ux = normalizeShopifyChatUx({
      welcome: { title: "ברוכים הבאים", subtitle: "נשמח לעזור", assistantName: "נועה", suggestedQuestions: ["מה זמני המשלוח?", "יש החזרות?"] },
      launcher: { label: "צריכים עזרה?" },
      proactive: { enabled: true, title: "רגע!", message: "יש לנו מבצע", actionLabel: "ספרו לי" },
    });
    const t = widgetTextsOf(ux, "אנחנו לא זמינים כרגע");
    expect(t).toMatchObject({
      "welcome.title": "ברוכים הבאים", "welcome.subtitle": "נשמח לעזור",
      "welcome.suggestedQuestions.0": "מה זמני המשלוח?", "welcome.suggestedQuestions.1": "יש החזרות?",
      "launcher.label": "צריכים עזרה?", "proactive.message": "יש לנו מבצע", "offline.message": "אנחנו לא זמינים כרגע",
    });
    expect(Object.values(t)).not.toContain("נועה");
    // A teaser that is off is not shown, so not translated.
    const off = widgetTextsOf(normalizeShopifyChatUx({ proactive: { enabled: false, message: "יש לנו מבצע" } }), "x");
    expect(Object.keys(off).filter((k) => k.startsWith("proactive."))).toEqual([]);
  });
});
