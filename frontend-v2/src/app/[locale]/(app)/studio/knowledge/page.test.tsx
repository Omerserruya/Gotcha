import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AddKnowledge } from '@/features/knowledge/add/AddKnowledge';
import { FocusSection } from '@/features/knowledge/FocusSection';
import { KnowledgeScreen } from '@/features/knowledge/KnowledgeScreen';
import { ScanPanel } from '@/features/knowledge/ScanPanel';
import { DocumentDrawer, DocumentTypeLead } from '@/features/knowledge/DocumentDrawer';
import { Drawer } from '@/shell/Drawer';

const sources = vi.hoisted(() => ({ value: [] as unknown[] | null }));
vi.mock('@/features/knowledge/load-knowledge', () => ({
  loadKnowledge: async () => ({
    sources: sources.value,
    unanswered: [],
    conflicts: [],
    everImported: false,
  }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getFormatter: async () => ({ list: (items: string[]) => items.join(', ') }),
}));
/* The workspace read the rescan needs: answered, or failed (`null`). */
const facts = vi.hoisted(() => ({ value: { websiteDomain: 'urban-supply.example' } as unknown }));
vi.mock('@/features/workspace/load-workspace', () => ({
  loadWorkspaceFacts: async () => facts.value,
}));
vi.mock('@/features/knowledge/ScanPanel', () => ({ ScanPanel: () => null }));
/* K6: the item's read is a spy - its own outcomes have their own tests. */
const loadDoc = vi.hoisted(() => vi.fn());
vi.mock('@/features/knowledge/load-document', () => ({ loadKnowledgeDocument: loadDoc }));
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

describe('★ 08b - Add knowledge opens by query', () => {
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

  it('★★ the read failed: unknown - never "none", which would make a second base', async () => {
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

describe('★ /studio/knowledge?section=gaps - the assistant links to the unanswered questions', () => {
  it('focuses the gaps section; without it, nothing moves', async () => {
    expect(find<{ testid: string }>(await page({ section: 'gaps' }), FocusSection)?.testid).toBe(
      'gaps-section',
    );
    expect(find(await page(), FocusSection)).toBeNull();
    expect(find(await page({ section: 'other' }), FocusSection)).toBeNull();
  });
});

describe('★ "Scan again" lives here now - moved from Settings · Workspace (Omer, 2026-10-11)', () => {
  const rescanOf = async () =>
    find<{ rescan: ReactNode }>(await page(), KnowledgeScreen)?.rescan ?? null;

  it('handed to the screen with the website the workspace read names', async () => {
    facts.value = { websiteDomain: 'urban-supply.example' };
    const rescan = await rescanOf();
    expect(isValidElement(rescan)).toBe(true);
    expect((rescan as ReactElement).type).toBe(ScanPanel);
    expect((rescan as ReactElement<{ domain: string | null }>).props.domain).toBe(
      'urban-supply.example',
    );
  });

  it('no website on file: still drawn, naming none', async () => {
    facts.value = { websiteDomain: null };
    expect((await rescanOf()) as ReactElement<{ domain: string | null }>).toHaveProperty(
      'props.domain',
      null,
    );
  });

  it('★ the gate it had on Workspace: the workspace read failed, no rescan', async () => {
    facts.value = null;
    expect(await rescanOf()).toBeNull();
    facts.value = { websiteDomain: 'urban-supply.example' };
  });
});

describe('★★ K6 - ?doc=<id> opens that item’s drawer', () => {
  const listed = [{ id: 'kb-1', isActive: true, documents: [{ id: 'd1' }] }];

  it('reads the item from the list just read, and draws its title as the user’s text', async () => {
    sources.value = listed;
    loadDoc.mockReset();
    loadDoc.mockResolvedValueOnce({ state: 'ok', document: { id: 'd1', title: 'Terms' } });
    const tree = await page({ doc: 'd1' });
    expect(loadDoc).toHaveBeenCalledWith(listed, 'd1');
    const drawer = find<{ title: string; userTitle?: boolean; closeHref: string; testId: string }>(
      tree,
      Drawer,
    );
    expect(drawer).toMatchObject({
      title: 'Terms',
      userTitle: true,
      closeHref: '/studio/knowledge',
      testId: 'knowledge-doc-drawer',
    });
    expect(find<{ read: unknown }>(tree, DocumentDrawer)?.read).toEqual({
      state: 'ok',
      document: { id: 'd1', title: 'Terms' },
    });
    sources.value = [];
  });

  it('★ a refusal still opens the drawer - with our title and its sentence', async () => {
    loadDoc.mockReset();
    loadDoc.mockResolvedValueOnce({ state: 'forbidden' });
    const tree = await page({ doc: 'd1' });
    expect(find<{ title: string; userTitle?: boolean }>(tree, Drawer)).toMatchObject({
      title: 'doc.title',
      userTitle: false,
    });
    expect(find<{ read: unknown }>(tree, DocumentDrawer)?.read).toEqual({ state: 'forbidden' });
  });

  it('★ K8: the head starts with the item’s kind - its own type; a refusal, none', async () => {
    sources.value = listed;
    loadDoc.mockReset();
    loadDoc.mockResolvedValueOnce({
      state: 'ok',
      document: { id: 'd1', title: 'Terms', type: 'google_drive' },
    });
    const lead = find<{ lead?: ReactElement<{ type?: string }> }>(
      await page({ doc: 'd1' }),
      Drawer,
    )?.lead;
    expect(lead?.type).toBe(DocumentTypeLead);
    expect(lead?.props.type).toBe('google_drive');
    loadDoc.mockResolvedValueOnce({ state: 'forbidden' });
    expect(find(await page({ doc: 'd1' }), DocumentTypeLead)).toBeNull();
    sources.value = [];
  });

  it('no ?doc, or the Add sheet open: no drawer, and nothing is read', async () => {
    loadDoc.mockReset();
    expect(find(await page(), Drawer)).toBeNull();
    expect(find(await page({ add: '1', doc: 'd1' }), Drawer)).toBeNull();
    expect(loadDoc).not.toHaveBeenCalled();
  });
});
