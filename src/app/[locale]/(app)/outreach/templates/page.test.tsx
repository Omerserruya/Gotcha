import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { templateSchema } from '@/api/contracts/templates';
import {
  RejectedCard,
  TemplatePreview,
  TemplateTable,
  WorthKnowing,
} from '@/features/outreach/TemplateList';

const loadTemplates = vi.hoisted(() => vi.fn());
vi.mock('@/features/outreach/load-templates', () => ({ loadTemplates }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

/** Structural, as the other screens' page tests are: what is mounted, with what. */
const find = <T,>(tree: ReactNode, type: unknown): T | null => {
  let found: T | null = null;
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    if (node.type === type) found = node.props as T;
    visit((node as ReactElement<{ children?: ReactNode }>).props.children);
  };
  visit(tree);
  return found;
};

const page = async (template?: string) => {
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(template ? { template } : {}) });
};

const row = (id: string, name: string) => templateSchema.parse({ id, name, status: 'APPROVED' });

beforeEach(() => {
  loadTemplates.mockReset();
});

describe('★★ 05c — the table, the preview, the rejection, worth knowing', () => {
  it('★ ?template= picks the preview, and the table marks the same row', async () => {
    loadTemplates.mockResolvedValue({ templates: [row('a', 'One'), row('b', 'Two')], total: 2 });
    const tree = await page('b');
    expect(find<{ group: { name: string } }>(tree, TemplatePreview)?.group.name).toBe('Two');
    expect(find<{ selectedId: string }>(tree, TemplateTable)?.selectedId).toBe('b');
    expect(find(tree, RejectedCard)).not.toBeNull();
    expect(find(tree, WorthKnowing)).not.toBeNull();
  });

  it('without one, the first', async () => {
    loadTemplates.mockResolvedValue({ templates: [row('a', 'One'), row('b', 'Two')], total: 2 });
    expect(find<{ selectedId: string }>(await page(), TemplateTable)?.selectedId).toBe('a');
  });

  it('⚠ a failed read still draws the frame: the table says so, the column keeps its cards', async () => {
    loadTemplates.mockResolvedValue({ templates: null, total: 0 });
    const tree = await page();
    expect(find<{ groups: unknown }>(tree, TemplateTable)?.groups).toBeNull();
    expect(find<{ group: unknown }>(tree, TemplatePreview)?.group).toBeNull();
    expect(find(tree, WorthKnowing)).not.toBeNull();
  });
});
