import OpenAI from "openai";
import { prisma } from "@chatcenter/shared";
import { upsertChunks, deleteByDocumentId } from "./qdrant.service";
import { logTokenUsage } from "./tokenlog.service";
import { randomUUID } from "crypto";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const CHUNK_SIZE = parseInt(process.env.RAG_CHUNK_SIZE || "500", 10);
const CHUNK_OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP || "50", 10);

export async function generateEmbedding(
  text: string,
  context?: { tenantId: string; documentId?: string },
): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.replace(/\n/g, " ").trim(),
  });

  if (response.usage && context?.tenantId) {
    logTokenUsage({
      tenantId: context.tenantId,
      type: "embedding",
      model: EMBEDDING_MODEL,
      promptTokens: response.usage.prompt_tokens,
      totalTokens: response.usage.total_tokens,
      documentId: context.documentId,
    });
  }

  return response.data[0].embedding;
}

export function chunkDocument(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const words = text.split(/\s+/);
  if (words.length <= chunkSize) return [text.trim()];

  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    const chunk = words.slice(start, end).join(" ").trim();
    if (chunk) chunks.push(chunk);
    if (end >= words.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

export async function processDocument(documentId: string): Promise<void> {
  const document = await prisma.knowledgeDocument.findUnique({
    where: { id: documentId },
  });
  if (!document) throw new Error(`Document ${documentId} not found`);

  // Mark as processing
  await prisma.knowledgeDocument.update({
    where: { id: documentId },
    data: { status: "processing" },
  });

  try {
    // Delete existing chunks from Qdrant
    await deleteByDocumentId(documentId);

    // Delete existing chunk records from Postgres
    await prisma.knowledgeChunk.deleteMany({ where: { documentId } });

    // Chunk the document
    const chunks = chunkDocument(document.content);

    // Process each chunk: generate embedding and store in Qdrant
    const qdrantPoints: { id: string; vector: number[]; payload: any }[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const embedding = await generateEmbedding(chunkText, { tenantId: document.tenantId, documentId });
      const chunkId = randomUUID();

      // Store metadata in Postgres
      await prisma.knowledgeChunk.create({
        data: {
          id: chunkId,
          documentId,
          tenantId: document.tenantId,
          content: chunkText,
          chunkIndex: i,
        },
      });

      // Collect for batch upsert to Qdrant
      qdrantPoints.push({
        id: chunkId,
        vector: embedding,
        payload: {
          tenantId: document.tenantId,
          documentId,
          knowledgeBaseId: document.knowledgeBaseId,
          documentTitle: document.title,
          content: chunkText,
          chunkIndex: i,
        },
      });
    }

    // Batch upsert all vectors to Qdrant
    await upsertChunks(qdrantPoints);

    // Mark as ready
    await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: "ready", chunkCount: chunks.length },
    });

    console.log(`[Embedding] Processed document ${documentId}: ${chunks.length} chunks -> Qdrant`);
  } catch (err: any) {
    console.error(`[Embedding] Failed to process document ${documentId}:`, err.message);
    await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: "error", metadata: { error: err.message } },
    });
    throw err;
  }
}
