import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { approvalFacts, approvalSchema } from '@/api/contracts/approvals';
import { toolUsageSchema } from '@/api/contracts/capabilities';
import messages from '@/i18n/messages/en/approvals.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { approvals: messages },
      namespace: namespace as 'approvals',
    }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

import { decisionSentence } from './decision-sentence';
import { handledToday } from './handled';
import { DecisionStats, HandledCard, NothingWaiting } from './NothingWaiting';

const NOW = new Date(2026, 9, 4, 15, 0);
const TODAY = new Date(2026, 9, 4, 9, 30).toISOString();
const YESTERDAY = new Date(2026, 9, 3, 9, 30).toISOString();

const usage = (toolName: string, successCount: number) =>
  toolUsageSchema.parse({ toolName, executionCount: successCount + 1, successCount });
const approved = (tool: string, decidedAt: string, executionState = 'SUCCEEDED') =>
  approvalSchema.parse({
    id: `${tool}-${decidedAt}`,
    tool,
    summary: 's',
    status: 'APPROVED',
    executionState,
    decidedAt,
    expiresAt: decidedAt,
    createdAt: decidedAt,
  });

describe('★★ handled without asking you — counted, never invented', () => {
  it('today’s successful runs, less the ones you approved today that ran', () => {
    const handled = handledToday(
      [
        usage('shopify.process_refund', 5),
        usage('shopify.get_order', 9),
        usage('shopify.create_return', 2),
      ],
      [
        approved('shopify.process_refund', TODAY),
        // Bare and prefixed names are one tool.
        approved('process_refund', TODAY),
        // Yesterday's, and one that failed, did not run today on your say-so.
        approved('shopify.process_refund', YESTERDAY),
        approved('shopify.process_refund', TODAY, 'FAILED'),
      ],
      NOW,
    );
    expect(handled).toEqual({ total: 14, refunds: 3, lookups: 9, returns: 2 });
  });

  it('never below zero; without either read, unknown — not zero', () => {
    expect(
      handledToday([usage('cancel_order', 0)], [approved('cancel_order', TODAY)], NOW)?.total,
    ).toBe(0);
    expect(handledToday(null, [], NOW)).toBeNull();
    expect(handledToday([], null, NOW)).toBeNull();
  });
});

describe('★★ 02’s sentence, from what the record knows', () => {
  const row = (tool: string, status: string, params: unknown) =>
    approvalSchema.parse({
      id: 'a',
      tool,
      summary: 'Process refund of 50 for order #1011',
      status,
      params,
      expiresAt: TODAY,
      createdAt: TODAY,
    });
  it.each([
    [
      'shopify.process_refund',
      'APPROVED',
      { amount: 179, order_name: '#1' },
      'Dana Cohen',
      '179',
      'refunded',
    ],
    [
      'shopify.process_refund',
      'APPROVED',
      { amount: 50, order_name: '#1011' },
      null,
      '50',
      'refundedOn',
    ],
    ['shopify.process_refund', 'APPROVED', { order_name: '#1016' }, null, null, 'refundedOrder'],
    ['shopify.process_refund', 'REJECTED', { amount: 600 }, 'Adi Katz', '600', 'refundAsked'],
    ['shopify.cancel_order', 'APPROVED', { order_name: '#4812' }, 'Rotem Shani', null, 'cancelled'],
    ['shopify.cancel_order', 'REJECTED', { order_name: '#4812' }, null, null, 'cancelAskedOrder'],
    ['shopify.send_invoice', 'APPROVED', {}, 'Noa Gil', null, 'withName'],
    ['shopify.send_invoice', 'APPROVED', {}, null, null, 'none'],
  ] as const)('%s %s → %s', (tool, status, params, name, amount, key) => {
    expect(decisionSentence(row(tool, status, params), name, amount).key).toBe(key);
  });

  it('the facts: an order, an amount, a currency only when the call named one', () => {
    expect(approvalFacts({ order_name: '#1011', amount: '50' })).toEqual({
      order: '#1011',
      amount: 50,
      currency: null,
    });
    expect(approvalFacts({ amount: 179, currency: 'ILS' }).currency).toBe('ILS');
    expect(approvalFacts({ amount: 'lots', currency: 'shekels' })).toEqual({
      order: null,
      amount: null,
      currency: null,
    });
    // And the parameters themselves never leave the contract.
    expect(
      Object.keys(
        approvalSchema.parse({
          id: 'a',
          tool: 't',
          summary: 's',
          params: { secret: 1 },
          expiresAt: TODAY,
          createdAt: TODAY,
        }),
      ),
    ).not.toContain('params');
  });
});

describe('★★ the dark card in its three states', () => {
  it('unread: in its shape, every figure "—"', async () => {
    render(await HandledCard({ handled: null }));
    expect(screen.getByTestId('handled-unread')).toHaveTextContent('—');
    expect(screen.getByTestId('handled-refunds')).toHaveTextContent('Refunds—');
  });

  it('nothing today: said, not a zero', async () => {
    render(await HandledCard({ handled: { total: 0, refunds: 0, lookups: 0, returns: 0 } }));
    expect(screen.getByTestId('handled-none')).toHaveTextContent('Nothing ran on its own today.');
    expect(screen.queryByTestId('handled-total')).toBeNull();
  });

  it('a count and its three figures — and no value nobody recorded', async () => {
    render(await HandledCard({ handled: { total: 31, refunds: 18, lookups: 9, returns: 4 } }));
    expect(screen.getByTestId('handled-total')).toHaveTextContent('31actions');
    expect(screen.getByTestId('handled-today')).not.toHaveTextContent(/₪|value/);
    expect(screen.getByTestId('handled-lookups')).toHaveTextContent('Orders looked up9');
  });
});

describe('★★ 03c’s rows: when, the sentence with the customer, how it ended', () => {
  const refund = (id: string, decidedAt: string) =>
    approvalSchema.parse({
      id,
      tool: 'shopify.process_refund',
      summary: 'ai-bot inbox tool call',
      status: 'APPROVED',
      executionState: 'SUCCEEDED',
      params: { amount: 179, order_name: '#1011' },
      decidedAt,
      expiresAt: decidedAt,
      createdAt: decidedAt,
    });

  it('a time today, "Yesterday", then a date; the customer named from the conversation', async () => {
    render(
      await NothingWaiting({
        decided: [
          refund('a1', TODAY),
          refund('a2', YESTERDAY),
          refund('a3', new Date(2026, 8, 20).toISOString()),
        ],
        mayBeIncomplete: false,
        requesterNames: {},
        customerNames: { a1: 'Dana Cohen' },
        now: NOW,
      }),
    );
    expect(screen.getByTestId('decided-a1')).toHaveTextContent('Refunded 179 to Dana Cohen');
    // No name: the order instead — never "to undefined".
    expect(screen.getByTestId('decided-a2')).toHaveTextContent('Refunded 179 on order #1011');
    expect(screen.getByTestId('when-a2')).toHaveTextContent('Yesterday');
    expect(screen.getByTestId('when-a3')).toHaveTextContent('Sep 20');
    expect(screen.getByTestId('when-a1').textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(screen.getByTestId('decided-today')).toHaveTextContent('1 today');
    // A reason is kept; nothing claims it teaches.
    expect(screen.getByTestId('decided-foot')).toHaveTextContent(
      'A reason you give is kept with the decision.',
    );
    expect(screen.getByTestId('nothing-waiting')).not.toHaveTextContent(/teaches|Undo/);
  });

  it('the average decision is "—" when none can be timed, not hidden', async () => {
    render(await DecisionStats({ stats: { approvedThisWeek: 0, avgDecisionSeconds: null } }));
    expect(screen.getByTestId('decision-stats')).toHaveTextContent('Avg decision —');
  });
});
