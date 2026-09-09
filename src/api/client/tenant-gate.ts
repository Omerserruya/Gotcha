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

/** The gate behind a failure, or null when the failure was something else. */
export function tenantGateFrom(cause: unknown): TenantGate | null {
  if (!isApiError(cause) || cause.kind !== 'tenant_inactive') return null;
  return {
    code: cause.code ?? null,
    tenantStatus: cause.tenantStatus ?? null,
    checkoutPath: cause.checkoutPath ?? null,
  };
}
