import { describe, expect, it } from 'vitest';

import { ApiError, kindFromStatus } from './api-error';

describe('kindFromStatus', () => {
  it.each([
    [401, 'authentication'],
    [403, 'authorization'],
    [404, 'not_found'],
    [409, 'conflict'],
    [400, 'validation'],
    [422, 'validation'],
    [429, 'rate_limited'],
    [503, 'integration'],
    [500, 'server'],
  ])('maps %i to %s', (status, expected) => {
    expect(kindFromStatus(status)).toBe(expected);
  });
});

describe('ApiError', () => {
  it('marks transient failures retryable and permanent ones not', () => {
    expect(new ApiError({ kind: 'network' }).isRetryable).toBe(true);
    expect(new ApiError({ kind: 'server' }).isRetryable).toBe(true);
    expect(new ApiError({ kind: 'authorization' }).isRetryable).toBe(false);
    expect(new ApiError({ kind: 'validation' }).isRetryable).toBe(false);
  });

  it('flags only authentication failures as needing re-authentication', () => {
    expect(new ApiError({ kind: 'authentication' }).requiresReauthentication).toBe(true);
    expect(new ApiError({ kind: 'authorization' }).requiresReauthentication).toBe(false);
  });

  it('keeps the backend message out of diagnostics', () => {
    const error = new ApiError({
      kind: 'server',
      status: 500,
      developerMessage: 'Customer 4821 phone +972...',
      route: '/api/contacts/{id}',
      method: 'GET',
    });
    const diagnostics = error.toDiagnostics();
    expect(JSON.stringify(diagnostics)).not.toContain('972');
    expect(diagnostics.route).toBe('/api/contacts/{id}');
  });
  /*
   * A 402 used to land in `unknown`, and the gate's own explanation - which
   * status, which rule, where to go - was dropped by the envelope parser. The
   * result on screen was a blank page with nothing to act on.
   */
  it('classifies the tenant gate as its own kind, not an unknown failure', () => {
    expect(kindFromStatus(402)).toBe('tenant_inactive');
    expect(kindFromStatus(403)).toBe('authorization');
  });

  it('is not retryable and does not mean the session ended', () => {
    const error = new ApiError({ kind: 'tenant_inactive', status: 402 });
    expect(error.isRetryable).toBe(false);
    expect(error.requiresReauthentication).toBe(false);
  });

  it('keeps the gate reason, which is an enum rather than customer data', () => {
    const error = new ApiError({
      kind: 'tenant_inactive',
      status: 402,
      code: 'TENANT_SUSPENDED',
      tenantStatus: 'SUSPENDED',
      checkoutPath: '/billing/checkout',
    });
    expect(error.checkoutPath).toBe('/billing/checkout');
    expect(error.toDiagnostics()).toMatchObject({
      code: 'TENANT_SUSPENDED',
      tenantStatus: 'SUSPENDED',
    });
  });
});
