import { prisma, recordUnansweredQuestion } from "@chatcenter/shared";
import { isSemanticallyRetrievable } from "./behavior-engine.service";

/**
 * Is a knowledge miss on this message a question the owner should be asked
 * to teach? Not when it came from the test chat (an operator rehearsing, the
 * same rule that keeps test runs out of skill stats: a sandbox turn, or a
 * "sandbox:" conversation). Not when the message carries no question at all -
 * "thanks", "ok", a greeting, an emoji, a bare number - by the SAME classifier
 * that decides whether a message is worth a knowledge search; a strategy that
 * always searches used to record "תודה רבה" as a gap.
 */
export function shouldRecordKnowledgeGap(t: { sandbox?: boolean; customerExternalId?: string | null; message: string }): boolean {
  if (t.sandbox) return false;
  if (String(t.customerExternalId ?? "").startsWith("sandbox:")) return false;
  if (isOnlyCourtesy(t.message)) return false;
  return isSemanticallyRetrievable(t.message);
}

/**
 * Words that make up a message with nothing to answer. The WHOLE message must
 * be made of them: "thanks, do you ship to Eilat?" is a question, "תודה רבה"
 * is not. (The retrieval classifier's prefix patterns end in \b, which in JS
 * only works for ASCII, so "תודה רבה" slipped past it.)
 */
const COURTESY_WORDS = new Set([
  "thanks", "thank", "you", "thx", "ty", "so", "much", "very", "a", "lot", "ok", "okay", "k", "great", "perfect",
  "cool", "nice", "good", "fine", "sure", "got", "it", "bye", "goodbye", "hi", "hello", "hey", "all", "set",
  "תודה", "רבה", "רבות", "מאוד", "ממש", "מעולה", "סבבה", "אחלה", "בסדר", "גמור", "אוקי", "אוקיי", "יופי",
  "נהדר", "מצוין", "שלום", "היי", "להתראות", "ביי", "לכם", "לך", "על", "הכל", "הכול", "טוב", "בטח", "מושלם",
]);

export function isOnlyCourtesy(message: string): boolean {
  const words = String(message ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // Nothing but emoji / punctuation, or only courtesy words.
  return words.length === 0 || words.every((w) => COURTESY_WORDS.has(w));
}
import { generateEmbedding } from "./embedding.service";
import { searchSimilar, SearchResult } from "./qdrant.service";
import { translatedQuery } from "./query-translation.service";

/**
 * Below this top similarity score (the best of the direct and the translated
 * search) a question is recorded as one the Knowledge could not answer.
 *
 * 0.30, measured on dev 2026-10-07 (text-embedding-3-small, two Hebrew
 * documents): answerable questions scored 0.294-0.428 (median ~0.35), clearly
 * unanswerable ones 0.191-0.312 (median ~0.27). The old 0.35 recorded four of
 * six ANSWERED questions as gaps; at 0.30 one answered question (0.294) is
 * still recorded and two unanswered ones (0.308, 0.312) are not. The ranges
 * overlap, so no number separates them perfectly; a sample this thin should be
 * re-measured on a tenant with richer Knowledge. (It was 0.35 in
 * @chatcenter/shared; this service is its only reader.)
 */
export const KNOWLEDGE_GAP_SCORE = 0.30;

/** Two result lists as one: each chunk once, at its best score, best first. */
export function mergeByBestScore(lists: SearchResult[][], limit: number): SearchResult[] {
  const best = new Map<string, SearchResult>();
  for (const list of lists) {
    for (const r of list) {
      const key = `${r.documentId ?? r.documentTitle}#${r.chunkIndex}`;
      const prev = best.get(key);
      if (!prev || (r.score ?? 0) > (prev.score ?? 0)) best.set(key, r);
    }
  }
  return [...best.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
}

export type { SearchResult as RetrievedChunk };

/**
 * Which knowledge bases may this employee read?
 *
 * Retrieval used to search EVERY active knowledge base in the tenant, which
 * made per-employee knowledge scoping inert: an employee with nothing attached
 * still answered from every other employee's knowledge, and a base scoped to
 * one agent or one department leaked to all of them. The schema has carried
 * `scope`, `scopeAgentId`, `scopeDepartmentId` and the AIAgentKnowledge join
 * for a long time; nothing honoured them at read time.
 *
 * A base is readable when ANY of these holds:
 *   - it is explicitly attached to this employee (AIAgentKnowledge), which is
 *     the operator saying "this one, for this employee";
 *   - it is tenant-wide (scope "all", the default) - shared knowledge stays
 *     shared, so attaching nothing does not leave an employee with nothing;
 *   - it is scoped to this employee's department.
 *
 * A base scoped to a DIFFERENT agent or department is excluded unless it was
 * explicitly attached. With no agent in context (internal callers, the
 * onboarding tuning chat) the old tenant-wide behaviour is kept deliberately -
 * there is no employee whose scope could be applied.
 */
export async function readableKnowledgeBaseIds(
  tenantId: string,
  aiAgentId?: string | null,
): Promise<string[]> {
  const bases = await prisma.knowledgeBase.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, scope: true, scopeAgentId: true, scopeDepartmentId: true },
  });
  if (!aiAgentId) return bases.map((b) => b.id);

  const [agent, attached] = await Promise.all([
    prisma.aIAgent.findFirst({
      where: { id: aiAgentId, tenantId },
      select: { departmentId: true },
    }),
    prisma.aIAgentKnowledge.findMany({
      where: { aiAgentId },
      select: { knowledgeBaseId: true },
    }),
  ]);
  // An agent id that does not belong to this tenant resolves to no agent, and
  // must not fall through to "read everything".
  if (!agent) return [];

  const attachedIds = new Set(attached.map((a) => a.knowledgeBaseId));
  return bases
    .filter((b) => {
      if (attachedIds.has(b.id)) return true;
      const scope = b.scope || "all";
      if (scope === "all") return true;
      if (scope === "department") return !!agent.departmentId && b.scopeDepartmentId === agent.departmentId;
      if (scope === "agent") return b.scopeAgentId === aiAgentId;
      return false;
    })
    .map((b) => b.id);
}

export async function retrieveRelevantChunks(
  tenantId: string,
  query: string,
  limit = 5,
  /**
   * Scopes the search to what this employee may read. Optional so existing
   * internal callers keep working; omitting it searches the whole tenant, as
   * before.
   */
  aiAgentId?: string | null,
  /**
   * Record a miss as a knowledge gap.
   *
   * Opt-in, because not every caller is answering a customer. A readiness test,
   * an admin probe or a KB preview that finds nothing is not a gap in the
   * business's knowledge, and recording those would fill the owner's list with
   * questions no customer ever asked.
   */
  gap: { record?: boolean; askerKey?: string | null } = {},
): Promise<SearchResult[]> {
  try {
    // A question in another language than the Knowledge is also searched in
    // the Knowledge's language (see query-translation.service); null = no
    // mismatch, or the translation was refused / failed: the plain search stands.
    const [queryEmbedding, translated] = await Promise.all([
      generateEmbedding(query, { tenantId }),
      translatedQuery(tenantId, query).catch(() => null),
    ]);

    const activeKBIds = await readableKnowledgeBaseIds(tenantId, aiAgentId);
    if (activeKBIds.length === 0) {
      // No readable knowledge base at all is the purest "no_knowledge" there is.
      if (gap.record) {
        void recordUnansweredQuestion({
          tenantId, question: query, reason: "no_knowledge", askerKey: gap.askerKey,
        });
      }
      return [];
    }

    const direct = await searchSimilar(tenantId, queryEmbedding, limit, activeKBIds);
    let results = direct;
    if (translated) {
      try {
        const translatedEmbedding = await generateEmbedding(translated, { tenantId });
        results = mergeByBestScore([direct, await searchSimilar(tenantId, translatedEmbedding, limit, activeKBIds)], limit);
      } catch (err: any) {
        console.warn("[Knowledge] translated search failed, using the direct one:", err?.message ?? err);
      }
    }

    // Recorded HERE, where the scores are, and never inferred later from a
    // conversation that happened to escalate. By the time anything downstream
    // can see the outcome, the reason why is gone.
    if (gap.record) {
      const topScore = results.length > 0 ? (results[0]!.score ?? 0) : 0;
      if (results.length === 0) {
        void recordUnansweredQuestion({
          tenantId, question: query, reason: "no_knowledge", askerKey: gap.askerKey,
        });
      } else if (topScore < KNOWLEDGE_GAP_SCORE) {
        void recordUnansweredQuestion({
          tenantId, question: query, reason: "low_confidence", askerKey: gap.askerKey,
        });
      }
    }

    return results;
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
