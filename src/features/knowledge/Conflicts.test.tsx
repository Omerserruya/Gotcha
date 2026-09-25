import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
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
 * The design draws two NAMED SOURCES disagreeing — a website page against an
 * uploaded PDF. That comparison has no left-hand side and no right-hand side
 * in this platform: `KnowledgeCandidate` has exactly one writer, the
 * historical-import extraction stage, and `importId` is a required column.
 * An uploaded document becomes a `KnowledgeDocument` and never produces
 * fact-level rows at all.
 *
 * So this panel is built on the axis that exists — the business answering
 * one question in more than one way, across past conversations — and says so.
 */

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

const show = async (over: Record<string, unknown> = {}) =>
  render(
    await KnowledgeScreen({
      sources: [],
      unanswered: [],
      conflicts: [candidate()],
      conflictsScannedAt: '2026-09-01T00:00:00.000Z',
      everImported: true,
      ...over,
    }),
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
     * `variants` carries no timestamp. `KnowledgeCandidateEvidence` does —
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
  it('★★ never-scanned is NOT "nothing disagrees"', async () => {
    /*
     * THE DISTINCTION THE PANEL EXISTS TO MAKE.
     *
     * Conflict detection runs inside the historical-import pipeline. With no
     * import it has never run at all, so an empty list carries no
     * information — and "no contradictions" would be the most misleading
     * sentence on the screen.
     */
    await show({ conflicts: [], everImported: false });
    const never = screen.getByTestId('conflicts-never-scanned');
    expect(never).toHaveTextContent(/nobody has checked/i);
    expect(screen.queryByTestId('conflicts-none')).toBeNull();
  });

  it('distinguishes a scanned-and-clean workspace from an unread one', async () => {
    await show({ conflicts: [], everImported: true });
    expect(screen.getByTestId('conflicts-none')).toHaveTextContent(/contradicted itself/i);
    expect(screen.queryByTestId('conflicts-never-scanned')).toBeNull();
  });

  it('a failed read is neither of those', async () => {
    await show({ conflicts: null });
    expect(screen.getByTestId('conflicts-unavailable')).toHaveTextContent(/couldn't read/i);
  });

  it('★★ states the axis even when conflicts ARE found', async () => {
    /*
     * A reader looking at two conflicts needs to know what was compared as
     * much as a reader looking at none. The design implies website-versus-PDF;
     * what this is, is your team's own answers over time — and the screen
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
     * `knowledge.service.ts` records the reason and returns `[]` — the reply
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

describe('★★ the header counts what it can, and names what it cannot', () => {
  it('★★ never renders a confidence count, because the score is not on knowledge', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE DESIGN'S FIRST TWO COUNTERS CANNOT BE COMPUTED AT ALL.
     * ════════════════════════════════════════════════════════════════════════
     * `confidence` is a column on `KnowledgeCandidate` and on no other
     * knowledge model — checked against every confidence field in the
     * schema. A candidate is a SUGGESTION awaiting approval, and approving
     * one creates a `KnowledgeDocument`, which has no confidence column.
     *
     * So the score exists only while the thing is not yet knowledge and is
     * discarded at the moment it becomes knowledge. Counting pending
     * candidates under "what GOTCHA knows about your business" would be
     * counting the inbox as the filing cabinet.
     */
    const { container } = await show();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/answers confidently|guesses sometimes/i);
    expect(text).not.toMatch(/\b\d+ topics\b/i);
    // And the absence explains itself, so nobody re-requests it every time
    // they read the design beside the screen.
    expect(screen.getByTestId('counter-no-confidence')).toHaveTextContent(
      /only on suggestions, before you accept/i,
    );
  });

  it('★★ the stale counter states the threshold, because the threshold is ours', async () => {
    // "4 out of date" is a verdict. "4 not refreshed in 90 days" is what we
    // actually know, and it is the same length.
    await show({ sources: [] });
    expect(screen.getByTestId('counter-stale')).toHaveTextContent(/90 days/);
    expect(screen.getByTestId('counter-stale')).not.toHaveTextContent(/out of date/i);
  });

  it('★ a failed conflict read does not count as zero conflicts', async () => {
    // The counter is a claim about the workspace. `null` is a claim about us.
    await show({ conflicts: null });
    expect(screen.getByTestId('counter-conflicts')).toHaveTextContent(/couldn't check/i);
  });

  it('★ no counters at all when the sources read failed', async () => {
    // Every counter is derived from sources or conflicts. A header of
    // zeroes over a failed read is the most confident thing on the page.
    await show({ sources: null });
    expect(screen.queryByTestId('knowledge-counters')).toBeNull();
  });
});
