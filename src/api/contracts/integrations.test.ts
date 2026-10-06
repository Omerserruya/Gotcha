import { describe, expect, it } from 'vitest';

import { connectionSchema } from './integrations';

describe('★ 14d - the store host from the connection, and nothing else of its config', () => {
  it('reads config.shopDomain', () => {
    const c = connectionSchema.parse({
      id: 'c1',
      status: 'ERROR',
      config: { shopDomain: 'avivco.myshopify.com', accessScopes: ['read_orders'], token: 'x' },
    });
    expect(c.shopDomain).toBe('avivco.myshopify.com');
    // The rest of config does not leave the contract.
    expect(c).not.toHaveProperty('config');
  });

  it('no config, or none with a shop, is null', () => {
    expect(connectionSchema.parse({ id: 'c1', status: 'CONNECTED' }).shopDomain).toBeNull();
    expect(
      connectionSchema.parse({ id: 'c1', status: 'CONNECTED', config: { shopDomain: ' ' } })
        .shopDomain,
    ).toBeNull();
  });
});
