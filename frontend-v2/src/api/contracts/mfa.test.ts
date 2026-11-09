import { describe, expect, it } from 'vitest';

import { accountSecuritySchema, mfaFlowUrl, mfaGateSchema } from './mfa';

describe('★ the MFA contract', () => {
  it('a flow URL: the provider’s origin, a RELATIVE next only when the gate chains', () => {
    expect(mfaFlowUrl('https://a.test', 'totp', 2)).toBe(
      'https://a.test/if/flow/default-authenticator-totp-setup/?next=%2Fif%2Fflow%2Fdefault-authenticator-static-setup%2F&_n=2',
    );
    expect(mfaFlowUrl('https://a.test', 'totp', 0, false)).toBe(
      'https://a.test/if/flow/default-authenticator-totp-setup/?_n=0',
    );
    expect(mfaFlowUrl('https://a.test', 'recoveryCodes')).toBe(
      'https://a.test/if/flow/default-authenticator-static-setup/?_n=0',
    );
  });

  it('the gate: an unknown reason reads as none; a missing mustEnroll is unread, never "not owed"', () => {
    const base = {
      required: true,
      reason: 'system_admin',
      enrolled: false,
      hasAuthenticator: false,
      hasRecovery: false,
      mustEnroll: true,
      identityAvailable: true,
    };
    expect(mfaGateSchema.parse({ ...base, reason: 'new_rule' }).reason).toBeNull();
    const { mustEnroll: _drop, ...noVerdict } = base;
    expect(mfaGateSchema.safeParse(noVerdict).success).toBe(false);
  });

  it('the factors: device ids as strings, absent lists empty', () => {
    const read = accountSecuritySchema.parse({ available: true, totp: [{ id: 5 }] });
    expect(read.totp[0]).toMatchObject({ id: '5', name: null });
    expect(read.recoveryCodes).toEqual([]);
  });
});
