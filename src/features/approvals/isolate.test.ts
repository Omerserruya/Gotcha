import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import he from '@/i18n/messages/he/approvals.json';

import { isolated } from './isolate';
import { reasonKeyOf } from './reason-words';

describe('★★ Hebrew: a name and an order number keep their own direction (measured on dev)', () => {
  it('each value between FSI and PDI; an ICU sentinel and an empty value left bare', () => {
    expect(isolated({ name: 'Matan Amran', order: '#TEST-1842', pick: 'none', blank: '' })).toEqual(
      {
        name: '⁨Matan Amran⁩',
        order: '⁨#TEST-1842⁩',
        pick: 'none',
        blank: '',
      },
    );
  });

  it('the Hebrew sentence carries the name isolated, so "ל" cannot swallow it', () => {
    const t = createTranslator({
      locale: 'he',
      messages: { approvals: he },
      namespace: 'approvals',
    });
    const said = t('decided.sentence.refunded', isolated({ amount: '50 ₪', name: 'Matan Amran' }));
    // A maqaf, then the isolated name.
    expect(said).toContain('ל־⁨Matan Amran⁩');
    expect(said).toContain('⁨50 ₪⁩');
  });
});

describe('★ a rejection reason in the reader’s language - when it was one of ours', () => {
  it('our labels, from either catalogue, map back to their key; anyone’s own words do not', () => {
    expect(reasonKeyOf('Outside policy')).toBe('policy');
    expect(reasonKeyOf(he.action2.reasons.policy)).toBe('policy');
    expect(reasonKeyOf(' wrong order ')).toBe('wrongOrder');
    expect(reasonKeyOf('Too generous')).toBe('tooGenerous');
    // Measured on dev: the platform's own words stay as written.
    expect(reasonKeyOf('not eligible under policy')).toBeNull();
  });
});

describe('★ Hebrew catalogues: a prefix letter never glued to a placeholder', () => {
  it('ל ב מ ש כ before {…} take a maqaf - "ל־{name}", never "ל{name}"', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = 'src/i18n/messages/he';
    const glued = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) =>
        (readFileSync(`${dir}/${f}`, 'utf8').match(/(^|[ "(])[לבמשכ]\{[a-zA-Z]+/g) ?? []).map(
          (hit) => `${f}: ${hit.trim()}`,
        ),
      );
    expect(glued).toEqual([]);
  });
});
