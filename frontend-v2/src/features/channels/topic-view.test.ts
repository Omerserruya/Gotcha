import { describe, expect, it } from 'vitest';

import { topicItemSchema, type ImportTopic } from '@/api/contracts/import-topics';
import he from '@/i18n/messages/he/channels.json';

import { chosenLineOf, monthYear, topicView, validDate, type TopicWords } from './topic-view';

/**
 * ★★ The chosen-value line and the topic's line, written on the server in
 * Omer's words: "נבחר: 449 ₪ (התשובה העדכנית, 12.11) · קודם: 350 ₪ (עד 06.2026)".
 */

const T = he.whatsapp.topics as unknown as Record<string, unknown>;

/** A tiny ICU stand-in: `{name}` and the plural's `other` with `#`. */
function t(key: string, values: Record<string, string | number> = {}): string {
  const message = key.split('.').reduce<unknown>((m, k) => (m as Record<string, unknown>)[k], T);
  if (typeof message !== 'string') throw new Error(`no message ${key}`);
  return message
    .replace(
      /\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
      (_m, name: string, one, other) =>
        (values[name] === 1 ? one : other).replace('#', String(values[name])),
    )
    .replace(/\{(\w+)(?:, number)?\}/g, (_m, name: string) => String(values[name]));
}

const dayFormat = new Intl.DateTimeFormat('he', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Asia/Jerusalem',
});
const monthFormat = new Intl.DateTimeFormat('he', {
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Asia/Jerusalem',
});
const w: TopicWords = {
  t,
  day: (iso) => {
    const d = validDate(iso);
    return d ? dayFormat.format(d) : null;
  },
  month: (iso) => {
    const d = validDate(iso);
    return d ? monthYear(monthFormat, d) : null;
  },
};

const item = (over: Record<string, unknown>) =>
  topicItemSchema.parse({
    candidateId: 'c1',
    status: 'PENDING',
    question: 'q',
    answer: 'a',
    ...over,
  });

describe('★★ the chosen-value line', () => {
  it('★ the latest answer with its day, and the one before with its month', () => {
    const line = chosenLineOf(
      item({
        chosen: { value: '449 ₪', basis: 'latest', at: '2026-11-12T08:00:00Z' },
        previous: { value: '350 ₪', until: '2026-06-30T12:00:00Z' },
      }),
      w,
    );
    expect(line).toBe('נבחר: 449 ₪ (התשובה העדכנית, 12.11) · קודם: 350 ₪ (עד 06.2026)');
  });

  it('"לפי התקנון" for a value the policy decides', () => {
    expect(chosenLineOf(item({ chosen: { value: '14 ימים', basis: 'policy' } }), w)).toBe(
      'נבחר: 14 ימים (לפי התקנון)',
    );
  });

  it('a date that is not one is left out, never "Invalid Date"', () => {
    expect(
      chosenLineOf(
        item({
          chosen: { value: '449', basis: 'latest', at: 'soon' },
          previous: { value: '350', until: null },
        }),
        w,
      ),
    ).toBe('נבחר: 449 (התשובה העדכנית) · קודם: 350');
  });

  it('no chosen value, no line', () => {
    expect(chosenLineOf(item({}), w)).toBeNull();
    expect(chosenLineOf(item({ chosen: { value: '  ', basis: 'policy' } }), w)).toBeNull();
  });
});

describe('★ the topic’s line and its items', () => {
  const topic = (over: Partial<ImportTopic>): ImportTopic => ({
    topicId: 't1',
    label: 'משלוחים',
    status: 'pending',
    occurrences: 12,
    customers: 1,
    lastSeenAt: '2026-11-12T08:00:00Z',
    conflict: false,
    docConflict: false,
    items: [
      item({
        answer: '3 ימים',
        variants: [{ answer: '5 ימים', lastSeenAt: '2026-10-01T08:00:00Z' }],
        quotes: [
          { question: 'a', answer: 'b' },
          { question: 'c', answer: 'd' },
          { question: 'e', answer: 'f' },
        ],
      }),
    ],
    ...over,
  });

  it('chats, customers and when last seen; a figure of 0 is not drawn', () => {
    expect(topicView(topic({}), w).meta).toBe('12 שיחות · לקוח אחד · נראה לאחרונה 12.11');
    expect(topicView(topic({ occurrences: 0, customers: 0, lastSeenAt: null }), w).meta).toBe('');
  });

  it('★ the chip follows any item that names its document; the conversations are carried', () => {
    const plain = topicView(topic({}), w);
    expect(plain.docConflict).toBe(false);
    expect(plain.occurrences).toBe(12);
    expect(plain.items[0]!.docConflict).toBeNull();
    const named = topicView(
      topic({
        items: [item({ docConflict: { document: 'תקנון', passage: '14 ימים' } })],
      }),
      w,
    );
    expect(named.docConflict).toBe(true);
    expect(named.items[0]!.docConflict).toEqual({ document: 'תקנון', passage: '14 ימים' });
  });

  it('each option with when it was last said, and at most two quotes', () => {
    const view = topicView(topic({}), w).items[0]!;
    expect(view.options).toEqual(['3 ימים', '5 ימים']);
    expect(view.optionSeen).toEqual([null, '01.10']);
    expect(view.quotes).toHaveLength(2);
  });
});

describe('★ monthYear: two digits for the month, the locale’s own separator', () => {
  it.each([
    ['he', '06.2026'],
    ['en', '06/2026'],
  ])('%s', (locale, want) => {
    const format = new Intl.DateTimeFormat(locale, {
      month: '2-digit',
      year: 'numeric',
      timeZone: 'Asia/Jerusalem',
    });
    expect(monthYear(format, new Date('2026-06-30T12:00:00Z'))).toBe(want);
  });
});
