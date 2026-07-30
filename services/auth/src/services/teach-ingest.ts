// Route "teach" (Your Business / onboarding gap resolver) text + URL knowledge
// through the AI service's document endpoint so it is actually EMBEDDED
// (chunked into Qdrant), instead of a bare prisma.create that left the document
// `pending` with no vectors - invisible to retrieval, so the employee never
// learned it while the UI reported "Learned". Embedding must live in
// services/ai (architecture rule); we forward the admin's JWT and let that
// service create + process the document.

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";

export interface TeachDocBody {
  title: string;
  content: string;
  sourceType: string;
  sourceUrl?: string;
  /** Provenance + dedupe key, so re-answering a gap replaces its document. */
  metadata?: Record<string, unknown>;
}

// Minimal fetch shape so callers can inject the auth service's own
// fetchWithTimeout (and tests can inject a fake) without a hard dependency.
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  timeoutMs?: number,
) => Promise<{ ok: boolean; json: () => Promise<any> }>;

/**
 * Create + embed a taught document via services/ai. Returns the created
 * document id, or null when ingestion failed - callers MUST treat null as a
 * failure and NOT report the knowledge as learned (no false success).
 */
export async function ingestTaughtDocument(
  kbId: string,
  authHeader: string,
  body: TeachDocBody,
  fetchFn: FetchLike,
): Promise<string | null> {
  try {
    const res = await fetchFn(
      `${AI_SERVICE_URL}/api/knowledge-bases/${encodeURIComponent(kbId)}/documents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify(body),
      },
      30000,
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return (json?.data?.id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Replace an already-taught document in place.
 *
 * Used when a customer answers the SAME gap a second time - typically to
 * correct their first answer. Creating a second document instead would leave
 * both versions in retrieval, and the employee could quote the answer that was
 * just corrected. Returns the document id on success, null on failure, so the
 * caller can refuse to report "Learned" for something that did not land.
 */
export async function updateTaughtDocument(
  kbId: string,
  documentId: string,
  authHeader: string,
  body: { title: string; content: string; metadata?: Record<string, unknown> },
  fetchFn: FetchLike,
): Promise<string | null> {
  try {
    const res = await fetchFn(
      `${AI_SERVICE_URL}/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(documentId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify(body),
      },
      30000,
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return (json?.data?.id as string | undefined) ?? documentId;
  } catch {
    return null;
  }
}
