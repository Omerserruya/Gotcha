/**
 * The single tenant access matrix.
 *
 * Every service asks this one function what a tenant status permits. The
 * alternative - each service carrying its own allowlist - is how one route
 * quietly keeps serving a suspended tenant after the others stop.
 *
 * The switch is EXHAUSTIVE by construction: `assertNever` makes a new
 * TenantStatus a compile error rather than something that silently inherits
 * whatever the default branch happens to do. That mattered here - before this
 * existed, PENDING_PAYMENT fell into an else branch that denied access (safe)
 * but told the customer their account was "suspended" (wrong, and unactionable).
 */
import type { TenantStatus } from "@prisma/client";

/**
 * What a route needs from the tenant.
 *
 *   FULL_APPLICATION  the paid product: inbox, conversations, AI, channels,
 *                     integrations, customer data, workflows, knowledge
 *   ONBOARDING        setup steps that must run BEFORE a tenant is active,
 *                     including connecting the source-of-truth system
 *   PAYMENT_SETUP     completing payment for a tenant that owes it, plus the
 *                     safe checkout summary and status polling
 *   IDENTITY          authentication, MFA, email verification, logout, support
 */
export type TenantAccessScope = "FULL_APPLICATION" | "ONBOARDING" | "PAYMENT_SETUP" | "IDENTITY";

export interface TenantAccessDenial {
  allow: false;
  httpStatus: number;
  /** Stable machine-readable code. The frontend routes on this, not on prose. */
  code:
    | "TENANT_ADMIN_SETUP_REQUIRED"
    | "TENANT_ONBOARDING_REQUIRED"
    | "TENANT_PAYMENT_REQUIRED"
    | "TENANT_SUSPENDED"
    | "TENANT_NOT_FOUND";
  /** Customer-safe. Never names a provider or exposes billing internals. */
  message: string;
  /** Where the customer should go to resolve it, when there is somewhere. */
  redirectPath?: string;
}

export type TenantAccessDecision = { allow: true } | TenantAccessDenial;

const ALLOW: TenantAccessDecision = { allow: true };

function assertNever(value: never): never {
  throw new Error(`unhandled tenant status: ${String(value)}`);
}

/**
 * Decide whether a tenant in `status` may exercise `scope`.
 *
 * IDENTITY is always allowed, for every status. Locking someone out of
 * authentication, MFA setup or logout because their organization owes money
 * makes the problem unfixable by the person best placed to fix it.
 */
export function evaluateTenantAccess(
  status: TenantStatus,
  scope: TenantAccessScope,
): TenantAccessDecision {
  if (scope === "IDENTITY") return ALLOW;

  switch (status) {
    case "ACTIVE":
      // Everything. Billing state is enforced separately by entitlements.
      return ALLOW;

    case "PENDING_ADMIN_SETUP":
      // The admin has not completed first-time setup; nothing else is usable.
      return {
        allow: false,
        httpStatus: 403,
        code: "TENANT_ADMIN_SETUP_REQUIRED",
        message: "Admin setup is required before using the platform",
      };

    case "PENDING_ONBOARDING":
      // Onboarding routes work, because connecting the source-of-truth system
      // is itself the activation event. The paid product does not.
      return scope === "ONBOARDING"
        ? ALLOW
        : {
            allow: false,
            httpStatus: 403,
            code: "TENANT_ONBOARDING_REQUIRED",
            message: "Organization onboarding must be completed before using the platform",
          };

    case "PENDING_PAYMENT":
      // Provisioned on a paid plan whose first payment is not confirmed.
      //
      // Payment setup and identity onboarding are permitted so the customer can
      // actually resolve it. The paid product is not - that is the whole point
      // of the state, and granting it "just until payment clears" is how a
      // paid plan becomes optional.
      return scope === "PAYMENT_SETUP" || scope === "ONBOARDING"
        ? ALLOW
        : {
            allow: false,
            httpStatus: 402, // Payment Required - accurate, and distinct from 403
            code: "TENANT_PAYMENT_REQUIRED",
            message: "Your plan activates once payment is confirmed",
            redirectPath: "/checkout/payment-required",
          };

    case "SUSPENDED":
      // Deliberately stricter than PENDING_PAYMENT: a suspended tenant may not
      // self-serve back in, including through payment setup.
      return {
        allow: false,
        httpStatus: 403,
        code: "TENANT_SUSPENDED",
        message: "This organization's account is suspended",
      };

    default:
      // A new TenantStatus reaches here as a TYPE error, not a runtime surprise.
      return assertNever(status);
  }
}

/** Convenience: the safe JSON body for a denial. Never leaks the tenant id. */
export function tenantAccessErrorBody(denial: TenantAccessDenial): Record<string, unknown> {
  return {
    code: denial.code,
    message: denial.message,
    ...(denial.redirectPath ? { checkoutPath: denial.redirectPath } : {}),
  };
}
