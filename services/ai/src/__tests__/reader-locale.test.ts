/**
 * ★ The language of text the ai service writes for a person (lib/reader-locale):
 * an explicit locale wins (query, then body); otherwise the user's interface
 * language, then the workspace's. Accept-Language counts only as ONE deliberate
 * tag (what the v2 app sends for the page); a browser's list is ignored (it made
 * Hebrew screens English).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ asked: [] as any[], effective: "he" as string, throws: false }));
vi.mock("@chatcenter/shared", () => ({
  resolveEffectiveLocale: async (a: any) => { H.asked.push(a); if (H.throws) throw new Error("db"); return { effective: H.effective }; },
}));

import { readerLocale, deliberateLanguage } from "../lib/reader-locale";

const req = (o: any = {}) => ({ query: {}, body: {}, headers: { "accept-language": "en-US,en;q=0.9" }, tenantId: "T", user: { userId: "u1" }, ...o }) as any;

beforeEach(() => { H.asked = []; H.effective = "he"; H.throws = false; });

describe("★ readerLocale", () => {
  it("no explicit locale: the user's / workspace's language, whatever a browser's list says", async () => {
    expect(await readerLocale(req())).toBe("he");
    expect(H.asked).toEqual([{ tenantId: "T", userId: "u1" }]);
    H.effective = "en";
    expect(await readerLocale(req({ headers: { "accept-language": "he-IL,he;q=0.9" } }))).toBe("en");
    expect(await readerLocale(req({ headers: {} }))).toBe("en");
  });

  it("★ one deliberate tag (the page's language, sent by the v2 app) wins over the saved one", async () => {
    H.effective = "en";
    expect(await readerLocale(req({ headers: { "accept-language": "he" } }))).toBe("he");
    expect(await readerLocale(req({ headers: { "accept-language": "he-IL" } }))).toBe("he");
    H.effective = "he";
    expect(await readerLocale(req({ headers: { "accept-language": "en" } }))).toBe("en");
    expect(await readerLocale(req({ headers: { "accept-language": "fr" } }))).toBe("he");
    // The explicit locale still wins over the header.
    expect(await readerLocale(req({ query: { locale: "he" }, headers: { "accept-language": "en" } }))).toBe("he");
  });

  it("explicit wins: the query, then the body; anything else is not a language", async () => {
    expect(await readerLocale(req({ query: { locale: "en" } }))).toBe("en");
    expect(await readerLocale(req({ body: { locale: "en" } }))).toBe("en");
    expect(await readerLocale(req({ query: { locale: "fr" } }))).toBe("he");
  });

  it("only one whole tag is deliberate", () => {
    expect(["he", "EN", "he-IL", " en-gb "].map(deliberateLanguage)).toEqual(["he", "en", "he", "en"]);
    for (const h of ["eng", "hebrew", "en-US,en;q=0.9", "he;q=1", "fr", "", undefined]) expect(deliberateLanguage(h)).toBeNull();
  });

  it("a workspace locale like he-IL reads as Hebrew", async () => {
    H.effective = "he-IL";
    expect(await readerLocale(req())).toBe("he");
  });

  it("nothing resolvable: English", async () => {
    H.throws = true;
    expect(await readerLocale(req())).toBe("en");
    expect(await readerLocale(req({ tenantId: undefined, user: {} }))).toBe("en");
  });
});
