import { describe, expect, it } from 'vitest';

import type { ProvisioningStatus } from '@/api/contracts/console';

import { repairOffered, tenantBillingState } from './billing-state';

const request = (state: string): NonNullable<ProvisioningStatus> => ({
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

describe('★★ repairOffered - the route’s own guard', () => {
  it('★ awaiting payment, a request that never finished and can be retried: offered', () => {
    expect(repairOffered('PENDING_PAYMENT', request('FAILED_RETRYABLE'))).toBe(true);
    expect(repairOffered('PENDING_PAYMENT', request('PENDING'))).toBe(true);
  });

  it('★ a half-provisioned POC owes nothing and is still repairable', () => {
    const poc = { ...request('FAILED_RETRYABLE'), mode: 'POC' };
    expect(repairOffered('PENDING_ADMIN_SETUP', poc)).toBe(true);
    expect(repairOffered('PENDING_ADMIN_SETUP', request('FAILED_RETRYABLE'))).toBe(false);
  });

  it('★★ not offered: no request, an unread one, a completed one, one that cannot be retried', () => {
    expect(repairOffered('PENDING_PAYMENT', null)).toBe(false);
    expect(repairOffered('PENDING_PAYMENT', undefined)).toBe(false);
    expect(repairOffered('PENDING_PAYMENT', request('COMPLETED'))).toBe(false);
    expect(
      repairOffered('PENDING_PAYMENT', { ...request('FAILED_PERMANENT'), canRepair: false }),
    ).toBe(false);
  });
});
