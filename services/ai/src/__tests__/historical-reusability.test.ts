import { describe, it, expect } from "vitest";
import { judgeSpecificity, redactSpecifics } from "../services/historical-intelligence/specificity";
import { analyzeBrandVoice, isPlaceholder, type VoiceMessage } from "../services/historical-intelligence/brand-voice";

// The rework replaced "was this asked twice" with "is this reusable". These
// tests pin the difference, because the failure it guards against is silent:
// a filter that is slightly too strict deletes the rare knowledge nobody has
// written down, and nothing in the output says it happened.

describe("judgeSpecificity", () => {
  it("keeps a policy that was only ever stated once", () => {
    const v = judgeSpecificity({
      question: "האם אפשר לאסוף הזמנה בשבת?",
      answer: "איסוף עצמי אפשרי בימים א-ה בלבד, לא בשבת.",
      scope: "standing_rule",
      generalized: true,
    });
    expect(v.ok).toBe(true);
  });

  it("keeps the numbers that MAKE a policy", () => {
    // A rule stripped of its numbers is not a rule. Four digits and fewer must
    // survive: days, percentages, prices.
    for (const answer of ["החזרה תוך 45 יום", "משלוח חינם מעל 199 ש\"ח", "20% הנחה לחברי מועדון", "אנחנו פתוחים עד 2026"]) {
      expect(judgeSpecificity({ question: "מה המדיניות?", answer, scope: "standing_rule", generalized: true }).ok).toBe(true);
    }
  });

  it("rejects one customer's order, tracking code, phone, email and address", () => {
    const cases: Array<[string, string]> = [
      ["order-or-tracking-number", "ההזמנה שלך 104325 יצאה למשלוח"],
      ["order-or-tracking-number", "מספר המעקב הוא RR123456789IL"],
      ["phone-number", "אפשר להתקשר אליי ל-050-918-1076"],
      ["email-address", "שלחתי לך מייל ל-dana@example.com"],
      ["personal-address", "המשלוח יגיע לרחוב הרצל 15"],
      ["specific-calendar-date", "האירוע שלך נקבע ל-15/03/2026"],
      ["id-number", "ת.ז שלך 123456789 נרשמה"],
    ];
    for (const [reason, answer] of cases) {
      const v = judgeSpecificity({ question: "מתי מגיע?", answer, scope: "standing_rule", generalized: true });
      expect(v.ok, answer).toBe(false);
      expect(v.reasons, answer).toContain(reason);
    }
  });

  it("drops what the model itself called a one-off, and what it says is not generalized", () => {
    expect(judgeSpecificity({ question: "מה שלום ההזמנה", answer: "יצאה אתמול", scope: "one_off", generalized: true }).ok).toBe(false);
    expect(judgeSpecificity({ question: "מה שלום ההזמנה", answer: "יצאה אתמול", scope: "standing_rule", generalized: false }).ok).toBe(false);
  });

  it("redaction rescues a real policy wearing one customer's order id", () => {
    const answer = "ההזמנה 104325 תצא מחר, אנחנו תמיד שולחים תוך 3 ימי עסקים";
    expect(judgeSpecificity({ question: "מתי נשלח?", answer, scope: "standing_rule", generalized: true }).ok).toBe(false);

    const redacted = redactSpecifics(answer);
    expect(redacted).not.toContain("104325");
    expect(redacted).toContain("3 ימי עסקים");
    expect(judgeSpecificity({ question: "מתי נשלח?", answer: redacted, scope: "standing_rule", generalized: true }).ok).toBe(true);
  });
});

describe("analyzeBrandVoice", () => {
  const at = (d: number) => new Date(2026, 0, d);
  const msg = (conversationId: string, body: string, day: number): VoiceMessage => ({ conversationId, body, at: at(day) });

  it("ignores the platform's placeholders for non-text content", () => {
    expect(isPlaceholder("[image message]")).toBe(true);
    expect(isPlaceholder("[media_placeholder message]")).toBe(true);
    expect(isPlaceholder("[Location: 31.812, 34.6624]")).toBe(true);
    // A real message that merely mentions one is not a placeholder.
    expect(isPlaceholder("שלחתי לך [image message] תראי")).toBe(false);

    const stats = analyzeBrandVoice([
      msg("c1", "[image message]", 1),
      msg("c1", "היי אהובה ❤️", 2),
    ]);
    expect(stats.messagesAnalyzed).toBe(1);
    expect(stats.openers[0]?.value ?? "").not.toContain("[image message]");
  });

  it("counts the emoji palette by frequency", () => {
    const stats = analyzeBrandVoice([
      msg("c1", "היי ❤️", 1), msg("c2", "תודה ❤️", 1), msg("c3", "שלום 🌷", 1),
    ]);
    expect(stats.emojis[0].value).toBe("❤️");
    expect(stats.emojis[0].count).toBe(2);
    expect(stats.emojiMessageShare).toBe(1);
  });

  it("treats a template addressed by name as one habit, not many", () => {
    const stats = analyzeBrandVoice([
      msg("c1", "ג'ני, תודה על הזמנתך", 1), msg("c1", "עוד משהו?", 2),
      msg("c2", "לאה, תודה על הזמנתך", 1), msg("c2", "עוד משהו?", 2),
      msg("c3", "מיכל, תודה על הזמנתך", 1), msg("c3", "עוד משהו?", 2),
    ]);
    const opener = stats.openers.find((o) => o.value.startsWith("{name},"));
    expect(opener?.count).toBe(3);
  });

  it("reassembles a canned paragraph instead of listing its sliding windows", () => {
    // The failure this replaced: one auto-reply filled eleven of fifteen
    // signature-phrase slots as overlapping 6-grams of equal count.
    const canned = "תודה שיצרת קשר עם מינרז איך אפשר לעזור אני מזמינה אותך לעקוב אחרינו באינסטגרם";
    const messages: VoiceMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg(`c${i}`, canned, 1));
      messages.push(msg(`c${i}`, "אין בעיה מותק", 2));
    }
    const stats = analyzeBrandVoice(messages, 10);
    const fragments = stats.signaturePhrases.filter((p) => canned.includes(p.value));
    // Some fragments may survive, but they must not crowd out everything else.
    expect(fragments.length).toBeLessThanOrEqual(3);
    expect(stats.signaturePhrases.some((p) => p.value.includes("אין בעיה"))).toBe(true);
  });

  it("separates openers from closers within a conversation", () => {
    const stats = analyzeBrandVoice([
      msg("c1", "היי 😊 תודה שפניתם", 1), msg("c1", "משהו באמצע", 2), msg("c1", "בשמחה!", 3),
      msg("c2", "היי 😊 תודה שפניתם", 1), msg("c2", "עוד משהו", 2), msg("c2", "בשמחה!", 3),
    ]);
    expect(stats.openers[0].value).toContain("היי");
    expect(stats.closers[0].value).toContain("בשמחה");
  });
});

describe("renderObservedVoice", () => {
  it("labels the examples and lists only the counted emoji", async () => {
    const { renderObservedVoice } = await import("../services/historical-intelligence/brand-voice.stage");
    const out = renderObservedVoice({
      summary: "Warm, short, heart-heavy.",
      guidance: "- Open with היי\n- Keep replies under five words",
      emojiPalette: ["❤️", "🩷"],
      greetingExample: "היי אהובה ❤️",
      closingExample: "באהבה",
    });
    expect(out).toContain("Warm, short, heart-heavy.");
    expect(out).toContain("- Open with היי");
    expect(out).toContain("❤️ 🩷");
    // Examples must read as examples. An unlabelled line in a system prompt is
    // an instruction, and the agent would open every chat with that exact text.
    expect(out).toContain('Example opening in their voice: "היי אהובה ❤️"');
    expect(out).toContain('Example closing in their voice: "באהבה"');
  });

  it("omits empty parts instead of emitting blank labels", async () => {
    const { renderObservedVoice } = await import("../services/historical-intelligence/brand-voice.stage");
    const out = renderObservedVoice({
      summary: "Plain and direct.",
      guidance: "- No emoji",
      emojiPalette: [],
      greetingExample: "",
      closingExample: "",
    });
    expect(out).not.toContain("Example opening");
    expect(out).not.toContain("Example closing");
    expect(out).not.toContain("Emoji this business actually uses");
  });
});

describe("parseItems", () => {
  const good = (over: Record<string, unknown> = {}) => ({
    topic: "Returns",
    category: "RETURNS_AND_CANCELLATION",
    question: "האם אפשר להחזיר?",
    answer: "כן, תוך 14 יום",
    reasoning: "They check whether the item is unworn first.",
    scope: "standing_rule",
    generalized: true,
    quotedQuestion: "אפשר להחזיר את זה?",
    quotedAnswer: "כן בטח, תוך 14 יום",
    ...over,
  });

  it("keeps the good items when one is malformed", async () => {
    const { parseItems } = await import("../services/historical-intelligence/knowledge-extraction.stage");
    // The measured production failure: one bad item discarded eight good ones,
    // losing 27% of conversations. A bad item must cost exactly itself.
    const out = parseItems([good(), { topic: "x" }, good({ question: "מתי נפתחים?" })]);
    expect(out).toHaveLength(2);
  });

  it("accepts the short answers Hebrew actually uses", async () => {
    const { parseItems } = await import("../services/historical-intelligence/knowledge-extraction.stage");
    for (const answer of ["כן", "בשמחה", "אין בעיה"]) {
      const out = parseItems([good({ answer, quotedAnswer: answer })]);
      expect(out, answer).toHaveLength(1);
      expect(out[0].answer).toBe(answer);
    }
  });

  it("coerces a scope value written into category instead of dropping the item", async () => {
    const { parseItems } = await import("../services/historical-intelligence/knowledge-extraction.stage");
    // The model confuses the two enums because the prompt asks for both.
    const out = parseItems([good({ category: "PROCESS" }), good({ category: "PRODUCT" })]);
    expect(out).toHaveLength(2);
    expect(out.every((i) => i.category === "OTHER")).toBe(true);
  });

  it("survives a missing reasoning rather than losing the answer", async () => {
    const { parseItems } = await import("../services/historical-intelligence/knowledge-extraction.stage");
    const out = parseItems([good({ reasoning: undefined })]);
    expect(out).toHaveLength(1);
    expect(out[0].reasoning).toContain("Not stated");
  });

  it("ignores non-objects without throwing", async () => {
    const { parseItems } = await import("../services/historical-intelligence/knowledge-extraction.stage");
    expect(parseItems([null, "nope", 42, good()])).toHaveLength(1);
  });
});

describe("placeholders are not answers", () => {
  it("rejects an answer that is only the platform's media marker", () => {
    // Measured on the first live run: "how much is a child's meal?" was stored
    // with the answer "[media_placeholder message]". A menu really was sent,
    // but that is not something a customer can be told.
    const v = judgeSpecificity({
      question: "כמה עולה מנת ילד?",
      answer: "[media_placeholder message]",
      scope: "standing_rule",
      generalized: true,
    });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain("placeholder-not-an-answer");
  });

  it("still accepts a question that merely mentions an image was sent", () => {
    const v = judgeSpecificity({
      question: "אפשר לקבל את התפריט?",
      answer: "כן, אנחנו שולחים את התפריט המלא בוואטסאפ",
      scope: "how_we_work",
      generalized: true,
    });
    expect(v.ok).toBe(true);
  });
});

describe("openers and closers carry a quotable example", () => {
  const at = (d: number) => new Date(2026, 0, d);
  const msg = (conversationId: string, body: string, day: number) => ({ conversationId, body, at: at(day) });

  it("keeps the full message behind the grouping head", () => {
    // The head groups; the example is what a model can quote. Without this the
    // brand voice shipped a closing cut off mid-clause into every prompt.
    const long = "חשוב לנו לציין שאנחנו סוגרים תאריכים רק אחרי חתימה על חוזה";
    const messages = [
      msg("c1", "היי", 1), msg("c1", long, 2),
      msg("c2", "היי", 1), msg("c2", "חשוב לנו לציין שאנחנו כאן", 2),
    ];
    const stats = analyzeBrandVoice(messages, 10);
    const closer = stats.closers.find((c) => c.value.startsWith("חשוב לנו לציין"));
    expect(closer?.count).toBe(2);
    // The longest full message wins - a complete sentence characterises the
    // habit better than whichever thread was processed first.
    expect(closer?.example).toBe(long);
  });

  it("omits the example when the head is already the whole message", () => {
    const stats = analyzeBrandVoice([
      msg("c1", "היי", 1), msg("c1", "בשמחה", 2),
      msg("c2", "היי", 1), msg("c2", "בשמחה", 2),
    ], 10);
    expect(stats.closers.find((c) => c.value === "בשמחה")?.example).toBeUndefined();
  });
});

describe("analysis progress never goes backwards", () => {
  it("resets both halves of the bar, not just customer learning", async () => {
    // A rerun that cleared customersAnalyzed but left conversationsExtracted at
    // the previous run's total made the bar read 85% the moment extraction
    // started, then drop to 54% when the first batch wrote the real count.
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/services/historical-intelligence/index.ts", "utf8");
    const reset = src.slice(src.indexOf("status: \"IDENTITY_RESOLUTION\""), src.indexOf("failureReason: null"));
    for (const field of ["customersAnalyzed: 0", "conversationsExtracted: 0", "conversationsEligible: 0"]) {
      expect(reset, `rerun must reset ${field}`).toContain(field);
    }
  });
});

describe("scope and category cannot be confused", () => {
  it("uses vocabularies that do not look alike", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/services/historical-intelligence/knowledge-extraction.stage.ts", "utf8");
    // Both fields were SCREAMING_SNAKE and the model put PROCESS/PRODUCT where a
    // category belonged. While the call failed outright the retry corrected it;
    // once items were parsed individually the bad value was coerced silently and
    // 263 of 266 candidates came back as OTHER. The vocabularies must stay
    // visibly different so the confusion cannot return.
    expect(src).toContain('"standing_rule", "product_fact", "how_we_work", "one_off"');
    for (const scope of ["standing_rule", "product_fact", "how_we_work", "one_off"]) {
      expect(scope, `${scope} must not look like a category`).toBe(scope.toLowerCase());
    }
  });

  it("still drops a one-off under the new spelling", () => {
    expect(judgeSpecificity({
      question: "מה קורה עם ההזמנה",
      answer: "יצאה אתמול",
      scope: "one_off",
      generalized: true,
    }).ok).toBe(false);
  });
});
