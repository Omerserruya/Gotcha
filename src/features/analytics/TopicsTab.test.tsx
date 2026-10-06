import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { askedAboutSchema, namedTopics } from '@/api/contracts/analytics';
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
  TopicByDay,
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

  it('the biggest rise, on a base worth saying - a rise from 2 is not news', () => {
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

  it('nothing moved: said so - no percentage of nothing', async () => {
    render(await TopicsHero({ data: data({ before: WEEK }) }));
    expect(screen.getByTestId('topics-hero')).toHaveTextContent('No topic moved much');
  });

  it('★ the table: topic, asked, change (+43%, new); "-" for what nothing counts', async () => {
    render(await TopicTable({ data: data() }));
    expect(screen.getByTestId('topic-order_status')).toHaveTextContent('Order status966+43%--');
    expect(screen.getByTestId('topic-does_it_shrink')).toHaveTextContent('new');
  });

  it('⚠ a failed read; no topics; questions not grouped - three different sentences', async () => {
    const one = render(await TopicTable({ data: data({ week: null }) }));
    expect(screen.getByTestId('topics-unavailable')).toBeInTheDocument();
    one.unmount();
    const two = render(await TopicTable({ data: data({ week: [] }) }));
    expect(screen.getByTestId('topics-none')).toHaveTextContent('No topics this week.');
    two.unmount();
    const three = render(await TopicTable({ data: data({ week: [topic('unknown', 9)] }) }));
    expect(screen.getByTestId('topics-none')).toHaveTextContent("aren't grouped into topics");
    three.unmount();
    // ★ 06e (Omer): no topics this week → the questions as people asked them, counted.
    render(
      await TopicTable({
        data: data({
          week: [
            topic(null, 9, 'Do you ship to Eilat?'),
            topic(null, 4, 'Is the linen pre-washed?'),
          ],
        }),
      }),
    );
    expect(screen.getByTestId('asked-0')).toHaveTextContent('Do you ship to Eilat?9');
    expect(screen.getByTestId('asked-1')).toHaveTextContent('Is the linen pre-washed?4');
    expect(screen.getByTestId('topics-table')).toHaveTextContent('What people asked');
    expect(screen.queryByTestId('topics-none')).toBeNull();
  });

  it('★ the question it could not answer, and "Answer it once" goes to Knowledge', async () => {
    render(await UnansweredCard({ data: data() }));
    expect(screen.getByTestId('topics-unanswered')).toHaveTextContent(
      '“Does it shrink” was asked 34 times this week',
    );
    expect(screen.getByTestId('topics-answer')).toHaveAttribute('href', '/studio/knowledge');
    expect(screen.getByText('Rename')).toHaveAttribute('aria-disabled', 'true');
  });

  it('how people sound: the rows kept, "-", and why', async () => {
    render(await HowTheySound());
    const card = screen.getByTestId('topics-sound');
    expect(card.textContent?.match(/-/g)).toHaveLength(3);
    expect(card).toHaveTextContent("Tone isn't counted yet.");
  });
});

describe('★★ the classifier\'s "no result" is not a topic', () => {
  // Dev, measured: the tenant's only intent this week was `unknown`, 5 rows.
  const DEV = data({ week: [topic('unknown', 5)], before: [] });
  const DAYS = [new Date('2026-10-01T00:00:00Z')];

  it('★★ "unknown" and "general" are not rows - and never "new"', () => {
    expect(topicRows([topic('unknown', 5), topic('General', 3)], [])).toEqual([]);
    expect(topicRows([...WEEK, topic('general', 9)], BEFORE).map((r) => r.key)).not.toContain(
      'general',
    );
  });

  it('★★ on dev\'s data: "not grouped", and the foot counts what it couldn\'t place', async () => {
    render(await TopicTable({ data: DEV }));
    expect(screen.queryByTestId('topic-unknown')).not.toBeInTheDocument();
    expect(screen.getByTestId('topics-none')).toHaveTextContent("aren't grouped into topics");
    expect(screen.getByTestId('topics-unplaced')).toHaveTextContent(
      "5 questions GOTCHA couldn't place this week.",
    );
  });

  it('★ with real topics beside them, the rows stay and the foot still counts', async () => {
    render(await TopicTable({ data: data({ week: [...WEEK, topic('general', 1)] }) }));
    expect(screen.getByTestId('topic-order_status')).toBeInTheDocument();
    expect(screen.queryByTestId('topic-general')).not.toBeInTheDocument();
    expect(screen.getByTestId('topics-unplaced')).toHaveTextContent(
      "1 question GOTCHA couldn't place",
    );
  });

  it('no foot count when everything was placed', async () => {
    render(await TopicTable({ data: data() }));
    expect(screen.queryByTestId('topics-unplaced')).not.toBeInTheDocument();
  });

  it('★★ it does not title the by-day card, nor the dark one', async () => {
    render(await TopicByDay({ data: DEV, days: DAYS }));
    expect(screen.getByTestId('topics-by-day')).toHaveTextContent('A topic, by day');
    expect(screen.getByTestId('topics-by-day')).not.toHaveTextContent(/unknown/i);
    render(await TopicsHero({ data: DEV }));
    expect(screen.getByTestId('topics-hero')).not.toHaveTextContent(/unknown/i);
  });

  it('★ nor is it a topic on 06\'s "What people ask about"', () => {
    expect(namedTopics([topic('unknown', 5), topic('returns', 2)]).map((r) => r.intent)).toEqual([
      'returns',
    ]);
    // A customer's own words (no intent) are never mistaken for the label.
    expect(namedTopics([topic(null, 2, 'general')])).toHaveLength(1);
  });
});

describe('★★ 06e - what the classifier could not place, in the customers’ words (backend 8d9d09ec)', () => {
  it('the unknown group’s examples are what people asked; the label itself is never a topic', async () => {
    const unknown = askedAboutSchema.parse({
      intent: 'unknown',
      question: 'unknown',
      count: 5,
      examples: [
        { question: 'תבטלו לי בבקשה את הזמנה 1002', count: 2 },
        { question: 'Where is my parcel?', count: 3 },
      ],
    });
    render(await TopicTable({ data: data({ week: [unknown] }) }));
    expect(screen.getByTestId('asked-0')).toHaveTextContent('Where is my parcel?3');
    expect(screen.getByTestId('asked-1')).toHaveTextContent('תבטלו לי בבקשה את הזמנה 1002');
    expect(screen.getByTestId('asked-1').querySelector('bdi')).toHaveAttribute('dir', 'auto');
    expect(screen.getByTestId('topics-table')).not.toHaveTextContent(/^unknown$/m);
    expect(screen.queryByTestId('topic-unknown')).toBeNull();
  });
});
