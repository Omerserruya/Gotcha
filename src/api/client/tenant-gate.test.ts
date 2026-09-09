import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiError } from './api-error';
import { HttpClient } from './http-client';
import { tenantGateFrom } from './tenant-gate';

const endpoint = { path: '/api/agents/presence', route: '/api/agents/presence' };

function respondWith(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

async function callAndCatch(): Promise<ApiError> {
  const client = new HttpClient({ baseUrl: '', defaultTimeoutMs: 1000 });
  try {
    await client.request({ method: 'GET', endpoint, payload: z.unknown() });
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected the request to fail');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tenantGateFrom', () => {
  it('reads the gate off a tenant failure', () => {
    const gate = tenantGateFrom(
      new ApiError({
        kind: 'tenant_inactive',
        status: 402,
        code: 'TENANT_PLAN_REQUIRED',
        tenantStatus: 'ACTIVE',
      }),
    );
    expect(gate).toEqual({
      code: 'TENANT_PLAN_REQUIRED',
      tenantStatus: 'ACTIVE',
      checkoutPath: null,
    });
  });

  it('is null for an ordinary failure and for a non-error', () => {
    expect(tenantGateFrom(new ApiError({ kind: 'server', status: 500 }))).toBeNull();
    expect(tenantGateFrom(new Error('boom'))).toBeNull();
  });
});

describe('classifying the tenant gate', () => {
  it('carries the gate fields off a 402 instead of discarding them', async () => {
    respondWith(402, {
      error: 'Tenant is not active',
      code: 'TENANT_PLAN_REQUIRED',
      tenantStatus: 'ACTIVE',
    });
    const error = await callAndCatch();
    expect(error.kind).toBe('tenant_inactive');
    expect(tenantGateFrom(error)).toMatchObject({ code: 'TENANT_PLAN_REQUIRED' });
  });

  /*
   * The backend sends the setup and onboarding gates as 403. Classifying by
   * status alone files those as `authorization`, which tells a user whose
   * onboarding is unfinished to go and ask an admin for permission - a remedy
   * that does not apply. The `TENANT_` code is what settles it.
   */
  it('treats a 403 carrying a tenant code as a gate, not a permission failure', async () => {
    respondWith(403, {
      error: 'Organization onboarding must be completed before using the platform',
      code: 'TENANT_ONBOARDING_REQUIRED',
      tenantStatus: 'PENDING_ONBOARDING',
    });
    expect((await callAndCatch()).kind).toBe('tenant_inactive');
  });

  it('leaves an ordinary 403 as an authorization failure', async () => {
    respondWith(403, { error: 'Forbidden' });
    expect((await callAndCatch()).kind).toBe('authorization');
  });
});
