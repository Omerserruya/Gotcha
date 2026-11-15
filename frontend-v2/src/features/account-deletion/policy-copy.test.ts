import { describe, expect, it } from 'vitest';

import en from '@/i18n/messages/en/auth.json';
import he from '@/i18n/messages/he/auth.json';

/**
 * The deletion policy Omer approved (2026-11-15), as the public page says it.
 * Play reviews this page: a placeholder must never ship again, and each line
 * keeps the fact it exists to state.
 */
describe.each([
  ['en', en],
  ['he', he],
] as const)('★★ the account-deletion policy, %s', (_locale, messages) => {
  const policy = messages.accountDeletion.policy;
  const cancel = messages.accountDeletion.confirm.done.cancel;
  const all = JSON.stringify(messages.accountDeletion);

  it('★★ no placeholder left anywhere in the flow', () => {
    expect(all).not.toMatch(/pending confirmation|ממתין לאישור|TODO|TBD/i);
  });

  it('★ the facts: workspace-wide for a sole member, 7 years of invoices, 90 days of backups, one month', () => {
    expect(policy.deleted).toMatch(/workspace|סביבת העבודה/);
    expect(policy.kept).toContain('7');
    expect(policy.kept).toContain('90');
    expect(policy.timing).toMatch(/one month|חודש/);
  });

  it('★ how to cancel: the privacy address', () => {
    expect(cancel).toContain('privacy@gotcha.co.il');
  });

  it('★ no em or en dash', () => {
    // Escaped, so this file holds no dash itself (no-dashes.test.ts reads every file).
    expect(all).not.toMatch(new RegExp('[\\u2013\\u2014]'));
  });
});
