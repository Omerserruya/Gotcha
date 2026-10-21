import { describe, expect, it } from 'vitest';

import type { ProvisioningStatus } from '@/api/contracts/console';

import { tenantBillingState } from './billing-state';

const request = (state: string): ProvisioningStatus => ({
  id: 'p1',
  state,
  mode: 'PAID_PLAN',
  attemptCount: 1,
  lastAttemptAt: null,
  lastFailureCode: null,
  lastFailureMessage: null,
  canRepair: state !== 'COMPLETED',
  canResend: state === 'COMPLETED',
});

describe('★★ tenantBillingState - resend and repair are two problems', () => {
  it('ACTIVE is ACTIVE, and a status that owes nothing is OTHER', () => {
    expect(tenantBillingState('ACTIVE', undefined)).toBe('ACTIVE');
    expect(tenantBillingState('PENDING_ONBOARDING', request('FAILED_RETRYABLE'))).toBe('OTHER');
  });

  it('★ awaiting payment with a COMPLETED request: waiting on the customer', () => {
    expect(tenantBillingState('PENDING_PAYMENT', request('COMPLETED'))).toBe(
      'PENDING_PAYMENT_READY',
    );
  });

  it('★★ awaiting payment with no request, or one that never finished: incomplete', () => {
    expect(tenantBillingState('PENDING_PAYMENT', null)).toBe('BILLING_SETUP_INCOMPLETE');
    for (const state of ['PENDING', 'PROCESSING', 'FAILED_RETRYABLE', 'FAILED_PERMANENT']) {
      expect(tenantBillingState('PENDING_PAYMENT', request(state))).toBe(
        'BILLING_SETUP_INCOMPLETE',
      );
    }
  });

  it('★★ a read that failed is unread - never "incomplete", which would offer a repair', () => {
    expect(tenantBillingState('PENDING_PAYMENT', undefined)).toBe('BILLING_UNREAD');
  });
});
