import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const flow = read("components/chatbot/FlowEditor.tsx");
const playbook = read("components/mainPlaybook/MainPlaybookEditor.tsx");

/**
 * There are two React Flow canvases. The chatbot one had full screen and a
 * trigger boundary; the Main Playbook - the widest graph in the product - had
 * neither, so the same workflow rules applied on one canvas and not the other.
 * These pin the parity so a future change to one is noticed on the other.
 */
describe("both canvases enforce the trigger boundary", () => {
  for (const [name, src] of [["FlowEditor", flow], ["MainPlaybookEditor", playbook]] as const) {
    it(`${name} constrains panning AND dragging to the boundary`, () => {
      expect(src, name).toMatch(/translateExtent=/);
      expect(src, name).toMatch(/nodeExtent=/);
    });

    it(`${name} derives the boundary from the shared helper, not its own copy`, () => {
      // Anti-duplication: two boundary implementations would eventually differ,
      // and the difference would be a canvas where triggers are not on the left.
      expect(src, name).toMatch(/leftBoundaryX\(/);
    });

    it(`${name} normalizes positions when a graph is loaded`, () => {
      expect(src, name).toMatch(/normalizeGraphPositions\(/);
    });

    it(`${name} has real full screen and Escape leaves it`, () => {
      expect(src, name).toMatch(/fixed inset-0/);
      expect(src, name).toMatch(/"Escape"/);
      expect(src, name).toMatch(/setFullscreen\(false\)/);
    });
  }

  it("full screen is a real viewport takeover, not a modal over a padded page", () => {
    // The spec is explicit that a fake modal with the old page still
    // constraining the canvas does not count.
    for (const [name, src] of [["FlowEditor", flow], ["MainPlaybookEditor", playbook]] as const) {
      expect(src, name).toMatch(/fullscreen \? "fixed inset-0 z-40 bg-white h-screen/);
    }
  });
});

describe("unsaved work is protected", () => {
  it("FlowEditor warns before the browser discards unsaved edits", () => {
    expect(flow).toMatch(/beforeunload/);
    expect(flow).toMatch(/saveState !== "unsaved"/);
  });
});
