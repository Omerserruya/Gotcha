import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import { blockSchema, sourceSchema, type AnswerBlock } from '@/api/contracts/assistant-threads';
import home from '@/i18n/messages/en/home.json';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/api/client/browser-api', () => ({ browserApi: api }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AnswerBlocks, SourceChips } from './AnswerBlocks';

const block = (b: Record<string, unknown>) => blockSchema.parse(b);
const show = (blocks: AnswerBlock[], ids = { threadId: 'th1', messageId: 'm1' }) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ home }} timeZone="UTC">
      <AnswerBlocks blocks={blocks} threadId={ids.threadId} messageId={ids.messageId} />
    </NextIntlClientProvider>,
  );
const answering =
  (value: unknown) =>
  async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
    payload.parse(value);

beforeEach(() => {
  api.get.mockReset();
});

const WEEK = [
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
];

describe('★★ a chart: the server’s values, the days that matter in terracotta', () => {
  it('a bar per day, each sized to its value against the largest, read out with its day and value', () => {
    show([
      block({
        type: 'chart',
        id: 'b1',
        title: 'Conversations this week',
        sourceId: 's1',
        kind: 'bar',
        x: { kind: 'day', values: WEEK },
        series: [{ key: 'c', label: 'Conversations', values: [3, 4, 2, 5, 3, 9, 12] }],
        unit: 'count',
        highlight: ['2026-10-06', '2026-10-07'],
      }),
    ]);
    const last = screen.getByTestId('bar-b1-2026-10-07');
    expect(last).toHaveAttribute('data-highlight');
    expect(screen.getByTestId('bar-b1-2026-10-01')).not.toHaveAttribute('data-highlight');
    const bar = last.querySelector('[data-series="0"]') as HTMLElement;
    expect(bar.style.blockSize).toBe('100%');
    expect(bar).toHaveAttribute('aria-label', 'Wed, Oct 7 · Conversations: 12');
    expect(
      (screen.getByTestId('bar-b1-2026-10-03').querySelector('[data-series="0"]') as HTMLElement)
        .style.blockSize,
    ).toBe(`${(2 / 12) * 100}%`);
    // A week reads by its weekday's letter.
    expect(last).toHaveTextContent(/^W$/);
  });
});

describe('★★ a breakdown: each part’s bar is the share the server gave', () => {
  const parts = () =>
    block({
      type: 'breakdown',
      id: 'b2',
      title: 'By channel',
      sourceId: 's1',
      items: [
        { key: 'WHATSAPP', label: 'WhatsApp', value: 23, share: 0.61 },
        { key: 'INSTAGRAM', label: 'Instagram', value: 13, share: 0.34 },
      ],
      total: 38,
      unit: 'count',
      other: { label: 'Other', value: 2 },
      coverage: { covered: 14, of: 88 },
      deepLink: '/inbox?channel=WHATSAPP',
    });

  it('label, value, and the share as the bar - plus the rest, and the total', () => {
    show([parts()]);
    const wa = screen.getByTestId('part-b2-WHATSAPP');
    expect(wa).toHaveTextContent('WhatsApp23');
    expect((wa.querySelector('[data-first]') as HTMLElement).style.inlineSize).toBe('61%');
    expect(screen.getByTestId('part-b2-other')).toHaveTextContent('Other2');
    expect(screen.getByTestId('block-b2')).toHaveTextContent('38 in all');
  });

  it('★ recorded for only some: said - never a distribution over everything', () => {
    show([parts()]);
    expect(screen.getByTestId('block-b2-coverage')).toHaveTextContent(
      'Recorded for 14 of 88 conversations',
    );
  });

  it('its link is the server’s in-app path; anything else is no link', () => {
    show([parts()]);
    expect(screen.getByTestId('block-b2-open')).toHaveAttribute('href', '/inbox?channel=WHATSAPP');
    const evil = { ...parts(), id: 'b9', deepLink: '//evil.example/x' };
    show([evil]);
    expect(screen.getByTestId('block-b9-open').tagName).not.toBe('A');
  });
});

describe('a block that is not the whole story says so', () => {
  it('capped: counted from the first N; the store’s limit: part of what it returned', () => {
    show([
      block({
        type: 'record',
        id: 'b4',
        title: 'Linen Duvet Set · King',
        kind: 'product',
        fields: [{ key: 'stock', label: 'In stock', value: '14' }],
        partial: { reason: 'capped', cap: 250 },
      }),
      block({
        type: 'record',
        id: 'b5',
        title: 'Order #2207',
        kind: 'order',
        fields: [],
        partial: { reason: 'store_limit' },
      }),
    ]);
    expect(screen.getByTestId('block-b4')).toHaveTextContent('In stock14');
    expect(screen.getByTestId('block-b4-partial')).toHaveTextContent('Counted from the first 250');
    expect(screen.getByTestId('block-b5-partial')).toHaveTextContent(
      'Part of what the store returned',
    );
  });
});

describe('★★ the rows behind a number: the first page, then the source’s own list', () => {
  const list = () =>
    block({
      type: 'record_list',
      id: 'b3',
      title: 'Conversations that mention size',
      sourceId: 's2',
      kind: 'conversation',
      items: [
        {
          id: 'c1',
          title: 'Dana Cohen',
          subtitle: 'Return #2207',
          meta: '7 October',
          deepLink: '/inbox?c=c1',
        },
      ],
      total: 3,
      hasMore: true,
    });
  const rows = () => within(screen.getByTestId('records-b3')).getAllByRole('listitem');

  it('Show all reads the source’s list FROM THE START (the reader’s visibility now), then more by its cursor', async () => {
    show([list()]);
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId('block-b3')).toHaveTextContent('3 in all');
    api.get.mockImplementationOnce(
      answering({
        data: [
          { id: 'c1', title: 'Dana Cohen' },
          { id: 'c2', title: 'Avi' },
        ],
        nextCursor: 'k2',
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('records-b3-more'));
    });
    expect(api.get.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/assistant/threads/th1/messages/m1/sources/s2/records' },
      query: {},
      raw: true,
    });
    expect(rows().map((r) => r.textContent)).toEqual(['Dana Cohen', 'Avi']);
    api.get.mockImplementationOnce(
      answering({ data: [{ id: 'c3', title: 'Noa' }], nextCursor: null }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('records-b3-more'));
    });
    expect(api.get.mock.calls[1]![0]).toMatchObject({ query: { cursor: 'k2' } });
    expect(rows()).toHaveLength(3);
    expect(screen.queryByTestId('records-b3-more')).toBeNull();
  });

  it('★ the store can no longer be read (409): said, and the first page stays', async () => {
    show([list()]);
    api.get.mockRejectedValueOnce(
      new ApiError({ kind: 'conflict', status: 409, code: 'SOURCE_UNAVAILABLE' }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('records-b3-more'));
    });
    expect(screen.getByTestId('records-b3-failed')).toHaveTextContent(
      "The store can't be read right now",
    );
    expect(rows()).toHaveLength(1);
  });

  it('nothing more: no button', () => {
    show([{ ...list(), hasMore: false } as AnswerBlock]);
    expect(screen.queryByTestId('records-b3-more')).toBeNull();
  });
});

describe('01a’s chips under the answer', () => {
  it('each source, to its list when it has one', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ home }}>
        <SourceChips
          sources={[
            sourceSchema.parse({
              id: 's1',
              label: '12 conversations mention “small”',
              kind: 'conversations',
              deepLink: '/inbox?channel=WHATSAPP',
            }),
            sourceSchema.parse({ id: 's2', label: 'Product · Linen Duvet King', kind: 'product' }),
          ]}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('source-s1')).toHaveAttribute('href', '/inbox?channel=WHATSAPP');
    expect(screen.getByTestId('source-s2').tagName).toBe('SPAN');
  });
});
