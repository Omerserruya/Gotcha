import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AddKnowledge } from '@/features/knowledge/add/AddKnowledge';

const sources = vi.hoisted(() => ({ value: [] as unknown[] | null }));
vi.mock('@/features/knowledge/load-knowledge', () => ({
  loadKnowledge: async () => ({
    sources: sources.value,
    unanswered: [],
    conflicts: [],
    conflictsScannedAt: null,
    everImported: false,
  }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getFormatter: async () => ({ list: (items: string[]) => items.join(', ') }),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

function find<P>(node: ReactNode, type: unknown): P | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find<P>(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, ReactNode>>;
  if (element.type === type) return element.props as P;
  for (const value of Object.values(element.props ?? {})) {
    const hit = find<P>(value as ReactNode, type);
    if (hit) return hit;
  }
  return null;
}

const page = async (query: Record<string, string> = {}) => {
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(query) });
};

describe('★ 08b — Add knowledge opens by query', () => {
  it('not without ?add=1', async () => {
    expect(find(await page(), AddKnowledge)).toBeNull();
  });

  it('?add=1&way=drive opens on Drive; an unknown way falls back to the first', async () => {
    expect(
      find<{ initialWay?: string }>(await page({ add: '1', way: 'drive' }), AddKnowledge)
        ?.initialWay,
    ).toBe('drive');
    const fallback = find<{ initialWay?: string }>(
      await page({ add: '1', way: 'catalogue' }),
      AddKnowledge,
    );
    expect(fallback).not.toBeNull();
    expect(fallback?.initialWay).toBeUndefined();
  });

  it('the header action is a link to it', async () => {
    const tree = await page();
    const actions = find<{ actions: ReactElement<{ href?: unknown; 'data-testid'?: string }> }>(
      tree,
      (await import('@/shell/PageContainer')).PageContainer,
    )?.actions;
    expect(actions?.props['data-testid']).toBe('add-knowledge');
    expect(actions?.props.href).toEqual({ pathname: '/studio/knowledge', query: { add: '1' } });
  });
});

describe('★★ where an added source goes', () => {
  const base = async () => find<{ base: unknown }>(await page({ add: '1' }), AddKnowledge)?.base;

  it('the newest active base (the route lists newest first)', async () => {
    sources.value = [
      { id: 'kb-old-off', isActive: false, documents: [] },
      { id: 'kb-new', isActive: true, documents: [] },
      { id: 'kb-older', isActive: true, documents: [] },
    ];
    expect(await base()).toEqual({ id: 'kb-new' });
  });

  it('none yet: one is made when something is added', async () => {
    sources.value = [];
    expect(await base()).toBe('none');
  });

  it('★★ the read failed: unknown — never "none", which would make a second base', async () => {
    sources.value = null;
    expect(await base()).toBe('unknown');
    sources.value = [];
  });
});

describe('★★ the way back from Google or Atlassian opens the sheet on its card', () => {
  const props = async (query: Record<string, string>) =>
    find<{ initialWay?: string; landing: unknown }>(
      await page({ add: '1', ...query }),
      AddKnowledge,
    );

  it.each([
    [
      { way: 'drive', connected: '1' },
      'drive',
      { connector: 'google_drive', outcome: 'connected' },
    ],
    [
      { way: 'confluence', error: 'denied' },
      'drive',
      { connector: 'confluence', outcome: 'denied' },
    ],
    [
      { way: 'confluence', error: 'made_up' },
      'drive',
      { connector: 'confluence', outcome: 'other' },
    ],
    [{ way: 'drive' }, 'drive', null],
    [{ way: 'page', connected: '1' }, 'page', null],
  ])('%o', async (query, way, landing) => {
    const p = await props(query);
    expect(p?.initialWay).toBe(way);
    expect(p?.landing).toEqual(landing);
  });
});
