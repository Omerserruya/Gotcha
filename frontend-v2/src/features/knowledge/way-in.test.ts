import { describe, expect, it, vi } from 'vitest';

import { knowledgeSourceSchema } from '@/api/contracts/knowledge';

vi.mock('next-intl/server', () => ({}));
vi.mock('./ResolveConflict', () => ({ ResolveConflict: () => null }));
vi.mock('@/i18n/navigation', () => ({ Link: () => null }));

import { groupByWayIn, wayIn } from './KnowledgeScreen';

const source = (id: string, types: string[]) =>
  knowledgeSourceSchema.parse({
    id,
    documents: types.map((sourceType, i) => ({ id: `${id}-${i}`, sourceType })),
  });

describe('★ how a source came in - the writers’ own sourceType', () => {
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

  it('★ a crawled page (`url_text`) is the website, with the scan summary and a hand-added page', () => {
    expect(wayIn(source('e', ['url_text']))).toBe('website');
    expect(wayIn(source('f', ['url_text', 'onboarding_scan', 'url']))).toBe('website');
  });

  it('groups in 02’s order and leaves out empty groups', () => {
    const groups = groupByWayIn([source('x', ['file']), source('y', ['onboarding_scan'])]);
    expect(groups.map((g) => g.way)).toEqual(['website', 'uploaded']);
  });
});
