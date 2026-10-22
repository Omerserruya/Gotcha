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

/**
 * One tenant - `GET /api/system/tenants/:id` (system.ts:172) → `{ data }`.
 * The route sends the whole Tenant row and more; the console reads what it
 * draws. `_count` here is unfiltered (all conversations, all channels).
 */
export const tenantDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  _count: z
    .object({
      users: count,
      conversations: count,
      messages: count,
      channelAccounts: count,
      departments: count,
    })
    .catch({
      users: null,
      conversations: null,
      messages: null,
      channelAccounts: null,
      departments: null,
    })
    .default({
      users: null,
      conversations: null,
      messages: null,
      channelAccounts: null,
      departments: null,
    }),
  channels: z
    .array(
      z.object({
        id: z.string(),
        channel: z.string(),
        displayName: nullableString,
        connectionStatus: z.string().catch('').default(''),
      }),
    )
    .catch([])
    .default([]),
  /** Always sent on the detail (system.ts:211), with `planName`. */
  planAccess: planAccessSchema,
});
export type TenantDetail = z.infer<typeof tenantDetailSchema>;

/** A plan's volume option: KEY and daily volume - the route prices it (`safeOption`). */
const volumeOptionSchema = z.object({ key: z.string(), dailyVolume: z.number() });

/**
 * Plans a paid plan can be given from - ACTIVE, PUBLIC, not sales-only
 * (billing `admin-pricing.ts:1085`) → `{ data }`. The picker's needs only:
 * the plan and its volume options by KEY. The route prices a choice itself
 * and takes keys alone.
 */
export const provisionablePlansSchema = z.array(
  z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    chatVolumeEnabled: z.boolean().catch(false).default(false),
    voiceVolumeEnabled: z.boolean().catch(false).default(false),
    chatOptions: z.array(volumeOptionSchema).catch([]).default([]),
    voiceOptions: z.array(volumeOptionSchema).catch([]).default([]),
  }),
);
export type ProvisionablePlan = z.infer<typeof provisionablePlansSchema>[number];

/**
 * A coupon (billing `coupon.service.ts:134` listCoupons) - `GET
 * /api/admin/coupons` → bare `{ coupons }`. `label` is the service's own
 * summary of the discount ("20% off").
 */
export const couponSchema = z.object({
  id: z.string(),
  code: z.string(),
  nameEn: z.string().catch('').default(''),
  nameHe: nullableString,
  /** `CouponDiscountType` (schema.prisma:3727): PERCENT · FIXED. */
  discountType: z.string(),
  percentOff: z.number().nullable().catch(null).default(null),
  amountOff: nullableString,
  currency: nullableString,
  defaultDurationMonths: z.number().int().nullable().catch(null).default(null),
  active: z.boolean(),
  maxRedemptions: z.number().int().nullable().catch(null).default(null),
  assignmentCount: z.number().int().catch(0).default(0),
  label: z.string().catch('').default(''),
});
export type Coupon = z.infer<typeof couponSchema>;
export const couponListSchema = z.object({ coupons: z.array(couponSchema) });

/**
 * One tenant's coupon assignment (coupon.service.ts:288) - `GET
 * /api/admin/coupons/tenants/:id` → bare `{ assignments }`. `live` is "is
 * discounting money right now": window open AND the coupon still active.
 * `status` is `TenantCouponStatus` (schema.prisma:3735).
 */
export const tenantCouponSchema = z.object({
  id: z.string(),
  code: z.string(),
  label: z.string().catch('').default(''),
  startsAt: z.string(),
  endsAt: nullableString,
  status: z.string(),
  live: z.boolean().catch(false).default(false),
});
export type TenantCoupon = z.infer<typeof tenantCouponSchema>;
export const tenantCouponsSchema = z.object({ assignments: z.array(tenantCouponSchema) });

/** The coupon routes' refusal codes (`refusal()`, admin-coupons.ts:42), each its own sentence. */
export const COUPON_REFUSALS = [
  'invalid_code',
  'name_required',
  'percent_out_of_range',
  'amount_required',
  'currency_required_for_fixed',
  'invalid_duration',
  'unknown_coupon',
  'coupon_inactive',
  'coupon_exhausted',
  'unknown_tenant',
  'already_assigned',
] as const;
export type CouponRefusalCode = (typeof COUPON_REFUSALS)[number];

/**
 * The quote for a selection - `POST /api/admin/pricing/provisioning/quote`
 * (billing admin-pricing.ts:1125) → `{ data }`. Every figure is the server's:
 * the screen computes no total, and what the operator approves is what
 * provisioning freezes. `chargeableToday` false: the plan's currency has no
 * verified charge contract yet - the tenant can be created, not charged.
 */
export const provisioningQuoteSchema = z.object({
  planName: z.string(),
  basePrice: z.string(),
  totalAmount: z.string(),
  currency: z.string(),
  includedCredits: z.number(),
  estimatedChatsMonthly: z.number().catch(0).default(0),
  estimatedCallsMonthly: z.number().catch(0).default(0),
  billingInterval: z.string(),
  chargeableToday: z.boolean().catch(false).default(false),
});
export type ProvisioningQuote = z.infer<typeof provisioningQuoteSchema>;

/** `GET /api/system/poc-feature-domains` (system.ts:1028) → `{ data: string[] }`. */
export const pocDomainsSchema = z.array(z.string());

/**
 * `POST /api/system/tenants` (system.ts:348) → 201 `{ data: { tenant,
 * admin, billing } }`. A 502 carries the same `data` with the tenant that WAS
 * created and its billing that was not - "repair, never create again".
 */
export const createdTenantSchema = z.object({
  tenant: z.object({ id: z.string(), name: z.string() }),
});
