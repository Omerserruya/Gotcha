import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { resetServerEnvCache } from '@/config/env.server';

import { billingWritesEnabled } from './billing-writes';

/** The variables `serverEnv` requires, so only BILLING_WRITES varies. */
const BASE = {
  API_BASE_URL: 'http://api.test',
  OIDC_ISSUER: 'http://idp.test/o/app/',
  OIDC_CLIENT_ID: 'client',
  APP_ORIGIN: 'http://app.test',
  SESSION_SECRET: 'x'.repeat(48),
};

const withEnv = (value: string | undefined) => {
  for (const [key, v] of Object.entries(BASE)) vi.stubEnv(key, v);
  if (value === undefined) vi.stubEnv('BILLING_WRITES', undefined as unknown as string);
  else vi.stubEnv('BILLING_WRITES', value);
  resetServerEnvCache();
  return billingWritesEnabled();
};

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCache();
});

describe('★★ BILLING_WRITES fails closed - only the exact `on` lets billing move money', () => {
  it('on: writes run', () => {
    expect(withEnv('on')).toBe(true);
  });

  it.each([
    ['unset', undefined],
    ['empty (a compose ${VAR:-})', ''],
    ['off', 'off'],
    ['a typo', 'yes'],
    ['the wrong case', 'ON'],
  ])('%s: held', (_name, value) => {
    expect(withEnv(value)).toBe(false);
  });
});
