import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_STUDIO_TABS,
  DEFAULT_AI_STUDIO_TAB,
  normalizeAiStudioTab,
  aiStudioHref,
  isAiStudioTab,
} from "../ai-studio-tabs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("AI Studio tab contract - URL is the source of truth", () => {
  it("canonical tabs are overview/knowledge/processes/tools; Overview is default", () => {
    expect([...AI_STUDIO_TABS]).toEqual(["overview", "knowledge", "processes", "tools"]);
    expect(DEFAULT_AI_STUDIO_TAB).toBe("overview");
    // Team is NOT a canonical tab, so route parsing can never yield it.
    expect(isAiStudioTab("team")).toBe(false);
  });

  it("§11.5 invalid/missing tab falls back to Overview, NOT Team", () => {
    expect(normalizeAiStudioTab(null)).toBe("overview");
    expect(normalizeAiStudioTab(undefined)).toBe("overview");
    expect(normalizeAiStudioTab("")).toBe("overview");
    expect(normalizeAiStudioTab("garbage")).toBe("overview");
    // A stale ?tab=team link resolves to Overview, never re-introducing Team.
    expect(normalizeAiStudioTab("team")).toBe("overview");
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

  it("Employee editor returns to Overview and never to a bare /ai-studio", () => {
    const src = read("app/ai-studio/agents/[id]/page.tsx");
    expect(src).toContain("aiStudioHref(returnTab)");
    expect(src).toMatch(/returnTab\s*=\s*_rt\s*\?\s*normalizeAiStudioTab\(_rt\)\s*:\s*"overview"/);
    expect(src).not.toContain('router.push("/ai-studio")');
  });

  it("the monolith default is Overview (never 'team')", () => {
    const src = read("app/ai-studio/page.tsx");
    expect(src).toContain("normalizeAiStudioTab(tabFromUrl)");
    // The old hardcoded team fallback is gone.
    expect(src).not.toMatch(/:\s*"team"\)/);
  });
});
