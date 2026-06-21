/**
 * Turn Outcome Ledger — the single source of truth for side effects within ONE
 * autonomous turn.
 *
 * Problem it solves (observed live): the model emits duplicate/parallel
 * side-effecting tool calls; a later FAILED call's result overrode an earlier
 * SUCCESS in what the customer was told (e.g. a real meeting was booked, then a
 * duplicate `schedule_meeting` self-collided with `agent_busy` and the customer
 * was told the slot was unavailable). The ledger makes success MONOTONIC and
 * gives the reply layer a deterministic, truthful outcome set.
 *
 * Invariants:
 *  - Every side effect flows through orchestrator.submit() → recorded here.
 *    A side effect with no ledger entry is a bug (LEDGER_GAP).
 *  - A semantic action that succeeded this turn can NEVER be downgraded by a
 *    later duplicate/failed call (monotonic commit).
 *  - "Already executed successfully" (committed OR succeeded_unverified) is the
 *    dedup signal — NOT "committed". An unverified success still blocks a
 *    duplicate re-execution.
 *  - A success becomes COMMITTED only with a real externalRef (eventId /
 *    leadId / messageId / …). ok:true without a ref → succeeded_unverified:
 *    deduped, but the reply layer must not confidently claim it.
 */

export type OutcomeKind =
  | "booking"
  | "create"
  | "update"
  | "send"
  | "note"
  | "tag"
  | "link"
  | "other";

export type OutcomeStatus =
  | "committed"
  | "succeeded_unverified"
  | "pending_approval"
  | "denied"
  | "failed";

export type OutcomeVisibility = "customer_facing" | "background";

export interface ExternalRef {
  /** e.g. "gcal_event" | "crm_lead" | "crm_contact" | "message" */
  type: string;
  id: string;
}

export interface LedgerEntry {
  semanticKey: string;
  tool: string;
  kind: OutcomeKind;
  visibility: OutcomeVisibility;
  status: OutcomeStatus;
  externalRef?: ExternalRef;
  /** Raw handler result of the call that produced the current status. */
  result: unknown;
  /** Monotonic order in which this key was first recorded (for stable sort). */
  seq: number;
}

// Higher = stronger. record() only ever upgrades; it never moves a key to a
// lower-ranked status. So a later `failed` (0) cannot downgrade a `committed`
// (4) or `succeeded_unverified` (3) for the same semantic action.
const STATUS_RANK: Record<OutcomeStatus, number> = {
  committed: 4,
  succeeded_unverified: 3,
  pending_approval: 2,
  denied: 1,
  failed: 0,
};

// Deterministic ordering for the customer-facing summary. Lower = earlier.
const KIND_PRIORITY: Record<OutcomeKind, number> = {
  booking: 0,
  send: 1,
  create: 2,
  update: 3,
  note: 4,
  tag: 5,
  link: 6,
  other: 7,
};

export interface RecordInput {
  semanticKey: string;
  tool: string;
  kind: OutcomeKind;
  visibility: OutcomeVisibility;
  status: OutcomeStatus;
  externalRef?: ExternalRef;
  result: unknown;
}

export class TurnOutcomeLedger {
  private entries = new Map<string, LedgerEntry>();
  private counter = 0;

  /** A prior call for this key already executed successfully this turn. */
  hasSucceeded(semanticKey: string): boolean {
    const e = this.entries.get(semanticKey);
    return !!e && (e.status === "committed" || e.status === "succeeded_unverified");
  }

  get(semanticKey: string): LedgerEntry | undefined {
    return this.entries.get(semanticKey);
  }

  /**
   * Record an outcome. Monotonic: an existing entry is only upgraded to a
   * higher-ranked status; a lower- or equal-ranked status is ignored (the
   * stored success/result is preserved). Returns the resulting entry.
   */
  record(input: RecordInput): LedgerEntry {
    const existing = this.entries.get(input.semanticKey);
    if (existing) {
      if (STATUS_RANK[input.status] > STATUS_RANK[existing.status]) {
        existing.status = input.status;
        existing.result = input.result;
        if (input.externalRef) existing.externalRef = input.externalRef;
      }
      return existing;
    }
    const entry: LedgerEntry = {
      semanticKey: input.semanticKey,
      tool: input.tool,
      kind: input.kind,
      visibility: input.visibility,
      status: input.status,
      externalRef: input.externalRef,
      result: input.result,
      seq: this.counter++,
    };
    this.entries.set(input.semanticKey, entry);
    return entry;
  }

  /** All committed entries (real externalRef), deterministically ordered. */
  committed(): LedgerEntry[] {
    return this.sorted(
      [...this.entries.values()].filter((e) => e.status === "committed"),
    );
  }

  /** Committed + customer-facing, deterministically ordered. The set the
   * customer reply MUST be consistent with. */
  customerFacingCommitted(): LedgerEntry[] {
    return this.committed().filter((e) => e.visibility === "customer_facing");
  }

  /** ok:true but missing a real externalRef — deduped, but not safe to claim.
   * Surfaced so handlers that don't return a ref get fixed. */
  unverified(): LedgerEntry[] {
    return this.sorted(
      [...this.entries.values()].filter((e) => e.status === "succeeded_unverified"),
    );
  }

  all(): LedgerEntry[] {
    return this.sorted([...this.entries.values()]);
  }

  private sorted(list: LedgerEntry[]): LedgerEntry[] {
    return list.sort(
      (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.seq - b.seq,
    );
  }
}

/**
 * Derive the ledger status from a handler result + extracted ref.
 * ok:true + ref → committed; ok:true + no ref → succeeded_unverified.
 * The sideEffect shape mirrors agent-tools.ts (awaitingApproval / denied).
 */
export function statusFromResult(
  result: any,
  externalRef: ExternalRef | undefined,
): OutcomeStatus {
  const se = result?.sideEffect ?? {};
  if (se.awaitingApproval) return "pending_approval";
  if (se.denied) return "denied";
  const ok = result?.ok === true || result?.parsed?.ok === true;
  if (!ok) return "failed";
  return externalRef ? "committed" : "succeeded_unverified";
}
