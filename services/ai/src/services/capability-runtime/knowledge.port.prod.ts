/**
 * Production KnowledgePort - the existing RAG BECOMES the adapter. `search`
 * delegates to `retrieveRelevantChunks` (embedding + vector search - the same
 * function the legacy brain's KB retrieval uses); availability is a cheap
 * tenant-scoped KB presence check. No reimplementation.
 */

import { prisma } from "@chatcenter/shared";
import { retrieveRelevantChunks } from "../knowledge.service";
import type { KnowledgePort } from "./knowledge.port";

export function createProdKnowledgePort(): KnowledgePort {
  return {
    async available(ctx) {
      try {
        const n = await (prisma as any).knowledgeBase.count({ where: { tenantId: ctx.tenantId } });
        return n > 0;
      } catch {
        return false; // unknown → don't offer the operation this tick (quiet degrade)
      }
    },

    async search(ctx, query, topK) {
      const chunks = await retrieveRelevantChunks(ctx.tenantId, query, topK);
      return (chunks ?? []).map((c) => ({
        text: String(c.content ?? "").slice(0, 1200),
        source: c.documentTitle || undefined,
        score: typeof c.score === "number" ? c.score : undefined,
      }));
    },
  };
}
