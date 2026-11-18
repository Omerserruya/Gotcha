/** The Smoovee rerun on luna (2026-11-18): no long dashes in what the import writes; a document conflict's source. */
import { describe, it, expect, vi } from "vitest";
const S = vi.hoisted(() => ({ results: [] as any[] }));
vi.mock("@chatcenter/shared", async (orig) => ({ ...(await orig<any>()), prisma: {} }));
vi.mock("../services/historical-intelligence/llm", async (orig) => {
  const real: any = await orig();
  return { ...real, structuredCall: async (a: any) => (a.feature === "historical_knowledge_crosscheck" && /compare answers/.test(a.system) ? { results: S.results } : a.feature === "historical_knowledge_crosscheck" ? { names: [] } : null) };
});
import { noDashes, noDashesDeep } from "../services/historical-intelligence/llm";
import { languageDirective } from "../services/historical-intelligence/stage-utils";
import { buildReview } from "../services/historical-intelligence/knowledge-review.stage";

const EM = String.fromCharCode(0x2014), EN = String.fromCharCode(0x2013);

describe("no em or en dash in the import's own output", () => {
  it("★ a range gets a hyphen, any other long dash a comma", () => {
    expect(noDashes(`פתוח 9${EN}17`)).toBe("פתוח 9-17");
    expect(noDashes(`משלוח חינם ${EM} מעל 299 ש"ח`)).toBe(`משלוח חינם, מעל 299 ש"ח`);
    expect(noDashes(`a${EM}b`)).toBe("a, b");
    expect(noDashes("no dash")).toBe("no dash");
  });
  it("★ verbatim quotes and a document's title and sentence stay as written", () => {
    const out: any = noDashesDeep({ items: [{ question: `q ${EM} x`, answer: `a ${EM} y`, quotedQuestion: `Q ${EM} chat`, quotedAnswer: `A ${EM} chat` }], results: [{ note: `n ${EM} z`, document: `תקנון ${EM} 2026`, passage: `p ${EM} doc` }] });
    expect(out.items[0]).toEqual({ question: "q, x", answer: "a, y", quotedQuestion: `Q ${EM} chat`, quotedAnswer: `A ${EM} chat` });
    expect(out.results[0]).toEqual({ note: "n, z", document: `תקנון ${EM} 2026`, passage: `p ${EM} doc` });
  });
  it("★ every import prompt says so (through the language directive)", () => {
    expect(languageDirective("Hebrew")).toMatch(/Never write an em dash or an en dash/);
  });
});

describe("a document conflict keeps its document and sentence", () => {
  const cand = (id: string) => ({ id, topic: "החזרות", category: "RETURNS_AND_CANCELLATION", question: "תוך כמה זמן אפשר להחזיר מוצר", answer: "אפשר להחזיר מוצר תוך 30 יום", occurrenceCount: 4, customerCount: 4, lastSeenAt: null, conflict: false, curationVerdict: "kept", curationNote: null, requiresLiveLookup: false });
  const docs = [{ id: "d1", title: "תקנון", content: "מדיניות החזרות: אפשר להחזיר מוצר תוך 14 יום מקבלתו, באריזה המקורית." }];
  it("★ the cross-check's document and sentence reach onContradiction; a title not sent is never invented", async () => {
    const seen: any[] = [];
    S.results = [{ id: "a", relation: "contradicts", note: "14 vs 30", document: "תקנון", passage: "אפשר להחזיר מוצר תוך 14 יום מקבלתו" }];
    await buildReview({ tenantId: "t", language: "Hebrew", tenantName: "סמובי", candidates: [cand("a")] as any, evidence: [], humanSourced: new Set(), docs, onContradiction: async (id, note, src) => { seen.push({ id, note, src }); } });
    expect(seen[0]).toMatchObject({ id: "a", src: { documentId: "d1", document: "תקנון", passage: "אפשר להחזיר מוצר תוך 14 יום מקבלתו", note: "14 vs 30" } });
    expect(seen[0].note).toMatch(/^\[doc-conflict\]/);
    seen.length = 0;
    S.results = [{ id: "a", relation: "contradicts", note: "x", document: "מסמך שלא נשלח", passage: "p" }];
    await buildReview({ tenantId: "t", language: "Hebrew", tenantName: "סמובי", candidates: [cand("a")] as any, evidence: [], humanSourced: new Set(), docs: [...docs, { id: "d2", title: "משלוחים", content: "אפשר להחזיר מוצר דרך שליח עד הבית תוך שבוע." }], onContradiction: async (id, note, src) => { seen.push({ id, note, src }); } });
    expect(seen[0].src).toMatchObject({ documentId: null, document: null, passage: null });
  });
  it("★ the model's spelling of a title is matched to the stored document in code", async () => {
    const { matchDocument } = await import("../services/historical-intelligence/knowledge-review.stage");
    const docs = [{ id: "c1", title: "קטלוג המוצרים" }, { id: "f1", title: "שאלות נפוצות" }, { id: "f2", title: "שאלות" }];
    for (const said of ["קטלוג המוצרים", "״קטלוג המוצרים״", "„קטלוג המוצרים”", "«קטלוג המוצרים»"]) expect(matchDocument(docs, said, "", [])).toEqual({ id: "c1", title: "קטלוג המוצרים" });
    expect(matchDocument(docs, "", "the FAQ (שאלות נפוצות) says 14 days", [])).toEqual({ id: "f1", title: "שאלות נפוצות" });
    expect(matchDocument(docs, "מסמך אחר", "no title here", [{ title: "שאלות" }, { title: "קטלוג המוצרים" }])).toBeNull();
    expect(matchDocument(docs, "מסמך אחר", "no title here", [{ title: "שאלות" }])).toEqual({ id: "f2", title: "שאלות" });
  });
});
