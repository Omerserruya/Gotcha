/**
 * KnowledgePort — the concrete knowledge surface the KNOWLEDGE operation set runs
 * on. Adapter boundary only: "is a knowledge base available?" and "retrieve the
 * passages relevant to a query". No business rules here (those are the contracts +
 * verifiers in knowledge.runtime.ts). The production port wraps the EXISTING RAG
 * (`retrieveRelevantChunks` — embeddings + vector search); tests inject a fake.
 */

export interface KnowledgeOpContext {
  tenantId: string;
  conversationId: string;
}

export interface KnowledgePassage {
  text: string;
  source?: string;
  score?: number;
}

export interface KnowledgePort {
  /** Concrete: does this tenant have any knowledge base content to search? */
  available(ctx: KnowledgeOpContext): Promise<boolean>;

  /** Concrete: the passages most relevant to the query (possibly none). */
  search(ctx: KnowledgeOpContext, query: string, topK: number): Promise<KnowledgePassage[]>;
}
