import { describe, expect, it } from 'vitest';

import { liveSearch, SEARCH_MAX, searchQuery } from './inbox-search';

describe('the phone inbox search', () => {
  it('★ typing searches from two characters, and an empty field is the whole list', () => {
    expect(liveSearch('d', '')).toBeNull();
    expect(liveSearch('da', '')).toBe('da');
    expect(liveSearch('', 'dana')).toBe('');
    expect(liveSearch('   ', 'dana')).toBe('');
  });

  it('★ a key that changes nothing after trimming sends nothing (no stale re-read)', () => {
    expect(liveSearch('dana ', 'dana')).toBeNull();
    expect(liveSearch('', '')).toBeNull();
  });

  it('one letter after a search keeps the list it has rather than reading half the workspace', () => {
    expect(liveSearch('d', 'da')).toBeNull();
  });

  it('a query is trimmed and cut at 80 characters, typed or sent with Enter', () => {
    const long = 'x'.repeat(200);
    expect(searchQuery(`  ${long}`)).toHaveLength(SEARCH_MAX);
    expect(liveSearch(long, '')).toHaveLength(SEARCH_MAX);
    expect(searchQuery(' a ')).toBe('a');
  });
});
