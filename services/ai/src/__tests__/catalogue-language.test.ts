/**
 * Search in the store's title language (Tehila, 2026-11-02: a Hebrew catalogue
 * searched for "scarf" came back empty and the shopper was asked again).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ redis: new Map<string, string>(), rows: [] as any[], calls: 0 }));
vi.mock("@chatcenter/shared", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getRedis: () => ({
    get: async (k: string) => H.redis.get(k) ?? null,
    set: async (k: string, v: string) => { H.redis.set(k, v); return "OK"; },
  }),
}));
vi.mock("../services/connectors/integration-framework", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  executeAdapterTool: async () => { H.calls++; return { ok: true, result: H.rows }; },
}));

import { titlesLanguageOf, cachedTitlesLanguage, refreshTitlesLanguage } from "../services/catalogue-language.service";
import { searchQueryInstruction } from "../services/ai-bot.service";

beforeEach(() => { H.redis.clear(); H.calls = 0; H.rows = []; });

describe("the store's title language", () => {
  it("Hebrew when most titles are Hebrew, English otherwise, null when there are none", () => {
    expect(titlesLanguageOf(["מטפחת משי", "מטפחת כותנה", "Scarf Silk"])).toBe("he");
    expect(titlesLanguageOf(["Heavy Hoodie", "Chino Pants", "מעיל"])).toBe("en");
    expect(titlesLanguageOf([])).toBeNull();
  });

  it("a cache miss answers null at once and refreshes in the background; the next turn has it", async () => {
    H.rows = [{ name: "מטפחת משי" }, { name: "מטפחת פרחונית" }];
    expect(await cachedTitlesLanguage("T")).toBeNull();
    await refreshTitlesLanguage("T");
    expect(await cachedTitlesLanguage("T")).toBe("he");
  });

  it("the search instruction follows it: Hebrew nouns for a Hebrew store, English for an English one", () => {
    expect(searchQueryInstruction("he")).toMatch(/HEBREW/);
    expect(searchQueryInstruction("he")).toMatch(/no English/);
    expect(searchQueryInstruction("en")).toMatch(/ENGLISH/);
  });
});
