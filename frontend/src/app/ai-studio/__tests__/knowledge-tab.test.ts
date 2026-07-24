import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import en from "../../../i18n/en.json";
import he from "../../../i18n/he.json";
import { canonicalDocType } from "@/lib/knowledge-source-type";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("§8 Knowledge tab shows real mapped sources, not a generic repository", () => {
  const page = read("app/ai-studio/page.tsx");

  it("§24 leads with source-type action cards (Files/Website/Drive/Manual FAQ/Confluence)", () => {
    // Cards deep-link into the focused add flow (dynamic ?add=<mode>).
    expect(page).toContain("/ai-studio/knowledge?add=${c.mode}");
    for (const mode of ["file", "url", "drive", "text", "confluence"]) {
      expect(page, `card mode ${mode}`).toContain(`mode: "${mode}"`);
    }
    expect(page).toContain('t("aiStudio.knowledge.explain")');
    expect(page).toContain('t("aiStudio.knowledge.activeSources")');
  });

  it("§29/§32 the active-sources table derives REAL type/items/status from the documents (not a placeholder)", () => {
    // The old fixed placeholders are gone.
    expect(page).not.toContain('src.type || "Document"');
    expect(page).not.toContain('src.status?.toLowerCase() || "synced"');
    // Real derivation from the API's document list.
    expect(page).toContain("Array.isArray(src.documents)");
    expect(page).toContain("const items = docs.length");
    // §30 error sources surface as "requires attention"/error.
    expect(page).toMatch(/anyError\s*\?\s*"error"/);
  });

  it("§8 all source-type + status labels are localized in EN and HE", () => {
    const k = (en as any).aiStudio.knowledge;
    const h = (he as any).aiStudio.knowledge;
    for (const key of ["explain", "activeSources", "itemsCol"]) {
      expect(k[key], `en ${key}`).toBeTruthy();
      expect(h[key], `he ${key}`).toBeTruthy();
    }
    for (const tl of ["file", "url", "text", "drive", "confluence", "mixed", "empty"]) {
      expect(k.typeLabels[tl], `en typeLabel ${tl}`).toBeTruthy();
      expect(h.typeLabels[tl], `he typeLabel ${tl}`).toBeTruthy();
    }
    for (const sl of ["ready", "processing", "error", "empty"]) {
      expect(k.statusLabels[sl], `en statusLabel ${sl}`).toBeTruthy();
      expect(h.statusLabels[sl], `he statusLabel ${sl}`).toBeTruthy();
    }
  });
});

describe("§8 every real ingestion sourceType maps to a localized TYPE label (no raw keys)", () => {
  const k = (en as any).aiStudio.knowledge.typeLabels;
  // The values ingestion actually writes (services/ai routes + drive/confluence
  // services + seed docs), plus an unknown, must all land on a label key that
  // exists - so the TYPE column never renders "aiStudio.knowledge.typeLabels.x".
  const cases: Record<string, string> = {
    file: "file", text: "text", url: "url",
    google_drive: "drive", confluence: "confluence",
    document: "file", manual: "text", website: "url", pdf: "file",
    something_unknown: "file",
  };
  for (const [raw, expected] of Object.entries(cases)) {
    it(`${raw} → ${expected} (a defined label)`, () => {
      const key = canonicalDocType(raw);
      expect(key).toBe(expected);
      expect(k[key], `typeLabels.${key} must exist`).toBeTruthy();
    });
  }
});

describe("§8 the manage page opens the correct focused add flow (?add=)", () => {
  it("routes file/url/text to the upload modal in that mode and drive/confluence to integrations", () => {
    const manage = read("app/ai-studio/knowledge/page.tsx");
    expect(manage).toContain('searchParams.get("add")');
    expect(manage).toContain('setUploadMode(addMode as "file" | "url" | "text")');
    expect(manage).toContain('setDetailTab("integrations")');
  });
});
