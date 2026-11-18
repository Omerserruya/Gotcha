import { describe, expect, it } from 'vitest';

import {
  answerOptions,
  byOccurrences,
  choiceMissing,
  choiceTooLong,
  importTopicsOf,
  initialChoice,
  itemAnswer,
  pendingByOccurrences,
  topicItemSchema,
  topicsResponseSchema,
  type ImportTopic,
} from './import-topics';

/**
 * ★★ 13f by topic: the contract is lenient per element, and the rules of
 * what an approve sends live here, where the card and its tests share them.
 */

const item = (over: Record<string, unknown> = {}) => ({
  candidateId: 'c1',
  status: 'PENDING',
  question: 'How long is delivery?',
  answer: '3 days',
  quotes: [],
  chosen: null,
  previous: null,
  unresolved: false,
  variants: [],
  ...over,
});

const topic = (over: Record<string, unknown> = {}) => ({
  topicId: 't1',
  label: 'Delivery',
  status: 'pending',
  occurrences: 5,
  customers: 4,
  lastSeenAt: '2026-11-12T10:00:00Z',
  conflict: false,
  docConflict: false,
  items: [item()],
  ...over,
});

const read = (raw: unknown) => importTopicsOf(topicsResponseSchema.parse(raw));

describe('★★ the topics read is lenient per element', () => {
  it('reads topics, items and the server’s progress', () => {
    const got = read({ topics: [topic()], progress: { total: 3, done: 1 } });
    expect(got.topics).toHaveLength(1);
    expect(got.topics[0]!.items[0]!.answer).toBe('3 days');
    expect(got.progress).toEqual({ total: 3, done: 1 });
    expect(got.dropped).toBe(0);
  });

  it('★ one odd topic and one odd item are dropped and counted, never the response', () => {
    const got = read({
      topics: [
        topic(),
        topic({ topicId: 't2', status: 'archived' }),
        { label: 'no id' },
        topic({ topicId: 't3', items: [item(), { candidateId: 'c9' }] }),
      ],
    });
    expect(got.topics.map((t) => t.topicId)).toEqual(['t1', 't3']);
    expect(got.topics[1]!.items).toHaveLength(1);
    expect(got.dropped).toBe(3);
  });

  it('a topic with no item left is not drawn', () => {
    expect(read({ topics: [topic({ items: [] })] }).topics).toEqual([]);
  });

  it('★ absent, null and odd optional fields read as nothing, not as a failure', () => {
    const got = read({
      topics: [
        topic({
          items: [
            {
              candidateId: 'c1',
              question: 'q',
              answer: 'a',
              chosen: 'yes',
              variants: null,
              unresolved: 'maybe',
            },
          ],
          occurrences: null,
          lastSeenAt: undefined,
        }),
      ],
    });
    const only = got.topics[0]!;
    expect(only.occurrences).toBe(0);
    expect(only.items[0]).toMatchObject({
      status: 'superseded',
      chosen: null,
      previous: null,
      unresolved: false,
      variants: [],
      quotes: [],
    });
    expect(got.progress).toBeNull();
  });

  it('no topics key is an empty read', () => {
    expect(read({}).topics).toEqual([]);
  });

  it('a chosen value that is a number reads as its text', () => {
    const parsed = topicItemSchema.parse(
      item({ chosen: { value: 449, basis: 'latest', at: '2026-11-12' } }),
    );
    expect(parsed.chosen).toEqual({ value: '449', basis: 'latest', at: '2026-11-12' });
  });
});

describe('★★ an item’s status is the database’s, in capitals', () => {
  it.each([
    ['PENDING', 'pending'],
    ['APPROVED', 'approved'],
    ['REJECTED', 'rejected'],
    ['SUPERSEDED', 'superseded'],
    ['pending', 'pending'],
  ])('%s reads as %s', (raw, want) => {
    expect(topicItemSchema.parse(item({ status: raw })).status).toBe(want);
  });

  it('★ an unknown or missing status is never offered for a decision', () => {
    expect(topicItemSchema.parse(item({ status: 'ARCHIVED' })).status).toBe('superseded');
    expect(topicItemSchema.parse(item({ status: undefined })).status).toBe('superseded');
  });
});

describe('★★ the document conflict and the auto count (0559643c), optional until a rerun', () => {
  it('reads an item’s document and sentence, trimmed; blank is none', () => {
    const parsed = topicItemSchema.parse(
      item({
        docConflict: { documentId: 'd1', document: ' Shipping ', passage: '', note: 'x' },
      }),
    );
    expect(parsed.docConflict).toEqual({ documentId: 'd1', document: 'Shipping', passage: null });
  });

  it.each([undefined, null, 'yes', { document: 3 }])(
    '★ absent or odd (%j) is none, never a failure',
    (v) => {
      const parsed = topicItemSchema.parse(item({ docConflict: v }));
      expect(parsed.docConflict === null || parsed.docConflict.document === null).toBe(true);
    },
  );

  it('the top-level count is read when sent, null when not', () => {
    expect(read({ topics: [], autoApprovable: 7 }).autoApprovable).toBe(7);
    expect(read({ topics: [] }).autoApprovable).toBeNull();
  });

  it('byOccurrences takes one status, the most-asked first', () => {
    const topics = [
      { topicId: 'a', status: 'rejected', occurrences: 2 },
      { topicId: 'b', status: 'pending', occurrences: 9 },
      { topicId: 'c', status: 'rejected', occurrences: 8 },
    ] as unknown as ImportTopic[];
    expect(byOccurrences(topics, 'rejected').map((t) => t.topicId)).toEqual(['c', 'a']);
  });
});

describe('★★ the order: pending only, the most-asked first', () => {
  it('sorts by occurrences, the server’s order breaking ties', () => {
    const topics = [
      { topicId: 'a', status: 'pending', occurrences: 2 },
      { topicId: 'b', status: 'approved', occurrences: 99 },
      { topicId: 'c', status: 'pending', occurrences: 7 },
      { topicId: 'd', status: 'pending', occurrences: 2 },
      { topicId: 'e', status: 'auto', occurrences: 50 },
    ] as unknown as ImportTopic[];
    expect(pendingByOccurrences(topics).map((t) => t.topicId)).toEqual(['c', 'a', 'd']);
  });
});

describe('★★ the answers to choose from, and what an approve sends', () => {
  const parsed = (over: Record<string, unknown>) => topicItemSchema.parse(item(over));

  it('the suggestion first, then each variant once - the same words are never two radios', () => {
    const it1 = parsed({
      answer: ' 3 days ',
      variants: [{ answer: '3 days' }, { answer: '5 days' }, { answer: ' 5 days' }, { answer: '' }],
    });
    expect(answerOptions(it1)).toEqual(['3 days', '5 days']);
  });

  it('an undisputed item starts on the suggestion; an unresolved one on nothing', () => {
    expect(initialChoice({ unresolved: false, options: ['a'] })).toEqual({
      kind: 'option',
      index: 0,
    });
    expect(initialChoice({ unresolved: true, options: ['a', 'b'] })).toBeNull();
  });

  it('nothing chosen, or "אחר" left empty, still needs the reviewer', () => {
    expect(choiceMissing(null)).toBe(true);
    expect(choiceMissing({ kind: 'other', text: '  ' })).toBe(true);
    expect(choiceMissing({ kind: 'other', text: 'x' })).toBe(false);
    expect(choiceMissing({ kind: 'option', index: 1 })).toBe(false);
  });

  it('"אחר" over 4000 characters is too long; at 4000 it is not', () => {
    expect(choiceTooLong({ kind: 'other', text: 'x'.repeat(4000) })).toBe(false);
    expect(choiceTooLong({ kind: 'other', text: 'x'.repeat(4001) })).toBe(true);
    expect(choiceTooLong({ kind: 'option', index: 0 })).toBe(false);
  });

  const plain = { candidateId: 'c1', unresolved: false, options: ['3 days', '5 days'] };

  it('★ the suggestion sends nothing: a plain approve', () => {
    expect(itemAnswer(plain, { kind: 'option', index: 0 })).toBeNull();
  });

  it('★ a variant sends its text', () => {
    expect(itemAnswer(plain, { kind: 'option', index: 1 })).toEqual({
      candidateId: 'c1',
      answer: '5 days',
    });
  });

  it('★ "אחר" sends its trimmed text, and typed back to the suggestion it is plain', () => {
    expect(itemAnswer(plain, { kind: 'other', text: '  4 days ' })).toEqual({
      candidateId: 'c1',
      answer: '4 days',
    });
    expect(itemAnswer(plain, { kind: 'other', text: ' 3 days ' })).toBeNull();
  });

  it('★ an unresolved item always sends the answer chosen, even the first', () => {
    const open = { ...plain, unresolved: true };
    expect(itemAnswer(open, { kind: 'option', index: 0 })).toEqual({
      candidateId: 'c1',
      answer: '3 days',
    });
    expect(itemAnswer(open, null)).toBeNull();
  });
});
