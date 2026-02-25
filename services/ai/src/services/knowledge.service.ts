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
    const queryEmbedding = await generateEmbedding(query);

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

  const contextParts = chunks.map((chunk) => {
    return `[Source: ${chunk.documentTitle}]\n${chunk.content}`;
  });

  return `## Knowledge Base Context\n\nThe following information was retrieved from the organization's knowledge base. Use it to inform your response. Cite sources when applicable.\n\n${contextParts.join("\n\n---\n\n")}`;
}
