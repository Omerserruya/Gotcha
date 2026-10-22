import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { humaniseCode } from '@/api/contracts/capabilities';
import en from '@/i18n/messages/en/capabilities.json';
import he from '@/i18n/messages/he/capabilities.json';

import { SYSTEM_CATEGORIES, systemCategoryName } from './system-category';

const t = (locale: 'en' | 'he') =>
  createTranslator({
    locale,
    messages: { capabilities: locale === 'en' ? en : he },
    namespace: 'capabilities',
  });

describe('★ a system’s category in the reader’s language (measured on dev: English on /he)', () => {
  it('the platform’s eleven, said in Hebrew', () => {
    expect(systemCategoryName('ECOMMERCE', t('he'))).toBe('חנות אונליין');
    expect(systemCategoryName('DATABASE', t('he'))).toBe('מסד נתונים');
    expect(systemCategoryName('PROJECT_MANAGEMENT', t('en'))).toBe('Project management');
  });

  it('English says what it said before - the platform’s code, humanised', () => {
    for (const code of SYSTEM_CATEGORIES) {
      expect(systemCategoryName(code, t('en'))).toBe(humaniseCode(code));
    }
  });

  it('every category has words in both languages - and no more than those', () => {
    for (const messages of [en, he]) {
      expect(Object.keys(messages.systemCategory).sort()).toEqual([...SYSTEM_CATEGORIES].sort());
    }
  });

  it('one added later is still said, in the platform’s words - never dropped, never raw', () => {
    expect(systemCategoryName('LOYALTY_PROGRAMS', t('he'))).toBe('Loyalty programs');
  });
});
