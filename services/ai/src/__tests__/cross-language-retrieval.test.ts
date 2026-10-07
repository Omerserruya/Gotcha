/**
 * Cross-language retrieval (query-translation.service + retrieveRelevantChunks),
 * with doubles for the embedding, the vector search and the model:
 *   - ★ an English question against Hebrew Knowledge is also searched in
 *     Hebrew; each chunk keeps its best score (0.12 → 0.31 measured on dev)
 *   - ★ no translation (no model call) when the languages match
 *   - ★ a refused (no credits), failed or timed-out translation falls back to
 *     the direct search: retrieval never fails because of it
 *   - the call: micro model, minimal reasoning, budget sized to the question,
 *     feature "knowledge_query_translation" (metered like every call)
 *   - ★ the gap threshold: 0.30, on the best of both searches
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  docs: [{ title: "סקירת העסק", content: "אנחנו חנות מקוונת למוצרים אורבניים, אופנה ואביזרים לצעירים." }] as any[],
  translation: "מה אתם מוכרים?" as string | Error,
  calls: [] as any[],
  gaps: [] as any[],
  scores: { hebrew: 0.31, english: 0.12 },
}));

vi.mock("@chatcenter/shared", () => {
  return {
    recordUnansweredQuestion: (q: any) => { H.gaps.push(q); },
    prisma: {
      knowledgeBase: { findMany: async () => [{ id: "kb1", scope: "all", scopeAgentId: null, scopeDepartmentId: null }] },
      knowledgeDocument: { findMany: async () => H.docs },
    },
  };
});
vi.mock("../services/embedding.service", () => ({ generateEmbedding: async (text: string) => [text] }));
vi.mock("../services/qdrant.service", () => ({
  // The Hebrew overview: close to a Hebrew question, far from an English one.
  searchSimilar: async (_t: string, vec: any[]) => {
    const hebrew = /[֐-׿]/.test(String(vec[0]));
    return [
      { content: "אנחנו חנות מקוונת...", score: hebrew ? H.scores.hebrew : H.scores.english, documentTitle: "סקירת העסק", chunkIndex: 0, documentId: "d1" },
      { content: "קול המותג...", score: hebrew ? 0.2 : 0.07, documentTitle: "שפת המותג", chunkIndex: 0, documentId: "d2" },
    ];
  },
}));
vi.mock("../services/ai.service", () => ({
  getMicroModel: () => "gpt-5-nano",
  generateResponse: async (p: any) => {
    H.calls.push(p);
    if (H.translation instanceof Error) throw H.translation;
    return { content: H.translation, usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 } };
  },
}));

import { retrieveRelevantChunks, mergeByBestScore, KNOWLEDGE_GAP_SCORE } from "../services/knowledge.service";
import { dominantScript, translatedQuery, clearKnowledgeScriptCache, knowledgeScript } from "../services/query-translation.service";

const T = "T";
beforeEach(() => {
  clearKnowledgeScriptCache();
  H.translation = "מה אתם מוכרים?"; H.calls = []; H.gaps = []; H.scores = { hebrew: 0.31, english: 0.12 };
  H.docs = [{ title: "סקירת העסק", content: "אנחנו חנות מקוונת למוצרים אורבניים, אופנה ואביזרים לצעירים." }];
});

describe("★ an English question, Hebrew Knowledge", () => {
  it("is also searched in Hebrew; the overview comes back at its Hebrew score", async () => {
    const r = await retrieveRelevantChunks(T, "What do you sell?", 5, null, { record: true });
    expect(r.map((c) => [c.documentId, c.score])).toEqual([["d1", 0.31], ["d2", 0.2]]);
    expect(H.gaps).toEqual([]); // 0.31 ≥ 0.30: answered, not a gap
  });

  it("the call: micro model, minimal reasoning, a budget sized to the question, its own usage feature", async () => {
    await translatedQuery(T, "What do you sell?");
    expect(H.calls).toHaveLength(1);
    expect(H.calls[0]).toMatchObject({
      tenantId: T, model: "gpt-5-nano", reasoningEffort: "minimal", maxTokens: Math.ceil("What do you sell?".length * 2) + 20,
      metadata: { type: "knowledge_query_translation" },
    });
    expect(H.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(H.calls[0].messages[0].content).toMatch(/into Hebrew/);
  });

  it("★ no model call when the question is in the Knowledge's language, or has no letters to tell", async () => {
    expect(await translatedQuery(T, "מה אתם מוכרים?")).toBeNull();
    expect(await translatedQuery(T, "?? 123")).toBeNull();
    const r = await retrieveRelevantChunks(T, "מה אתם מוכרים?", 5, null, { record: false });
    expect(r[0]!.score).toBe(0.31);
    expect(H.calls).toEqual([]);
  });

  it("★ refused (no AI credits), failed or timed out → the direct search, never an error", async () => {
    for (const err of [Object.assign(new Error("ai_units"), { name: "AiUnitsExhaustedError" }), new Error("provider 500"), Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" })]) {
      H.translation = err;
      await expect(translatedQuery(T, "What do you sell?")).resolves.toBeNull();
      const r = await retrieveRelevantChunks(T, "What do you sell?", 5, null, { record: false });
      expect(r.map((c) => c.score)).toEqual([0.12, 0.07]);
    }
  });

  it("Knowledge in English, question in Hebrew: translated into English", async () => {
    H.docs = [{ title: "About us", content: "We are an online store for urban goods and accessories." }];
    H.translation = "What do you sell?";
    expect(await translatedQuery(T, "מה אתם מוכרים?")).toBe("What do you sell?");
    expect(H.calls[0].messages[0].content).toMatch(/into English/);
  });
});

describe("the Knowledge's script", () => {
  it("is the majority script, cached for an hour", async () => {
    expect(dominantScript("Urban Supply - חנות מקוונת למוצרים אורבניים")).toBe("hebrew");
    expect(dominantScript("مرحبا بكم")).toBe("arabic");
    expect(dominantScript("12 ?!")).toBeNull();
    expect(await knowledgeScript(T, 0)).toBe("hebrew");
    H.docs = [{ title: "About", content: "English only now" }];
    expect(await knowledgeScript(T, 30 * 60_000)).toBe("hebrew");
    expect(await knowledgeScript(T, 61 * 60_000)).toBe("latin");
  });
});

describe("★ the gap threshold (0.30, on the best of both searches)", () => {
  it("is 0.30", () => { expect(KNOWLEDGE_GAP_SCORE).toBe(0.3); });

  it("0.299 is a gap, 0.30 is not; the translated search's score is what counts", async () => {
    H.scores = { hebrew: 0.299, english: 0.1 };
    await retrieveRelevantChunks(T, "What do you sell?", 5, null, { record: true });
    expect(H.gaps).toEqual([expect.objectContaining({ reason: "low_confidence", question: "What do you sell?" })]);
    H.gaps = [];
    H.scores = { hebrew: 0.3, english: 0.1 };
    await retrieveRelevantChunks(T, "What do you sell?", 5, null, { record: true });
    expect(H.gaps).toEqual([]);
  });

  it("mergeByBestScore: one entry per chunk, at its best score, best first, capped", () => {
    const a = { content: "", documentTitle: "x", chunkIndex: 0, documentId: "d1" };
    expect(mergeByBestScore([[{ ...a, score: 0.1 }], [{ ...a, score: 0.4 }, { ...a, chunkIndex: 1, score: 0.2 }]], 5).map((c) => [c.chunkIndex, c.score]))
      .toEqual([[0, 0.4], [1, 0.2]]);
    expect(mergeByBestScore([[{ ...a, score: 0.1 }, { ...a, chunkIndex: 1, score: 0.2 }]], 1)).toHaveLength(1);
  });
});
