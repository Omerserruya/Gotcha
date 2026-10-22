import { fireEvent, render, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  candidateSchema,
  lastHeardFor,
  type Candidate,
} from '@/api/contracts/knowledge-candidates';
import messages from '@/i18n/messages/en/knowledge.json';

import { KnowledgeScreen } from './KnowledgeScreen';

/**
 * Screen 08's conflict panel.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS PANEL IS, AND THE TWO THINGS IT REFUSES TO BE
 * ════════════════════════════════════════════════════════════════════════════
 * The design draws two NAMED SOURCES disagreeing - a website page against an
 * uploaded PDF. That comparison has no left-hand side and no right-hand side
 * in this platform: `KnowledgeCandidate` has exactly one writer, the
 * historical-import extraction stage, and `importId` is a required column.
 * An uploaded document becomes a `KnowledgeDocument` and never produces
 * fact-level rows at all.
 *
 * So this panel is built on the axis that exists - the business answering
 * one question in more than one way, across past conversations - and says so.
 */

/* K6: each document row's link - `href` as the address it would open. */
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children?: unknown;
    scroll?: boolean;
  }) => {
    const to =
      typeof href === 'string'
        ? href
        : `${href.pathname}?${new URLSearchParams(href.query ?? {}).toString()}`;
    return (
      <a href={to} {...rest}>
        {children as never}
      </a>
    );
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'knowledge') =>
    createTranslator({ locale: 'en', messages: { knowledge: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const candidate = (over: Record<string, unknown> = {}): Candidate =>
  candidateSchema.parse({
    id: 'c1',
    question: 'What is the minimum order?',
    answer: '₪850',
    status: 'PENDING',
    conflict: true,
    occurrenceCount: 23,
    variants: [
      { key: 'k850', answer: 'Minimum order is ₪850', occurrenceCount: 14, customerCount: 9 },
      { key: 'k550', answer: 'Minimum order is ₪550', occurrenceCount: 9 },
    ],
    examples: [
      {
        question: 'minimum?',
        answer: '₪850',
        occurredAt: '2026-07-14T09:00:00.000Z',
        variantKey: 'k850',
      },
      {
        question: 'minimum?',
        answer: '₪550',
        occurredAt: '2026-03-02T09:00:00.000Z',
        variantKey: 'k550',
      },
    ],
    ...over,
  });

/*
 * ★ THE PROVIDER, BECAUSE THE PANEL NOW CONTAINS A CLIENT COMPONENT.
 * `ResolveConflict` calls `useTranslations`, which reads React context -
 * mocking `next-intl/server` does nothing for it. Without this the render
 * throws rather than rendering an empty string, which is the good failure:
 * the seventh time this has come up, and the only one that was loud.
 */
const show = async (over: Record<string, unknown> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ knowledge: messages }}>
      {await KnowledgeScreen({
        sources: [],
        unanswered: [],
        conflicts: [candidate()],
        everImported: true,
        ...over,
      })}
    </NextIntlClientProvider>,
  );

describe('★★ both answers, and neither is preferred', () => {
  it('★★ shows every variant with how often each was said', async () => {
    /*
     * The schema is explicit: *"The business answered this differently at
     * different times. We do NOT pick one."* A screen that showed the most
     * common answer and hid the other would be making the decision the
     * platform deliberately refuses to make.
     */
    await show();
    expect(screen.getByTestId('variant-c1-k850')).toHaveTextContent(/₪850/);
    expect(screen.getByTestId('variant-c1-k850')).toHaveTextContent(/said 14 times/i);
    expect(screen.getByTestId('variant-c1-k550')).toHaveTextContent(/₪550/);
    expect(screen.getByTestId('variant-c1-k550')).toHaveTextContent(/said 9 times/i);
  });

  it('★★ dates each answer from its OWN evidence, never from the candidate', async () => {
    /*
     * `variants` carries no timestamp. `KnowledgeCandidateEvidence` does -
     * `variantKey` ties an exchange to the answer it demonstrates, and
     * `occurredAt` dates it. That is what makes "₪550 in March, ₪850 in
     * July" answerable rather than a design aspiration.
     */
    await show();
    expect(screen.getByTestId('variant-c1-k850')).toHaveTextContent(/July/);
    expect(screen.getByTestId('variant-c1-k550')).toHaveTextContent(/March/);
  });

  it('★★ a variant with no dated evidence gets NO date, not a borrowed one', async () => {
    /*
     * At most three representative examples come back, so a third or fourth
     * variant can have none. Falling back to the candidate's `lastSeenAt`
     * would stamp one answer with the date another was said.
     */
    const undated = candidate({
      variants: [
        { key: 'a', answer: 'Two weeks', occurrenceCount: 5 },
        { key: 'b', answer: 'Three weeks', occurrenceCount: 3 },
      ],
      examples: [
        {
          question: 'lead time?',
          answer: 'Two weeks',
          occurredAt: '2026-07-14T09:00:00.000Z',
          variantKey: 'a',
        },
      ],
    });
    expect(lastHeardFor(undated.variants![1]!, undated.examples)).toBeNull();

    await show({ conflicts: [undated] });
    expect(screen.getByTestId('variant-c1-a')).toHaveTextContent(/last on/i);
    expect(screen.getByTestId('variant-c1-b')).not.toHaveTextContent(/last on/i);
  });

  it('★ shows a customer count only where the merge left one', async () => {
    /*
     * `knowledge-extraction.stage.ts` writes `customerCount` per variant;
     * `knowledge-dedupe.stage.ts` merges and writes back only three of the
     * four fields, so it survives extraction and is dropped by the first
     * merge. A zero here would read as "no customers", which is a claim
     * nobody made.
     */
    await show();
    expect(screen.getByTestId('variant-c1-k850')).toHaveTextContent(/9 customers/i);
    expect(screen.getByTestId('variant-c1-k550')).not.toHaveTextContent(/customers/i);
  });
});

describe('★★ what the scan covered, which an empty list cannot say', () => {
  it('★★ no card unless something conflicts (Omer, 2026-10-12, K9)', async () => {
    /*
     * "Nothing has been checked yet" over a screen with nothing to do was a
     * box with no action in it. Never scanned, scanned and clean, a failed
     * read, and conflicts with no import behind them: no card, no words.
     */
    for (const over of [
      { conflicts: [], everImported: false },
      { conflicts: [], everImported: true },
      { conflicts: null, everImported: true },
      { everImported: false },
    ]) {
      const { unmount } = await show(over);
      expect(screen.queryByTestId('conflicts-section'), JSON.stringify(over)).toBeNull();
      expect(document.body).not.toHaveTextContent(/contradict|checked/i);
      unmount();
    }
  });

  it('★★ states the axis even when conflicts ARE found', async () => {
    /*
     * A reader looking at two conflicts needs to know what was compared as
     * much as a reader looking at none. The design implies website-versus-PDF;
     * what this is, is your team's own answers over time - and the screen
     * says that rather than letting the design's framing be assumed.
     */
    await show();
    const coverage = screen.getByTestId('conflicts-coverage');
    expect(coverage).toHaveTextContent(/past conversations/i);
    expect(coverage).toHaveTextContent(/your team actually gave/i);
    // And it names the check that does NOT exist, rather than leaving its
    // absence to be discovered.
    expect(coverage).toHaveTextContent(/doesn't exist yet/i);
  });
});

describe('★ the two sentences this screen must not say', () => {
  it('★★ never promises that GOTCHA passes to a person when it does not know', async () => {
    /*
     * The design prints *"GOTCHA never invents an answer. If it doesn't
     * know, it says so and passes the conversation to a person."*
     *
     * `knowledge.service.ts` records the reason and returns `[]` - the reply
     * proceeds with no passages and nothing tells the model retrieval
     * failed. A settings screen cannot assert a runtime guarantee the
     * runtime does not make.
     */
    const { container } = await show();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/never invents/i);
    expect(text).not.toMatch(/passes (the conversation )?to a person/i);
  });

  it('★ does not name a source as either side of a conflict', async () => {
    // The pointer on every piece of evidence is a `conversationId`. Labelling
    // a side "your website" or "a PDF" would be inventing provenance.
    const { container } = await show();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/your website · |uploaded PDF|wholesale page/i);
  });
});

describe('★★ no strip of four figures (Omer, 2026-10-11: K3)', () => {
  it('the hero tiles are gone - "answers confidently", "thin", "contradicts", "not refreshed"', async () => {
    await show({ sources: [] });
    expect(screen.queryByTestId('knowledge-counters')).toBeNull();
    expect(document.body).not.toHaveTextContent(
      /Answers confidently|guesses sometimes|Contradicts itself/i,
    );
  });
});

describe('★ found: the card, and what was compared said beside it', () => {
  it('the conflicts and the coverage line', async () => {
    await show();
    expect(screen.getByTestId('conflicts-section')).toBeInTheDocument();
    expect(screen.getByTestId('conflicts-coverage')).toBeInTheDocument();
  });
});

describe('★★ 08 arms with the whole document - what this candidate is made of', () => {
  it('its question and its reasoning reach the confirm, with the answer armed', async () => {
    await show({
      conflicts: [candidate({ reasoning: 'Below it, delivery costs more than the order.' })],
    });
    fireEvent.click(screen.getByTestId('resolve-c1-k550'));
    const used = screen.getByTestId('resolve-used-c1');
    expect([...used.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'What is the minimum order?',
      'Minimum order is ₪550',
      'How we approach this: Below it, delivery costs more than the order.',
    ]);
  });
});
