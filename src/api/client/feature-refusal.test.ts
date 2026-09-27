import { describe, expect, it } from 'vitest';

import { ApiError } from './api-error';
import { featureRefusalFrom, tenantGateFrom } from './tenant-gate';

/**
 * Two different 402s share one envelope.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A FEATURE REFUSAL WAS BEING READ AS A WHOLE-TENANT GATE
 * ════════════════════════════════════════════════════════════════════════════
 * The tenant gate means the ORGANISATION is locked out. `requireEntitlement`
 * means one feature is not on their plan. Both arrive as
 * `kind: 'tenant_inactive'`, because 402 maps there by status.
 *
 * `load-home-data` does `gate ??= tenantGateFrom(cause)` across every one of its
 * parallel reads, so **one entitlement-gated route would have told a merchant
 * their organisation was locked out while the rest of the product worked.**
 *
 * Found by reading both sides. It needs a tenant whose plan denies something Home
 * reads, and the demo tenant is not one — so no walk could have found it.
 */

const refused = (code: string, extra: Record<string, unknown> = {}) =>
  new ApiError({ kind: 'tenant_inactive', status: 402, code, ...extra });

describe('★★ featureRefusalFrom reads the feature-level 402', () => {
  it('★★ carries `upgradePath`, which is NOT `checkoutPath`', () => {
    /*
     * The field the envelope was stripping. `EntitlementDeniedError` sends
     * `upgradePath`; the tenant gate sends `checkoutPath`. Declaring only the
     * second threw away the only link that tells somebody where to go.
     */
    const refusal = featureRefusalFrom(
      refused('PLAN_FEATURE_REQUIRED', {
        feature: 'ai.copilot',
        currentPlan: 'foundation',
        upgradePath: '/settings/billing/plan',
      }),
    );
    expect(refusal).toEqual({
      code: 'PLAN_FEATURE_REQUIRED',
      feature: 'ai.copilot',
      currentPlan: 'foundation',
      upgradePath: '/settings/billing/plan',
      limit: null,
      used: null,
    });
  });

  it('carries the numbers on a limit breach', () => {
    const refusal = featureRefusalFrom(refused('PLAN_LIMIT_REACHED', { limit: 3, current: 3 }));
    expect(refusal?.limit).toBe(3);
    expect(refusal?.used).toBe(3);
  });

  it('★★ keeps FEATURE_NOT_AVAILABLE distinct, because no plan change lifts it', () => {
    /*
     * `isEntitled` returns false for an unsellable key, which means **the product
     * has not built this**. Folding it in with PLAN_FEATURE_REQUIRED would offer
     * an upgrade for something that does not exist to buy.
     */
    expect(featureRefusalFrom(refused('FEATURE_NOT_AVAILABLE'))?.code).toBe(
      'FEATURE_NOT_AVAILABLE',
    );
  });

  it('is null for a tenant gate, an authorization failure, and a plain error', () => {
    expect(featureRefusalFrom(refused('TENANT_PLAN_REQUIRED'))).toBeNull();
    expect(featureRefusalFrom(new ApiError({ kind: 'authorization', status: 403 }))).toBeNull();
    expect(featureRefusalFrom(new Error('network'))).toBeNull();
  });

  it('★ is null for a 402 with no code, which we cannot classify', () => {
    // Absent is not one of the three. Guessing would put a tenant-wide notice on
    // a screen for a reason nobody stated.
    expect(featureRefusalFrom(new ApiError({ kind: 'tenant_inactive', status: 402 }))).toBeNull();
  });
});

describe('★★ tenantGateFrom no longer claims the tenant is locked out', () => {
  it('★★ returns nothing for any of the three feature codes', () => {
    for (const code of ['PLAN_FEATURE_REQUIRED', 'PLAN_LIMIT_REACHED', 'FEATURE_NOT_AVAILABLE']) {
      expect(tenantGateFrom(refused(code))).toBeNull();
    }
  });

  it('★★ still returns the gate for a real tenant gate', () => {
    /*
     * Both directions. A fix that made `tenantGateFrom` return null more often
     * would also "pass" a test that only checked the feature codes — and then a
     * suspended tenant would get no notice at all, which is the worse failure.
     */
    const gate = tenantGateFrom(
      refused('TENANT_PLAN_REQUIRED', { tenantStatus: 'SUSPENDED', checkoutPath: '/billing' }),
    );
    expect(gate).toEqual({
      code: 'TENANT_PLAN_REQUIRED',
      tenantStatus: 'SUSPENDED',
      checkoutPath: '/billing',
    });
  });

  it('still returns a gate for a 402 with no code at all', () => {
    // The tenant gate is the historical meaning of a bare 402, so an
    // unclassifiable one keeps it rather than silently rendering nothing.
    expect(tenantGateFrom(new ApiError({ kind: 'tenant_inactive', status: 402 }))).not.toBeNull();
  });
});
