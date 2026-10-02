import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type * as LoadApprovals from '@/features/approvals/load-approvals';

const loadApprovals = vi.hoisted(() => vi.fn());
vi.mock('@/features/approvals/load-approvals', async (original) => ({
  ...(await original<typeof LoadApprovals>()),
  loadApprovals,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

import { DecisionStats } from '@/features/approvals/NothingWaiting';
import { PageContainer } from '@/shell/PageContainer';

/*
 * 03c's page-level wiring: the STATE is the title, and 02's figures sit in
 * the header. The components are tested on their own; this is the join.
 */
const propsOf = <T,>(tree: ReactNode, type: unknown): T | null => {
  let found: T | null = null;
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    const element = node as ReactElement<{ children?: ReactNode }>;
    if (element.type === type) found = element.props as T;
    visit(element.props.children);
  };
  visit(tree);
  return found;
};

const emptyQueue = async () => {
  loadApprovals.mockResolvedValue({
    pending: [],
    decided: [],
    decidedMayBeIncomplete: false,
    aiEmployees: [],
    readAt: '2026-09-20T09:00:00.000Z',
  });
  const { default: Page } = await import('./page');
  return Page();
};

describe('★★ 03c — nothing waiting', () => {
  it('★★ the title is the state, not the page’s name', async () => {
    const props = propsOf<{ title: string; layout: string }>(await emptyQueue(), PageContainer);
    expect(props?.title).toBe('rest.title');
    expect(props?.layout).toBe('screen');
  });

  it('★ and 02’s figures are in the header', async () => {
    const props = propsOf<{ actions: ReactNode }>(await emptyQueue(), PageContainer);
    expect(propsOf(props?.actions, DecisionStats)).not.toBeNull();
  });
});
