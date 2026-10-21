import { z } from 'zod';

/**
 * The platform console - `/api/system/*` (auth `routes/system.ts`) and the
 * billing service's sysadmin routes. SYSTEM_ADMIN only: every route is behind
 * `requireSystemAdmin()` or `requirePlatformPermission()`, both of which
 * refuse any other role (packages/shared `rbac.ts:61`,
 * `platform-permission.ts:28`).
 */

/**
 * `TenantStatus` (packages/shared `schema.prisma:46`). Read as a string: a
 * status this build has not named is drawn as its code, not a rejected list.
 */
export const TENANT_STATUSES = [
  'PENDING_ADMIN_SETUP',
  'PENDING_ONBOARDING',
  'PENDING_PAYMENT',
  'ACTIVE',
  'SUSPENDED',
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/**
 * `PlanAccessState` (packages/shared `billing/tenant-plan-access.ts:36`): how
 * an organization holds the product right now - never empty, the bad states
 * included. A string here for the same reason as the status.
 */
export const PLAN_ACCESS_STATES = [
  'ACTIVE_PAID',
  'ACTIVE_POC',
  'ACTIVE_TRIAL',
  'ACTIVE_MANUAL_CONTRACT',
  'PENDING_PAYMENT',
  'SETUP_INCOMPLETE',
  'EXPIRED',
  'CONFLICTING',
  'MISSING',
] as const;
export type PlanAccessState = (typeof PLAN_ACCESS_STATES)[number];

const nullableString = z.string().nullable().catch(null).default(null);
const count = z.number().int().nonnegative().nullable().catch(null).default(null);

/**
 * A tenant's plan, as the console sees it (`resolveTenantPlanAccess`). The
 * route's `label` is English prose; the screen names the state in its own
 * words and keeps the label only for a state it does not know.
 */
export const planAccessSchema = z.object({
  state: z.string(),
  label: z.string().catch('').default(''),
  active: z.boolean().catch(false).default(false),
  planKey: nullableString,
  /** The detail route sends it; the list does not. */
  planName: nullableString,
  expiresAt: nullableString,
  /** A person has to decide something: no plan, two plans, ended, or half set up. */
  needsReview: z.boolean().catch(false).default(false),
});
export type PlanAccess = z.infer<typeof planAccessSchema>;

/**
 * One row of `GET /api/system/tenants` (system.ts:101). `_count` counts open
 * conversations and CONNECTED channels only - the route's own `where`s.
 */
export const tenantRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  _count: z
    .object({ users: count, conversations: count, channelAccounts: count })
    .catch({ users: null, conversations: null, channelAccounts: null })
    .default({ users: null, conversations: null, channelAccounts: null }),
  /** Null when the resolver had no verdict - drawn as "plan unknown", never as fine. */
  planAccess: planAccessSchema.nullable().catch(null).default(null),
});
export type TenantRow = z.infer<typeof tenantRowSchema>;

/** `{ data, meta }` - `data` with a sibling, so the call is `raw`. */
export const tenantListSchema = z.object({
  data: z.array(tenantRowSchema),
  meta: z.object({ total: z.number().int().nonnegative() }).nullable().catch(null).default(null),
});

/**
 * `BillingProvisioningState` (schema.prisma:4054), from
 * `GET /api/system/tenants/:id/billing-provisioning` (system.ts:880) →
 * `{ data: status | null }` - null when no request was ever made.
 */
export const provisioningStatusSchema = z
  .object({
    id: z.string(),
    state: z.string(),
    mode: nullableString,
    attemptCount: z.number().int().catch(0).default(0),
    lastAttemptAt: nullableString,
    lastFailureCode: nullableString,
    lastFailureMessage: nullableString,
    /**
     * PENDING or FAILED_RETRYABLE (billing-provisioning.service.ts:285). An
     * unread answer offers Repair, as legacy did: a refused repair says why,
     * a hidden one says nothing.
     */
    canRepair: z.boolean().catch(true).default(true),
    canResend: z.boolean().catch(false).default(false),
  })
  .nullable();
export type ProvisioningStatus = z.infer<typeof provisioningStatusSchema>;
