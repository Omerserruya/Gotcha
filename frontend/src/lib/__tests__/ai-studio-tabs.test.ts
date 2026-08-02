import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_STUDIO_TABS,
  DEFAULT_AI_STUDIO_TAB,
  normalizeAiStudioTab,
  aiStudioHref,
  aiStudioTabI18nKey,
  isAiStudioTab,
} from "../ai-studio-tabs";
import en from "../../i18n/en.json";
import he from "../../i18n/he.json";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("AI Studio tab contract - URL is the source of truth", () => {
  it("canonical tabs are employees/knowledge/processes/tools; AI Employees is default", () => {
    expect([...AI_STUDIO_TABS]).toEqual(["employees", "knowledge", "processes", "tools"]);
    expect(DEFAULT_AI_STUDIO_TAB).toBe("employees");
    // Team is NOT a canonical tab, so route parsing can never yield it.
    expect(isAiStudioTab("team")).toBe(false);
    // Nor is the old name, now that it is only an inbound alias.
    expect(isAiStudioTab("overview")).toBe(false);
  });

  it("§11.5 invalid/missing tab falls back to AI Employees, NOT Team", () => {
    expect(normalizeAiStudioTab(null)).toBe("employees");
    expect(normalizeAiStudioTab(undefined)).toBe("employees");
    expect(normalizeAiStudioTab("")).toBe("employees");
    expect(normalizeAiStudioTab("garbage")).toBe("employees");
    // A stale ?tab=team link resolves there too, never re-introducing Team.
    expect(normalizeAiStudioTab("team")).toBe("employees");
  });

  it("every ?tab=overview link ever shared still works", () => {
    // The tab was renamed for clarity; breaking bookmarks, guided-tour anchors
    // and in-product links to pay for it would not be a fair trade.
    expect(normalizeAiStudioTab("overview")).toBe("employees");
  });

  it("§11.4/§11.7 canonical + legacy aliases resolve deterministically (refresh + deep links)", () => {
    for (const t of AI_STUDIO_TABS) expect(normalizeAiStudioTab(t)).toBe(t);
    // Legacy aliases keep bookmarks + Settings redirects working.
    expect(normalizeAiStudioTab("playbooks")).toBe("processes");
    expect(normalizeAiStudioTab("skills")).toBe("tools");
  });

  it("aiStudioHref builds the canonical URL, preserving extras (e.g. OAuth view)", () => {
    expect(aiStudioHref("tools")).toBe("/ai-studio?tab=tools");
    expect(aiStudioHref("processes")).toBe("/ai-studio?tab=processes");
    expect(aiStudioHref("tools", { view: "permissions" })).toBe("/ai-studio?tab=tools&view=permissions");
  });
});

describe("Nested pages preserve their origin tab on Back (no bare /ai-studio)", () => {
  it("§11.1 Knowledge detail returns to Knowledge", () => {
    const src = read("app/ai-studio/knowledge/page.tsx");
    expect(src).toContain("aiStudioHref(returnTab)");
    expect(src).toMatch(/returnTab\s*=\s*rt\s*\?\s*normalizeAiStudioTab\(rt\)\s*:\s*"knowledge"/);
    // The old bug: a bare push that fell through to the Team default.
    expect(src).not.toContain('router.push("/ai-studio")');
  });

  it("§11.2 Process editor returns to Processes", () => {
    const src = read("app/ai-studio/flows/[id]/page.tsx");
    expect(src).toContain("aiStudioHref(returnTab)");
    expect(src).toMatch(/returnTab\s*=\s*rt\s*\?\s*normalizeAiStudioTab\(rt\)\s*:\s*"processes"/);
    expect(src).not.toContain('router.push("/ai-studio")');
  });

  it("§11.3/§11.6 Tool/integration detail (and OAuth return) go to Tools", () => {
    const src = read("app/ai-studio/marketplace/[slug]/page.tsx");
    expect(src).toContain("aiStudioHref(returnTab)");
    expect(src).toMatch(/returnTab\s*=\s*rt\s*\?\s*normalizeAiStudioTab\(rt\)\s*:\s*"tools"/);
    expect(src).not.toContain('router.push("/ai-studio")');
  });

  it("Employee editor returns to AI Employees and never to a bare /ai-studio", () => {
    const src = read("app/ai-studio/agents/[id]/page.tsx");
    expect(src).toContain("aiStudioHref(returnTab)");
    expect(src).toMatch(/returnTab\s*=\s*_rt\s*\?\s*normalizeAiStudioTab\(_rt\)\s*:\s*"employees"/);
    expect(src).not.toContain('router.push("/ai-studio")');
  });

  it("the monolith default is AI Employees (never 'team')", () => {
    const src = read("app/ai-studio/page.tsx");
    expect(src).toContain("normalizeAiStudioTab(tabFromUrl)");
    // The old hardcoded team fallback is gone.
    expect(src).not.toMatch(/:\s*"team"\)/);
  });

  it("every tab key has a translation in both locales", () => {
    // Renaming a tab key while leaving its label pointing at the old i18n key
    // does not throw - t() echoes the key, so the tab renders as the literal
    // string "aiStudio.tabs.overview" to the user.
    for (const tab of AI_STUDIO_TABS) {
      const path = aiStudioTabI18nKey(tab).split(".");
      for (const [locale, dict] of [["en", en], ["he", he]] as const) {
        const value = path.reduce<any>((node, k) => node?.[k], dict);
        expect(typeof value, `${locale} is missing ${aiStudioTabI18nKey(tab)}`).toBe("string");
        expect(value).not.toContain("aiStudio.tabs.");
      }
    }
  });

  it("the tab strip derives each label from its own key", () => {
    const src = read("app/ai-studio/page.tsx");
    // No hand-written key strings to drift out of sync with the key: field.
    expect(src).not.toMatch(/t\("aiStudio\.tabs\./);
    for (const tab of AI_STUDIO_TABS) {
      expect(src).toContain(`aiStudioTabI18nKey("${tab}")`);
    }
  });
});
