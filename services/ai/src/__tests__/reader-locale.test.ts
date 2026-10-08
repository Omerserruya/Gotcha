/**
 * ★ The language of text the ai service writes for a person (lib/reader-locale):
 * an explicit locale wins (query, then body); otherwise the user's interface
 * language, then the workspace's; never Accept-Language (the v2 app calls from
 * its server, and Hebrew screens got English).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ asked: [] as any[], effective: "he" as string, throws: false }));
vi.mock("@chatcenter/shared", () => ({
  resolveEffectiveLocale: async (a: any) => { H.asked.push(a); if (H.throws) throw new Error("db"); return { effective: H.effective }; },
}));

import { readerLocale } from "../lib/reader-locale";

const req = (o: any = {}) => ({ query: {}, body: {}, headers: { "accept-language": "en-US" }, tenantId: "T", user: { userId: "u1" }, ...o }) as any;

beforeEach(() => { H.asked = []; H.effective = "he"; H.throws = false; });

describe("★ readerLocale", () => {
  it("no explicit locale: the user's / workspace's language, whatever the header says", async () => {
    expect(await readerLocale(req())).toBe("he");
    expect(H.asked).toEqual([{ tenantId: "T", userId: "u1" }]);
    H.effective = "en";
    expect(await readerLocale(req({ headers: { "accept-language": "he-IL" } }))).toBe("en");
  });

  it("explicit wins: the query, then the body; anything else is not a language", async () => {
    expect(await readerLocale(req({ query: { locale: "en" } }))).toBe("en");
    expect(await readerLocale(req({ body: { locale: "en" } }))).toBe("en");
    expect(await readerLocale(req({ query: { locale: "fr" } }))).toBe("he");
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
