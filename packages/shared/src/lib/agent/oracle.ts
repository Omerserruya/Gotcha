/**
 * Oracle - the deterministic composer of Facts (the pure heart).
 *
 * The Oracle is the ONE source of truth for world-state. This file owns the
 * deterministic COMPOSITION: given the KERNEL signals (identity, money,
 * permissions) already read from their homes, plus each capability's
 * self-described `CapabilityWorldView`, it assembles the canonical `Facts` and
 * derives the operation menu GENERICALLY (union of every capability's current
 * operations, intersected with permissions). It is pure, never throws, has zero
 * execution deps, and knows NO domain - it never mentions calendar, crm, etc.
 *
 * Adding a capability changes NOTHING here: a new `CapabilityWorldView` flows
 * through untouched and its operations join the menu automatically.
 */

import type { Facts, AvailableOperation, BillingStatus, CapabilityWorldView } from "./facts";

/** KERNEL signals - universal to every employee, read from their homes. */
export interface KernelSignals {
  customer: {
    id?: string;
    knownFields: Record<string, string | undefined>;
    identityResolved: boolean;
  };
  billing: {
    status: BillingStatus;
    credits?: number;
    planFeatures?: string[];
    withinLimits?: boolean;
  };
  permissions: { allowedOperations: string[] };
  /** Each registered capability's self-description this tick. */
  world: CapabilityWorldView[];
  /** ISO timestamp of the read - passed in (no ambient clock). */
  now: string;
}

/**
 * Derive the menu generically: the union of every capability's current
 * operations, de-duplicated by name, intersected with RBAC permissions when a
 * non-empty allow-list is present. No domain knowledge.
 */
function deriveMenu(world: CapabilityWorldView[], allowed: string[]): AvailableOperation[] {
  const restrict = allowed.length > 0;
  const permit = new Set(allowed);
  const seen = new Set<string>();
  const menu: AvailableOperation[] = [];
  for (const view of world) {
    for (const op of view.operations) {
      if (seen.has(op.name)) continue;
      if (restrict && !permit.has(op.name)) continue;
      seen.add(op.name);
      menu.push(op);
    }
  }
  return menu;
}

/**
 * Compose the canonical Facts from kernel signals + capability world views. Pure,
 * total, never throws. Domain-agnostic: the `world` passes through and the menu is
 * derived from it.
 */
export function assembleFacts(signals: KernelSignals): Facts {
  return {
    customer: {
      id: signals.customer.id,
      knownFields: signals.customer.knownFields,
      identityResolved: signals.customer.identityResolved,
    },
    entitlements: {
      credits: signals.billing.credits,
      planFeatures: signals.billing.planFeatures ?? [],
      withinLimits: signals.billing.withinLimits ?? true,
    },
    billing: { status: signals.billing.status },
    permissions: { allowedOperations: signals.permissions.allowedOperations },
    availableOperations: deriveMenu(signals.world, signals.permissions.allowedOperations),
    world: signals.world,
    asOf: signals.now,
  };
}
