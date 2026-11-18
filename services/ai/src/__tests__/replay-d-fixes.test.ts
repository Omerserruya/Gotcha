/** The independent rating of the cab0f40e prod replay (replay d, 2026-11-18): the units. */
import { describe, it, expect, vi } from "vitest";
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "m", platformPaidScope: { run: (_: any, f: any) => f() } }));
import { sellerPitch, storyMentionOnly, fastRelevance } from "../services/conversation-relevance.service";
import { machineInbound, danglingQuestion, oneTeamPass } from "../services/reply-engine/engine";

const now = new Date("2026-11-18T16:00:00Z");

describe("6: a seller's pitch to the business", () => {
  it("★ the dev Messenger pitch is a pitch: marketing by fast rule, and the engine is silent", () => {
    const p = "שלום, אנחנו מציעים שירותי בניית אתרים במחיר מבצע, רוצים הצעת מחיר?";
    expect(sellerPitch(p)).toBe(true);
    expect(fastRelevance({ channel: "MESSENGER", firstDirection: "INBOUND", messages: [{ direction: "INBOUND", body: p, createdAt: now }] }, now)).toMatchObject({ category: "marketing", source: "fast" });
    expect(machineInbound("MESSENGER", [], p)).toBe("seller_pitch");
    expect(sellerPitch("Hi, we offer SEO services for online stores, want a free audit?")).toBe(true);
    expect(sellerPitch("רציתי להציע לכם שירות קידום ממומן לעסק")).toBe(true);
  });
  it("★ a buyer introducing their own business is a lead, never a pitch", () => {
    for (const s of ["אנחנו מספקים שירותי קייטרינג ורוצים להזמין מכם 50 משטחים", "אנחנו מציעים שירותי הסעדה ומחפשים ספק משטחים, אפשר מחיר לכמות?", "We provide catering services and would like to order 50 mats from you, what is the bulk price?"]) {
      expect(sellerPitch(s)).toBe(false);
      expect(machineInbound("WHATSAPP", [], s)).toBeNull();
    }
  });
  it("★ a pitch on the business's own site chat or voice is answered (never labelled there)", () => {
    const p = "שלום, אנחנו מציעים שירותי בניית אתרים במחיר מבצע, רוצים הצעת מחיר?";
    expect(machineInbound("WEBCHAT", [], p)).toBeNull();
    expect(machineInbound("VOICE", [], p)).toBeNull();
  });
  it("★ in doubt a customer: an ask, a service she needs, her own order", () => {
    for (const s of ["אני מחפשת שירות משלוחים מהיר", "אנחנו מחפשים משטח למיקסר", "יש לכם שירות התקנה?", "אנחנו מציעים לחברים שלנו את המשטח שלכם, יש הנחה לקבוצה?", "we offer our thanks, my order 1234 arrived broken", "הזמנתי אצלכם, אנחנו מציעים לבטל את השירות", "קניתי משטח בשבוע שעבר. אנחנו מספקים שירות הובלה, אפשר לשלוח דרכנו?"]) {
      expect(sellerPitch(s)).toBe(false);
      expect(machineInbound("WHATSAPP", [], s)).toBeNull();
    }
  });
});

describe("5: a story mention with no words", () => {
  it("★ no reply; a story mention with words is answered", () => {
    expect(storyMentionOnly("[Story mention]")).toBe(true);
    expect(machineInbound("INSTAGRAM", [], "[Story mention]")).toBe("story_mention");
    expect(storyMentionOnly("[Story mention] כמה עולה?")).toBe(false);
    expect(machineInbound("INSTAGRAM", [], "[Story mention] כמה עולה?")).toBeNull();
  });
});

describe("2: a counter-question the cut left is no answer", () => {
  it("★ one short question on her ask for an explanation", () => {
    expect(danglingQuestion("מה נראה אצלך?", "איך אדע מה התת גוון")).toBe(true);
    expect(danglingQuestion("What do you see?", "how do I know my undertone")).toBe(true);
    expect(danglingQuestion("איזה מכשיר יש לך?", "מה ההבדל בין המשטחים?")).toBe(true);
  });
  it("★ a value ask may need one detail first: never replaced", () => {
    expect(danglingQuestion("לאיזו עיר?", "כמה עולה משלוח?")).toBe(false);
    expect(danglingQuestion("של איזה מוצר?", "מה המחיר?")).toBe(false);
  });
  it("★ not when it answers, is long, or she asked nothing", () => {
    expect(danglingQuestion("בודקים את צבע הוורידים. מה נראה אצלך?", "איך אדע מה התת גוון")).toBe(false);
    expect(danglingQuestion("מה נראה אצלך?", "שלום")).toBe(false);
    expect(danglingQuestion("כדי שאוכל להמליץ על הגוון המדויק, מה הצבע של הוורידים בפרק כף היד שלך?", "איך אדע מה התת גוון")).toBe(false);
  });
});

describe("4: one team pass per reply", () => {
  it("★ the offer goes when the fixed line is there; the fixed line once", () => {
    const r = "אפשר להעביר את זה לצוות, והתשובה תגיע כאן בצ'אט. העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.";
    expect(oneTeamPass(r)).toBe("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.");
    expect(oneTeamPass("המשטח עולה 99 ₪. העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט. העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.")).toBe("המשטח עולה 99 ₪. העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.");
  });
  it("★ a sentence with other content loses only its pass clause", () => {
    const r = "גפן מתאים למיקסר, ולגבי הטוסטר אשאל את הצוות. העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.";
    const out = oneTeamPass(r);
    expect(out).toMatch(/^גפן מתאים למיקסר\./);
    expect(out.match(/לצוות/g) ?? []).toHaveLength(1);
    expect(out).not.toMatch(/אשאל/);
  });
  it("★ unchanged without the fixed line, and a holding line is never cut", () => {
    expect(oneTeamPass("אפשר להעביר את זה לצוות. רוצה?")).toBe("אפשר להעביר את זה לצוות. רוצה?");
    const h = "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט. החיוב עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.";
    expect(oneTeamPass(h)).toBe(h);
  });
});
