/**
 * Guardrails — the deterministic AUTHORIZE plane of the cognitive kernel.
 *
 * The Reasoner may PROPOSE anything; Guardrails decide whether it is ALLOWED —
 * deterministically, never by reasoning. This is the single checkpoint between
 * DECIDE and EXECUTE. It is PURE over `Facts`: the Oracle has already flattened
 * permissions, entitlements, billing and the capability menu into Facts, so
 * authorization needs no I/O and cannot be bypassed or hallucinated.
 *
 * Money and security are non-negotiable: a suspended tenant, an exhausted budget,
 * or a missing permission is a hard DENY regardless of what the Reasoner wants.
 *
 * NOTE: `mode` (autonomous vs advisory) is intentionally NOT an input — mode
 * changes only EXECUTE's *effect* (perform vs recommend), never authorization.
 */

import type { Facts } from "./facts";

export type AuthorizationVerdict =
  | { allow: true }
  | { allow: false; reason: string };

/**
 * Authorize a proposed operation against verified world-state. Deterministic,
 * total, never throws. Order = cheapest/most-decisive first.
 */
export function authorizeOperation(operation: string, facts: Facts): AuthorizationVerdict {
  // 1. Money/security — non-negotiable.
  if (facts.billing.status === "suspended") return { allow: false, reason: "billing_suspended" };
  if (facts.entitlements.withinLimits === false) return { allow: false, reason: "budget_exhausted" };

  // 2. Permissions — when an allow-list is present, the op must be on it.
  //    (Empty allow-list = unrestricted for this principal, by convention.)
  const allowed = facts.permissions.allowedOperations;
  if (allowed.length > 0 && !allowed.includes(operation)) return { allow: false, reason: "not_permitted" };

  // 3. Capability presence — the op must be on the live menu (possible ∩ permitted).
  //    This subsumes the loop's off-menu guard: an operation the Reasoner invents
  //    or one whose capability isn't enabled/connected is unavailable.
  if (!facts.availableOperations.some((o) => o.name === operation)) {
    return { allow: false, reason: "capability_unavailable" };
  }

  return { allow: true };
}
