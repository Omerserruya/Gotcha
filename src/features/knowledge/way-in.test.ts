import { describe, expect, it, vi } from 'vitest';

import { knowledgeSourceSchema } from '@/api/contracts/knowledge';

vi.mock('next-intl/server', () => ({}));
vi.mock('./ResolveConflict', () => ({ ResolveConflict: () => null }));

import { groupByWayIn, wayIn } from './KnowledgeScreen';

const source = (id: string, types: string[]) =>
  knowledgeSourceSchema.parse({
    id,
    documents: types.map((sourceType, i) => ({ id: `${id}-${i}`, sourceType })),
  });

describe('★ how a source came in — the writers’ own sourceType', () => {
  it('maps each written value to its way in', () => {
    expect(
      [
        'url',
        'onboarding_scan',
        'file',
        'text',
        'google_drive',
        'drive',
        'confluence',
        'historical_conversations',
        'readiness_answer',
      ].map((type) => wayIn(source('s', [type]))),
    ).toEqual([
      'website',
      'website',
      'uploaded',
      'uploaded',
      'drive',
      'drive',
      'confluence',
      'conversations',
      'answers',
    ]);
  });

  it('★ an unknown value is "other", never a guess; mixed documents are "mixed"', () => {
    expect(wayIn(source('a', ['ad']))).toBe('other');
    expect(wayIn(source('b', []))).toBe('other');
    expect(wayIn(source('c', ['url', 'file']))).toBe('mixed');
    expect(wayIn(source('d', ['file', 'text']))).toBe('uploaded');
  });

  it('groups in 02’s order and leaves out empty groups', () => {
    const groups = groupByWayIn([source('x', ['file']), source('y', ['onboarding_scan'])]);
    expect(groups.map((g) => g.way)).toEqual(['website', 'uploaded']);
  });
});
