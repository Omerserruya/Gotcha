import { prisma } from "@chatcenter/shared";
import { upsertChunks, deleteByDocumentId } from "./qdrant.service";
import { generateEmbedding as aiGenerateEmbedding } from "./ai.service";
import { randomUUID } from "crypto";

const CHUNK_SIZE = parseInt(process.env.RAG_CHUNK_SIZE || "500", 10);
const CHUNK_OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP || "50", 10);

export async function generateEmbedding(
  text: string,
  context?: { tenantId: string; documentId?: string },
): Promise<number[]> {
  const result = await aiGenerateEmbedding({
    tenantId: context?.tenantId || "",
    input: text,
    metadata: { documentId: context?.documentId },
  });

  return result.embedding;
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

/**
 * Create-or-update a document that originates from an external sync source
 * (Google Drive, Confluence). Keyed by (knowledgeBaseId, sourceUrl) so a given
 * source page/file maps to exactly ONE document - re-syncing never duplicates.
 *
 * `changeKey` is an opaque version marker (Drive modifiedTime, Confluence
 * version number). When it matches what we stored last time the document is
 * left untouched (no re-embed, no LLM cost). When it differs - or the document
 * is new - the content is (re)written and re-embedded via processDocument.
 *
 * Returns the outcome so callers can report imported/updated/skipped counts.
 */
export async function upsertSyncedDocument(params: {
  knowledgeBaseId: string;
  tenantId: string;
  title: string;
  content: string;
  sourceType: string;
  sourceUrl: string;
  changeKey: string;
  metadata?: Record<string, unknown>;
}): Promise<"created" | "updated" | "skipped"> {
  const { knowledgeBaseId, tenantId, title, content, sourceType, sourceUrl, changeKey } = params;
  const metadata = { ...(params.metadata || {}), syncChangeKey: changeKey };

  const existing = await prisma.knowledgeDocument.findFirst({
    where: { knowledgeBaseId, tenantId, sourceUrl },
    select: { id: true, metadata: true },
  });

  if (existing) {
    const prevKey = (existing.metadata as any)?.syncChangeKey;
    // Unchanged at the source - nothing to do (avoids needless re-embedding).
    if (prevKey && changeKey && prevKey === changeKey) return "skipped";

    await prisma.knowledgeDocument.update({
      where: { id: existing.id },
      data: { title, content, sourceType, metadata, status: "pending" },
    });
    await processDocument(existing.id).catch((err) => {
      console.error(`[KnowledgeSync] Failed to re-embed ${existing.id}:`, err.message);
    });
    return "updated";
  }

  const doc = await prisma.knowledgeDocument.create({
    data: { knowledgeBaseId, tenantId, title, content, sourceType, sourceUrl, status: "pending", metadata },
  });
  await processDocument(doc.id).catch((err) => {
    console.error(`[KnowledgeSync] Failed to embed ${doc.id}:`, err.message);
  });
  return "created";
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
    await prisma.knowledgeChunk.deleteMany({ where: { tenantId: document.tenantId, documentId } });

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
