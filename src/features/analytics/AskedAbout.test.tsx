import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { askedAboutSchema, type AskedAbout as Topic } from '@/api/contracts/analytics';
import messages from '@/i18n/messages/en/analytics.json';

import { AskedAbout } from './AskedAbout';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'analytics') =>
    createTranslator({ locale: 'en', messages: { analytics: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const topic = (over: Record<string, unknown> = {}): Topic =>
  askedAboutSchema.parse({ question: 'where is my order', count: 966, ...over });

const show = async (topics: readonly Topic[] | null) => render(await AskedAbout({ topics }));

describe('★★ the caption is load-bearing', () => {
  it('★★ tells the reader the grouping is GOTCHA’s and imperfect', async () => {
    /*
     * `detectedIntent` is a model-written unconstrained string, so "where is
     * my order" and "order status" arrive as two rows. Uncaptioned, a reader
     * seeing two rows that look like one question concludes the counts are
     * broken. Captioned, they know we know.
     */
    await show([topic()]);
    const caption = screen.getByTestId('asked-caption');
    expect(caption).toHaveTextContent(/grouped these questions itself/i);
    expect(caption).toHaveTextContent(/hasn't learned to merge them/i);
  });

  it('renders the label verbatim — we did not write it', async () => {
    await show([topic({ question: 'wheres my package' })]);
    expect(screen.getByTestId('topic-wheres my package')).toHaveTextContent('wheres my package');
  });
});

describe('★★ what is deliberately absent', () => {
  it('★★ renders no change column and no new-topic flag', async () => {
    /*
     * Both are DERIVABLE from two queries, and both are out. The label is
     * unstable, so an unmerged variant would read as a brand-new topic — a
     * spelling difference rendered as the most attention-grabbing thing on
     * the panel. Derivable is not the same as true.
     */
    const { container } = await show([topic()]);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\+\d+%|new topic|\bnew\b|didn't exist|did not exist/i);
  });

  it('★★ never renders "automatable", under either name', async () => {
    /*
     * The route sends `automatable: count > 5` — a threshold relabelled as a
     * property. As "GOTCHA could handle this" it asserts a capability from a
     * frequency; as "asked more than 5 times" it is a worse way of printing
     * the count beside it.
     */
    const parsed = askedAboutSchema.parse({ question: 'q', count: 9, automatable: true });
    expect(parsed).not.toHaveProperty('automatable');

    const { container } = await show([topic({ count: 9 })]);
    expect(container.textContent ?? '').not.toMatch(/automatable|could handle|more than 5/i);
  });

  it('★ shows no sentiment, no AI-alone rate, no how-it-ends', async () => {
    const { container } = await show([topic()]);
    expect(container.textContent ?? '').not.toMatch(/sentiment|upset|alone|how it ends|resolved/i);
  });
});

describe('★ the ordinary states', () => {
  it('★★ drops an unnamed row rather than inventing a name for it', async () => {
    // A count with nothing to attach to is not a topic, and naming it would
    // be the one thing this panel must not do.
    await show([topic(), topic({ question: '  ', count: 12 })]);
    expect(screen.getAllByTestId(/^topic-/)).toHaveLength(1);
  });

  it('an empty grouping says it fills in, rather than reading as none', async () => {
    await show([]);
    expect(screen.getByTestId('asked-none')).toHaveTextContent(/fills in as conversations/i);
  });

  it('a failed read is not an empty grouping', async () => {
    await show(null);
    expect(screen.getByTestId('asked-unavailable')).toHaveTextContent(/couldn't read/i);
  });
});
