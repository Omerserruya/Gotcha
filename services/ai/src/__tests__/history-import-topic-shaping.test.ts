/** Topic shaping and fragments (2026-11-18, the Smoovee rerun on luna: 94 topics, 34 singletons, one topic of 30). */
import { describe, it, expect, vi, beforeEach } from "vitest";
const S = vi.hoisted(() => ({ calls: [] as any[], answer: (_a: any): any => null }));
vi.mock("@chatcenter/shared", async (orig) => ({ ...(await orig<any>()), prisma: {} }));
vi.mock("../services/historical-intelligence/llm", async (orig) => {
  const real: any = await orig();
  return { ...real, structuredCall: async (a: any) => { S.calls.push(a); return S.answer(a); } };
});
import { labelKeys, labelsJoin, freeJoin, joinSingletons, checkSplit, splitBig, shapeTopics, SPLIT_ABOVE, PART_MAX, type ShapeGroup } from "../services/historical-intelligence/topic-shaping";
import { isFragment, foldFragments, canonicalFrom } from "../services/historical-intelligence/consolidation";

beforeEach(() => { S.calls = []; S.answer = () => null; });
const g = (label: string, ids: string[], category = "PRODUCT_INFO"): ShapeGroup => ({ label, category, candidateIds: ids });
const byId = (ids: string[], q = (id: string) => `שאלה ${id}`) => new Map(ids.map((id) => [id, { id, question: q(id), answer: `תשובה ${id}` }]));
const allIds = (gs: ShapeGroup[]) => gs.flatMap((x) => x.candidateIds).sort();

describe("the free label join", () => {
  it("★ twins join: the ה prefix and a plural ending do not make a new topic", () => {
    expect(labelsJoin("מידות משטח", "מידות המשטח")).toBe(true);
    expect(labelsJoin("משטח למיקסר", "משטחי מיקסר")).toBe(true);
    expect([...labelKeys("משטחי מיקסר")].sort()).toEqual([...labelKeys("משטח למיקסר")].sort());
  });
  it("★ a one-word label never joins on containment alone (the Supervisor's rule)", () => {
    expect(labelsJoin("משטח", "התאמת משטח למכשירים")).toBe(false);
    expect(labelsJoin("מידות", "מידות משטח")).toBe(false);
    // Two keys inside a longer label: joined.
    expect(labelsJoin("התאמת משטח", "התאמת משטח למכשירים")).toBe(true);
  });
  it("★ a singleton joins a topic of its own category only; every id stays once", () => {
    const out = freeJoin([g("מידות משטח", ["a", "b"]), g("מידות המשטח", ["c"]), g("מידות המשטח", ["d"], "SHIPPING_AND_DELIVERY"), g("הרשמה לניוזלטר", ["e"])]);
    expect(out.find((x) => x.label === "מידות משטח")!.candidateIds).toEqual(["a", "b", "c"]);
    expect(out.find((x) => x.category === "SHIPPING_AND_DELIVERY")!.candidateIds).toEqual(["d"]);
    expect(allIds(out)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("the per-category join call", () => {
  it("★ one call per category with singletons left; an OTHER singleton may join any category; a made-up label is ignored", async () => {
    S.answer = (a: any) => (/Single items/.test(a.user) ? { joins: [{ id: "n2", topic: "הרשמה לניוזלטר" }, { id: "x", topic: "תווית שלא קיימת" }] } : null);
    const groups = [g("הרשמה לניוזלטר", ["n1", "n3"], "PROMOTIONS"), g("ניוזלטר", ["n2"], "OTHER"), g("משהו", ["x"], "OTHER")];
    const r = await joinSingletons({ tenantId: "t", language: "Hebrew", groups, byId: byId(["n1", "n2", "n3", "x"]) });
    expect(r.calls).toBe(1);
    expect(r.groups.find((x) => x.label === "הרשמה לניוזלטר")!.candidateIds).toEqual(["n1", "n3", "n2"]);
    expect(r.groups.find((x) => x.label === "משהו")!.candidateIds).toEqual(["x"]);
    expect(allIds(r.groups)).toEqual(["n1", "n2", "n3", "x"]);
  });
  it("★ no call when a category has no singleton or no topic to join", async () => {
    const r = await joinSingletons({ tenantId: "t", language: "Hebrew", groups: [g("א ב", ["a", "b"]), g("ג ד", ["c"], "RETURNS")], byId: byId(["a", "b", "c"]) });
    expect(r.calls).toBe(0);
  });
});

describe("the split of a big topic", () => {
  const ids30 = Array.from({ length: 30 }, (_, i) => `d${i}`);
  it("★ only above 12 members; a 9 is never split", async () => {
    const r = await splitBig({ tenantId: "t", language: "Hebrew", groups: [g("אמצעי תשלום והטבות", ids30.slice(0, 9))], byId: byId(ids30) });
    expect(r.calls).toBe(0);
    expect(r.groups).toHaveLength(1);
    expect(SPLIT_ABOVE).toBe(12);
  });
  it("★ the 30-item device topic: parts of 2 to 8, every id once, labels unique", async () => {
    S.answer = () => ({ parts: [{ label: "תמי 4", ids: ids30.slice(0, 5) }, { label: "מידות לפי מכשיר", ids: ids30.slice(5, 20) }, { label: "ידית", ids: ["d20"] }, { label: "קנייה", ids: ids30.slice(21, 28) }] });
    const r = await splitBig({ tenantId: "t", language: "Hebrew", groups: [g("התאמת משטח למכשירים", ids30)], byId: byId(ids30) });
    expect(r.calls).toBe(1);
    expect(allIds(r.groups)).toEqual([...ids30].sort());
    for (const p of r.groups) { expect(p.candidateIds.length).toBeLessThanOrEqual(PART_MAX); expect(p.candidateIds.length).toBeGreaterThanOrEqual(2); }
    expect(new Set(r.groups.map((p) => p.label)).size).toBe(r.groups.length);
  });
  it("★ no usable answer: runs of 8 in the topic's own order, nothing lost", () => {
    const parts = checkSplit(g("התאמת משטח למכשירים", ids30), null, byId(ids30));
    expect(parts.map((p) => p.candidateIds.length)).toEqual([8, 8, 8, 6]);
    expect(allIds(parts)).toEqual([...ids30].sort());
  });
  it("★ shapeTopics: the join, then the split, with its detail", async () => {
    S.answer = (a: any) => (/Split by what is asked/.test(a.system) ? { parts: [{ label: "א", ids: ids30.slice(0, 15) }, { label: "ב", ids: ids30.slice(15) }] } : null);
    const r = await shapeTopics({ tenantId: "t", language: "Hebrew", groups: [g("התאמת משטח למכשירים", ids30), g("התאמת משטח", ["s1"])], byId: byId([...ids30, "s1"]) });
    expect(r.detail).toMatchObject({ before: 2, freeJoined: 1, split: 1, splitCalls: 1 });
    expect(allIds(r.groups)).toEqual([...ids30, "s1"].sort());
    for (const p of r.groups) expect(p.candidateIds.length).toBeLessThanOrEqual(PART_MAX);
  });
});

describe("fragments never survive as questions of their own", () => {
  it("★ the rule: 5 words or fewer, opening with אבל, אז, גם, ומה or a joined ו", () => {
    expect(isFragment("אבל עד לידית מה המידה")).toBe(true);
    expect(isFragment("ומה עם הידית")).toBe(true);
    expect(isFragment("וגם בשחור")).toBe(true);
    expect(isFragment("מה המידה של המשטח עד הידית")).toBe(false);
    expect(isFragment("אבל האם המשטח מתאים למיקסר שלי")).toBe(false);
    expect(isFragment("אבל האם המשטח מתאים למיקסר של קיטשן אייד")).toBe(false);
  });
  it("★ a fragment folds into the item whose answer shares the most words; with none shared it stays", () => {
    const m = (id: string, question: string, answer: string) => ({ id, question, answer, occurrenceCount: 2, firstSeenAt: null, lastSeenAt: null, curationVerdict: "kept", curationNote: null, requiresLiveLookup: false });
    const members = [m("f", "אבל עד לידית מה המידה", "המידה עד הידית היא 12 סנטימטר"), m("h", "מה גובה המשטח עד הידית", "המידה עד הידית היא 12 סנטימטר בכל הדגמים"), m("p", "כמה עולה משלוח", "משלוח עולה 30 שקל")];
    const folded = foldFragments(canonicalFrom(members as any, null));
    expect(folded.map((x) => x.question)).toEqual(["מה גובה המשטח עד הידית", "כמה עולה משלוח"]);
    expect(folded[0].sourceIds.sort()).toEqual(["f", "h"]);
    expect(folded[0].occurrences).toBe(4);
    const alone = foldFragments(canonicalFrom([m("f", "אבל עד לידית מה המידה", "שאלה טובה"), m("p", "כמה עולה משלוח", "משלוח עולה 30 שקל")] as any, null));
    expect(alone.map((x) => x.question)).toContain("אבל עד לידית מה המידה");
  });
});
