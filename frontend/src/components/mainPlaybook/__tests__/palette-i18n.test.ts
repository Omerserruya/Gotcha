import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "../../../i18n/en.json";
import he from "../../../i18n/he.json";
import { NODE_PALETTE } from "../MainPlaybookEditor";
import { nodeCategoryLabel, nodeLabel } from "../node-i18n";

const COMP = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(COMP, rel), "utf8");

// A t() that resolves against the real dictionaries (dot path), returning the
// key itself when unresolved - exactly like the app's i18n.
const makeT = (dict: any) => (key: string) =>
  key.split(".").reduce((o: any, k) => (o == null ? o : o[k]), dict) ?? key;

describe("§5 workflow node palette is fully localized (no hardcoded English in Hebrew mode)", () => {
  it("MainPlaybookEditor palette renders node names/descriptions/categories via i18n helpers", () => {
    const src = read("MainPlaybookEditor.tsx");
    expect(src).toContain("nodeCategoryLabel(cat.category, t)");
    expect(src).toContain("nodeLabel(item.type, t, item.label)");
    expect(src).toContain("nodeDesc(item.type, t, item.desc)");
    // The raw-string renders are gone.
    expect(src).not.toMatch(/>\{item\.label\}</);
    expect(src).not.toMatch(/>\{cat\.category\}</);
    // Header strings localized.
    expect(src).toContain('t("aiStudio.nodePaletteTitle")');
    expect(src).toContain('t("aiStudio.nodePaletteHint")');
  });

  it("FlowEditor palette header is localized too (parity)", () => {
    const src = read("../chatbot/FlowEditor.tsx");
    expect(src).toContain('t("aiStudio.nodePaletteTitle")');
    expect(src).toContain('t("aiStudio.nodePaletteHint")');
  });

  it("every palette category resolves to a real Hebrew label (not the English fallback)", () => {
    const tHe = makeT(he);
    for (const cat of NODE_PALETTE) {
      const label = nodeCategoryLabel(cat.category, tHe);
      expect(label, `category "${cat.category}"`).toBeTruthy();
      // Resolved (not equal to the raw English category name it falls back to).
      expect(label, `category "${cat.category}" not localized`).not.toBe(cat.category);
    }
  });

  it("every palette node type resolves to a Hebrew label", () => {
    const tHe = makeT(he);
    for (const cat of NODE_PALETTE) {
      for (const item of cat.items) {
        const label = nodeLabel(item.type, tHe, item.label);
        expect(label, `node ${item.type}`).toBeTruthy();
        expect(label, `node ${item.type} not localized`).not.toBe(item.label);
      }
    }
  });

  it("palette title/hint exist in both locales", () => {
    for (const dict of [en, he] as any[]) {
      expect(dict.aiStudio.nodePaletteTitle).toBeTruthy();
      expect(dict.aiStudio.nodePaletteHint).toBeTruthy();
    }
  });
});
