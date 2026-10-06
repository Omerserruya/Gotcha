import { z } from 'zod';

/**
 * The tenant's business rules for sensitive actions - what GOTCHA may do on
 * its own. `GET /api/business-policies` answers `{ data: { actionKinds,
 * policies } }`, the latest version per kind.
 *
 * Read for 04e's "What GOTCHA may do for them". The ENGINE is the platform's
 * (`packages/shared/src/lib/business-policy.ts`); this contract only names
 * the fields its sentences use, and `describePolicy` says what the engine
 * does with them - no more:
 *
 *   enabled: false              → DENIED, always ("action_disabled")
 *   maxAmount / maxPercentOfOrder → the stricter one caps the amount
 *   managerApprovalAboveAmount  → above it, a person approves
 *   no row for the kind         → REFUND, CANCEL_ORDER, CUSTOMER_WRITE allowed;
 *                                 COMPENSATION, COUPON, DISCOUNT denied
 *
 * ⚠ The tool catalog's own approval rule ("catalog=always") sits OUTSIDE
 * this engine, so no sentence here says "on its own": the policy can allow
 * what the catalog still sends for approval.
 */

/** As the route lists them. A string, not an enum: a kind added later must not reject the read. */
export const POLICY_KINDS = [
  'REFUND',
  'CANCEL_ORDER',
  'COUPON',
  'COMPENSATION',
  'DISCOUNT',
  'CUSTOMER_WRITE',
] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

/** Denied when no policy row exists - `defaultDecisionWithoutPolicy`. */
const DENIED_WITHOUT_POLICY: ReadonlySet<string> = new Set(['COMPENSATION', 'COUPON', 'DISCOUNT']);

const amount = z.number().finite().nonnegative().nullish().default(null);

export const businessPolicySchema = z.object({
  actionKind: z.string(),
  enabled: z.boolean().default(true),
  version: z.number().default(1),
  config: z
    .object({
      maxAmount: amount,
      maxPercentOfOrder: amount,
      managerApprovalAboveAmount: amount,
    })
    .default({ maxAmount: null, maxPercentOfOrder: null, managerApprovalAboveAmount: null }),
});
export type BusinessPolicy = z.infer<typeof businessPolicySchema>;

export const businessPoliciesSchema = z.object({
  actionKinds: z.array(z.string()).default([...POLICY_KINDS]),
  policies: z.array(businessPolicySchema).default([]),
});
export type BusinessPolicies = z.infer<typeof businessPoliciesSchema>;

/**
 * One kind's rule, as data a sentence can be built from.
 *
 *   never      disabled, or denied by default with no rule set
 *   unset      no rule set, and the default allows it
 *   limits     enabled, with whichever limits are set (each may be null)
 */
export type PolicyLine =
  | { readonly kind: string; readonly shape: 'never'; readonly byDefault: boolean }
  | { readonly kind: string; readonly shape: 'unset' }
  | {
      readonly kind: string;
      readonly shape: 'limits';
      readonly max: number | null;
      readonly percent: number | null;
      readonly approvalAbove: number | null;
    };

export function describePolicy(kind: string, policy: BusinessPolicy | undefined): PolicyLine {
  if (!policy) {
    return DENIED_WITHOUT_POLICY.has(kind)
      ? { kind, shape: 'never', byDefault: true }
      : { kind, shape: 'unset' };
  }
  if (!policy.enabled) return { kind, shape: 'never', byDefault: false };
  return {
    kind,
    shape: 'limits',
    max: policy.config.maxAmount,
    percent: policy.config.maxPercentOfOrder,
    approvalAbove: policy.config.managerApprovalAboveAmount,
  };
}

/** Every listed kind, in the route's order, each with its rule or its default. */
export function policyLines(policies: BusinessPolicies): readonly PolicyLine[] {
  const byKind = new Map(policies.policies.map((policy) => [policy.actionKind, policy]));
  return policies.actionKinds.map((kind) => describePolicy(kind, byKind.get(kind)));
}
