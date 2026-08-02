/**
 * KNOWLEDGE operation set - the vendor-neutral bridge between the Runtime and the
 * tenant's knowledge base (the existing RAG: embeddings + vector search). Three
 * jobs only: describeWorld (is a KB available?), expose SEARCH_KNOWLEDGE when it
 * is, execute via the shared Runtime → production `retrieveRelevantChunks`.
 * Registering this changes nothing in Reasoner/Loop/Runtime/Oracle/Guardrails.
 */

import type {
  AvailableOperation,
  CapabilityWorldView,
  ExecutionRequest,
  OperationContract,
} from "@chatcenter/shared";
import { KNOWLEDGE_CONTRACTS } from "../capability-runtime/knowledge.contracts";
import { executeKnowledgeOperation } from "../capability-runtime/knowledge.runtime";
import { createProdKnowledgePort } from "../capability-runtime/knowledge.port.prod";
import type { CapabilityRegistration } from "./registry";

const port = createProdKnowledgePort();
const CONTRACTS: OperationContract[] = Object.values(KNOWLEDGE_CONTRACTS);

function toAvailableOperation(c: OperationContract): AvailableOperation {
  return {
    name: c.id,
    meaning: c.meaning,
    params: c.params.map((p) => ({ name: p.key, meaning: p.meaning, required: !!p.required })),
    businessPreconditions: c.invariants
      .filter((i) => i.checkpoint === "PRE" && i.strength === "MUST")
      .map((i) => i.statement),
  };
}

export const KnowledgeCapability: CapabilityRegistration = {
  name: "KNOWLEDGE",

  ownsOperation: (op) => op in KNOWLEDGE_CONTRACTS,

  async describeWorld(ctx): Promise<CapabilityWorldView> {
    const available = await port.available({ tenantId: ctx.tenantId, conversationId: ctx.conversationId });
    return {
      capability: "KNOWLEDGE",
      summary: available
        ? "A knowledge base is available - it is the authoritative source for questions about the business's products, prices, policies, and processes. Look things up rather than guessing."
        : "No knowledge base is available.",
      facts: { knowledgeBaseAvailable: available },
      operations: available ? CONTRACTS.map(toAvailableOperation) : [],
    };
  },

  async execute(req: ExecutionRequest) {
    return executeKnowledgeOperation(req, { port, strategyId: "knowledge" });
  },
};
