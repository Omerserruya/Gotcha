/**
 * WAITING FOR A PERSON - the one definition (pure, no imports).
 *
 * The figure the owner sees in three places must be one figure: Home's
 * "waiting on you" (analytics getQueueDepth), Home's ranked queue (analytics
 * getQueueItems), the inbox's "Waiting in queue" view (conversation list,
 * view=queue) and, through the analytics API, the assistant. Before
 * 2026-10-07 they said 21, 10 and 3 at the same moment.
 *
 * A conversation is waiting for a person when it is open, nobody is assigned,
 * it is not a setup rehearsal, and neither the AI nor a flow is answering it
 * (unless the AI handed it over).
 *
 * The AI/flow condition is an OR, nested in AND so a caller's own top-level
 * OR (the inbox's visibility clause) is never overwritten.
 */
export const WAITING_STATUSES = ["OPEN", "WAITING"] as const;

export function waitingForPersonClause() {
  return {
    isTest: false,
    NOT: { customerExternalId: { startsWith: "sandbox:" } },
    status: { in: [...WAITING_STATUSES] as ("OPEN" | "WAITING")[] },
    assignedAgentId: null,
    AND: [{ OR: [{ handledBy: null }, { handledBy: "human" }, { isHandedOver: true }] }],
  };
}

export function waitingForPersonWhere(tenantId: string) {
  return { tenantId, ...waitingForPersonClause() };
}
