/**
 * The whole feature turns on one distinction: what the customer wrote
 * about THEMSELVES, versus everything else. These tests are mostly about
 * everything else - the daughter, the wife, the quoted message, the name,
 * the phone number - because that is where a "gender detector" goes wrong
 * and where going wrong is worst.
 */
import { describe, it, expect } from "vitest";
import {
  detectGrammaticalEvidence,
  updateGrammaticalAddress,
  readGrammaticalAddress,
  grammaticalAddressPromptBlock,
  validateGrammaticalAgreement,
  shouldRegenerateForAddress,
  isGenderedLanguage,
  UNKNOWN_ADDRESS,
  type GrammaticalAddress,
} from "../lib/grammatical-address";

// ─── Evidence: explicit first-person ─────────────────────────

describe("explicit masculine Hebrew", () => {
  it.each([
    "אני מחפש נעליים",
    "אני מתלבט בין שתי אפשרויות",
    "אני לא בטוח מה מתאים לי",
    "אני ממש צריך את זה למחר",
    "אני כבר לא מבין מה קורה עם ההזמנה",
    "ואני מעדיף משהו יותר קליל",
  ])("%s", (text) => {
    expect(detectGrammaticalEvidence(text)).toMatchObject({
      form: "masculine",
      confidence: "explicit",
    });
  });
});

describe("explicit feminine Hebrew", () => {
  it.each([
    "אני מחפשת נעליים",
    "אני מתלבטת בין שתי אפשרויות",
    "אני לא בטוחה מה מתאים לי",
    "אני ממש צריכה את זה למחר",
    "אני כבר לא מבינה מה קורה עם ההזמנה",
    "ואני מעדיפה משהו יותר קליל",
  ])("%s", (text) => {
    expect(detectGrammaticalEvidence(text)).toMatchObject({
      form: "feminine",
      confidence: "explicit",
    });
  });
});

describe("the customer states the form outright", () => {
  it("asks for feminine", () => {
    expect(detectGrammaticalEvidence("אפשר לכתוב אליי בלשון נקבה בבקשה")).toMatchObject({
      form: "feminine",
      confidence: "explicit",
      rule: "explicit_request",
    });
  });

  it("asks for masculine", () => {
    expect(detectGrammaticalEvidence("תכתבו אליי בלשון זכר")).toMatchObject({
      form: "masculine",
      confidence: "explicit",
      rule: "explicit_request",
    });
  });
});

// ─── Ambiguity is not evidence ───────────────────────────────

describe("ambiguous Hebrew produces NO evidence", () => {
  it.each([
    // Identical in masculine and feminine without vowels.
    ["אני רוצה לקנות לעצמי"],
    ["אני מנסה להבין מה עדיף"],
    ["אני קונה את זה בכל מקרה"],
    ["אני מחכה לתשובה"],
    // Past and future carry no gender in the first person at all.
    ["הזמנתי לעצמי"],
    ["קניתי את זה בשבוע שעבר"],
    ["אזמין את זה מחר"],
    // Nothing first-person at all.
    ["מה המחיר?"],
    ["תודה רבה"],
    [""],
    ["   "],
  ])("%s", (text) => {
    expect(detectGrammaticalEvidence(text)).toEqual({ form: "unknown", confidence: "unknown" });
  });

  it("handles null and undefined", () => {
    expect(detectGrammaticalEvidence(null).form).toBe("unknown");
    expect(detectGrammaticalEvidence(undefined).form).toBe("unknown");
  });
});

// ─── Somebody else is being described ────────────────────────

describe("another person's description is never evidence", () => {
  it("הבת שלי מחפשת שמלה does not make the speaker feminine", () => {
    // The canonical case from the spec. A feminine verb, a third-person
    // subject, and nothing at all about the person typing.
    expect(detectGrammaticalEvidence("הבת שלי מחפשת שמלה")).toEqual(UNKNOWN_ADDRESS_EVIDENCE);
  });

  it.each([
    "הבן שלי צריך נעליים חדשות",
    "אשתי מחפשת מתנה",
    "בעלי מחפש מעיל",
    "אמא שלי צריכה משהו חם",
    "החברה שלי מתלבטת בין שתיים",
    "היא מחפשת משהו לאירוע",
    "הוא מחפש משהו לאירוע",
    "מישהי מחפשת את הדגם הזה",
  ])("%s", (text) => {
    expect(detectGrammaticalEvidence(text)).toEqual(UNKNOWN_ADDRESS_EVIDENCE);
  });

  it("a quoted message is somebody else's words", () => {
    expect(detectGrammaticalEvidence('היא כתבה לי "אני מחפשת שמלה"')).toEqual(
      UNKNOWN_ADDRESS_EVIDENCE,
    );
  });

  it("first-person evidence survives alongside a third party", () => {
    // "אני" governs "מחפש" directly, so the daughter later in the sentence
    // does not disqualify what the speaker said about themselves.
    expect(detectGrammaticalEvidence("אני מחפש מתנה לבת שלי")).toMatchObject({
      form: "masculine",
      confidence: "explicit",
    });
    expect(detectGrammaticalEvidence("אני מחפשת מתנה לבן שלי")).toMatchObject({
      form: "feminine",
      confidence: "explicit",
    });
  });

  it("a distant verb inside a subordinate clause is not attributed to the speaker", () => {
    // "אני יודע" is the speaker; "מחפשת" belongs to the daughter. The
    // adjacency window is what keeps those apart.
    expect(detectGrammaticalEvidence("אני יודע שהבת שלי מחפשת שמלה")).toMatchObject({
      form: "masculine",
    });
  });

  it("refuses when one message carries both forms in first person", () => {
    expect(detectGrammaticalEvidence("אני מחפש ואני מחפשת")).toEqual(UNKNOWN_ADDRESS_EVIDENCE);
  });
});

// ─── Subject-less clauses ────────────────────────────────────

describe("Hebrew chat drops the pronoun", () => {
  it("a subject-less clause is strong context, not explicit", () => {
    expect(detectGrammaticalEvidence("מחפשת נעליים בבקשה")).toMatchObject({
      form: "feminine",
      confidence: "strong_context",
      rule: "clause_subjectless",
    });
  });

  it("but not when the clause names somebody else", () => {
    expect(detectGrammaticalEvidence("הבת מחפשת נעליים")).toEqual(UNKNOWN_ADDRESS_EVIDENCE);
  });
});

// ─── Nothing else is ever evidence ───────────────────────────

describe("forbidden signals are structurally impossible", () => {
  // The function takes text and an optional locale. There is no argument
  // for a name, a phone number, an email, an avatar, an address, a
  // product or a category - so these cannot influence the result even by
  // accident. Asserted as behaviour so a future signature change fails.
  it.each([
    ["Sarah Cohen"],
    ["+972541234567"],
    ["dana@example.com"],
    ["https://cdn.shopify.com/avatars/1.jpg"],
    ["Tel Aviv, Israel"],
    ["שמלת ערב אדומה"],
    ["Women's Running Shoes"],
    ["קטגוריה: הריון ולידה"],
  ])("%s is not evidence", (text) => {
    expect(detectGrammaticalEvidence(text)).toEqual(UNKNOWN_ADDRESS_EVIDENCE);
  });

  it("a non-Hebrew locale short-circuits detection entirely", () => {
    expect(detectGrammaticalEvidence("אני מחפש נעליים", "en")).toEqual(UNKNOWN_ADDRESS_EVIDENCE);
  });
});

// ─── Mixed Hebrew and English ────────────────────────────────

describe("mixed Hebrew and English", () => {
  it("evidence survives an English product name", () => {
    expect(detectGrammaticalEvidence("אני מחפשת משהו כמו Nike Air Max 90")).toMatchObject({
      form: "feminine",
      confidence: "explicit",
    });
  });

  it("an English-only message yields nothing", () => {
    expect(detectGrammaticalEvidence("I am looking for running shoes")).toEqual(
      UNKNOWN_ADDRESS_EVIDENCE,
    );
  });
});

// ─── State transitions ───────────────────────────────────────

const NOW = new Date("2026-08-05T09:00:00.000Z");

describe("state transitions", () => {
  it("no evidence leaves the state untouched", () => {
    const current: GrammaticalAddress = { form: "feminine", confidence: "explicit", language: "he" };
    const r = updateGrammaticalAddress({ current, text: "תודה רבה", locale: "he", now: NOW });
    expect(r.changed).toBe(false);
    expect(r.next).toBe(current);
  });

  it("first evidence sets the form", () => {
    const r = updateGrammaticalAddress({
      current: null,
      text: "אני מחפשת נעליים",
      messageId: "m1",
      locale: "he",
      now: NOW,
    });
    expect(r).toMatchObject({ changed: true, corrected: false });
    expect(r.next).toEqual({
      form: "feminine",
      confidence: "explicit",
      sourceMessageId: "m1",
      language: "he",
      updatedAt: NOW.toISOString(),
    });
  });

  it("agreeing evidence may raise confidence but never lower it", () => {
    const current: GrammaticalAddress = { form: "masculine", confidence: "explicit", language: "he" };
    const weaker = updateGrammaticalAddress({ current, text: "מחפש נעליים", locale: "he", now: NOW });
    expect(weaker.changed).toBe(false);

    const raised = updateGrammaticalAddress({
      current: { form: "masculine", confidence: "strong_context", language: "he" },
      text: "אני מחפש נעליים",
      locale: "he",
      now: NOW,
    });
    expect(raised.changed).toBe(true);
    expect(raised.next.confidence).toBe("explicit");
    expect(raised.corrected).toBe(false);
  });

  it("the form changing later in the conversation is a correction that lands", () => {
    // The customer switches. This must take effect on the very next
    // reply, not after a majority vote.
    const current: GrammaticalAddress = { form: "masculine", confidence: "explicit", language: "he" };
    const r = updateGrammaticalAddress({
      current,
      text: "אני מחפשת דווקא משהו אחר",
      messageId: "m9",
      locale: "he",
      now: NOW,
    });
    expect(r).toMatchObject({ changed: true, corrected: true });
    expect(r.next.form).toBe("feminine");
    expect(r.next.sourceMessageId).toBe("m9");
  });

  it("an explicit request corrects an explicit inference", () => {
    const current: GrammaticalAddress = { form: "masculine", confidence: "explicit", language: "he" };
    const r = updateGrammaticalAddress({ current, text: "בבקשה בלשון נקבה", locale: "he", now: NOW });
    expect(r.next).toMatchObject({ form: "feminine", confidence: "explicit" });
    expect(r.corrected).toBe(true);
  });

  it("a weak contradiction does NOT overturn an explicit form", () => {
    // The anti-oscillation rule. One loose clause must not flip a form
    // the customer stated about themselves.
    const current: GrammaticalAddress = { form: "feminine", confidence: "explicit", language: "he" };
    const r = updateGrammaticalAddress({ current, text: "מחפש משהו כזה", locale: "he", now: NOW });
    expect(r.changed).toBe(false);
    expect(r.next.form).toBe("feminine");
  });

  it("does not oscillate over a run of ambiguous messages", () => {
    let state: GrammaticalAddress = { form: "feminine", confidence: "explicit", language: "he" };
    for (const text of ["אני רוצה", "אני מנסה", "תודה", "מתי זה מגיע?", "אני מחכה"]) {
      state = updateGrammaticalAddress({ current: state, text, locale: "he", now: NOW }).next;
    }
    expect(state).toMatchObject({ form: "feminine", confidence: "explicit" });
  });

  it("a Hebrew form is recorded against Hebrew, and English cannot touch it", () => {
    const current: GrammaticalAddress = { form: "feminine", confidence: "explicit", language: "he" };
    // The same customer switches to English mid-conversation. English has
    // no evidence table, so the stored Hebrew form is neither confirmed
    // nor overturned by anything they write there.
    const r = updateGrammaticalAddress({
      current,
      text: "I am looking for something else",
      locale: "en",
      now: NOW,
    });
    expect(r.changed).toBe(false);
    expect(r.next).toMatchObject({ form: "feminine", language: "he" });
  });
});

// ─── Persistence shape ───────────────────────────────────────

describe("readGrammaticalAddress", () => {
  it("round-trips a well-formed blob", () => {
    const stored = {
      form: "feminine",
      confidence: "explicit",
      sourceMessageId: "m1",
      language: "he",
      updatedAt: NOW.toISOString(),
    };
    expect(readGrammaticalAddress(stored)).toEqual(stored);
  });

  it.each([[null], [undefined], [42], ["feminine"], [{}], [{ form: "male" }], [{ form: "feminine", confidence: "sure" }]])(
    "collapses %s to unknown rather than throwing",
    (raw) => {
      expect(readGrammaticalAddress(raw)).toEqual(UNKNOWN_ADDRESS);
    },
  );

  it("drops unexpected fields - nothing extra can ride along", () => {
    const read = readGrammaticalAddress({
      form: "masculine",
      confidence: "explicit",
      customerId: "cus_1",
      gender: "male",
      evidence: ["אני מחפש"],
    });
    expect(read).toEqual({
      form: "masculine",
      confidence: "explicit",
      sourceMessageId: undefined,
      language: undefined,
      updatedAt: undefined,
    });
    expect(Object.keys(read).sort()).toEqual(
      ["confidence", "form", "language", "sourceMessageId", "updatedAt"].sort(),
    );
  });
});

// ─── Prompt block ────────────────────────────────────────────

describe("prompt block", () => {
  it("states the form, the confidence and nothing else", () => {
    const block = grammaticalAddressPromptBlock(
      { form: "feminine", confidence: "explicit", sourceMessageId: "m1", language: "he" },
      "he",
    )!;
    expect(block).toContain("feminine");
    expect(block).toContain("explicit");
    // The evidence never travels with it.
    expect(block).not.toContain("m1");
    expect(block).not.toContain("מחפשת");
  });

  it("asks for restructured neutral phrasing when nothing is known", () => {
    const block = grammaticalAddressPromptBlock(UNKNOWN_ADDRESS, "he")!;
    expect(block).toContain("איזה מוצר מעניין אותך?");
    expect(block).toContain("אפשר לבדוק עבורך");
    expect(block).toContain("RESTRUCTURING");
  });

  it("forbids slash forms in every state", () => {
    for (const state of [UNKNOWN_ADDRESS, { form: "masculine", confidence: "explicit" } as const]) {
      expect(grammaticalAddressPromptBlock(state, "he")).toContain("slash forms");
    }
  });

  it("never tells the model to ask", () => {
    for (const state of [UNKNOWN_ADDRESS, { form: "feminine", confidence: "explicit" } as const]) {
      const block = grammaticalAddressPromptBlock(state, "he")!;
      expect(block).toContain("never ask about it");
    }
  });

  it("is absent for languages with no evidence table", () => {
    expect(grammaticalAddressPromptBlock(UNKNOWN_ADDRESS, "en")).toBeNull();
    expect(grammaticalAddressPromptBlock(UNKNOWN_ADDRESS, "es")).toBeNull();
    expect(grammaticalAddressPromptBlock(UNKNOWN_ADDRESS, null)).toBeNull();
  });
});

describe("isGenderedLanguage", () => {
  it.each([["he", true], ["he-IL", true], ["ar", true], ["es", true], ["en", false], ["ja", false], ["", false]])(
    "%s -> %s",
    (locale, expected) => {
      expect(isGenderedLanguage(locale)).toBe(expected);
    },
  );
});

// ─── Reply validation ────────────────────────────────────────

describe("reply validation", () => {
  const masc: GrammaticalAddress = { form: "masculine", confidence: "explicit", language: "he" };
  const fem: GrammaticalAddress = { form: "feminine", confidence: "explicit", language: "he" };

  it("passes a masculine reply to a masculine customer", () => {
    const v = validateGrammaticalAgreement("בטח, תוכל לבחור מידה בעמוד המוצר.", masc, "he");
    expect(v.ok).toBe(true);
    expect(v.replyForm).toBe("masculine");
  });

  it("catches a feminine reply to a masculine customer", () => {
    const v = validateGrammaticalAgreement("בטח, תוכלי לבחור מידה בעמוד המוצר.", masc, "he");
    expect(v.problems).toContain("address_form_conflict");
    expect(shouldRegenerateForAddress(v)).toBe(true);
  });

  it("catches a masculine reply to a feminine customer", () => {
    const v = validateGrammaticalAgreement("תבדוק את זה בעמוד המוצר.", fem, "he");
    expect(v.problems).toContain("address_form_conflict");
  });

  it("catches a reply that switches form mid-message", () => {
    const v = validateGrammaticalAgreement("תוכל לבחור מידה, ואז תשלחי לי את המספר.", fem, "he");
    expect(v.problems).toContain("mixed_address_forms");
    expect(shouldRegenerateForAddress(v)).toBe(true);
  });

  it("catches slash forms", () => {
    const v = validateGrammaticalAgreement("מעוניין/ת שאבדוק את זה?", masc, "he");
    expect(v.problems).toContain("slash_form_used");
    expect(shouldRegenerateForAddress(v)).toBe(true);
  });

  it("accepts restructured neutral phrasing when nothing is known", () => {
    const v = validateGrammaticalAgreement("איזה מוצר מעניין אותך? אפשר לבדוק עבורך.", UNKNOWN_ADDRESS, "he");
    expect(v.ok).toBe(true);
    expect(v.replyForm).toBe("neutral");
  });

  it("flags a gendered guess with no evidence, but does not force a rewrite", () => {
    const v = validateGrammaticalAgreement("תרצה שאבדוק?", UNKNOWN_ADDRESS, "he");
    expect(v.problems).toEqual(["gendered_address_without_evidence"]);
    // Advisory: the neutral register is a preference, not a truth claim.
    expect(shouldRegenerateForAddress(v)).toBe(false);
  });

  it("does not mistake the assistant's own self-reference for addressing the customer", () => {
    // "אני בודק" is the assistant speaking in its OWN configured gender.
    const v = validateGrammaticalAgreement("אני בודק את זה עכשיו ומעדכן.", fem, "he");
    expect(v.problems).not.toContain("address_form_conflict");
  });

  it("does not treat the accusative particle את as a feminine pronoun", () => {
    // "אני רוצה את זה" is in a large share of Hebrew sentences.
    const v = validateGrammaticalAgreement("אשלח את הפרטים, ותוכל לבדוק אותם.", masc, "he");
    expect(v.problems).toEqual([]);
  });

  it("says nothing about an English reply", () => {
    const v = validateGrammaticalAgreement("Sure, I can check that for you.", masc, "en");
    expect(v.ok).toBe(true);
  });

  it("says nothing about an empty reply", () => {
    expect(validateGrammaticalAgreement("", masc, "he").ok).toBe(true);
    expect(validateGrammaticalAgreement(null, masc, "he").ok).toBe(true);
  });
});

// ─── The boundary the feature must not cross ─────────────────

describe("this is not a customer identity attribute", () => {
  it("the persisted shape carries no customer or tenant identifier", () => {
    const r = updateGrammaticalAddress({
      current: null,
      text: "אני מחפשת נעליים",
      messageId: "m1",
      locale: "he",
      now: NOW,
    });
    const keys = Object.keys(r.next);
    for (const forbidden of ["customerId", "customer", "tenantId", "gender", "sex", "identity", "phone", "email", "name"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("the prompt block cannot become a Shopify note or tag - it is not a value", () => {
    // A structural assertion: what reaches the model is prose, and what
    // is persisted is a form plus a confidence. Neither is a customer
    // field, so there is nothing for a writeback to pick up.
    const state = updateGrammaticalAddress({
      current: null,
      text: "אני מחפשת נעליים",
      locale: "he",
      now: NOW,
    }).next;
    expect(state.form).toBe("feminine");
    expect(JSON.stringify(state)).not.toMatch(/customer|tag|note|segment|price/i);
  });
});

const UNKNOWN_ADDRESS_EVIDENCE = { form: "unknown", confidence: "unknown" } as const;
