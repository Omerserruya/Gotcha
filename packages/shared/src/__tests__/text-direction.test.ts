/**
 * Direction detection is the load-bearing half of RTL support: every
 * bubble, the composer, the product cards and the carousel all read from
 * it. These cases are written from real storefront traffic shapes, not
 * from the alphabet - mixed script with a URL in it is the normal case,
 * not the edge one.
 */
import { describe, it, expect } from "vitest";
import {
  detectScriptDirection,
  resolveMessageDirection,
  messageDirection,
  directionForLocale,
  isRtlLocale,
  countStrongCharacters,
  segmentBidiText,
  needsBidiIsolation,
  textAlignFor,
  inlineStartSide,
  inlineEndSide,
} from "../lib/text-direction";

describe("detectScriptDirection - single script", () => {
  it("Hebrew is RTL", () => {
    expect(detectScriptDirection("שלום, אני מחפש נעליים")).toBe("rtl");
  });

  it("Arabic is RTL", () => {
    expect(detectScriptDirection("مرحبا، أبحث عن حذاء رياضي")).toBe("rtl");
  });

  it("Persian is RTL", () => {
    expect(detectScriptDirection("سلام، دنبال یک کفش ورزشی هستم")).toBe("rtl");
  });

  it("Urdu is RTL", () => {
    expect(detectScriptDirection("سلام، میں ایک جوتا تلاش کر رہا ہوں")).toBe("rtl");
  });

  it("English is LTR", () => {
    expect(detectScriptDirection("Hi, I am looking for running shoes")).toBe("ltr");
  });

  it("Japanese is LTR (not RTL merely because it is not Latin)", () => {
    expect(detectScriptDirection("こんにちは、靴を探しています")).toBe("ltr");
  });

  it("Cyrillic is LTR", () => {
    expect(detectScriptDirection("Здравствуйте, ищу кроссовки")).toBe("ltr");
  });
});

describe("detectScriptDirection - no strong characters", () => {
  // Null, not "ltr": the caller falls through to the conversation locale,
  // so a Hebrew shopper's thumbs-up stays on the Hebrew side.
  it.each([["👍"], ["42"], ["!!!"], ["   "], [""], ["... 3.14 ..."]])(
    "%s has no direction of its own",
    (text) => {
      expect(detectScriptDirection(text)).toBeNull();
    },
  );

  it("null and undefined are handled", () => {
    expect(detectScriptDirection(null)).toBeNull();
    expect(detectScriptDirection(undefined)).toBeNull();
  });
});

describe("detectScriptDirection - mixed script", () => {
  it("Hebrew sentence naming an English product stays RTL", () => {
    expect(detectScriptDirection("אני מחפש משהו כמו Nike Air Max 90")).toBe("rtl");
  });

  it("terse Hebrew with a long English product name stays RTL", () => {
    expect(detectScriptDirection("רוצה את Cloud Pro Runner")).toBe("rtl");
  });

  it("English sentence with one borrowed Hebrew word stays LTR", () => {
    expect(detectScriptDirection("The שלום hoodie is nice and warm")).toBe("ltr");
  });

  it("Hebrew with a Shopify URL stays RTL - the URL does not vote", () => {
    expect(
      detectScriptDirection("הנה הקישור https://demo-store.myshopify.com/products/cloud-pro"),
    ).toBe("rtl");
  });

  it("Hebrew with an email address stays RTL", () => {
    expect(detectScriptDirection("אפשר לשלוח לי ל support@demo-store.com")).toBe("rtl");
  });

  it("Hebrew with prices and numbers stays RTL", () => {
    expect(detectScriptDirection("המחיר הוא $120.00 ואפשר גם 149.99 USD")).toBe("rtl");
  });

  it("Hebrew with a SKU stays RTL", () => {
    expect(detectScriptDirection("המק״ט הוא AIR-MAX-90 נכון?")).toBe("rtl");
  });

  it("Hebrew with a phone number stays RTL", () => {
    expect(detectScriptDirection("תתקשרו אליי +972 54 123 4567")).toBe("rtl");
  });

  it("Arabic with an English product name stays RTL", () => {
    expect(detectScriptDirection("أريد شراء Cloud Pro Runner من فضلك")).toBe("rtl");
  });

  it("a URL-only message has no direction of its own", () => {
    expect(detectScriptDirection("https://demo-store.myshopify.com/products/cloud-pro")).toBeNull();
  });
});

describe("countStrongCharacters", () => {
  it("neutral atoms are excluded from the count", () => {
    const withUrl = countStrongCharacters("שלום https://shop.example.com/products/abc");
    expect(withUrl.ltr).toBe(0);
    expect(withUrl.rtl).toBe(4);
    expect(withUrl.rtlShare).toBe(1);
  });

  it("an empty string yields a zero share rather than NaN", () => {
    expect(countStrongCharacters("")).toEqual({ rtl: 0, ltr: 0, rtlShare: 0 });
  });
});

describe("isRtlLocale / directionForLocale", () => {
  it.each([
    ["he", true],
    ["he-IL", true],
    ["iw", true],
    ["ar", true],
    ["ar-SA", true],
    ["fa", true],
    ["fa-IR", true],
    ["ur", true],
    ["ur-PK", true],
    ["ps", true],
    ["en", false],
    ["en-US", false],
    ["fr", false],
    ["ja", false],
    ["", false],
  ])("%s -> rtl:%s", (locale, rtl) => {
    expect(isRtlLocale(locale)).toBe(rtl);
  });

  it("underscore-separated tags are accepted", () => {
    expect(isRtlLocale("he_IL")).toBe(true);
  });

  it("a non-string is never RTL", () => {
    expect(isRtlLocale(null)).toBe(false);
    expect(isRtlLocale(undefined)).toBe(false);
    expect(isRtlLocale(42 as unknown as string)).toBe(false);
  });

  it("an empty or absent locale gives no direction at all", () => {
    expect(directionForLocale("")).toBeNull();
    expect(directionForLocale(null)).toBeNull();
    expect(directionForLocale("  ")).toBeNull();
  });
});

describe("resolveMessageDirection - the priority chain", () => {
  it("1. explicit content locale beats the script in the text", () => {
    // A translated message knows its own language; the sample it carries
    // may be a quoted English product name.
    const r = resolveMessageDirection({ contentLocale: "he", text: "Cloud Pro Runner" });
    expect(r).toEqual({ direction: "rtl", source: "content_locale" });
  });

  it("2. script beats the conversation locale", () => {
    const r = resolveMessageDirection({
      text: "Sure, I can check that for you",
      conversationLocale: "he",
    });
    expect(r).toEqual({ direction: "ltr", source: "script" });
  });

  it("3. conversation locale answers when the text has no strong characters", () => {
    const r = resolveMessageDirection({ text: "👍", conversationLocale: "he" });
    expect(r).toEqual({ direction: "rtl", source: "conversation_locale" });
  });

  it("4. widget locale answers when there is no conversation locale", () => {
    const r = resolveMessageDirection({ text: "42", widgetLocale: "ar-EG" });
    expect(r).toEqual({ direction: "rtl", source: "widget_locale" });
  });

  it("5. LTR is the last resort", () => {
    expect(resolveMessageDirection({})).toEqual({ direction: "ltr", source: "default" });
  });

  it("a merchant override short-circuits everything", () => {
    const r = resolveMessageDirection({
      override: "ltr",
      contentLocale: "he",
      text: "שלום",
      conversationLocale: "he",
    });
    expect(r).toEqual({ direction: "ltr", source: "override" });
  });

  it('"auto" is not an override - it runs the chain', () => {
    const r = resolveMessageDirection({ override: "auto", text: "שלום" });
    expect(r).toEqual({ direction: "rtl", source: "script" });
  });

  it("a Hebrew conversation still renders an English agent message LTR", () => {
    // The whole point of per-message resolution.
    expect(
      messageDirection({ text: "Hi, this is Dana from support", conversationLocale: "he" }),
    ).toBe("ltr");
    expect(
      messageDirection({ text: "היי, זו דנה מהתמיכה", conversationLocale: "he" }),
    ).toBe("rtl");
  });
});

describe("segmentBidiText", () => {
  it("lifts a URL out of Hebrew prose so its punctuation cannot migrate", () => {
    const segments = segmentBidiText("בקרו כאן https://shop.example.com/products/x ותודה");
    expect(segments.map((s) => s.kind)).toEqual(["text", "isolate", "text"]);
    expect(segments[1].text).toBe("https://shop.example.com/products/x");
  });

  it("isolates prices written either way round", () => {
    expect(segmentBidiText("המחיר $120.00").find((s) => s.kind === "isolate")?.text).toBe("$120.00");
    expect(segmentBidiText("המחיר 120.00 USD").find((s) => s.kind === "isolate")?.text).toBe(
      "120.00 USD",
    );
  });

  it("isolates emails, SKUs and phone numbers", () => {
    expect(needsBidiIsolation("כתבו ל dana@example.com")).toBe(true);
    expect(needsBidiIsolation("מק״ט AIR-MAX-90")).toBe(true);
    expect(needsBidiIsolation("חייגו +972 54 123 4567")).toBe(true);
  });

  it("does NOT isolate a bare number - the bidi algorithm handles those", () => {
    expect(needsBidiIsolation("יש לי 3 מוצרים בסל")).toBe(false);
  });

  it("plain prose needs no isolation and round-trips unchanged", () => {
    const text = "שלום, איך אפשר לעזור?";
    expect(needsBidiIsolation(text)).toBe(false);
    expect(segmentBidiText(text)).toEqual([{ text, kind: "text" }]);
  });

  it("segments always reassemble into the original string", () => {
    const cases = [
      "בקרו כאן https://shop.example.com/x ותודה",
      "The price is $120.00 for SKU AIR-MAX-90",
      "מרחבا https://a.co dana@b.com +972 54 123 4567 ₪49",
      "",
      "שלום",
    ];
    for (const text of cases) {
      expect(segmentBidiText(text).map((s) => s.text).join("")).toBe(text);
    }
  });

  it("an empty string produces no segments", () => {
    expect(segmentBidiText("")).toEqual([]);
    expect(segmentBidiText(null)).toEqual([]);
  });
});

describe("physical-side helpers", () => {
  it("map direction to CSS sides", () => {
    expect(textAlignFor("rtl")).toBe("right");
    expect(textAlignFor("ltr")).toBe("left");
    expect(inlineStartSide("rtl")).toBe("right");
    expect(inlineStartSide("ltr")).toBe("left");
    expect(inlineEndSide("rtl")).toBe("left");
    expect(inlineEndSide("ltr")).toBe("right");
  });
});
