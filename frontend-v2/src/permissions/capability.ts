/**
 * The capability model.
 *
 * The product needs to answer five different questions about an action, and
 * collapsing them into a boolean is what produces the two classic failures:
 * buttons that vanish with no explanation, and buttons that look available but
 * fail on click.
 *
 *   1. Should the user see this at all?          → `hidden`
 *   2. May they execute it?                      → `allowed` / `denied`
 *   3. Will executing it need a human approval?  → `requires_approval`
 *   4. Is it blocked by state or integration?    → `unavailable`
 *   5. Why?                                      → `reason`
 *
 * `denied` and `unavailable` are deliberately distinct. "You lack permission"
 * and "this order is already refunded" call for different copy, different
 * affordances, and different follow-up.
 *
 * None of this is security. The backend is the authority; this is the layer
 * that decides what the interface says.
 */
export type CapabilityStatus =
  /** Executable now. */
  | 'allowed'
  /** Executable, but it will enter an approval queue rather than run. */
  | 'requires_approval'
  /** The principal is not permitted. Usually shown disabled, with a reason. */
  | 'denied'
  /** Permitted in principle, blocked right now by state or a dependency. */
  | 'unavailable'
  /** Not part of this workspace's product surface. Render nothing. */
  | 'hidden';

/**
 * Stable machine codes for *why*. Never a sentence: the UI translates these,
 * so the same cause reads correctly in English and Hebrew, and a backend
 * wording change cannot alter what the user is told.
 */
export type CapabilityReason =
  | 'missing_permission'
  | 'requires_approval'
  | 'integration_disconnected'
  | 'integration_unsupported'
  | 'invalid_state'
  | 'plan_limit_reached'
  | 'read_only_mode'
  | 'not_assigned'
  | 'unknown';

export interface Capability {
  readonly status: CapabilityStatus;
  readonly reason?: CapabilityReason;
  /**
   * Values for the translated explanation, e.g. `{ channel: 'WhatsApp' }`.
   * Codes stay stable; only the copy is localised.
   */
  readonly reasonValues?: Readonly<Record<string, string | number>>;
}

export const ALLOWED: Capability = { status: 'allowed' };
export const HIDDEN: Capability = { status: 'hidden' };

export function denied(
  reason: CapabilityReason = 'missing_permission',
  reasonValues?: Capability['reasonValues'],
): Capability {
  return { status: 'denied', reason, reasonValues };
}

export function unavailable(
  reason: CapabilityReason,
  reasonValues?: Capability['reasonValues'],
): Capability {
  return { status: 'unavailable', reason, reasonValues };
}

export function requiresApproval(reasonValues?: Capability['reasonValues']): Capability {
  return { status: 'requires_approval', reason: 'requires_approval', reasonValues };
}

/** True when the control should appear at all. */
export function isVisible(capability: Capability): boolean {
  return capability.status !== 'hidden';
}

/** True when the control should accept input. */
export function isEnabled(capability: Capability): boolean {
  return capability.status === 'allowed' || capability.status === 'requires_approval';
}

/**
 * True when the user must be told the action will not execute immediately.
 * Approval is not an error - it is a different, slower success path, and the
 * interface should say so before the click, not after.
 */
export function needsApproval(capability: Capability): boolean {
  return capability.status === 'requires_approval';
}

/**
 * Combines capabilities, keeping the most restrictive.
 *
 * Used where several independent constraints apply to one action - a
 * permission, a plan limit, and a channel's feature support, say.
 */
export function narrowest(...capabilities: readonly Capability[]): Capability {
  const severity: Record<CapabilityStatus, number> = {
    allowed: 0,
    requires_approval: 1,
    unavailable: 2,
    denied: 3,
    hidden: 4,
  };
  return capabilities.reduce(
    (worst, candidate) => (severity[candidate.status] > severity[worst.status] ? candidate : worst),
    ALLOWED,
  );
}
