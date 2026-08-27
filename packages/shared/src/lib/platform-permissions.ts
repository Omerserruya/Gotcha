/**
 * PLATFORM permissions - the Sysadmin tier.
 *
 * These are deliberately NOT in the tenant permission catalog. That catalog's
 * rule 4 is that no authorization decision hardcodes a role name, with one
 * stated exception: SYSTEM_ADMIN is a platform tier, not a tenant role. Adding
 * `platform:*` keys to the tenant catalog would make them grantable to a tenant
 * ADMIN, which is exactly what must never happen for cross-organization pricing
 * and analytics.
 *
 * So: the AUTHORIZATION check remains the existing SYSTEM_ADMIN gate, and these
 * keys make each route DECLARE which platform capability it exercises. That
 * declaration is what lands in the audit log, so "who changed the price of AI
 * Voice" is answerable without reading route code.
 */

export const PLATFORM_PERMISSIONS = {
  PRICING_READ: "platform:pricing:read",
  PRICING_MANAGE: "platform:pricing:manage",
  PRICING_PUBLISH: "platform:pricing:publish",
  PLANS_MANAGE: "platform:plans:manage",
  CUSTOM_PLANS_MANAGE: "platform:custom-plans:manage",
  POC_CREATE: "platform:poc:create",
  TENANTS_CREATE: "platform:tenants:create",
  BILLING_PROVISION: "platform:billing:provision",
  /// Strictly stronger than BILLING_PROVISION: this one activates a paid
  /// subscription without any payment processor involved.
  BILLING_MANUAL_ACTIVATE: "platform:billing:manual-activate",
  BILLING_PAYMENT_LINK_CREATE: "platform:billing:payment-link:create",
  BILLING_PAYMENT_LINK_RESEND: "platform:billing:payment-link:resend",
  BILLING_READ: "platform:billing:read",
  USAGE_ANALYTICS_READ: "platform:usage-analytics:read",
  /// Issue coupons and give them to organizations. Commercial: it changes
  /// what a customer is charged, every period the coupon is live.
  COUPONS_MANAGE: "platform:coupons:manage",
} as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS];

export interface PlatformPermissionDef {
  key: PlatformPermission;
  displayName: string;
  description: string;
  /** True when exercising it moves money or changes what customers are charged. */
  commercial: boolean;
}

export const PLATFORM_PERMISSION_CATALOG: readonly PlatformPermissionDef[] = [
  {
    key: PLATFORM_PERMISSIONS.PRICING_READ,
    displayName: "View pricing configuration",
    description: "Read plans, volume options, estimation ratios, packages and currency configuration.",
    commercial: false,
  },
  {
    key: PLATFORM_PERMISSIONS.PRICING_MANAGE,
    displayName: "Edit pricing configuration",
    description: "Create and edit DRAFT plans, volume options, estimation ratios and credit packages.",
    commercial: true,
  },
  {
    key: PLATFORM_PERMISSIONS.PRICING_PUBLISH,
    displayName: "Publish pricing",
    description: "Publish a draft plan version or estimation config, making it live for new customers.",
    commercial: true,
  },
  {
    key: PLATFORM_PERMISSIONS.PLANS_MANAGE,
    displayName: "Manage plans",
    description: "Create plan versions, retire versions, reorder the catalog and set the recommended plan.",
    commercial: true,
  },
  {
    key: PLATFORM_PERMISSIONS.CUSTOM_PLANS_MANAGE,
    displayName: "Manage custom plans",
    description: "Build and assign an organization-specific negotiated plan.",
    commercial: true,
  },
  {
    key: PLATFORM_PERMISSIONS.POC_CREATE,
    displayName: "Create POC and Trial access",
    description: "Provision evaluation access with a credit cap and an expiry.",
    commercial: true,
  },
  {
    key: PLATFORM_PERMISSIONS.USAGE_ANALYTICS_READ,
    displayName: "Read cross-organization usage analytics",
    description: "Read actual credit, token and model-cost analytics across organizations.",
    commercial: false,
  },
  {
    key: PLATFORM_PERMISSIONS.COUPONS_MANAGE,
    displayName: "Issue and assign coupons",
    description:
      "Create discount coupons and assign them to organizations. Every period inside an assignment window is charged the discounted amount.",
    commercial: true,
  },
] as const;

export const ALL_PLATFORM_PERMISSION_KEYS: readonly string[] = PLATFORM_PERMISSION_CATALOG.map((p) => p.key);

export function isPlatformPermission(key: string): key is PlatformPermission {
  return ALL_PLATFORM_PERMISSION_KEYS.includes(key);
}
