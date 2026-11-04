/**
 * Tehila (prod 2026-11-03): "איפה יש נקודות מכירה" was answered with "the
 * studio in Nahariya, coordinate a pickup" from her shipping doc. Her points of
 * sale are on a page that is not in her Knowledge. A neighbouring policy is not
 * an answer:
 *   - a source under the gap line is marked as a weak match;
 *   - when every source is weak, the model is told before it reads them;
 *   - the rules name the neighbour-topic case (points of sale vs pickup).
 */
import { describe, it, expect } from "vitest";
import { buildKnowledgeContext, KNOWLEDGE_GAP_SCORE } from "../services/knowledge.service";

const chunk = (title: string, score: number, content = "x") => ({ documentTitle: title, content, score, chunkIndex: 0, documentId: title } as any);

describe("knowledge context: a neighbouring topic is not an answer", () => {
  it("the shipping doc for a points-of-sale question is marked weak, and all-weak is said up front", () => {
    const ctx = buildKnowledgeContext([chunk("משלוחים", KNOWLEDGE_GAP_SCORE - 0.04, "איסוף עצמי מהסטודיו בנהריה בתיאום")]);
    expect(ctx).toContain("### Source 1: משלוחים (weak match: probably NOT about this question)");
    expect(ctx.indexOf("None of the sources below clearly matches")).toBeGreaterThan(-1);
    expect(ctx.indexOf("None of the sources below clearly matches")).toBeLessThan(ctx.indexOf("---BEGIN KNOWLEDGE---"));
  });
  it("a strong source is not marked, and one strong source lifts the all-weak line", () => {
    const ctx = buildKnowledgeContext([chunk("נקודות רכישה", KNOWLEDGE_GAP_SCORE + 0.1), chunk("משלוחים", KNOWLEDGE_GAP_SCORE - 0.05)]);
    expect(ctx).toContain("### Source 1: נקודות רכישה\n");
    expect(ctx).toContain("### Source 2: משלוחים (weak match");
    expect(ctx).not.toContain("None of the sources below clearly matches");
  });
  it("the rules name the case: pickup is not a point of sale; offer the team", () => {
    const ctx = buildKnowledgeContext([chunk("a", 0.5)]);
    expect(ctx).toMatch(/NEIGHBOURING topic is not an answer/);
    expect(ctx).toMatch(/נקודות מכירה/);
    expect(ctx).toMatch(/offer to have the team answer/);
  });
  it("a chunk with no score (older callers) is never called weak", () => {
    const ctx = buildKnowledgeContext([{ documentTitle: "t", content: "c", chunkIndex: 0 } as any]);
    expect(ctx).not.toContain("weak match");
    expect(ctx).not.toContain("None of the sources below");
  });
});
