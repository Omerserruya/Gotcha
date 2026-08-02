/**
 * Facts - the Oracle's output: deterministic, authoritative world-state.
 *
 * TWO layers, by design (the kernel/domain split):
 *   1. KERNEL facts - universal to EVERY employee regardless of domain: customer
 *      identity, entitlements, billing, permissions, the operation menu, freshness.
 *      The kernel understands these.
 *   2. DOMAIN world - a generic list of per-capability SELF-DESCRIPTIONS. The kernel
 *      does NOT know what a "calendar" or a "cart" is; it only carries opaque
 *      `CapabilityWorldView`s and passes them to the Reasoner. Adding a capability
 *      (Calendar, CRM, Commerce, Voice, Knowledge…) adds one of these - NO kernel,
 *      loop, or Reasoner change.
 *
 * The Reasoner may read Facts but may NEVER contradict them - entitlements,
 * permissions and billing are Facts, never judgments. Money is never negotiable.
 */

/** A meaning-level parameter the Reasoner must supply to propose an operation. */
export interface OperationParamHint {
  name: string;
  /** Plain-language description, e.g. "the time the customer chose". */
  meaning: string;
  required: boolean;
}

/** An operation that is genuinely possible AND permitted this turn - the menu. */
export interface AvailableOperation {
  name: string;
  /** One-line business meaning, e.g. "book a confirmed meeting". */
  meaning: string;
  params: OperationParamHint[];
  /** Business-language preconditions (never tool names). */
  businessPreconditions?: string[];
}

export type BillingStatus = "active" | "past_due" | "suspended";

/**
 * A capability's SELF-DESCRIPTION of its current world-state - the only thing the
 * kernel knows about any domain. The kernel never interprets `facts`; it carries
 * the whole view and hands it to the Reasoner. Each registered capability produces
 * exactly one of these per tick.
 */
export interface CapabilityWorldView {
  /** Capability name, e.g. "CALENDAR" / "CRM" / "COMMERCE". */
  capability: string;
  /** One-line, LLM-readable statement of the current domain state. */
  summary: string;
  /** Structured domain facts - opaque to the kernel, read by the Reasoner. */
  facts: Record<string, unknown>;
  /** Operations this capability offers RIGHT NOW (its contribution to the menu). */
  operations: AvailableOperation[];
  /** Salient notes worth the Reasoner's attention (optional). */
  observations?: string[];
}

export interface Facts {
  // ── KERNEL facts (universal to every employee) ──
  customer: {
    id?: string;
    /** On-file fields (email/phone/name/…); undefined = unknown, not empty. */
    knownFields: Record<string, string | undefined>;
    identityResolved: boolean;
  };
  entitlements: {
    credits?: number;
    planFeatures: string[];
    withinLimits: boolean;
  };
  billing: { status: BillingStatus };
  permissions: {
    /** Operations RBAC permits for this principal (the Runtime re-checks). */
    allowedOperations: string[];
  };
  /** The menu the Reasoner MUST pick from - union of world ops ∩ permitted. */
  availableOperations: AvailableOperation[];

  // ── DOMAIN world (generic; the kernel does not know these domains) ──
  world: CapabilityWorldView[];

  /** Freshness; the Runtime may re-verify any fact at execution. */
  asOf: string;
}
