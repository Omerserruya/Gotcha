import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { AiFailures as AiFailuresData } from '@/api/contracts/ai-failures';
import consoleEn from '@/i18n/messages/en/console.json';

/**
 * ★★ The AI failures screen: the filters as a GET over the address, the
 * groups, and the latest rows with the tenant's name and the id to copy.
 */
vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'console.aiFailures') =>
    createTranslator({ locale: 'en', messages: { console: consoleEn }, namespace }),
  getFormatter: async () => ({
    dateTime: () => '18/11/2026, 09:12',
    number: (n: number) => String(n),
  }),
}));

const { AiFailures } = await import('./AiFailures');

const T = consoleEn.aiFailures;

const data: AiFailuresData = {
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
    { tool: 'shopify.search', errorCode: null, count: 1, tenants: 1, lastAt: null },
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

const names = new Map([
  ['tn2', 'Avi Store'],
  ['tn1', 'Bloom Shop'],
]);

async function show(
  over: Partial<AiFailuresData> = {},
  filters = { hours: 24, tenantId: '', tool: '' },
) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      {await AiFailures({ data: { ...data, ...over }, filters, names })}
    </NextIntlClientProvider>,
  );
}

describe('★★ AiFailures', () => {
  it('the filter form is a GET over the address, with the current values selected', async () => {
    await show({}, { hours: 72, tenantId: 'tn1', tool: '' });
    const form = screen.getByTestId('ai-failures-filters');
    expect(form).toHaveAttribute('method', 'get');
    expect(within(form).getByRole('combobox', { name: T.filters.hours })).toHaveValue('72');
    const tenant = within(form).getByRole('combobox', { name: T.filters.tenant });
    expect(tenant).toHaveValue('tn1');
    // Tenants by name, "All" first.
    expect([...tenant.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      T.filters.all,
      'Avi Store',
      'Bloom Shop',
    ]);
    const tools = within(form).getByRole('combobox', { name: T.filters.tool });
    expect([...tools.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      T.filters.all,
      'shopify.search',
      'woocommerce.get_order',
    ]);
  });

  it('★ a filtered tenant no longer listed is still an option, by its id', async () => {
    await show({}, { hours: 24, tenantId: 'tn-gone', tool: '' });
    expect(screen.getByRole('combobox', { name: T.filters.tenant })).toHaveValue('tn-gone');
  });

  it('★★ the groups: tool, error, times, tenants, last seen; no code reads as such', async () => {
    await show();
    expect(screen.getByTestId('ai-failure-group-woocommerce.get_order-timeout')).toHaveTextContent(
      'woocommerce.get_ordertimeout2218/11/2026, 09:12',
    );
    const none = screen.getByTestId('ai-failure-group-shopify.search-none');
    expect(none).toHaveTextContent(T.noCode);
    expect(none).toHaveTextContent('-');
  });

  it('★★ the latest rows: the tenant’s name, the id to copy, "-" for what is missing', async () => {
    await show();
    const first = screen.getByTestId('ai-failure-a1');
    expect(first).toHaveTextContent('Bloom Shop');
    expect(first).toHaveTextContent('order 1042');
    expect(first).toHaveTextContent('15000');
    expect(screen.getByTestId('ai-failure-conversation-a1')).toHaveTextContent('conv-1');
    expect(screen.getByTestId('ai-failure-conversation-a1-copy')).toHaveAccessibleName(
      'Copy conversation id conv-1',
    );
    const second = screen.getByTestId('ai-failure-a2');
    expect(second).toHaveTextContent('tn-gone');
    expect(second).not.toHaveTextContent('Bloom Shop');
    expect(screen.queryByTestId('ai-failure-conversation-a2-copy')).toBeNull();
  });

  it('★ Copy puts the id on the clipboard and says so; a refusal says that', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    writeText.mockResolvedValueOnce(undefined);
    await show();
    await user.click(screen.getByTestId('ai-failure-conversation-a1-copy'));
    expect(writeText).toHaveBeenCalledWith('conv-1');
    expect(await screen.findByRole('status')).toHaveTextContent(T.copy.copied);
    writeText.mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByTestId('ai-failure-conversation-a1-copy'));
    expect(await screen.findByText(T.copy.refused)).toBeInTheDocument();
  });

  it('★ nothing failed: one sentence, no tables', async () => {
    await show({ hours: 6, total: 0, groups: [], recent: [] });
    expect(screen.getByTestId('ai-failures-none')).toHaveTextContent(
      'No action failed in the last 6 hours.',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });
});
