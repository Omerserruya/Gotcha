import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { callSchema, callSummarySchema, type Call } from '@/api/contracts/calls';
import { customerRowSchema } from '@/api/contracts/customers';
import calls from '@/i18n/messages/en/calls.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'calls') =>
    createTranslator({ locale: 'en', messages: { calls }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => (
    <a
      href={
        typeof href === 'string'
          ? href
          : `${href.pathname}?${new URLSearchParams(href.query ?? {})}`
      }
      {...rest}
    >
      {children}
    </a>
  ),
}));

import {
  callDuration,
  CallStats,
  DialerCard,
  isMissed,
  keepCall,
  parseCallFilter,
  RecentCalls,
} from './CallsScreen';

/**
 * Screen 05d. This tenant has voice on and no number, so dev photographs the
 * "no number" frame; these are the calls a real tenant will have, built
 * through the real contract.
 */
const call = (over: Record<string, unknown> = {}): Call =>
  callSchema.parse({
    id: 'v1',
    conversationId: 'c1',
    direction: 'inbound',
    status: 'completed',
    startedAt: new Date().toISOString(),
    answeredAt: new Date().toISOString(),
    durationMs: 192000,
    customerNumber: '972524189930',
    ...over,
  });

describe('★ the rules', () => {
  it('missed is an inbound call nobody answered — by answeredAt, never status', () => {
    expect(isMissed(call({ answeredAt: null }))).toBe(true);
    expect(isMissed(call({ answeredAt: null, direction: 'outbound' }))).toBe(false);
    expect(isMissed(call())).toBe(false);
  });

  it('the filters keep what they name', () => {
    const inbound = call();
    const outbound = call({ direction: 'outbound' });
    const missed = call({ answeredAt: null });
    expect([inbound, outbound, missed].filter((c) => keepCall(c, 'incoming'))).toEqual([
      inbound,
      missed,
    ]);
    expect([inbound, outbound, missed].filter((c) => keepCall(c, 'outgoing'))).toEqual([outbound]);
    expect([inbound, outbound, missed].filter((c) => keepCall(c, 'missed'))).toEqual([missed]);
    // An outgoing call they did not answer is not a call YOU missed.
    const unansweredOut = call({ direction: 'outbound', answeredAt: null });
    expect(keepCall(unansweredOut, 'missed')).toBe(false);
    expect(parseCallFilter('missed')).toBe('missed');
    expect(parseCallFilter('nope')).toBe('all');
  });

  it('02’s durations — and no length is "—", never "0s"', () => {
    expect(callDuration(192000)).toBe('3m 12s');
    expect(callDuration(52000)).toBe('52s');
    expect(callDuration(66000)).toBe('1m 06s');
    expect(callDuration(null)).toBe('—');
  });
});

describe('★★ the dialer — a live search, and no call placed from here', () => {
  const dana = customerRowSchema.parse({
    id: 'k1',
    displayName: 'Dana Cohen',
    phone: '972524189930',
    tags: ['Trade'],
  });

  it('★ results: the person, their number in display form, their tag; the first chosen', async () => {
    render(await DialerCard({ query: 'dana', results: [dana] }));
    const row = screen.getByTestId('dialer-k1');
    expect(row).toHaveTextContent('Dana Cohen');
    expect(row).toHaveTextContent('+972 52 418 9930');
    expect(row).toHaveTextContent('Trade');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveAttribute('href', '/customers/k1');
  });

  it('★★ "Call Dana" and "Let GOTCHA call them" are drawn and NOT live', async () => {
    const { container } = render(await DialerCard({ query: 'dana', results: [dana] }));
    expect(screen.getByText('Call Dana').closest('[aria-disabled]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('Let GOTCHA call them')).toHaveAttribute('aria-disabled', 'true');
    // Nothing that could place a call: no button, no form action but the search.
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('⚠ three different empties: no query, no match, a failed search', async () => {
    const one = render(await DialerCard({ query: '', results: [] }));
    expect(screen.getByText('Type a name or a number.')).toBeInTheDocument();
    one.unmount();
    const two = render(await DialerCard({ query: 'zzz', results: [] }));
    expect(screen.getByTestId('dialer-no-match')).toBeInTheDocument();
    two.unmount();
    render(await DialerCard({ query: 'zzz', results: null }));
    expect(screen.getByTestId('dialer-failed')).toBeInTheDocument();
  });

  it('the search is a GET form keyed q, so the URL keeps it', async () => {
    const { container } = render(await DialerCard({ query: 'dana', results: [] }));
    const form = container.querySelector('form')!;
    expect(form.getAttribute('method')).toBe('get');
    expect(screen.getByTestId('dialer-q')).toHaveAttribute('name', 'q');
    expect(screen.getByTestId('dialer-q')).toHaveValue('dana');
  });

  it('"Or have GOTCHA call a list" keeps its place', async () => {
    render(await DialerCard({ query: '', results: [] }));
    expect(screen.getByTestId('dialer-lists')).toHaveTextContent('Nothing yet.');
  });
});

describe('★ the week', () => {
  it('total and average from the week’s summary; "—" for what nothing records', async () => {
    render(
      await CallStats({
        week: callSummarySchema.parse({ total: 124, averageDurationMs: 160000 }),
      }),
    );
    expect(screen.getByTestId('stat-week')).toHaveTextContent('124');
    expect(screen.getByTestId('stat-average')).toHaveTextContent('2m 40s');
    expect(screen.getByTestId('stat-gotchaAnswered')).toHaveTextContent('—');
    expect(screen.getByTestId('stat-sale')).toHaveTextContent('—');
  });

  it('⚠ no summary, or no durations: "—", never 0', async () => {
    const { unmount } = render(await CallStats({ week: null }));
    expect(screen.getByTestId('call-stats').textContent?.match(/—/g)).toHaveLength(4);
    unmount();
    render(
      await CallStats({ week: callSummarySchema.parse({ total: 3, averageDurationMs: null }) }),
    );
    expect(screen.getByTestId('stat-average')).toHaveTextContent('—');
  });
});

describe('★★ recent calls', () => {
  it('★ a row: the number in display form, the length, a factual outcome, when, the transcript', async () => {
    render(await RecentCalls({ calls: [call()], state: 'ok', filter: 'all' }));
    const row = screen.getByTestId('call-v1');
    expect(row).toHaveTextContent('+972 52 418 9930');
    expect(row).toHaveTextContent('3m 12s');
    expect(row.querySelector('a[href="/inbox?c=c1"]')).toHaveTextContent('Transcript');
  });

  it('★ a missed call says nobody picked up; an unanswered outgoing says they did not answer', async () => {
    render(
      await RecentCalls({
        calls: [
          call({ id: 'm', answeredAt: null, durationMs: null }),
          call({ id: 'o', direction: 'outbound', answeredAt: null }),
        ],
        state: 'ok',
        filter: 'all',
      }),
    );
    expect(screen.getByTestId('call-m')).toHaveTextContent('Nobody picked up');
    expect(screen.getByTestId('call-m')).toHaveTextContent('—');
    expect(screen.getByTestId('call-o')).toHaveTextContent("They didn't answer");
  });

  it('a matched call links to the person', async () => {
    render(await RecentCalls({ calls: [call({ customerId: 'k9' })], state: 'ok', filter: 'all' }));
    expect(screen.getByTestId('call-v1').querySelector('a[href="/customers/k9"]')).not.toBeNull();
  });

  it.each([
    ['unknown', 'calls-unknown'],
    ['off', 'calls-off'],
    ['failed', 'calls-failed'],
    ['noNumber', 'calls-noNumber'],
    ['none', 'calls-none'],
  ] as const)('⚠ %s: the card stays, its body says why', async (state, testid) => {
    render(await RecentCalls({ calls: [], state, filter: 'all' }));
    expect(screen.getByTestId(testid)).toBeInTheDocument();
    expect(screen.getByTestId('recent-calls')).toHaveTextContent(
      "Every call is attached to the customer's conversation.",
    );
  });

  it('⚠ the foot claims no retention period — nothing states one', async () => {
    render(await RecentCalls({ calls: [], state: 'none', filter: 'all' }));
    expect(screen.getByTestId('recent-calls')).not.toHaveTextContent(/90 days|kept for/);
  });

  it('a filter that keeps nothing says so', async () => {
    render(await RecentCalls({ calls: [call()], state: 'ok', filter: 'outgoing' }));
    expect(screen.getByTestId('calls-filter-empty')).toBeInTheDocument();
  });
});
