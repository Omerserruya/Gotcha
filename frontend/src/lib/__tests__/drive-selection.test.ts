/**
 * Picking files and folders in the Google Drive browser.
 *
 * The rule that matters is the one the server also enforces: a batch cannot
 * hold folders and files at once, because a folder source owns the documents it
 * produced and a mixed batch is ambiguous about which source owns what. The UI
 * has to make that impossible to assemble rather than let the admin build a
 * selection and then be told no.
 */
import { describe, it, expect } from "vitest";
import {
  emptyDriveSelection,
  toggleDriveSelection,
  driveSelectionList,
} from "../drive-selection";

const doc = (id: string, name = id) => ({
  id,
  name,
  mimeType: "application/vnd.google-apps.document",
});
const folder = (id: string, name = id) => ({
  id,
  name,
  mimeType: "application/vnd.google-apps.folder",
});

describe("picking files", () => {
  it("selects one file", () => {
    const state = toggleDriveSelection(emptyDriveSelection(), doc("a", "Handbook"), false);
    expect(driveSelectionList(state)).toEqual([
      { id: "a", kind: "file", name: "Handbook", driveId: undefined, mimeType: doc("a").mimeType },
    ]);
  });

  it("selects several files", () => {
    let state = emptyDriveSelection();
    state = toggleDriveSelection(state, doc("a"), false);
    state = toggleDriveSelection(state, doc("b"), false);
    state = toggleDriveSelection(state, doc("c"), false);

    expect(driveSelectionList(state).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(state.kind).toBe("file");
  });

  it("unticks a file", () => {
    let state = toggleDriveSelection(emptyDriveSelection(), doc("a"), false);
    state = toggleDriveSelection(state, doc("b"), false);
    state = toggleDriveSelection(state, doc("a"), false);

    expect(driveSelectionList(state).map((s) => s.id)).toEqual(["b"]);
  });

  it("goes back to accepting either kind once emptied", () => {
    let state = toggleDriveSelection(emptyDriveSelection(), doc("a"), false);
    state = toggleDriveSelection(state, doc("a"), false);

    expect(state.kind).toBeNull();
    state = toggleDriveSelection(state, folder("F"), true);
    expect(state.kind).toBe("folder");
  });
});

describe("picking folders", () => {
  it("selects a folder as its own source", () => {
    const state = toggleDriveSelection(emptyDriveSelection(), folder("F", "Policies"), true);
    expect(driveSelectionList(state)).toEqual([
      { id: "F", kind: "folder", name: "Policies", driveId: undefined, mimeType: folder("F").mimeType },
    ]);
  });

  it("selects several folders", () => {
    let state = toggleDriveSelection(emptyDriveSelection(), folder("F"), true);
    state = toggleDriveSelection(state, folder("G"), true);
    expect(driveSelectionList(state).map((s) => s.id)).toEqual(["F", "G"]);
  });
});

describe("folders and files never mix", () => {
  it("replaces a file selection when a folder is ticked", () => {
    let state = toggleDriveSelection(emptyDriveSelection(), doc("a"), false);
    state = toggleDriveSelection(state, doc("b"), false);
    state = toggleDriveSelection(state, folder("F"), true);

    expect(state.kind).toBe("folder");
    expect(driveSelectionList(state).map((s) => s.id)).toEqual(["F"]);
  });

  it("replaces a folder selection when a file is ticked", () => {
    let state = toggleDriveSelection(emptyDriveSelection(), folder("F"), true);
    state = toggleDriveSelection(state, doc("a"), false);

    expect(state.kind).toBe("file");
    expect(driveSelectionList(state).map((s) => s.id)).toEqual(["a"]);
  });

  it("never produces a list holding both kinds", () => {
    let state = emptyDriveSelection();
    for (const step of [
      [doc("a"), false],
      [folder("F"), true],
      [doc("b"), false],
      [folder("G"), true],
      [folder("H"), true],
    ] as const) {
      state = toggleDriveSelection(state, step[0], step[1]);
      const kinds = new Set(driveSelectionList(state).map((s) => s.kind));
      expect(kinds.size).toBeLessThanOrEqual(1);
    }
    expect(driveSelectionList(state).map((s) => s.id)).toEqual(["G", "H"]);
  });
});

describe("Shared Drives", () => {
  it("carries the drive id from the browsing context, not the row", () => {
    // A file listed inside a Shared Drive has to be queried with that drive's
    // id, and only the listing knows which drive we are in.
    const state = toggleDriveSelection(emptyDriveSelection(), doc("sd1", "MSA"), false, "D1");
    expect(driveSelectionList(state)[0].driveId).toBe("D1");
  });

  it("carries the drive id for a folder too", () => {
    const state = toggleDriveSelection(emptyDriveSelection(), folder("SDF", "Contracts"), true, "D1");
    expect(driveSelectionList(state)[0]).toMatchObject({ kind: "folder", driveId: "D1" });
  });

  it("keeps My Drive picks free of a drive id", () => {
    const state = toggleDriveSelection(emptyDriveSelection(), doc("a"), false);
    expect(driveSelectionList(state)[0].driveId).toBeUndefined();
  });

  it("lets one batch span My Drive and a Shared Drive, since each pick carries its own scope", () => {
    let state = toggleDriveSelection(emptyDriveSelection(), folder("F"), true);
    state = toggleDriveSelection(state, folder("SDF"), true, "D1");

    expect(driveSelectionList(state).map((s) => s.driveId)).toEqual([undefined, "D1"]);
  });
});

describe("immutability", () => {
  it("does not mutate the previous state, so React sees a change", () => {
    const first = toggleDriveSelection(emptyDriveSelection(), doc("a"), false);
    const second = toggleDriveSelection(first, doc("b"), false);

    expect(first.items.size).toBe(1);
    expect(second.items.size).toBe(2);
    expect(second.items).not.toBe(first.items);
  });
});
