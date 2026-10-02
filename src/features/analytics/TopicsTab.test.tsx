import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { askedAboutSchema } from '@/api/contracts/analytics';
import analytics from '@/i18n/messages/en/analytics.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'analytics') =>
    createTranslator({ locale: 'en', messages: { analytics }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: { pathname: string }; children: ReactNode }) => (
    <a href={href.pathname} {...rest}>
      {children}
    </a>
  ),
}));

import {
  biggestRise,
  HowTheySound,
  MIN_BASE,
  TopicsHero,
  TopicTable,
  topicRows,
  topicWords,
  UnansweredCard,
} from './TopicsTab';
import type { TopicsData } from './load-analytics';

const topic = (intent: string | null, count: number, question: string | null = intent) =>
  askedAboutSchema.parse({ intent, question, count });

const WEEK = [topic('order_status', 966), topic('returns', 596), topic('does_it_shrink', 34)];
const BEFORE = [topic('order_status', 675), topic('returns', 573), topic('rare', 2)];

describe('★ topics against the week before', () => {
  it('★ change is real: percent on the week before; "new" when it had none; null when unread', () => {
    const rows = topicRows(WEEK, BEFORE);
    expect(rows.map((r) => [r.key, r.change])).toEqual([
      ['order_status', 43],
      ['returns', 4],
      ['does_it_shrink', 'new'],
    ]);
    expect(topicRows(WEEK, null).every((r) => r.change === null)).toBe(true);
  });

  it('★★ rows the route made from raw message bodies are not topics', () => {
    const fallback = [topic(null, 40, 'where is my parcel?? it was due monday')];
    expect(topicRows(fallback, null)).toEqual([]);
  });

  it('the biggest rise, on a base worth saying — a rise from 2 is not news', () => {
    expect(biggestRise(WEEK, BEFORE)?.key).toBe('order_status');
    expect(biggestRise([topic('rare', 10)], [topic('rare', MIN_BASE - 1)])).toBeNull();
    expect(biggestRise(WEEK, null)).toBeNull();
  });

  it('an intent key in words; a phrase left as it is', () => {
    expect(topicWords('order_status')).toBe('Order status');
    expect(topicWords('Where is my order')).toBe('Where is my order');
  });
});

const data = (over: Partial<TopicsData> = {}): TopicsData => ({
  week: WEEK,
  before: BEFORE,
  unanswered: { data: [{ id: 'q', question: 'Does it shrink', askCount: 34 }] },
  ...over,
});

describe('★★ 06e on screen', () => {
  it('★ what changed: the rise, in words and percent', async () => {
    render(await TopicsHero({ data: data() }));
    expect(screen.getByTestId('topics-hero')).toHaveTextContent(
      'Order status questions are up 43% on the week before.',
    );
  });

  it('nothing moved: said so — no percentage of nothing', async () => {
    render(await TopicsHero({ data: data({ before: WEEK }) }));
    expect(screen.getByTestId('topics-hero')).toHaveTextContent('No topic moved much');
  });

  it('★ the table: topic, asked, change (+43%, new); "—" for what nothing counts', async () => {
    render(await TopicTable({ data: data() }));
    expect(screen.getByTestId('topic-order_status')).toHaveTextContent('Order status966+43%——');
    expect(screen.getByTestId('topic-does_it_shrink')).toHaveTextContent('new');
  });

  it('⚠ a failed read; no topics; questions not grouped — three different sentences', async () => {
    const one = render(await TopicTable({ data: data({ week: null }) }));
    expect(screen.getByTestId('topics-unavailable')).toBeInTheDocument();
    one.unmount();
    const two = render(await TopicTable({ data: data({ week: [] }) }));
    expect(screen.getByTestId('topics-none')).toHaveTextContent('No topics this week.');
    two.unmount();
    render(await TopicTable({ data: data({ week: [topic(null, 9, 'hi')] }) }));
    expect(screen.getByTestId('topics-none')).toHaveTextContent("aren't grouped into topics");
  });

  it('★ the question it could not answer, and "Answer it once" goes to Knowledge', async () => {
    render(await UnansweredCard({ data: data() }));
    expect(screen.getByTestId('topics-unanswered')).toHaveTextContent(
      '“Does it shrink” was asked 34 times this week',
    );
    expect(screen.getByTestId('topics-answer')).toHaveAttribute('href', '/studio/knowledge');
    expect(screen.getByText('Rename')).toHaveAttribute('aria-disabled', 'true');
  });

  it('how people sound: the rows kept, "—", and why', async () => {
    render(await HowTheySound());
    const card = screen.getByTestId('topics-sound');
    expect(card.textContent?.match(/—/g)).toHaveLength(3);
    expect(card).toHaveTextContent("Tone isn't counted yet.");
  });
});
