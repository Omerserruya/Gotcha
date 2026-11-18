import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';

/**
 * ★★ /system/ai-failures: behind the console door; the filters are the
 * address; a failed read is never "nothing failed"; the latest rows carry
 * the tenant's name and the conversation's id to copy.
 */
const { door, load } = vi.hoisted(() => ({
  door: { open: true },
  load: { loadAiFailures: vi.fn(), loadTenantNames: vi.fn(), loadAiAlertCount: vi.fn() },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/shell/require-console', () => ({
  requireConsole: async () => {
    if (!door.open) throw new Error('NEXT_NOT_FOUND');
    return 'open' as const;
  },
}));
vi.mock('@/features/console/load-ai-failures', () => load);
vi.mock('@/features/console/AiFailures', () => ({
  AiFailures: ({
    data,
    filters,
    names,
  }: {
    data: { total: number };
    filters: unknown;
    names: Map<string, string>;
  }) => (
    <div
      data-testid="ai-failures"
      data-total={data.total}
      data-filters={JSON.stringify(filters)}
      data-names={names.size}
    />
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'console.aiFailures') =>
    createTranslator({ locale: 'en', messages: { console: consoleEn }, namespace }),
  getFormatter: async () => ({
    dateTime: () => '18/11/2026, 09:12',
    number: (n: number) => String(n),
  }),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ),
}));

const { default: Page } = await import('./page');

const T = consoleEn.aiFailures;

const open = async (params: Record<string, string> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      {await Page({ searchParams: Promise.resolve(params) })}
    </NextIntlClientProvider>,
  );

const data = {
  hours: 24,
  total: 3,
  groups: [
    {
      tool: 'woocommerce.get_order',
      errorCode: 'timeout',
      count: 2,
      tenants: 2,
      lastAt: '2026-11-18T07:12:00Z',
    },
    {
      tool: 'shopify.search',
      errorCode: null,
      count: 1,
      tenants: 1,
      lastAt: '2026-11-18T06:00:00Z',
    },
  ],
  recent: [
    {
      id: 'a1',
      tenantId: 'tn1',
      conversationId: 'conv-1',
      at: '2026-11-18T07:12:00Z',
      tool: 'woocommerce.get_order',
      errorCode: 'timeout',
      argsSummary: 'order 1042',
      ms: 15000,
    },
    {
      id: 'a2',
      tenantId: 'tn-gone',
      conversationId: null,
      at: '2026-11-18T06:00:00Z',
      tool: 'shopify.search',
      errorCode: null,
      argsSummary: '',
      ms: null,
    },
  ],
};

beforeEach(() => {
  door.open = true;
  for (const fn of Object.values(load)) fn.mockReset();
  load.loadTenantNames.mockResolvedValue(
    new Map([
      ['tn1', 'Bloom Shop'],
      ['tn2', 'Avi Store'],
    ]),
  );
});

describe('★★ /system/ai-failures', () => {
  it('★ behind the console door: nothing is read without it', async () => {
    door.open = false;
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(load.loadAiFailures).not.toHaveBeenCalled();
  });

  it('★ the filters come from the address; an hour the route does not offer is the default', async () => {
    load.loadAiFailures.mockResolvedValue(data);
    await open({ hours: '6', tenantId: ' tn1 ', tool: 'shopify.search' });
    expect(load.loadAiFailures).toHaveBeenCalledWith({
      hours: 6,
      tenantId: 'tn1',
      tool: 'shopify.search',
    });
    load.loadAiFailures.mockClear();
    await open({ hours: '99999' });
    expect(load.loadAiFailures).toHaveBeenCalledWith({ hours: 24, tenantId: '', tool: '' });
  });

  it('the read and the names go to the screen', async () => {
    load.loadAiFailures.mockResolvedValue(data);
    await open({ tool: 'shopify.search' });
    const screenStub = screen.getByTestId('ai-failures');
    expect(screenStub).toHaveAttribute('data-total', '3');
    expect(screenStub).toHaveAttribute('data-names', '2');
    expect(JSON.parse(screenStub.getAttribute('data-filters')!)).toEqual({
      hours: 24,
      tenantId: '',
      tool: 'shopify.search',
    });
  });

  it('★ a failed read says so, never "nothing failed"', async () => {
    load.loadAiFailures.mockResolvedValue(null);
    await open();
    expect(screen.getByTestId('ai-failures-unread')).toHaveTextContent(T.unread);
    expect(screen.queryByTestId('ai-failures-none')).toBeNull();
  });
});
