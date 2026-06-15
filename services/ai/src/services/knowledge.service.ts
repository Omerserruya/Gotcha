import { prisma } from "@chatcenter/shared";
import { generateEmbedding } from "./embedding.service";
import { searchSimilar, SearchResult } from "./qdrant.service";

export type { SearchResult as RetrievedChunk };

export async function retrieveRelevantChunks(
  tenantId: string,
  query: string,
  limit = 5
): Promise<SearchResult[]> {
  try {
    const queryEmbedding = await generateEmbedding(query, { tenantId });

    // Get active knowledge base IDs for this tenant
    const activeKBs = await prisma.knowledgeBase.findMany({
      where: { tenantId, isActive: true },
      select: { id: true },
    });
    const activeKBIds = activeKBs.map((kb) => kb.id);

    if (activeKBIds.length === 0) return [];

    return await searchSimilar(tenantId, queryEmbedding, limit, activeKBIds);
  } catch (err: any) {
    console.error("[Knowledge] Retrieval error:", err.message);
    return [];
  }
}

export function buildKnowledgeContext(chunks: SearchResult[]): string {
  if (chunks.length === 0) return "";

  const contextParts = chunks.map((chunk, i) => {
    return `### Source ${i + 1}: ${chunk.documentTitle}\n${chunk.content}`;
  });

  return `## KNOWLEDGE BASE CONTEXT (HIGH PRIORITY)

The text below is the PRIMARY source of truth for this turn. It overrides your general knowledge and any prior assumptions about this organization, its products, prices, policies, processes, and people.

Rules:
1. Treat the content below as authoritative. If it answers the question, use it.
2. Prefer the wording, numbers, and definitions found here over anything you "remember".
3. If the answer is NOT covered here, say so plainly - do not guess, do not infer beyond the text, do not fabricate names, prices, dates, links, or policies.
4. Do not contradict this content. If two sources here disagree, surface the disagreement instead of picking one silently.
5. When you use a fact from a specific source, you may reference it by its title or number; never invent sources.
6. Information NOT present here is treated as unknown for this turn.

---BEGIN KNOWLEDGE---

${contextParts.join("\n\n---\n\n")}

---END KNOWLEDGE---`;
}
