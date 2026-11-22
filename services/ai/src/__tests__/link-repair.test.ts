/**
 * Link repair keeps a link whole (prod 2026-11-19 and 11-22). A measuring guide whose file name is written in
 * Hebrew letters was read up to its first Hebrew letter; that folder was then "repaired" to a product image on
 * the same host, and the file name stayed glued after the image: ".../uploads/2024/10/3@2x.pngסמובי-מדריך-מדידה.pdf"
 * and ".../uploads/2022/07/5.pngסמובי-מדריך-מדידה.pdf" went to customers.
 */
import { describe, it, expect } from "vitest";
import { repairUrls, spaceSentences } from "../services/reply-engine/gates";

const HOST = "https://smoovee-ltd.com";
const PDF = `${HOST}/wp-content/uploads/2026/11/סמובי-מדריך-מדידה.pdf`;
const IMG1 = `${HOST}/wp-content/uploads/2024/10/3@2x.png`;
const IMG2 = `${HOST}/wp-content/uploads/2022/07/5.png`;
const IMG3 = `${HOST}/wp-content/uploads/2024/07/9@2x-1.png`;
const PAGE1 = `${HOST}/product/%d7%a1%d7%9e%d7%95%d7%91%d7%99-%d7%90%d7%9c%d7%9b%d7%a1%d7%94/`;
const PAGE2 = `${HOST}/product/%d7%a1%d7%9e%d7%95%d7%91%d7%99-%d7%a4%d7%9e%d7%99%d7%9c%d7%99/`;
// What went to customers.
const SENT1 = `${IMG1}סמובי-מדריך-מדידה.pdf`;
const SENT2 = `${IMG2}סמובי-מדריך-מדידה.pdf`;
// The turn's products with their images, and the site.
const PRODUCTS = `${PAGE1} ${IMG1}\n${PAGE2} ${IMG2}\n${IMG3}\n${HOST}`;
const NEXT = "אם תרצי, אעזור לבחור מידה.";
const REPLY = `מדריך המדידה נמצא כאן: ${PDF}\n${NEXT}`;
/** No image file name with Hebrew letters glued after it, and neither of the two strings that went out. */
const neverTheProdStrings = (t: string) => {
  expect(t).not.toContain(SENT1);
  expect(t).not.toContain(SENT2);
  expect(t).not.toMatch(/\.(?:png|jpe?g|webp|gif)[א-ת]/u);
};

describe("a link with Hebrew letters in its path is one link", () => {
  it("★ a source has it as written: the reply is not touched", () => {
    for (const reply of [REPLY, `המדריך: ${PDF}. ${NEXT}`, `יש מדריך (${PDF}) באתר. ${NEXT}`, `${PDF}`, `*${PDF}*`]) {
      const r = repairUrls(reply, `מדריך מדידה להורדה: ${PDF}\n${PRODUCTS}`);
      expect(r).toEqual({ text: reply, fixed: 0, dropped: 0 });
      expect(spaceSentences(r.text)).toBe(reply);
    }
  });
  it("★ a source has it percent-encoded, in either letter case: still the same link, kept as the reply wrote it", () => {
    const encoded = encodeURI(PDF);
    expect(encoded).toContain("%D7%A1");
    for (const source of [encoded, encoded.replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase())]) {
      expect(repairUrls(REPLY, `guide: ${source}\n${PRODUCTS}`)).toEqual({ text: REPLY, fixed: 0, dropped: 0 });
    }
    // And the other way: the source in Hebrew letters, the reply percent-encoded.
    const other = `מדריך המדידה: ${encoded}`;
    expect(repairUrls(other, `${PDF}\n${PRODUCTS}`)).toEqual({ text: other, fixed: 0, dropped: 0 });
  });
  it("★ no source has it: the sentence goes whole, and no other file of that host takes its place", () => {
    const sourceSets = [
      PRODUCTS,
      `${IMG3}`,
      `${IMG1} ${IMG2} ${IMG3}`,
      // Another file in the very same folder, an image and a PDF.
      `${HOST}/wp-content/uploads/2026/11/cover.png`,
      `${HOST}/wp-content/uploads/2026/11/other-guide.pdf`,
      // The folder itself.
      `${HOST}/wp-content/uploads/2026/11/`,
      "",
    ];
    for (const sources of sourceSets) {
      const r = repairUrls(REPLY, sources);
      expect(r.text).toBe(NEXT);
      expect(r).toMatchObject({ fixed: 0, dropped: 1 });
      neverTheProdStrings(r.text);
    }
  });
  it("★ the two strings that went out are never produced, whatever the sources hold", () => {
    const replies = [REPLY, `${PDF}`, `הנה ${PDF}, ואם צריך עוד משהו אני כאן.`, `המדריך: ${encodeURI(PDF)}`];
    const sourceSets = [PRODUCTS, `${PDF}\n${PRODUCTS}`, `${encodeURI(PDF)}\n${PRODUCTS}`, IMG1, IMG2, `${IMG1}\n${IMG2}`, `${HOST}/wp-content/uploads/2026/11/x.png`];
    for (const reply of replies) for (const sources of sourceSets) {
      const r = repairUrls(reply, sources);
      neverTheProdStrings(r.text);
      neverTheProdStrings(spaceSentences(r.text));
      // The link is whole or gone: never its folder alone, never its file name alone.
      if (!r.text.includes(PDF) && !r.text.includes(encodeURI(PDF))) { expect(r.text).not.toMatch(/uploads|מדריך-מדידה|pdf/); }
    }
  });
  it("a conversation that already got the broken string: repeating it is no link, and the true one still passes", () => {
    const earlier = `מדריך המדידה: ${SENT1}`;
    for (const sent of [SENT1, SENT2]) {
      const again = repairUrls(`הנה שוב: ${sent}\n${NEXT}`, `${earlier}\nמדריך המדידה: ${SENT2}\n${PRODUCTS}`);
      expect(again.text).toBe(NEXT);
      expect(again.dropped).toBe(1);
    }
    // The broken string in what was sent before does not make itself a source.
    expect(repairUrls(`הנה שוב: ${SENT1}`, earlier).dropped).toBe(1);
    expect(repairUrls(REPLY, `${earlier}\n${PDF}\n${PRODUCTS}`)).toEqual({ text: REPLY, fixed: 0, dropped: 0 });
  });
  it("another sentence goes: a kept Hebrew-path link stays in one piece", () => {
    const r = repairUrls(`הנה: https://evil.example/x. המדריך: ${PDF}. תודה.`, `${PDF}\n${PRODUCTS}`);
    expect(r.text).toBe(`המדריך: ${PDF}. תודה.`);
    expect(r).toMatchObject({ fixed: 0, dropped: 1 });
  });
  it("a team line glued straight after the kept link gets its space, the link stays whole", () => {
    const TEAM = "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.";
    const r = repairUrls(`מדריך המדידה: ${PDF}.${TEAM}`, `${PDF}\n${PRODUCTS}`);
    expect(r).toEqual({ text: `מדריך המדידה: ${PDF}. ${TEAM}`, fixed: 1, dropped: 0 });
    expect(spaceSentences(r.text)).toBe(r.text);
    // No source has the link: where it ends cannot be told, so the sentence it is glued into goes with it.
    expect(repairUrls(`מדריך המדידה: ${PDF}.${TEAM} ${NEXT}`, PRODUCTS)).toEqual({ text: NEXT, fixed: 0, dropped: 1 });
  });
  it("a Hebrew-path link cut short of exactly one source link becomes that link", () => {
    const cut = `${HOST}/wp-content/uploads/2026/11/סמובי-מדריך`;
    expect(repairUrls(`המדריך: ${cut}`, `${PDF}\n${PRODUCTS}`)).toEqual({ text: `המדריך: ${PDF}`, fixed: 1, dropped: 0 });
    // Two it could be: none.
    expect(repairUrls(`המדריך: ${cut}`, `${PDF}\n${HOST}/wp-content/uploads/2026/11/סמובי-מדריך-התקנה.pdf`).dropped).toBe(1);
  });
});

describe("a substitute is the same address written another way, never another file", () => {
  const SHOP = "https://shop.example";
  it("★ another product page of the same folder is no substitute", () => {
    const r = repairUrls(`הקישור למקס: ${SHOP}/product/smoovee-max/\nרוצה לראות עוד?`, `${SHOP}/product/smoovee-alexa/ ${SHOP}/product/smoovee-family/`);
    expect(r.text).toBe("רוצה לראות עוד?");
    expect(r).toMatchObject({ fixed: 0, dropped: 1 });
    // One product in the sources: still not that one.
    expect(repairUrls(`הקישור למקס: ${SHOP}/product/smoovee-max/`, `${SHOP}/product/smoovee-alexa/`).text).toBe("");
    // An image of the same folder for another image.
    expect(repairUrls(`תמונה: ${SHOP}/uploads/2024/a.png`, `${SHOP}/uploads/2024/b.png`).dropped).toBe(1);
  });
  it("broken percent-encoding is read as the source's link, also when the source wrote Hebrew letters", () => {
    const bad = `בעמוד המוצר: ${SHOP}/product/%d7%ה%d7%9e-abc תודה.`;
    expect(repairUrls(bad, `${SHOP}/product/%d7%94%d7%9e-abc`)).toEqual({ text: `בעמוד המוצר: ${SHOP}/product/%d7%94%d7%9e-abc תודה.`, fixed: 1, dropped: 0 });
    expect(repairUrls(bad, `${SHOP}/product/המ-abc`)).toEqual({ text: `בעמוד המוצר: ${SHOP}/product/המ-abc תודה.`, fixed: 1, dropped: 0 });
    // Broken, and still no source's link: it goes.
    expect(repairUrls(bad, `${SHOP}/product/%d7%94%d7%a0-abc`).dropped).toBe(1);
  });
  it("a closing slash more or less, a query no source has, a mark of emphasis", () => {
    const src = `${SHOP}/product/abc/ ${SHOP}/product/abc-long/ ${SHOP}/page`;
    expect(repairUrls(`ראי ${SHOP}/product/abc כאן`, src)).toEqual({ text: `ראי ${SHOP}/product/abc/ כאן`, fixed: 1, dropped: 0 });
    expect(repairUrls(`ראי ${SHOP}/page/ כאן`, src)).toEqual({ text: `ראי ${SHOP}/page כאן`, fixed: 1, dropped: 0 });
    expect(repairUrls(`ראי ${SHOP}/product/abc/?utm=x#top כאן`, src)).toEqual({ text: `ראי ${SHOP}/product/abc/ כאן`, fixed: 1, dropped: 0 });
    expect(repairUrls(`ראי *${SHOP}/product/abc/* כאן`, src)).toEqual({ text: `ראי *${SHOP}/product/abc/* כאן`, fixed: 0, dropped: 0 });
    expect(repairUrls(`ראי ${SHOP}/page כאן`, `**${SHOP}/page**`)).toEqual({ text: `ראי ${SHOP}/page כאן`, fixed: 0, dropped: 0 });
    // A source that holds the link inside escaped HTML.
    expect(repairUrls(`ראי ${SHOP}/a.pdf כאן`, `{"description":"<a href=\\"${SHOP}/a.pdf\\">guide</a>"}`)).toEqual({ text: `ראי ${SHOP}/a.pdf כאן`, fixed: 0, dropped: 0 });
  });
  it("★ a link cut at the domain becomes the one page it begins, never that page's image", () => {
    const cut = "הקישור לסמובי אלכסה: https://smoovee-ltd.העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.";
    const r = repairUrls(cut, `${PAGE1} ${IMG1}`);
    expect(r.text).toBe(`הקישור לסמובי אלכסה: ${PAGE1}.העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.`);
    expect(spaceSentences(r.text)).toBe(`הקישור לסמובי אלכסה: ${PAGE1}. העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.`);
    expect(r).toMatchObject({ fixed: 1, dropped: 0 });
    // Only images begin like it: none of them.
    const none = repairUrls(cut, `${IMG1} ${IMG2}`);
    expect(none.text).toBe("העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.");
    expect(none.dropped).toBe(1);
  });
});

describe("text glued to a link comes apart from it", () => {
  const SHOP = "https://shop.example";
  it("a word after a file ending or a domain, and one word after a link a source has", () => {
    expect(repairUrls(`המדריך: ${SHOP}/a.pdfהעברתי את השאלה לצוות.`, `${SHOP}/a.pdf`)).toEqual({ text: `המדריך: ${SHOP}/a.pdf העברתי את השאלה לצוות.`, fixed: 1, dropped: 0 });
    expect(repairUrls(`האתר: ${SHOP}תודה`, `${SHOP}/a.pdf`)).toEqual({ text: `האתר: ${SHOP} תודה`, fixed: 1, dropped: 0 });
    expect(repairUrls(`ראי ${SHOP}/product/abcתודה רבה`, `${SHOP}/product/abc`)).toEqual({ text: `ראי ${SHOP}/product/abc תודה רבה`, fixed: 1, dropped: 0 });
    // A source that has the link with a word glued to it still has the link.
    expect(repairUrls(`המדריך: ${SHOP}/a.pdf כאן`, `${SHOP}/a.pdfלהורדה`)).toEqual({ text: `המדריך: ${SHOP}/a.pdf כאן`, fixed: 0, dropped: 0 });
    // The link it was glued to is in no source: the sentence goes, the glued word with it.
    expect(repairUrls(`המדריך: ${SHOP}/b.pdfהעברתי את השאלה לצוות. תודה.`, `${SHOP}/a.pdf`)).toEqual({ text: "תודה.", fixed: 0, dropped: 1 });
  });
  it("a folder's next letters are its path, never a glued word", () => {
    const r = repairUrls(`ראי ${SHOP}/product/שמלה\nתודה.`, `${SHOP}/product/ ${SHOP}/product/abc/`);
    expect(r.text).toBe("תודה.");
    expect(r.dropped).toBe(1);
    // The same page when a source has it.
    expect(repairUrls(`ראי ${SHOP}/product/שמלה`, `${SHOP}/product/ ${SHOP}/product/%d7%a9%d7%9e%d7%9c%d7%94`)).toEqual({ text: `ראי ${SHOP}/product/שמלה`, fixed: 0, dropped: 0 });
  });
  it("a kept link whose Hebrew file name has a dot in it gets no space put inside", () => {
    const u = `${SHOP}/uploads/2026/11/מדריך.מדידה.pdf`;
    const reply = `המדריך: ${u}. תודה.`;
    const r = repairUrls(reply, `guide ${u}`);
    expect(r).toEqual({ text: reply, fixed: 0, dropped: 0 });
    expect(spaceSentences(r.text)).toBe(reply);
    // A sentence mark straight after the address is still a sentence end.
    expect(spaceSentences(`ראי ${SHOP}/a.תודה.שלום`)).toBe(`ראי ${SHOP}/a. תודה. שלום`);
    // A sentence glued after the whole link: the link a source has ends before the mark.
    const glued = repairUrls(`ראי ${u}.תודה רבה. שלום.`, `guide ${u}`);
    expect(glued).toEqual({ text: `ראי ${u}. תודה רבה. שלום.`, fixed: 1, dropped: 0 });
    expect(spaceSentences(glued.text)).toBe(glued.text);
    // The same glue after a link no source has: the sentence goes.
    expect(repairUrls(`ראי ${u}.תודה רבה. שלום.`, `${SHOP}/uploads/2026/11/x.png`)).toEqual({ text: "שלום.", fixed: 0, dropped: 1 });
  });
  it("a query written in Hebrew letters that a source has stays one link", () => {
    const u = `${SHOP}/search?שמלה`;
    expect(repairUrls(`ראי ${u} כאן`, `חיפוש: ${u}`)).toEqual({ text: `ראי ${u} כאן`, fixed: 0, dropped: 0 });
  });
});
