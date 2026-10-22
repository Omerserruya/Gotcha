import { describe, expect, it } from 'vitest';

import { setupLinkReason } from './reasons';

describe('?reason= on the setup-link landing', () => {
  it('each reason services/auth sends is read as itself', () => {
    /*
     * Written out from the backend (setup-link.ts:130, :145, :164 and
     * `SetupLinkRejection`), not read from the list under test: a reason
     * dropped there must fail here, not shrink this loop with it.
     */
    for (const reason of ['expired', 'revoked', 'invalid', 'identity_missing', 'idp_unavailable']) {
      expect(setupLinkReason(reason)).toBe(reason);
    }
  });

  it('none, an unknown one or a repeated one reads as expired, as in the legacy page', () => {
    for (const raw of [undefined, '', 'nope', ['expired', 'revoked']]) {
      expect(setupLinkReason(raw)).toBe('expired');
    }
  });
});
