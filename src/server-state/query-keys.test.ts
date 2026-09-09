import { describe, expect, it } from 'vitest';

import { featureKeys, identityKeys, tenantScope } from './query-keys';

describe('query keys', () => {
  it('scopes every feature key by tenant', () => {
    const inbox = featureKeys('inbox');
    expect(inbox('t_1', 'conversations')).toEqual(['tenant', 't_1', 'inbox', 'conversations']);
  });

  it('produces different keys for the same query in different tenants', () => {
    const inbox = featureKeys('inbox');
    expect(inbox('t_1', 'conversations')).not.toEqual(inbox('t_2', 'conversations'));
  });

  it('gives a signed-out user a distinct scope rather than colliding on undefined', () => {
    expect(tenantScope(null)).toEqual(['tenant', 'none']);
  });

  it('scopes permissions by tenant, since they differ per workspace', () => {
    expect(identityKeys.permissions('t_1')).not.toEqual(identityKeys.permissions('t_2'));
  });
});
