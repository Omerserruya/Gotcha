import { describe, expect, it } from 'vitest';

import { destinations, matching } from './command-palette-model';

describe('★ 19 - the screens GO TO offers are the rail’s, under its permission check', () => {
  it('everything, for someone who may see everything', () => {
    const hrefs = destinations(() => true).map((d) => d.href);
    expect(hrefs).toContain('/home');
    expect(hrefs).toContain('/inbox?view=mine');
    expect(hrefs).toContain('/studio/knowledge');
    expect(hrefs).toContain('/settings/channels');
  });

  it('a child is labelled under its parent', () => {
    const knowledge = destinations(() => true).find((d) => d.href === '/studio/knowledge');
    expect(knowledge?.labelKeys).toEqual(['primary.studio', 'studio.knowledge']);
  });

  it('★ nothing the rail would hide', () => {
    const hrefs = destinations((permission) => permission === undefined).map((d) => d.href);
    expect(hrefs).toContain('/home');
    expect(hrefs).not.toContain('/inbox');
    expect(hrefs).not.toContain('/studio/knowledge');
  });

  it('no destination twice', () => {
    const hrefs = destinations(() => true).map((d) => d.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('matching', () => {
  const items = [{ label: 'Studio · Knowledge' }, { label: 'Settings · Channels' }];
  it('every word, any order, any case', () => {
    expect(matching(items, 'knowledge studio')).toEqual([items[0]]);
    expect(matching(items, 'CHAN')).toEqual([items[1]]);
    expect(matching(items, 'refund dana')).toEqual([]);
    // EVERY word: one matching and one not is no match.
    expect(matching(items, 'knowledge channels')).toEqual([]);
    expect(matching(items, '  ')).toEqual(items);
  });
});
