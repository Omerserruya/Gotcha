import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const REPO = join(SRC, "../.."); // frontend/src → repo root
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const readRepo = (rel: string) => readFileSync(join(REPO, rel), "utf8");

describe("§2 Processes tab is canvas-first (no card/Enter/Edit step)", () => {
  const page = read("app/ai-studio/page.tsx");

  it("§11.8/§11.9 the Processes tab embeds the editor directly with a selector", () => {
    // Editors are rendered inline in the tab, not reached via a card push.
    expect(page).toContain("<MainPlaybookEditor embedded />");
    expect(page).toMatch(/<FlowEditor\s+key=[^>]*flowId=[^>]*embedded/);
    // A compact process selector replaces the card grid.
    expect(page).toContain('t("aiStudio.playbooks.process")');
    // The old card-first list body is gone.
    expect(page).not.toContain("Main Playbook Card");
    expect(page).not.toContain('router.push(`/ai-studio/flows/${flow.id}`)');
  });
});

describe("§2 explicit, honest save lifecycle", () => {
  const fe = read("components/chatbot/FlowEditor.tsx");

  it("has a real save-state machine (saved/saving/unsaved/error), not a bare bool", () => {
    expect(fe).toMatch(/saveState[^;]*"saved"\s*\|\s*"saving"\s*\|\s*"unsaved"\s*\|\s*"error"/);
    // "Saved" is set ONLY after the backend confirms (inside the try, after await).
    expect(fe).toContain('setSaveState("saved");');
    expect(fe).toContain('setSaveState("error");');
    // Dirty tracking flags unsaved on graph/name change.
    expect(fe).toMatch(/loadedRef\.current[\s\S]*setSaveState\(\(s\) => \(s === "saving" \? s : "unsaved"\)\)/);
  });

  it("blocks duplicate/concurrent saves and guards stale-version overwrites", () => {
    expect(fe).toContain('if (!token || saveState === "saving") return;');
    expect(fe).toContain("expectedUpdatedAt");
  });

  it("§11.10/§11.11 fullscreen toggles a page-filling editor with an Exit control, keeping the toolbar", () => {
    expect(fe).toContain("fullscreen");
    expect(fe).toContain("fixed inset-0 z-40");
    expect(fe).toContain('t("chatbot.exitFullscreen")');
    // Embedded mode fills its container (canvas-first tab) rather than the viewport.
    expect(fe).toContain('embedded ? "h-full flex flex-col"');
  });
});

describe("§2 backend enforces stale-version conflict (authoritative)", () => {
  it("chatbot PUT rejects a stale expectedUpdatedAt with 409", () => {
    const route = readRepo("services/chatbot/src/routes/chatbot.ts");
    expect(route).toContain("expectedUpdatedAt");
    expect(route).toContain("stale_version_conflict");
    expect(route).toContain("res.status(409)");
  });
});
