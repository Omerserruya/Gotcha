import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { NewAutomation } from '@/features/automations/create/NewAutomation';
import { PageContainer } from '@/shell/PageContainer';

vi.mock('@/features/automations/load-automations', () => ({ loadAutomations: async () => [] }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
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

describe('★ 21 - New automation opens by query', () => {
  it('only with ?create=1', async () => {
    expect(find(await page(), NewAutomation)).toBeNull();
    expect(find(await page({ create: '1' }), NewAutomation)).not.toBeNull();
  });

  it('the header action is a link to it', async () => {
    const actions = find<{ actions: ReactElement<{ href?: unknown; 'data-testid'?: string }> }>(
      await page(),
      PageContainer,
    )?.actions;
    expect(actions?.props['data-testid']).toBe('create-automation');
    expect(actions?.props.href).toEqual({
      pathname: '/studio/automations',
      query: { create: '1' },
    });
  });
});
