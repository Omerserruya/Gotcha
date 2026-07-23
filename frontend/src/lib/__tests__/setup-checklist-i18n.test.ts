import { describe, it, expect } from "vitest";
import en from "../../i18n/en.json";
import he from "../../i18n/he.json";

// The five canonical setup actions - the ONE list both the Getting Started
// page and the sidebar "Complete setup" panel render (same ids as the
// backend /onboarding/journey milestones).
const CANONICAL = [
  "connect_source_of_truth",
  "connect_channel",
  "connect_knowledge",
  "create_ai_employee",
  "create_process",
];

describe("setup checklist copy", () => {
  for (const [name, dict] of [["en", en], ["he", he]] as const) {
    it(`${name}: has all five canonical items with title/why/cta`, () => {
      const items = (dict as any).setupChecklist?.items;
      expect(items).toBeTruthy();
      expect(Object.keys(items).sort()).toEqual([...CANONICAL].sort());
      for (const id of CANONICAL) {
        expect(items[id].title?.length).toBeGreaterThan(0);
        expect(items[id].why?.length).toBeGreaterThan(0);
        expect(items[id].cta?.length).toBeGreaterThan(0);
      }
    });

    it(`${name}: setup + empty-state copy contains no em/en dashes`, () => {
      const scan = (obj: unknown): string[] =>
        typeof obj === "string" ? [obj] : obj && typeof obj === "object" ? Object.values(obj).flatMap(scan) : [];
      const texts = [
        ...scan((dict as any).setupChecklist),
        ...scan((dict as any).outbound?.call),
      ];
      expect(texts.length).toBeGreaterThan(10);
      for (const text of texts) {
        expect(text).not.toMatch(/[—–]/);
      }
    });
  }
});
