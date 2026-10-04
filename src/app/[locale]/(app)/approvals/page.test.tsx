import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type * as LoadApprovals from '@/features/approvals/load-approvals';

const loadApprovals = vi.hoisted(() => vi.fn());
vi.mock('@/features/approvals/approval-customers', () => ({
  loadApprovalCustomers: async () => ({}),
}));
vi.mock('@/features/approvals/load-approvals', async (original) => ({
  ...(await original<typeof LoadApprovals>()),
  loadApprovals,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

import { DecisionStats, HandledCard, NothingWaiting } from '@/features/approvals/NothingWaiting';
import { ApprovalsScreen } from '@/features/approvals/ApprovalsScreen';
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
    usageToday: null,
    customerNames: {},
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
      usageToday: null,
      customerNames: {},
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
      usageToday: null,
      customerNames: {},
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

describe('★★ 03c — what GOTCHA handled leads, and the subline says only what is true', () => {
  const rest = async (over: Record<string, unknown>) => {
    loadApprovals.mockResolvedValue({
      pending: [],
      decided: [],
      decidedMayBeIncomplete: false,
      aiEmployees: [],
      usageToday: null,
      customerNames: {},
      readAt: Date.parse('2026-10-04T12:00:00.000Z'),
      ...over,
    });
    const { default: Page } = await import('./page');
    return Page();
  };

  it('a quiet day: "Nothing needs a decision from you."', async () => {
    const tree = await rest({ usageToday: [] });
    expect(propsOf<{ description: string }>(tree, PageContainer)?.description).toBe('rest.lead');
    expect(propsOf<{ handled: unknown }>(tree, HandledCard)?.handled).toEqual({
      total: 0,
      refunds: 0,
      lookups: 0,
      returns: 0,
    });
  });

  it('something ran on its own today: "inside the limits you set"', async () => {
    const tree = await rest({
      usageToday: [
        { toolName: 'shopify.get_order', executionCount: 3, successCount: 3, refusedCount: 0 },
      ],
    });
    expect(propsOf<{ description: string }>(tree, PageContainer)?.description).toBe('rest.busy');
  });

  it('usage unread: the card in its shape, and no claim about the day', async () => {
    const tree = await rest({ usageToday: null });
    expect(propsOf<{ handled: unknown }>(tree, HandledCard)?.handled).toBeNull();
    expect(propsOf<{ description: string }>(tree, PageContainer)?.description).toBe('rest.lead');
  });
});

describe('★ "Requested by Support AI" — named only where one employee could have asked', () => {
  const ask = async (aiEmployees: unknown[]) => {
    loadApprovals.mockResolvedValue({
      pending: [
        {
          id: 'p1',
          summary: 'x',
          tool: 'shopify.process_refund',
          requestedBy: 'ai-bot:chat',
          expiresAt: '2026-10-04T12:00:00.000Z',
          createdAt: '2026-10-04T09:00:00.000Z',
          riskTags: [],
        },
      ],
      decided: [],
      decidedMayBeIncomplete: false,
      aiEmployees,
      usageToday: null,
      customerNames: {},
      refundLimit: null,
      readAt: Date.parse('2026-10-04T10:00:00.000Z'),
    });
    const { default: Page } = await import('./page');
    return propsOf<{ requesterNames: Record<string, string>; aiAsked: string[] }>(
      await Page(),
      ApprovalsScreen,
    );
  };

  it('one AI employee: it is the one who asked', async () => {
    const props = await ask([{ id: 'ai1', name: 'Support AI', status: 'ACTIVE' }]);
    expect(props?.requesterNames.p1).toBe('Support AI');
    expect(props?.aiAsked).toEqual([]);
  });

  it('two: no guess — "your AI employee"', async () => {
    const props = await ask([
      { id: 'ai1', name: 'Support AI', status: 'ACTIVE' },
      { id: 'ai2', name: 'Sales AI', status: 'ACTIVE' },
    ]);
    expect(props?.requesterNames.p1).toBeUndefined();
    expect(props?.aiAsked).toEqual(['p1']);
  });
});
