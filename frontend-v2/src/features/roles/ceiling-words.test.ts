import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import en from '@/i18n/messages/en/roles.json';
import he from '@/i18n/messages/he/roles.json';

import { ceilingSentence, isCeilingReason } from './ceiling-words';

const say = (locale: 'en' | 'he', refusal: Parameters<typeof ceilingSentence>[0]) => {
  const t = createTranslator({
    locale,
    messages: { roles: locale === 'en' ? en : he },
    namespace: 'roles',
  });
  const format = createFormatter({ locale, timeZone: 'Asia/Jerusalem' });
  return ceilingSentence(refusal, t as never, (items) =>
    format.list(items, { type: 'conjunction' }),
  );
};

describe('★★ a refusal from the grant ceiling, in a sentence (auth 679b8812)', () => {
  it('ABOVE_OWN_ROLE names the missing permissions in the role grid’s words', () => {
    const refusal = {
      reason: 'above_own_role' as const,
      missing: ['crm:contacts:update', 'customer:commerce:refund'],
    };
    const english = say('en', refusal);
    expect(english).toMatch(/^You can't give permissions you don't hold yourself: /);
    expect(english).toContain(`${en.form.row['crm:contacts']} · ${en.form.action.update}`);
    expect(english).toContain(`${en.form.row['customer:commerce']} · ${en.form.action.refund}`);
    expect(english).not.toMatch(/crm:contacts|customer:commerce/);
    const hebrew = say('he', refusal);
    expect(hebrew).toContain(`${he.form.row['crm:contacts']} · ${he.form.action.update}`);
    expect(hebrew).not.toMatch(/[a-z]+:[a-z]+/);
  });

  it('one key the grid has no words for: a sentence naming none - never a code', () => {
    const refusal = {
      reason: 'above_own_role' as const,
      missing: ['crm:contacts:update', 'billing:invoices:frobnicate'],
    };
    expect(say('en', refusal)).toBe(en.ceiling.aboveOwnUnnamed);
    expect(say('he', refusal)).toBe(he.ceiling.aboveOwnUnnamed);
    // No keys at all (a legacy feature, or none sent): the same.
    expect(say('en', { reason: 'above_own_role', missing: [] })).toBe(en.ceiling.aboveOwnUnnamed);
    expect(say('en', { reason: 'above_own_role', missing: ['billing.refund'] })).toBe(
      en.ceiling.aboveOwnUnnamed,
    );
  });

  it('OWNER_ONLY', () => {
    expect(say('en', { reason: 'owner_only' })).toBe(en.ceiling.ownerOnly);
    expect(say('he', { reason: 'owner_only' })).toBe(he.ceiling.ownerOnly);
  });

  it('only the two ceiling reasons are taken for one', () => {
    expect(isCeilingReason({ reason: 'owner_only' })).toBe(true);
    expect(isCeilingReason({ reason: 'above_own_role' })).toBe(true);
    expect(isCeilingReason({ reason: 'forbidden' })).toBe(false);
  });
});
