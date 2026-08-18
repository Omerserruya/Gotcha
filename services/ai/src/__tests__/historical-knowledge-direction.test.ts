import { describe, it, expect } from "vitest";
import { quoteMatchesDirection } from "../services/historical-intelligence/knowledge-extraction.stage";

/**
 * Knowledge may enter the pipeline ONLY from messages the business itself
 * sent; questions only from messages the customer sent.
 *
 * This is not hypothetical hygiene. The first live import (2026-08-18)
 * contained threads where the business OWNER was the customer of some other
 * business, and that side's auto-replies ("your request has been received and
 * will be handled when the center is available") were mined as this business's
 * service-availability policy - another company's canned bot message, offered
 * for approval into the knowledge base. The direction guard is what makes the
 * prompt's "answers only from Business lines" rule enforceable rather than
 * aspirational.
 */

const transcript = [
  // The business owner wrote TO another business - stored as OUTBOUND.
  { direction: "OUTBOUND" as const, body: "היי, המכשיר שלי לא נדלק, אפשר לתאם תיקון?" },
  // The other business's auto-reply - received, so INBOUND. Reads like policy.
  {
    direction: "INBOUND" as const,
    body: "הודעת הפניה תתקבל ותטופל בהקדם כשהמרכז חוזר לזמין. תודה על הסבלנות!",
  },
  // A genuine exchange with a real customer of THIS business.
  { direction: "INBOUND" as const, body: "אפשר להחליף פריט אחרי קנייה?" },
  {
    direction: "OUTBOUND" as const,
    body: "בוודאי, ניתן להחליף כל פריט תוך 30 יום עם חשבונית. מחכים לך בסניף.",
  },
  { direction: "INBOUND" as const, body: "תודה רבה" },
];

describe("answers must come from the business's own messages", () => {
  it("rejects an auto-reply the business RECEIVED, even though it reads like policy", () => {
    const receivedAutoReply = "הודעת הפניה תתקבל ותטופל בהקדם כשהמרכז חוזר לזמין";
    expect(quoteMatchesDirection(transcript, receivedAutoReply, "OUTBOUND")).toBe(false);
    // It IS an inbound line - the guard fails it only on the claimed side.
    expect(quoteMatchesDirection(transcript, receivedAutoReply, "INBOUND")).toBe(true);
  });

  it("accepts an answer the business actually sent", () => {
    expect(
      quoteMatchesDirection(transcript, "בוודאי, ניתן להחליף כל פריט תוך 30 יום עם חשבונית", "OUTBOUND"),
    ).toBe(true);
  });

  it("rejects a question that was never a customer line", () => {
    expect(quoteMatchesDirection(transcript, "מה קורה אם מרכז השירות לא זמין כרגע?", "INBOUND")).toBe(
      false,
    );
  });

  it("accepts a question the customer actually asked", () => {
    expect(quoteMatchesDirection(transcript, "אפשר להחליף פריט אחרי קנייה?", "INBOUND")).toBe(true);
  });
});

describe("matching survives the renderer's clipping without going lax", () => {
  it("matches a quote that is a prefix of a long stored body", () => {
    const long = [
      {
        direction: "OUTBOUND" as const,
        body: "שעות הפעילות שלנו הן ראשון עד חמישי 9:00-18:00 ושישי 9:00-13:00. " + "בחגים ".repeat(80),
      },
    ];
    expect(
      quoteMatchesDirection(long, "שעות הפעילות שלנו הן ראשון עד חמישי 9:00-18:00", "OUTBOUND"),
    ).toBe(true);
  });

  it("a fabricated quote matches nothing", () => {
    expect(quoteMatchesDirection(transcript, "משלוח חינם בקנייה מעל 200 שקל", "OUTBOUND")).toBe(false);
  });

  it("a two-word body cannot back a long quote (reverse-containment floor)", () => {
    expect(
      quoteMatchesDirection(transcript, "תודה רבה על הפנייה, המדיניות שלנו היא החזר מלא תוך 14 יום", "INBOUND"),
    ).toBe(false);
  });
});
