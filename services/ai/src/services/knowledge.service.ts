import { prisma } from "@chatcenter/shared";
import { generateEmbedding } from "./embedding.service";
import { searchSimilar, SearchResult } from "./qdrant.service";

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
async function readableKnowledgeBaseIds(
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
): Promise<SearchResult[]> {
  try {
    const queryEmbedding = await generateEmbedding(query, { tenantId });

    const activeKBIds = await readableKnowledgeBaseIds(tenantId, aiAgentId);
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
