import { getQdrantClient } from "../qdrant.service";
import { generateEmbedding } from "../embedding.service";
import { searchSimilar } from "../qdrant.service";
import { prisma } from "@chatcenter/shared";

/**
 * The vector index that makes "the same question, asked four ways" into one
 * suggestion.
 *
 * "Where are you located", "what's your address", "do you have a Tel Aviv
 * branch" and "where's the store" are one piece of knowledge. Grouping them by
 * string similarity fails immediately - they share almost no words - so the
 * grouping has to be semantic, which means embeddings, which in this repository
 * means Qdrant. Vectors have never lived in Postgres here.
 *
 * Its own collection, separate from `knowledge_chunks`, because the two answer
 * different questions and must never contaminate each other: the KB collection
 * is what the AI retrieves from when talking to a customer, and an unapproved
 * candidate appearing there would be exactly the silent promotion this whole
 * feature is built to prevent.
 */

const COLLECTION_NAME = "historical_knowledge_candidates";
const VECTOR_SIZE = 1536; // text-embedding-3-small, matching knowledge_chunks

/**
 * Cosine similarity above which two questions are treated as the same one.
 *
 * Tuned deliberately high. The two failure modes are not symmetric: merging two
 * genuinely different questions hides one of them from the owner forever and is
 * invisible, while failing to merge shows them two similar cards, which they
 * can see and resolve in a second. When in doubt, do not merge.
 */
const CLUSTER_THRESHOLD = 0.9;

/**
 * Similarity against EXISTING knowledge above which a candidate is considered
 * already covered. Lower than the clustering threshold on purpose - a knowledge
 * base document is longer and differently phrased than a question, so an exact
 * match scores lower than two questions would.
 */
const EXISTING_KB_THRESHOLD = 0.82;

let collectionReady = false;

async function ensureCandidateCollection(): Promise<void> {
  if (collectionReady) return;
  const qdrant = getQdrantClient();
  const collections = await qdrant.getCollections();
  if (!collections.collections.some((c) => c.name === COLLECTION_NAME)) {
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
    // Both are filtered on every single query. `tenantId` is the isolation
    // boundary and `importId` scopes clustering to one run, so neither is
    // optional.
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "tenantId",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "importId",
      field_schema: "keyword",
    });
    console.log(`[Qdrant] Created collection "${COLLECTION_NAME}"`);
  }
  collectionReady = true;
}

/**
 * The text that gets embedded for clustering.
 *
 * Question and topic, never the answer. Two contradictory answers to the same
 * question MUST land in the same cluster - that is how a conflict is detected
 * at all. Embedding the answer would push them apart and produce two confident
 * candidates that quietly disagree, which is the single worst output this
 * feature could produce.
 */
export function clusterText(topic: string, question: string): string {
  return `${topic}: ${question}`;
}

export async function embedForCluster(tenantId: string, text: string): Promise<number[] | null> {
  try {
    return await generateEmbedding(text, { tenantId });
  } catch (err: any) {
    console.warn(`[historical-intelligence] embedding failed: ${err?.message}`);
    return null;
  }
}

/**
 * The existing candidate this question belongs to, if any.
 *
 * Scoped to (tenantId, importId). The tenant filter is the isolation boundary
 * and is never optional; the import filter keeps one business's runs from
 * merging into each other, which matters after a re-onboarding.
 */
export async function findCluster(args: {
  tenantId: string;
  importId: string;
  vector: number[];
}): Promise<{ candidateId: string; score: number } | null> {
  await ensureCandidateCollection();
  const qdrant = getQdrantClient();
  const results = await qdrant.search(COLLECTION_NAME, {
    vector: args.vector,
    limit: 1,
    filter: {
      must: [
        { key: "tenantId", match: { value: args.tenantId } },
        { key: "importId", match: { value: args.importId } },
      ],
    },
    with_payload: true,
  });
  const top = results[0];
  if (!top || top.score < CLUSTER_THRESHOLD) return null;
  const candidateId = (top.payload as any)?.candidateId;
  return candidateId ? { candidateId: String(candidateId), score: top.score } : null;
}

export async function indexCluster(args: {
  pointId: string;
  tenantId: string;
  importId: string;
  candidateId: string;
  vector: number[];
}): Promise<void> {
  await ensureCandidateCollection();
  const qdrant = getQdrantClient();
  await qdrant.upsert(COLLECTION_NAME, {
    points: [
      {
        id: args.pointId,
        vector: args.vector,
        payload: {
          tenantId: args.tenantId,
          importId: args.importId,
          candidateId: args.candidateId,
        },
      },
    ],
  });
}

/**
 * Is this already in the tenant's knowledge base?
 *
 * Run twice for every candidate: once when it is created, and again at the
 * moment of approval. Twice because a document can be added by hand in between,
 * and approving a duplicate then would leave the AI retrieving two documents
 * that answer the same question - which is how a knowledge base starts
 * contradicting itself.
 *
 * Searches ONLY the tenant's own active knowledge bases. There is no code path
 * here that can reach another tenant's vectors: the tenant filter is applied
 * inside `searchSimilar`, and the knowledge-base id list is resolved from this
 * tenant's rows.
 */
export async function findExistingKnowledge(args: {
  tenantId: string;
  question: string;
  answer: string;
}): Promise<{ documentId: string | null; title: string; score: number } | null> {
  const activeKbs = await prisma.knowledgeBase.findMany({
    where: { tenantId: args.tenantId, isActive: true },
    select: { id: true },
  });
  if (activeKbs.length === 0) return null;

  const vector = await embedForCluster(args.tenantId, `${args.question}\n${args.answer}`);
  if (!vector) return null;

  let hits: Awaited<ReturnType<typeof searchSimilar>>;
  try {
    hits = await searchSimilar(args.tenantId, vector, 1, activeKbs.map((k) => k.id));
  } catch (err: any) {
    // A vector store that is down must not silently suppress the duplicate
    // check AND must not block the import. Returning null means "we could not
    // tell", and the candidate is offered to a human, who can tell.
    console.warn(`[historical-intelligence] existing-kb probe failed: ${err?.message}`);
    return null;
  }

  const top = hits[0];
  if (!top || top.score < EXISTING_KB_THRESHOLD) return null;

  // `searchSimilar` returns the chunk's content and title but not its document
  // id, so the document is resolved by title within this tenant. A null id
  // still marks the candidate as covered - the reviewer sees which document
  // covers it, which is the part that matters.
  const doc = await prisma.knowledgeDocument.findFirst({
    where: { tenantId: args.tenantId, title: top.documentTitle },
    select: { id: true },
  });
  return { documentId: doc?.id ?? null, title: top.documentTitle, score: top.score };
}

/** Remove an import's cluster vectors. Used when an import is deleted. */
export async function dropImportClusters(tenantId: string, importId: string): Promise<void> {
  await ensureCandidateCollection();
  const qdrant = getQdrantClient();
  await qdrant.delete(COLLECTION_NAME, {
    filter: {
      must: [
        { key: "tenantId", match: { value: tenantId } },
        { key: "importId", match: { value: importId } },
      ],
    },
  });
}

export const __thresholds = { CLUSTER_THRESHOLD, EXISTING_KB_THRESHOLD };
