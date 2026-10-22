import { describe, expect, it } from 'vitest';

import { businessPoliciesSchema, describePolicy, policyLines } from './business-policies';

/** The engine's semantics, as `business-policy.ts` applies them. */

const policy = (over: Record<string, unknown> = {}) =>
  businessPoliciesSchema.parse({ policies: [{ actionKind: 'REFUND', ...over }] }).policies[0]!;

describe('★★ each rule as the engine applies it', () => {
  it('switched off is never - "action_disabled"', () => {
    expect(describePolicy('REFUND', policy({ enabled: false }))).toEqual({
      kind: 'REFUND',
      shape: 'never',
      byDefault: false,
    });
  });

  it('★ with no rule, compensation, coupons and discounts are denied - `defaultDecisionWithoutPolicy`', () => {
    for (const kind of ['COMPENSATION', 'COUPON', 'DISCOUNT']) {
      expect(describePolicy(kind, undefined)).toEqual({ kind, shape: 'never', byDefault: true });
    }
  });

  it('with no rule, refunds, cancels and record changes are allowed - and said to be unset', () => {
    for (const kind of ['REFUND', 'CANCEL_ORDER', 'CUSTOMER_WRITE']) {
      expect(describePolicy(kind, undefined)).toEqual({ kind, shape: 'unset' });
    }
  });

  it('the limits it has, and only those', () => {
    expect(
      describePolicy(
        'REFUND',
        policy({ config: { maxAmount: 300, managerApprovalAboveAmount: 100 } }),
      ),
    ).toEqual({ kind: 'REFUND', shape: 'limits', max: 300, percent: null, approvalAbove: 100 });
  });
});

describe('★ the read', () => {
  it('every listed kind, in the route’s order, ruled or defaulted', () => {
    const lines = policyLines(
      businessPoliciesSchema.parse({
        actionKinds: ['REFUND', 'DISCOUNT', 'CUSTOMER_WRITE'],
        policies: [{ actionKind: 'REFUND', config: { maxAmount: 100 } }],
      }),
    );
    expect(lines.map((line) => [line.kind, line.shape])).toEqual([
      ['REFUND', 'limits'],
      ['DISCOUNT', 'never'],
      ['CUSTOMER_WRITE', 'unset'],
    ]);
  });

  it('★ a kind the platform adds later does not reject the response', () => {
    const parsed = businessPoliciesSchema.parse({
      actionKinds: ['REFUND', 'GIFT_CARD'],
      policies: [{ actionKind: 'GIFT_CARD', enabled: false }],
    });
    expect(policyLines(parsed)[1]).toEqual({ kind: 'GIFT_CARD', shape: 'never', byDefault: false });
  });

  it('a policy with no config is enabled with no limits', () => {
    expect(describePolicy('REFUND', policy())).toEqual({
      kind: 'REFUND',
      shape: 'limits',
      max: null,
      percent: null,
      approvalAbove: null,
    });
  });
});
