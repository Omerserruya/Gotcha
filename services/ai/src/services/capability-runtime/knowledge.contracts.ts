/**
 * KNOWLEDGE operation set — contracts as DATA (business-only language; no vector
 * store, embeddings, or vendor appears here). Same shape as the CALENDAR/CRM
 * contracts; co-located with the runtime so adding Knowledge touched nothing in
 * the kernel or shared.
 */

import type { OperationContract } from "@chatcenter/shared";

const SEARCH_KNOWLEDGE: OperationContract = {
  id: "SEARCH_KNOWLEDGE",
  capability: "KNOWLEDGE",
  effect: "read",
  meaning: "look up what the business's own knowledge base says about a question",
  params: [
    { key: "query", meaning: "the question or topic to look up, in the customer's own terms", required: true },
  ],
  outcome: "the relevant knowledge-base passages (possibly none) — authoritative over general knowledge",
  success: {
    id: "knowledge_search_established",
    statement: "a set of relevant passages (possibly empty) has been established from the knowledge base",
  },
  invariants: [
    {
      id: "query_present",
      statement: "there is a concrete question or topic to look up",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "query" },
    },
  ],
  failureModes: ["knowledge_base_unavailable"],
  recoveryPosture: { retries: "bounded", alternatives: false, askCustomer: false, escalate: "never" },
  approval: "none",
};

export const KNOWLEDGE_CONTRACTS: Record<string, OperationContract> = {
  SEARCH_KNOWLEDGE,
};
