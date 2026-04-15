import OpenAI from "openai";
import { prisma, trackAIUsage } from "@chatcenter/shared";
import { QdrantClient } from "@qdrant/js-client-rest";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || undefined; // empty string = no auth
const COLLECTION_NAME = "knowledge_chunks";

let qdrantClient: QdrantClient;

function getQdrant(): QdrantClient {
  if (!qdrantClient) {
    qdrantClient = new QdrantClient({ url: QDRANT_URL, ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}) });
  }
  return qdrantClient;
}

export interface RetrievedChunk {
  content: string;
  score: number;
  documentTitle: string;
  chunkIndex: number;
}

async function generateEmbedding(text: string, tenantId?: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.replace(/\n/g, " ").trim(),
  });

  // Track embedding usage (fire-and-forget) via centralized shared helper
  if (response.usage && tenantId) {
    trackAIUsage({
      tenantId,
      feature: "knowledge_retrieval",
      model: EMBEDDING_MODEL,
      promptTokens: response.usage.prompt_tokens ?? response.usage.total_tokens,
      completionTokens: 0,
      totalTokens: response.usage.total_tokens,
    }).catch((err: any) => console.error("[Knowledge] Usage tracking failed:", err.message));
  }

  return response.data[0].embedding;
}

export async function retrieveRelevantChunks(
  tenantId: string,
  query: string,
  limit = 5
): Promise<RetrievedChunk[]> {
  try {
    const queryEmbedding = await generateEmbedding(query, tenantId);

    // Get active knowledge base IDs for this tenant
    const activeKBs = await prisma.knowledgeBase.findMany({
      where: { tenantId, isActive: true },
      select: { id: true },
    });
    const activeKBIds = activeKBs.map((kb) => kb.id);

    if (activeKBIds.length === 0) return [];

    const qdrant = getQdrant();

    const results = await qdrant.search(COLLECTION_NAME, {
      vector: queryEmbedding,
      limit,
      filter: {
        must: [
          { key: "tenantId", match: { value: tenantId } },
          { key: "knowledgeBaseId", match: { any: activeKBIds } },
        ],
      },
      with_payload: true,
    });

    return results.map((r) => ({
      content: (r.payload as any).content,
      score: r.score,
      documentTitle: (r.payload as any).documentTitle,
      chunkIndex: (r.payload as any).chunkIndex,
    }));
  } catch (err: any) {
    console.error("[Knowledge] Retrieval error:", err.message);
    return [];
  }
}

export function buildKnowledgeContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";

  const contextParts = chunks.map((chunk) => {
    return `[Source: ${chunk.documentTitle}]\n${chunk.content}`;
  });

  return `## Knowledge Base Context\n\nThe following information was retrieved from the organization's knowledge base. Use it to inform your response. Cite sources when applicable.\n\n${contextParts.join("\n\n---\n\n")}`;
}
