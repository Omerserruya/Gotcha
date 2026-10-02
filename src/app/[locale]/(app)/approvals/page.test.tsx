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

import { DecisionStats, NothingWaiting } from '@/features/approvals/NothingWaiting';
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

  it('★★ and it is a window: the header stays, the decisions scroll inside their card', async () => {
    const props = propsOf<{ fill?: boolean }>(await emptyQueue(), PageContainer);
    expect(props?.fill).toBe(true);
  });

  it('★ and 02’s figures are in the header', async () => {
    const props = propsOf<{ actions: ReactNode }>(await emptyQueue(), PageContainer);
    expect(propsOf(props?.actions, DecisionStats)).not.toBeNull();
  });
});

describe('★★ 03 — things need your decision', () => {
  const withPending = async () => {
    const at = Date.parse('2026-09-19T10:00:00.000Z');
    loadApprovals.mockResolvedValue({
      pending: [
        {
          id: 'a',
          summary: 'x',
          tool: 't',
          expiresAt: '2026-09-19T10:38:00.000Z',
          createdAt: '2026-09-19T09:00:00.000Z',
          riskTags: [],
          requestedBy: 'bot',
        },
        {
          id: 'b',
          summary: 'y',
          tool: 't',
          expiresAt: '2026-09-19T12:00:00.000Z',
          createdAt: '2026-09-19T09:00:00.000Z',
          riskTags: [],
          requestedBy: 'bot',
        },
      ],
      decided: [],
      decidedMayBeIncomplete: false,
      aiEmployees: [],
      readAt: at,
    });
    const { default: Page } = await import('./page');
    return Page();
  };

  it('★★ the title is how many need you, and the subline the soonest deadline', async () => {
    const props = propsOf<{ title: string; description: string; flush?: boolean }>(
      await withPending(),
      PageContainer,
    );
    expect(props?.title).toBe('pending.title');
    expect(props?.description).toBe('pending.soonest');
    // The queue runs to the panel's edges.
    expect(props?.flush).toBe(true);
  });
});

describe('★ the history is reachable while items are pending — `?view=decided`', () => {
  it('shows the decisions card, titled as the history, with the way back', async () => {
    loadApprovals.mockResolvedValue({
      pending: [
        {
          id: 'a',
          summary: 'x',
          tool: 't',
          expiresAt: '2026-09-19T12:00:00.000Z',
          createdAt: '2026-09-19T09:00:00.000Z',
          riskTags: [],
          requestedBy: 'bot',
        },
      ],
      decided: [],
      decidedMayBeIncomplete: false,
      aiEmployees: [],
      readAt: Date.parse('2026-09-19T10:00:00.000Z'),
    });
    const { default: Page } = await import('./page');
    const tree = await Page({ searchParams: Promise.resolve({ view: 'decided' }) });
    const props = propsOf<{ title: string; fill?: boolean }>(tree, PageContainer);
    expect(props?.title).toBe('decided.heading');
    expect(props?.fill).toBe(true);
    expect(propsOf(tree, NothingWaiting)).not.toBeNull();
  });
});
