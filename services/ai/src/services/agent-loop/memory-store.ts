/**
 * AgentMemory persistence — the DB-backed implementation of the kernel's
 * cross-turn memory (per agent × customer, following the customer across
 * conversations). This closes the loop the contract always described: the
 * Reasoner's `memoryUpdate` becomes the NEXT turn's `memory` input.
 *
 * Trust model unchanged: memory is ADVISORY — Facts always override it.
 * Fail-soft both ways: a load failure yields empty memory; a save failure is
 * logged and never breaks a turn. Bounded before save so it can't grow
 * unbounded or poison context.
 */

import { prisma, EMPTY_AGENT_MEMORY, type AgentMemory, type MemoryStore, type MemoryKey } from "@chatcenter/shared";

export type AgentMemoryKey = MemoryKey;

const MAX_LIST = 12;
const MAX_PRIOR_READS = 8;

/** Enforce the AgentMemory bounds (dedup + rolling windows). Pure. */
export function boundAgentMemory(m: AgentMemory): AgentMemory {
  const uniq = (xs: string[] | undefined, cap = MAX_LIST) =>
    [...new Set((xs ?? []).map((s) => (s ?? "").trim()).filter(Boolean))].slice(-cap);
  return {
    committedGoal: m.committedGoal,
    workingHypotheses: uniq(m.workingHypotheses),
    alreadyAsked: uniq(m.alreadyAsked),
    priorReads: (m.priorReads ?? []).filter((r) => r && typeof r.situation === "string").slice(-MAX_PRIOR_READS),
    openCommitments: uniq(m.openCommitments),
  };
}

/** Load the customer-scoped memory, or empty. Never throws. */
export async function loadAgentMemory(key: AgentMemoryKey): Promise<AgentMemory> {
  try {
    const row = await (prisma as any).agentCustomerMemory.findUnique({
      where: {
        tenantId_agentId_customerExternalId: {
          tenantId: key.tenantId,
          agentId: key.agentId,
          customerExternalId: key.customerExternalId,
        },
      },
    });
    if (!row?.memory) return { ...EMPTY_AGENT_MEMORY };
    return boundAgentMemory({ ...EMPTY_AGENT_MEMORY, ...(row.memory as Partial<AgentMemory>) });
  } catch (err: any) {
    console.warn("[agent-loop][memory] load failed:", err?.message);
    return { ...EMPTY_AGENT_MEMORY };
  }
}

/**
 * The kernel contract's `MemoryStore`, DB-backed — the shared interface now has
 * its production implementation (wire-or-delete: wired).
 */
export const agentMemoryStore: MemoryStore = {
  load: loadAgentMemory,
  save: saveAgentMemory,
};

/** Persist the turn's memoryUpdate (bounded). Never throws. */
export async function saveAgentMemory(key: AgentMemoryKey, memory: AgentMemory): Promise<void> {
  try {
    const bounded = boundAgentMemory(memory);
    await (prisma as any).agentCustomerMemory.upsert({
      where: {
        tenantId_agentId_customerExternalId: {
          tenantId: key.tenantId,
          agentId: key.agentId,
          customerExternalId: key.customerExternalId,
        },
      },
      create: {
        tenantId: key.tenantId,
        agentId: key.agentId,
        customerExternalId: key.customerExternalId,
        memory: bounded as any,
      },
      update: { memory: bounded as any },
    });
  } catch (err: any) {
    console.warn("[agent-loop][memory] save failed:", err?.message);
  }
}
