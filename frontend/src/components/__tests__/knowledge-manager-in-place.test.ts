import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const manager = read("components/KnowledgeDrawer.tsx");
const readiness = read("components/ReadinessReport.tsx");

/**
 * The complaint: knowledge buttons sent the user AWAY to a separate page (in
 * some places a new tab), so adding a missing answer meant abandoning the
 * readiness report - and any in-progress hire behind it. There must be ONE
 * shared manager with entry modes, opened in place.
 */
describe("ONE shared Knowledge Manager with entry modes", () => {
  it("declares the documented entry modes", () => {
    expect(manager).toMatch(/export type KnowledgeEntryMode =/);
    for (const mode of ["browse", "upload", "url", "drive", "answer"]) {
      expect(manager, mode).toContain(`"${mode}"`);
    }
  });

  it("maps entry mode to panel mode in exactly one place", () => {
    // Two vocabularies genuinely differ ("upload" is a file, "drive" is a
    // connected source); stating the mapping once stops them drifting.
    expect(manager).toMatch(/function panelModeFor\(mode: KnowledgeEntryMode\): UploadMode/);
    expect((manager.match(/panelModeFor\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("routes straight to the requested job instead of a list to navigate", () => {
    expect(manager).toMatch(/Entry-mode routing/);
    expect(manager).toMatch(/setView\("upload"\)/);
  });

  it("does not yank the user forward again if they navigate back to the list", () => {
    // The routing effect must not depend on `view`.
    expect(manager).toMatch(/\}, \[isOpen, initialMode, loading, knowledgeBases\]\);/);
  });

  it("works with no employee in scope - linking is optional", () => {
    // Opened from readiness or onboarding there is nothing to link to, and
    // showing link checkboxes there would be meaningless.
    expect(manager).toMatch(/linkedKbIds\?: string\[\]/);
    expect(manager).toMatch(/onToggleKb\?: \(/);
    expect(manager).toMatch(/const canLink = typeof onToggleKb === "function"/);
    expect(manager).toMatch(/\{canLink && \(/);
  });

  it("supports answering a question directly, stored question-first", () => {
    expect(manager).toMatch(/uploadMode === "answer"/);
    // Question-first so retrieval matches what the customer will actually ask.
    expect(manager).toMatch(/question the customer will actually ask/);
  });

  it("tells the caller when something landed so it can refresh in place", () => {
    expect(manager).toMatch(/onAdded\?: \(\) => void/);
    expect(manager).toMatch(/onAdded\?\.\(\);/);
  });

  it("shows why it was opened", () => {
    expect(manager).toMatch(/contextLabel/);
    expect(manager).toMatch(/data-testid="knowledge-context"/);
  });
});

describe("the readiness report no longer navigates away", () => {
  it("has no new-tab links to the Knowledge page left", () => {
    expect(readiness).not.toMatch(/href="\/ai-studio\/knowledge"/);
  });

  it("opens the shared manager in place instead", () => {
    expect(readiness).toMatch(/import KnowledgeDrawer/);
    expect(readiness).toMatch(/<KnowledgeDrawer/);
    expect(readiness).toMatch(/onOpenKnowledge/);
  });

  it("asks for the mode that matches the button pressed", () => {
    // "Connect a source" -> drive, "Add knowledge" -> upload.
    expect(readiness).toMatch(/onOpenKnowledge\?\.\("drive"\)/);
    expect(readiness).toMatch(/onOpenKnowledge\?\.\("upload"\)/);
  });

  it("re-runs readiness after knowledge is added, so the score is not stale", () => {
    expect(readiness).toMatch(/onAdded=\{\(\) => \{/);
    expect(readiness).toMatch(/onRerun\(\);/);
  });

  it("passes the originating context through", () => {
    expect(readiness).toMatch(/contextLabel=/);
    expect(readiness).toMatch(/readiness report/i);
  });
});
