/**
 * Packaging / plans - built ENTIRELY on the existing License layer.
 *
 * A plan is just a set of tenant entitlements (TenantFeature rows keyed by
 * catalog license keys). The resolver's `isPermissionLicensed()` already does
 * `License AND Permission`, so a plan needs no new architecture: applying a
 * plan writes the feature-domain entitlement rows, and every permission check
 * automatically respects it.
 *
 *   Final access = License(plan)  AND  Permission(role + grants)
 *
 * Default is ALLOW (a tenant with no rows has everything), so plans are
 * opt-in: applying one DISABLES the domains not in the plan. Existing tenants
 * are unaffected until a plan is applied.
 */

import { prisma } from "./prisma";
import { invalidatePermissionsCache } from "./permissions";
import type { PermissionDomain } from "./permission-catalog";

// Self-serve tiers (Light/Pro/Business) + sales-only Enterprise. `grandfathered`
// is a temporary one-way compatibility state (full access, billing+enforcement
// OFF) used only during rollout - see services/billing migration flow.
export type PlanKey = "light" | "pro" | "business" | "enterprise" | "grandfathered";

/** Every feature domain (top segment of a permission key) = a packaging unit. */
export const PLAN_DOMAINS: readonly PermissionDomain[] = [
  "conversation",
  "customer",
  "crm",
  "ai",
  "approvals",
  "integrations",
  "channels",
  "analytics",
  "settings",
] as const;

export interface PlanDef {
  key: PlanKey;
  name: string;
  description: string;
  /** Feature domains this plan entitles. Anything not listed is disabled. */
  domains: PermissionDomain[];
}

// Starting defaults - edit freely; this is the only place packaging is defined.
// `conversation`, `customer`, `channels` and `settings` are core (every plan).
export const PLAN_PRESETS: Record<PlanKey, PlanDef> = {
  light: {
    key: "light",
    name: "Light",
    description: "Core shared inbox and customer context.",
    domains: ["conversation", "customer", "channels", "settings"],
  },
  pro: {
    key: "pro",
    name: "Pro",
    description: "Adds CRM, AI employees, approvals and analytics.",
    domains: ["conversation", "customer", "channels", "settings", "crm", "ai", "approvals", "analytics"],
  },
  business: {
    key: "business",
    name: "Business",
    description: "Everything in Pro plus third-party integrations and higher limits.",
    domains: [...PLAN_DOMAINS],
  },
  enterprise: {
    key: "enterprise",
    name: "Enterprise",
    description: "Custom limits and contract pricing (sales-only). All capabilities.",
    domains: [...PLAN_DOMAINS],
  },
  // Temporary compatibility state for existing tenants during billing rollout.
  // Full access; the AI runtime gate is skipped (enforcementEnabled=false on the
  // subscription) and no billing runs. NOT a commercial product.
  grandfathered: {
    key: "grandfathered",
    name: "Grandfathered",
    description: "Legacy tenant - full access while billing rolls out. Not for sale.",
    domains: [...PLAN_DOMAINS],
  },
};

export const PLAN_ORDER: PlanKey[] = ["light", "pro", "business", "enterprise"];

/**
 * Apply a plan to a tenant by writing the feature-domain entitlement rows.
 * Idempotent (upsert). Invalidates the permission cache for the tenant.
 */
export async function applyPlanToTenant(
  tenantId: string,
  plan: PlanKey,
  updatedBy?: string,
): Promise<void> {
  const def = PLAN_PRESETS[plan];
  if (!def) throw new Error(`Unknown plan "${plan}"`);
  const enabled = new Set<string>(def.domains);

  for (const domain of PLAN_DOMAINS) {
    await prisma.tenantFeature.upsert({
      where: { tenantId_feature: { tenantId, feature: domain } },
      create: { tenantId, feature: domain, enabled: enabled.has(domain), updatedBy },
      update: { enabled: enabled.has(domain), updatedBy },
    });
  }
  invalidatePermissionsCache({ tenantId });
}

/** Which domains a plan entitles (for display / comparison). */
export function planDomains(plan: PlanKey): PermissionDomain[] {
  return PLAN_PRESETS[plan].domains;
}
