import { isApiError } from './api-error';

/**
 * Why the platform locked an entire tenant out.
 *
 * Lives in the API layer because it is read off the error the transport
 * produced, and because both the shell and any feature may need it — neither
 * can import the other.
 *
 * Every field is an enum or a path, never prose and never customer data.
 */
export interface TenantGate {
  /** Stable machine-readable reason, e.g. `TENANT_PLAN_REQUIRED`. */
  readonly code: string | null;
  /** Tenant lifecycle status the gate reported, e.g. `ACTIVE`. */
  readonly tenantStatus: string | null;
  /** In-app path that would lift it, when the backend names one. */
  readonly checkoutPath: string | null;
}

/**
 * The three codes `EntitlementDeniedError` sends. **Not tenant gates.**
 *
 * `FEATURE_NOT_AVAILABLE` is the important one and it is not a commercial state
 * at all: `isEntitled` returns false for an unsellable key, which means *the
 * product has not built this*. No plan change lifts it, so offering an upgrade
 * would sell somebody something that does not exist.
 */
const FEATURE_CODES = new Set([
  'PLAN_FEATURE_REQUIRED',
  'PLAN_LIMIT_REACHED',
  'FEATURE_NOT_AVAILABLE',
]);

/**
 * One feature this tenant may not use — not the tenant being locked out.
 *
 * `null` when the failure was anything else.
 */
export interface FeatureRefusal {
  readonly code: 'PLAN_FEATURE_REQUIRED' | 'PLAN_LIMIT_REACHED' | 'FEATURE_NOT_AVAILABLE';
  /** The feature key, e.g. `ai.copilot`. Never rendered raw. */
  readonly feature: string | null;
  readonly currentPlan: string | null;
  /** Where a plan change happens, when one would help. */
  readonly upgradePath: string | null;
  /** Limit breaches only. */
  readonly limit: number | null;
  readonly used: number | null;
}

export function featureRefusalFrom(cause: unknown): FeatureRefusal | null {
  if (!isApiError(cause) || !cause.code || !FEATURE_CODES.has(cause.code)) return null;
  return {
    code: cause.code as FeatureRefusal['code'],
    feature: cause.feature ?? null,
    currentPlan: cause.currentPlan ?? null,
    upgradePath: cause.upgradePath ?? null,
    limit: cause.limit ?? null,
    used: cause.current ?? null,
  };
}

/**
 * The gate behind a failure, or null when the failure was something else.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A FEATURE REFUSAL IS NOT A TENANT GATE, AND THIS RETURNED ONE
 * ════════════════════════════════════════════════════════════════════════════
 * Two different 402s share an envelope: the tenant gate, which means the
 * ORGANISATION is locked out, and `requireEntitlement`, which means one feature
 * is not on their plan. Both arrive as `kind: 'tenant_inactive'` because 402 maps
 * there by status.
 *
 * So any read that hit a feature-level refusal produced a whole-tenant gate —
 * and `load-home-data` does `gate ??= tenantGateFrom(cause)` across every one of
 * its parallel reads. **One entitlement-gated route would have told a merchant
 * their organisation was locked out while the rest of the product worked.**
 *
 * Found by reading both sides, not by seeing it: it needs a tenant whose plan
 * denies something Home reads, and the demo tenant is not one.
 */
export function tenantGateFrom(cause: unknown): TenantGate | null {
  if (!isApiError(cause) || cause.kind !== 'tenant_inactive') return null;
  if (cause.code && FEATURE_CODES.has(cause.code)) return null;
  return {
    code: cause.code ?? null,
    tenantStatus: cause.tenantStatus ?? null,
    checkoutPath: cause.checkoutPath ?? null,
  };
}
