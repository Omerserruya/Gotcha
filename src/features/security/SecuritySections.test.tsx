import { render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { auditEntrySchema } from '@/api/contracts/security';
import security from '@/i18n/messages/en/security.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'security') =>
    createTranslator({ locale: 'en', messages: { security }, namespace }),
  getLocale: async () => 'en',
}));

import { AuditSection } from './SecuritySections';

const entry = (id: string, over: Record<string, unknown>) =>
  auditEntrySchema.parse({
    id,
    actorType: 'ai',
    action: 'ai.paused_for_approval',
    createdAt: new Date().toISOString(),
    ...over,
  });

const show = async (entries: ReturnType<typeof entry>[]) =>
  render(await AuditSection({ entries, available: true, facets: [], facetsTruncated: false }));

describe('★ 16 - an audit row is time · what happened · its kind', () => {
  it('a failure says "Failure"; otherwise who did it', async () => {
    await show([
      entry('a', {}),
      entry('b', { actorType: 'user' }),
      entry('c', { action: 'adapter.err.shopify.process_refund' }),
    ]);
    expect(screen.getByTestId('audit-kind-a')).toHaveTextContent(/^By GOTCHA$/);
    expect(screen.getByTestId('audit-kind-b')).toHaveTextContent(/^By a person$/);
    expect(screen.getByTestId('audit-kind-c')).toHaveTextContent(/^Failure$/);
  });

  it('an actor nobody named gets no word - never a missing-message key', async () => {
    await show([entry('x', { actorType: 'webhook' })]);
    expect(screen.getByTestId('audit-kind-x')).toBeEmptyDOMElement();
  });

  it('today’s row carries the clock; an older one, the date', async () => {
    await show([entry('t', { createdAt: '2026-01-05T09:41:00' }), entry('n', {})]);
    expect(screen.getByTestId('audit-t').querySelector('time')).toHaveTextContent(/2026/);
    expect(screen.getByTestId('audit-n').querySelector('time')).not.toHaveTextContent(/2026|,/);
  });
});

describe('★ 16 - the audit card’s head is 02’s', () => {
  const facet = (action: string, count: number) => ({ action, count });

  it('"All" first and dark, four facets in the rows’ words, the rest under More', async () => {
    render(
      await AuditSection({
        entries: [entry('a', {})],
        available: true,
        facets: [
          facet('adapter.err.shopify.get_customer_by_phone', 1411),
          facet('ai.bot_turn', 207),
          facet('ai.paused_for_approval', 20),
          facet('message.sent', 9),
          facet('ai.responded', 3),
        ],
        facetsTruncated: false,
      }),
    );
    const head = screen.getByTestId('audit-facets');
    const chips = [...head.children].filter((el) => el.tagName === 'SPAN');
    expect(chips).toHaveLength(5);
    expect(chips[0]).toHaveTextContent(/^All$/);
    expect(chips[0]).toHaveAttribute('data-current', 'yes');
    // The count is on the title, never in the chip; no machine strings.
    expect(head).not.toHaveTextContent(/1411|adapter|\w\.\w/);
    expect(chips[1]).toHaveAttribute('title', expect.stringContaining('1,411 times'));
    expect(screen.getByTestId('audit-facets-more')).toBeInTheDocument();
  });

  it('Export is drawn and is not live - whether or not the log could be read', async () => {
    render(
      await AuditSection({ entries: [], available: false, facets: [], facetsTruncated: false }),
    );
    const exp = screen.getByText('Export');
    expect(exp).toHaveAttribute('aria-disabled', 'true');
    expect(exp.closest('a,button')).toBeNull();
  });

  it('yesterday’s row says "Yesterday"', async () => {
    const y = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await show([entry('y', { createdAt: y })]);
    expect(screen.getByTestId('audit-y').querySelector('time')).toHaveTextContent(/^Yesterday$/);
  });
});

describe('★ 16 corrections (measurement of 9aeb1a7)', () => {
  it('a tool’s worked and failed halves are ONE chip; the failures ride on its title', async () => {
    render(
      await AuditSection({
        entries: [entry('a', {})],
        available: true,
        facets: [
          { action: 'adapter.err.shopify.get_customer_by_phone', count: 1411 },
          { action: 'adapter.ok.shopify.get_customer_by_phone', count: 1081 },
        ],
        facetsTruncated: false,
      }),
    );
    const chips = screen.getAllByText('Looked up by phone');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveAttribute('title', '2,492 times · 1,411 didn’t work'.replace('’', "'"));
  });

  it.each([
    [
      'adapter.err.shopify.get_customer_by_phone',
      'ai',
      'GOTCHA looked up customer by phone in Shopify',
    ],
    ['adapter.ok.shopify.process_refund', 'ai', 'GOTCHA processed refund in Shopify'],
    ['adapter.ok.shopify.get_shop', 'ai', 'GOTCHA looked up shop in Shopify'],
    ['ai.paused_for_approval', 'ai', 'GOTCHA paused and asked for approval'],
    [
      'billing.provisioning_request_created',
      'user',
      'Someone on your team asked for billing to be set up',
    ],
    ['some.new_thing', 'webhook', 'Something · Some new thing'],
  ])('%s by %s → "%s"', async (action, actorType, sentence) => {
    await show([entry('s', { action, actorType })]);
    expect(within(screen.getByTestId('audit-s')).getByText(sentence)).toBeInTheDocument();
  });
});

describe('★ 16 - chips in the rows’ words, short (measurement of f6f4564)', () => {
  it.each([
    ['adapter.ok.shopify.get_customer_by_phone', 'Looked up by phone'],
    ['adapter.ok.shopify.search_products', 'Searched products'],
    ['adapter.ok.shopify.get_customer', 'Looked up customer'],
    ['adapter.ok.shopify.get_customer_orders', 'Looked up orders'],
    ['ai.responded', 'AI replies'],
    ['billing.provisioning_failed', 'Billing setup'],
  ])('%s → "%s"', async (action, label) => {
    render(
      await AuditSection({
        entries: [entry('a', {})],
        available: true,
        facets: [{ action, count: 3 }],
        facetsTruncated: false,
      }),
    );
    expect(within(screen.getByTestId('audit-facets')).getByText(label)).toBeInTheDocument();
  });
});
