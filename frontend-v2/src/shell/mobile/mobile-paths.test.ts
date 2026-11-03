import { describe, expect, it } from 'vitest';

import { inMobileOverlay } from './mobile-paths';

describe('inMobileOverlay', () => {
  it('a thing open over its list hides the tabs', () => {
    for (const path of ['/m/inbox/c1', '/m/approvals/a1/', '/m/outreach/o1', '/m/customers/p1']) {
      expect(inMobileOverlay(path)).toBe(true);
    }
  });

  it('★ the customer screen over a conversation hides them too', () => {
    expect(inMobileOverlay('/m/inbox/c1/customer')).toBe(true);
    expect(inMobileOverlay('/m/inbox/c1/customer/')).toBe(true);
  });

  it('the lists keep them, and nothing else deeper counts', () => {
    for (const path of ['/m/inbox', '/m/home', '/m/customers/p1/customer', '/m/inbox/c1/other']) {
      expect(inMobileOverlay(path)).toBe(false);
    }
  });
});
