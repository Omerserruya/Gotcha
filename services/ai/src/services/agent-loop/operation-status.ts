/**
 * ⛔ TEMPORARY - MIGRATION SCAFFOLDING. NOT part of the final Kernel. ⛔
 *
 * The FINAL architecture has NO routing and no operation ledger:
 *     Employee → Reasoner → Capability Runtime → Observation → Reasoner → …
 * One brain owns every conversation. This file exists ONLY so the Kernel can safely
 * take over conversations while the Legacy brain (`generateAIBotReplyInner`) still
 * exists. Everything here is designed to be DELETED, not extended.
 *
 * DELETION CONDITION (delete this whole file + its one wiring site + the
 * `AGENT_LOOP_AGENTS` env): the moment `generateAIBotReplyInner` is deleted, i.e. the
 * Kernel is the sole production brain. Nothing here survives the migration.
 *
 * It is deliberately two tiny, dumb pieces - if either grows into real "routing logic",
 * STOP: we would be rebuilding a second architecture instead of deleting the first.
 *   1. OPERATION_STATUS - a flat progress ledger: which operations the Kernel is PROVEN
 *      to own autonomously (telemetry + the record behind each opt-in). No behavior.
 *   2. agentKernelEligible - the deterministic routing floor: an explicit operator
 *      opt-in (`AGENT_LOOP_AGENTS`), exactly like `AGENT_LOOP_TENANTS`. NO LLM, NO
 *      tool-surface derivation, NO domain knowledge. The operator opts in only agents
 *      they have VERIFIED need nothing beyond autonomous operations. Reversible env flag.
 */

export type OperationStatus = "shadow" | "autonomous";

/**
 * Migration progress ledger. Absent ⇒ the Kernel has no capability for it yet
 * (Legacy-only). Pure record - read for telemetry and to justify an opt-in.
 */
export const OPERATION_STATUS: Record<string, OperationStatus> = {
  // ── CALENDAR ── whole set verified LIVE autonomous on the pilot (2026-07-02):
  // real Google Calendar insert/patch/delete, every invariant held, zero residual
  // (scripts/pilot-book-verify.ts + pilot-move-verify.ts). READ (CHECK) shadow-
  // evidenced 2026-07-01. A taken slot is rejected at the strategy - never a double-book.
  CHECK_AVAILABILITY: "autonomous",
  BOOK_MEETING: "autonomous",
  MOVE_MEETING: "autonomous",
  CANCEL_MEETING: "autonomous",
  // ── CRM ── connector registered 2026-07-02 (wraps getCrmAdapter + crm-identity).
  // SEARCH_CUSTOMER (READ) + UPSERT_CUSTOMER (WRITE, identity foundation) in shadow,
  // accruing evidence before they flip.
  SEARCH_CUSTOMER: "shadow",
  UPSERT_CUSTOMER: "shadow",
  ADD_NOTE: "shadow",
  GET_CUSTOMER_CONTEXT: "shadow",
  UPDATE_RECORD: "shadow",
  CREATE_TASK: "shadow",
  // ── KNOWLEDGE ── wraps the production RAG (retrieveRelevantChunks). READ, 2026-07-03.
  SEARCH_KNOWLEDGE: "shadow",
  // ── COMMERCE / CUSTOM ── not yet in the Kernel (Legacy-only).
};

export function operationStatus(op: string): OperationStatus | "unknown" {
  return OPERATION_STATUS[op] ?? "unknown";
}

/** True only when the Kernel is trusted to own this operation's production execution. */
export function isOperationAutonomous(op: string): boolean {
  return OPERATION_STATUS[op] === "autonomous";
}

/**
 * THE DETERMINISTIC ROUTING FLOOR (temporary). The Kernel drives a conversation ONLY
 * when its agent is explicitly opted in via `AGENT_LOOP_AGENTS` (comma-separated agent
 * ids). Empty ⇒ NO agent routes to the Kernel (safe default). No wildcard is supported
 * on purpose - routing a real customer to the Kernel must always be an explicit,
 * per-agent, operator decision that the agent needs nothing beyond autonomous operations.
 *
 * This is the entire router. When Legacy is deleted, this and the ledger above go with it.
 */
export function agentKernelEligible(aiAgentId: string): boolean {
  const raw = (process.env.AGENT_LOOP_AGENTS || "").trim();
  if (!raw) return false;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(aiAgentId);
}

/** Count of operations at each status - migration telemetry only. */
export function operationStatusSummary(): { autonomous: number; shadow: number; operations: number } {
  const vals = Object.values(OPERATION_STATUS);
  return {
    autonomous: vals.filter((s) => s === "autonomous").length,
    shadow: vals.filter((s) => s === "shadow").length,
    operations: vals.length,
  };
}
