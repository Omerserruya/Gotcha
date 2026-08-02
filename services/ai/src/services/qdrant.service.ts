import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || undefined; // empty string = no auth
const COLLECTION_NAME = "knowledge_chunks";
const VECTOR_SIZE = 1536; // text-embedding-3-small

let client: QdrantClient;

export function getQdrantClient(): QdrantClient {
  if (!client) {
    client = new QdrantClient({ url: QDRANT_URL, ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}) });
  }
  return client;
}

export async function ensureCollection(): Promise<void> {
  const qdrant = getQdrantClient();

  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION_NAME);

  if (!exists) {
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
    // Create payload indexes for filtering
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "tenantId",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "documentId",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "knowledgeBaseId",
      field_schema: "keyword",
    });
    console.log(`[Qdrant] Created collection "${COLLECTION_NAME}" with indexes`);
  }
}

export interface ChunkPayload {
  tenantId: string;
  documentId: string;
  knowledgeBaseId: string;
  documentTitle: string;
  content: string;
  chunkIndex: number;
}

export async function upsertChunks(
  chunks: { id: string; vector: number[]; payload: ChunkPayload }[]
): Promise<void> {
  if (chunks.length === 0) return;
  const qdrant = getQdrantClient();
  await ensureCollection();

  await qdrant.upsert(COLLECTION_NAME, {
    points: chunks.map((c) => ({
      id: c.id,
      vector: c.vector,
      payload: c.payload as unknown as Record<string, unknown>,
    })),
  });
}

export async function deleteByDocumentId(documentId: string): Promise<void> {
  await ensureCollection();
  const qdrant = getQdrantClient();

  await qdrant.delete(COLLECTION_NAME, {
    filter: {
      must: [{ key: "documentId", match: { value: documentId } }],
    },
  });
}

export async function deleteByKnowledgeBaseId(knowledgeBaseId: string): Promise<void> {
  await ensureCollection();
  const qdrant = getQdrantClient();

  await qdrant.delete(COLLECTION_NAME, {
    filter: {
      must: [{ key: "knowledgeBaseId", match: { value: knowledgeBaseId } }],
    },
  });
}

export async function deleteByTenantId(tenantId: string): Promise<void> {
  await ensureCollection();
  const qdrant = getQdrantClient();

  await qdrant.delete(COLLECTION_NAME, {
    filter: {
      must: [{ key: "tenantId", match: { value: tenantId } }],
    },
  });
}

export interface SearchResult {
  content: string;
  score: number;
  documentTitle: string;
  chunkIndex: number;
}

export async function searchSimilar(
  tenantId: string,
  queryVector: number[],
  limit = 5,
  activeKnowledgeBaseIds?: string[]
): Promise<SearchResult[]> {
  const qdrant = getQdrantClient();
  await ensureCollection();

  const filter: any = {
    must: [{ key: "tenantId", match: { value: tenantId } }],
  };

  if (activeKnowledgeBaseIds?.length) {
    filter.must.push({
      key: "knowledgeBaseId",
      match: { any: activeKnowledgeBaseIds },
    });
  }

  const results = await qdrant.search(COLLECTION_NAME, {
    vector: queryVector,
    limit,
    filter,
    with_payload: true,
  });

  return results.map((r) => ({
    content: (r.payload as any).content,
    score: r.score,
    documentTitle: (r.payload as any).documentTitle,
    chunkIndex: (r.payload as any).chunkIndex,
  }));
}
