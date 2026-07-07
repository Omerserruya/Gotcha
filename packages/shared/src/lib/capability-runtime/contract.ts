/**
 * Capability Runtime — Operation Contracts (the BUSINESS MODEL).
 *
 * See docs/architecture/capability-runtime.md (FROZEN). This module is the
 * meaning/mechanics boundary made into data. It is **business-owned**:
 *
 *   - It imports NOTHING from providers / strategies / adapters / SDKs / Prisma.
 *     (Constraint A: contracts stay implementation-free; the build enforces the
 *     dependency direction `strategies -> contracts`, never the reverse.)
 *   - Invariants are PREDICATES (truths that must hold), never steps. They may
 *     reference business state and other OPERATIONS (business vocabulary), never
 *     tools, providers, endpoints, or protocols.
 *   - `success` and every `MUST` invariant describe WORLD-STATE, never a tool
 *     result — the leak test. A predicate is bound to a runtime verifier by `id`;
 *     the verifier (which knows the store/provider) lives in the runtime, not here.
 */

export type Effect = "read" | "write";

/** MUST = hard (violation aborts). SHOULD = normative (may be skipped, logged). */
export type InvariantStrength = "MUST" | "SHOULD";

/** When the predicate is checked relative to execution. */
export type InvariantCheckpoint = "PRE" | "POST";

/**
 * RUNTIME_VERIFIED  — checkable against world-state regardless of strategy.
 * PROVIDER_ATTESTED — only the executing strategy can guarantee it mid-flight;
 *                     the runtime trusts it and relies on POST/success as backstop.
 * Rule: every MUST invariant must be RUNTIME_VERIFIED (so hard safety is
 * strategy-independent). Only SHOULD invariants may be PROVIDER_ATTESTED.
 */
export type InvariantEnforcement = "RUNTIME_VERIFIED" | "PROVIDER_ATTESTED";

/** The four execution modes that parameterize the SAME runtime. */
/**
 * `advisory` — copilot posture: writes become RECOMMENDED before the approval
 * gate (a human is already in the loop; simulating HITL is noise).
 * `dry_run` — evaluation/shadow posture: writes still never execute, but the
 * approval gate IS probed (no request created) so shadow evidence proves the
 * HITL policy surface, not just the write path.
 */
export type ExecutionMode = "autonomous" | "advisory" | "dry_run" | "workflow" | "external";

/** A meaning-level input the LLM may supply (resolved to concrete by the strategy). */
export interface ParamSpec {
  key: string;
  /** Business description of the param (Product-readable). */
  meaning: string;
  required?: boolean;
}

/** What to return when a PRE invariant is unsatisfied and cannot be auto-satisfied. */
export type UnsatisfiedOutcome =
  | { kind: "NEEDS_INPUT"; field: string }
  | { kind: "FAILED"; reason: string };

export interface Invariant {
  /** Stable id — also the key the runtime binds a verifier to. */
  id: string;
  /** Business-readable statement (the Product test reads this). */
  statement: string;
  strength: InvariantStrength;
  checkpoint: InvariantCheckpoint;
  enforcement: InvariantEnforcement;
  /**
   * For a PRE dependency the runtime can satisfy by running a READ OPERATION
   * (business vocabulary, e.g. "CHECK_AVAILABILITY") — never a tool name.
   */
  satisfierOperation?: string;
  /** What the resolver returns if this is unsatisfied and unrecoverable. */
  onUnsatisfied?: UnsatisfiedOutcome;
}

/** A business predicate over world-state; verified by a runtime-bound function. */
export interface SuccessPredicate {
  id: string;
  statement: string;
}

/** Declarative permission envelope for recovery — NOT a sequence. */
export interface RecoveryPosture {
  retries: "none" | "bounded";
  /** May the runtime GATHER alternatives (as data) on failure? Presenting is the planner's. */
  alternatives: boolean;
  /** May the runtime ask the customer for a missing detail? */
  askCustomer: boolean;
  escalate: "last_resort" | "never";
}

export interface OperationContract {
  id: string;
  capability: string;
  effect: Effect;

  // ── public face (the planner / LLM sees only these) ──
  meaning: string;
  params: ParamSpec[];
  /** Business-readable shape of the semantic outcome the LLM narrates. */
  outcome: string;

  // ── runtime face (mechanics — hidden from the planner) ──
  success: SuccessPredicate;
  invariants: Invariant[];
  failureModes: string[];
  recoveryPosture: RecoveryPosture;
  approval: "none" | "configurable" | "always";
  /** What makes a repeat a no-op (business identity), e.g. ["customer","meeting_kind","day"]. */
  dedupKey?: string[];
  destructive?: boolean;
}

// ── The Execution Contract: the universal, mode-agnostic entry/exit ──

export interface ExecutionContext {
  tenantId: string;
  conversationId: string;
  customerExternalId?: string;
  /** Opaque to the pure resolver; strategies/verifiers read what they need. */
  [k: string]: unknown;
}

export interface ExecutionRequest {
  operation: string;
  /** Meaning-level params (e.g. desired_time: "tomorrow 17:00"). */
  params: Record<string, unknown>;
  context: ExecutionContext;
  mode: ExecutionMode;
  /**
   * Approval-resume (P1-3/B6): set ONLY by the approved-action dispatcher.
   * The gate treats a matching APPROVED request as already satisfied, so the
   * resumed execution re-runs the FULL Runtime (invariants included) without
   * re-asking the human.
   */
  approval?: { approvedRef: string };
}

export type ExecutionResult =
  | { status: "EXECUTED"; outcome: string; data?: Record<string, unknown> }
  | { status: "NEEDS_INPUT"; field: string; reason: string }
  | { status: "RECOMMENDED"; proposal: { operation: string; params: Record<string, unknown> } }
  | { status: "AWAITING_APPROVAL"; ref: string }
  | { status: "BLOCKED"; reason: string }
  | { status: "FAILED"; reason: string; data?: Record<string, unknown>; recoverable: boolean };

// ── Execution Trace (Constraint 2: instrument from day one) ──
// A structured, provider-agnostic record of WHY an operation ended as it did —
// available for debugging, observability, and analytics without reading provider
// logs. The pure resolver builds it; the runtime injects an `emitTrace` sink.

export type InvariantOutcome =
  | "held"               // probe was already true (no work needed)
  | "satisfied_by_read"  // became true after running its satisfier operation
  | "skipped_should"     // SHOULD invariant left unsatisfied; proceeded anyway
  | "unsatisfied"        // MUST invariant could not be satisfied → run stopped here
  | "violated"           // POST MUST invariant failed after execution
  | "trusted_attested";  // PROVIDER_ATTESTED with no runtime verifier (trusted)

export interface InvariantTrace {
  id: string;
  checkpoint: InvariantCheckpoint;
  strength: InvariantStrength;
  enforcement: InvariantEnforcement;
  outcome: InvariantOutcome;
  satisfierOperation?: string;
}

export interface ExecutionTrace {
  operation: string;
  capability: string;
  mode: ExecutionMode;
  /** Strategy that fulfilled (or would fulfill) the operation, e.g. "calendar.google". */
  strategy?: string;
  /** Every PRE/POST invariant and how it resolved. */
  invariants: InvariantTrace[];
  /** Human-readable optimizations the runtime took (e.g. a skipped fresh read). */
  optimizations: string[];
  /** Did the terminal strategy actually run? */
  executed: boolean;
  /** Was the success predicate verified against world-state? */
  successVerified?: boolean;
  result: ExecutionResult["status"];
  outcome?: string;
  /** Failure / blocked / needs-input reason, when applicable. */
  reason?: string;
  /**
   * dry_run only: whether the write WOULD have required human approval had it
   * run autonomously (gate probed, no request created). Shadow-eval evidence
   * for the HITL surface.
   */
  approvalProbe?: { wouldRequire: boolean; reason?: string };
}
