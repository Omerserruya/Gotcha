/** Consolidation (2026-11-18, Smoovee dry run 2): a small canonical set per topic, contradictions settled or flagged. */
import { describe, it, expect, vi } from "vitest";
vi.mock("@chatcenter/shared", async (orig) => ({ ...(await orig<any>()), prisma: {} }));
import { canonicalFrom } from "../services/historical-intelligence/consolidation";
import { unresolvedConflict, autoApprovable } from "../services/historical-intelligence/knowledge-review.stage";

const m = (id: string, answer: string, last: string, n = 1, o: any = {}) => ({ id, question: "כמה זמן לוקח משלוח?", answer, occurrenceCount: n, firstSeenAt: new Date(last), lastSeenAt: new Date(last), curationVerdict: "kept", curationNote: null, requiresLiveLookup: false, ...o });

describe("canonical items", () => {
  it("★ sources merged: occurrences summed, dates spanned, a rewrite", () => {
    const members = [m("a", "עד 3 ימי עסקים", "2026-03-01", 2), m("b", "35 ש\"ח", "2026-04-01"), m("c", "35 ש\"ח", "2026-05-01", 3)];
    const out = canonicalFrom(members, { items: [
      { question: "כמה זמן לוקח משלוח?", answer: "עד 3 ימי עסקים.", sourceIds: ["a"], status: "ok" },
      { question: "כמה עולה משלוח?", answer: "35 ש\"ח.", sourceIds: ["b", "c", "zz"], status: "ok" },
    ] });
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ occurrences: 4, sourceIds: ["b", "c"], curationVerdict: "rewritten", conflict: false });
    expect(out[1].lastSeenAt?.toISOString().slice(0, 10)).toBe("2026-05-01");
  });
  it("★ a clean switch is settled; overlapping answers are an unresolved conflict", () => {
    const members = [m("old", "עד 7 ימי עסקים", "2026-02-01", 5), m("new", "עד 3 ימי עסקים", "2026-09-01", 2), m("x", "עד 5", "2026-09-02"), m("y", "עד 2", "2026-09-03")];
    const out = canonicalFrom(members, { items: [
      { question: "זמן משלוח", answer: "עד 3 ימי עסקים.", sourceIds: ["old", "new"], status: "switched", note: "was 7 until 2026-02", competing: [{ answer: "עד 7 ימי עסקים", sourceIds: ["old"] }, { answer: "עד 3 ימי עסקים", sourceIds: ["new"] }] },
      { question: "זמן איסוף", answer: "עד 2", sourceIds: ["x", "y"], status: "unresolved", competing: [{ answer: "עד 5", sourceIds: ["x"] }, { answer: "עד 2", sourceIds: ["y"] }] },
    ] });
    expect(unresolvedConflict(out[0])).toBe(false);
    expect(out[0].curationNote).toMatch(/was 7/);
    expect(unresolvedConflict(out[1])).toBe(true);
  });
  it("★ an item the model left out is kept as its own; a doc conflict and live data carry over", () => {
    const members = [m("a", "x", "2026-03-01", 3, { curationNote: "[doc-conflict] price" }), m("b", "y", "2026-03-02", 1, { requiresLiveLookup: true })];
    const out = canonicalFrom(members, { items: [{ question: "q", answer: "x", sourceIds: ["a"], status: "ok" }] });
    expect(out.map((c) => c.sourceIds)).toEqual([["a"], ["b"]]);
    expect(out[0].curationNote).toMatch(/^\[doc-conflict\]/);
    expect(out[1].requiresLiveLookup).toBe(true);
    expect(autoApprovable({ humanSourced: true, occurrenceCount: out[0].occurrences, conflict: out[0].conflict, variants: out[0].variants, curationVerdict: out[0].curationVerdict, curationNote: out[0].curationNote, requiresLiveLookup: false })).toBe(false);
  });
  it("★ the value taken from the business's document clears a source's doc conflict; the choice line is the note", () => {
    const members = [m("a", "מעל 299", "2026-03-01", 4, { curationNote: "[doc-conflict] free shipping differs" }), m("b", "מעל 449", "2026-10-01", 2)];
    const out = canonicalFrom(members, { items: [{ question: "מעל כמה משלוח חינם?", answer: "משלוח חינם מעל 449 ₪.", sourceIds: ["a", "b"], status: "ok", policy: true, chosenFrom: "document", choice: "נבחר: 449 (מסמך: תקנון)", chosenValue: "449 ₪" }] });
    expect(out[0].curationNote).toBe("נבחר: 449 (מסמך: תקנון)");
    expect(out[0].chosen).toEqual({ value: "449 ₪", basis: "policy", at: null });
    const kept = canonicalFrom(members, { items: [{ question: "q", answer: "מעל 449", sourceIds: ["a", "b"], status: "ok", chosenFrom: "newest_answer" }] });
    expect(kept[0].curationNote).toMatch(/^\[doc-conflict\]/);
  });
  it("no model output: every item stays", () => {
    expect(canonicalFrom([m("a", "x", "2026-01-01"), m("b", "y", "2026-01-02")], null)).toHaveLength(2);
  });
});
