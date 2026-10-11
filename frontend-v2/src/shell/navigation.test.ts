import { describe, expect, it } from 'vitest';

import { isCurrentHrefChild, PRIMARY_NAVIGATION, SETTINGS_NAVIGATION } from './navigation';

const current = (pathname: string, id: string) => {
  const parent = [...PRIMARY_NAVIGATION, SETTINGS_NAVIGATION].find((item) => item.id === id)!;
  const children = parent.children ?? [];
  return children.filter((c) => isCurrentHrefChild(pathname, c, children)).map((c) => c.id);
};

describe('★★ the rail marks one place, not two', () => {
  it.each([
    ['/outreach', ['campaigns']],
    ['/outreach/campaigns/b1', ['campaigns']],
    ['/outreach/calls', ['calls']],
    ['/outreach/templates', ['templates']],
  ])('%s → %j', (pathname, ids) => {
    expect(current(pathname, 'outreach')).toEqual(ids);
  });

  // Every destination, so a nesting added later is held to the same rule.
  const pages = [...PRIMARY_NAVIGATION, SETTINGS_NAVIGATION].flatMap((item) =>
    (item.children ?? []).filter((c) => c.href).map((c) => [c.href!, item.id] as const),
  );
  it.each(pages)('%s marks exactly itself', (href, id) => {
    const parent = [...PRIMARY_NAVIGATION, SETTINGS_NAVIGATION].find((item) => item.id === id)!;
    const marked = current(href, id);
    expect(marked).toHaveLength(1);
    expect(parent.children!.find((c) => c.id === marked[0])!.href).toBe(href);
  });
});

describe('★★ the inbox rail has one view for what GOTCHA handles, not two (Omer, 2026-10-11)', () => {
  it('★★ "AI managed" and "Flow managed" are gone, "Handled by GOTCHA" is in their place', () => {
    /*
     * The same ids as `INBOX_VIEW_IDS` (less `all`, reached by links): a rail
     * view the page does not know falls back to the queue under its own name.
     */
    const inbox = PRIMARY_NAVIGATION.find((item) => item.id === 'inbox')!;
    expect(inbox.children!.map((child) => [child.view, child.labelKey])).toEqual([
      ['queue', 'inbox.queue'],
      ['mine', 'inbox.mine'],
      ['active', 'inbox.active'],
      ['gotcha', 'inbox.gotcha'],
      ['resolved', 'inbox.resolved'],
    ]);
  });
});

describe('★★ a bare /inbox is "Assigned to me" (Omer, 2026-10-11)', () => {
  it('the rail lights "Assigned to me" when no view is named', () => {
    const inbox = PRIMARY_NAVIGATION.find((item) => item.id === 'inbox');
    expect(inbox?.href).toBe('/inbox');
    // Mirrors inbox-views' DEFAULT_INBOX_VIEW, which the shell may not import.
    expect(inbox?.defaultView).toBe('mine');
  });
});
