import { describe, expect, it } from 'vitest';

import { displayHost } from './workspace';

describe('★ a website as 02 writes it - the host alone', () => {
  it('drops the scheme, `www.` and the path', () => {
    expect(displayHost('https://urban-supply-gotcha-demo.myshopify.com')).toBe(
      'urban-supply-gotcha-demo.myshopify.com',
    );
    expect(displayHost('https://www.avivco.il/shop/')).toBe('avivco.il');
    expect(displayHost('avivco.il')).toBe('avivco.il');
    expect(displayHost('  http://www.avivco.il  ')).toBe('avivco.il');
  });
});
