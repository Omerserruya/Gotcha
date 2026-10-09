import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { permissionDefSchema } from '@/api/contracts/permission-catalog';
import en from '@/i18n/messages/en/roles.json';
import he from '@/i18n/messages/he/roles.json';

import { areaName, permissionDescription, permissionName } from './permission-words';

/**
 * ★ A1 of the 14" Hebrew sweep: the catalogue is English only, and a Hebrew
 * page printed "Reply to conversations" under a Hebrew heading. The names
 * come from the role grid's own words, which already say every row and action.
 */
const words = (locale: 'en' | 'he') => {
  const t = createTranslator({
    locale,
    messages: { roles: locale === 'en' ? en : he },
    namespace: 'roles',
  });
  return {
    word: (key: string) => (t.has(key as never) ? t(key as never) : null),
    join: (row: string, action: string) => t('catalog.permissionName', { row, action }),
  };
};
const perm = (key: string, displayName: string, description = '') => {
  const [feature, subFeature, action] = key.split(':');
  return permissionDefSchema.parse({
    key,
    domain: feature,
    feature,
    subFeature,
    action,
    displayName,
    description,
  });
};

describe('★ A1 - a permission is named in the reader’s language', () => {
  it('★ Hebrew: the grid’s row and action, never the platform’s English', () => {
    const { word, join } = words('he');
    expect(
      permissionName(
        perm('conversation:messages:reply', 'Reply to conversations'),
        'he',
        word,
        join,
      ),
    ).toBe('שיחות · מענה');
  });

  it('English keeps the platform’s own name', () => {
    const { word, join } = words('en');
    expect(
      permissionName(
        perm('conversation:messages:reply', 'Reply to conversations'),
        'en',
        word,
        join,
      ),
    ).toBe('Reply to conversations');
  });

  it('a key the grid has no words for keeps the platform’s name, never a code', () => {
    const { word, join } = words('he');
    expect(permissionName(perm('warehouse:stock:count', 'Count stock'), 'he', word, join)).toBe(
      'Count stock',
    );
    expect(permissionName(perm('warehouse:stock:count', ''), 'he', word, join)).toBe(
      'warehouse:stock:count',
    );
  });

  it('★ the English description is not printed under a Hebrew name', () => {
    const p = perm('conversation:messages:reply', 'Reply', 'Send replies in any conversation');
    expect(permissionDescription(p, 'he')).toBeNull();
    expect(permissionDescription(p, 'en')).toBe('Send replies in any conversation');
  });

  it('★ an area: Hebrew from the grid; English keeps the catalogue’s heading', () => {
    const he_ = words('he');
    const en_ = words('en');
    expect(areaName('conversation', 'he', he_.word, 'Conversation')).toBe('תיבה');
    // The grid's English areas are screen names ("Studio" for `ai`); not used here.
    expect(areaName('ai', 'en', en_.word, 'AI')).toBe('AI');
    expect(areaName('warehouse', 'he', he_.word, 'Warehouse')).toBe('Warehouse');
  });
});
