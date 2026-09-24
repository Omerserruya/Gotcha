import { render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { candidateSchema } from '@/api/contracts/knowledge-candidates';
import messages from '@/i18n/messages/en/channels.json';

import { KnowledgeReview } from './KnowledgeReview';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels.whatsapp') =>
    createTranslator({ locale: 'en', messages: { channels: messages }, namespace }),
  getLocale: async () => 'en',
}));

const candidate = (over: Record<string, unknown> = {}) =>
  candidateSchema.parse({
    id: 'c1',
    question: 'Do you ship to Eilat?',
    answer: 'Yes, two to three days.',
    status: 'PENDING',
    ...over,
  });

const renderReview = async (candidates: unknown[], minConfidence = 0.8) =>
  render(
    await KnowledgeReview({
      candidates: candidates as never,
      bulkMinConfidence: minConfidence,
    }),
  );

describe('★ the claim that makes the screen worth reading slowly', () => {
  it('says nothing is in use until approved, and why that is true', async () => {
    /*
     * Approving CREATES the document, and nothing in the AI path reads a
     * candidate — so this holds by construction. A reviewer who does not
     * believe it will rush, and rushing is the failure this screen exists to
     * prevent.
     */
    await renderReview([candidate()]);
    expect(screen.getByTestId('review-nothing-used')).toHaveTextContent(/cannot reach a customer/i);
  });

  it('★ says these are evidence, not policy', async () => {
    // The schema's own rule. A reviewer who thinks they are confirming facts
    // approves everything; one who knows they are reading what a colleague
    // once said reads it.
    await renderReview([candidate()]);
    const note = screen.getByTestId('review-evidence-not-truth');
    expect(note).toHaveTextContent(/evidence, not policy/i);
    expect(note).toHaveTextContent(/made an exception once, or been wrong/i);
  });
});

describe('★ already covered is not rejected', () => {
  it('gives it its own group and says nothing was turned down', async () => {
    await renderReview([candidate({ status: 'SUPERSEDED', duplicateOfDocumentId: 'd1' })]);
    const group = screen.getByTestId('review-group-already_covered');
    expect(within(group).getByTestId('review-candidate')).toBeInTheDocument();
    expect(screen.getByTestId('review-already-covered-body')).toHaveTextContent(
      /nothing was turned down/i,
    );
    expect(
      within(screen.getByTestId('review-group-rejected')).queryByTestId('review-candidate'),
    ).toBeNull();
  });

  it('★ calls a duplicate "your knowledge base", never "your website"', async () => {
    /*
     * Nothing records a document's origin. Calling it the website would
     * assert a provenance the schema does not carry — the same error as an
     * industry inferred from a login page.
     */
    await renderReview([candidate({ status: 'SUPERSEDED', duplicateOfDocumentId: 'd1' })]);
    const dup = screen.getByTestId('review-duplicate');
    expect(dup).toHaveTextContent(/in your knowledge base/i);
    expect(dup).not.toHaveTextContent(/website/i);
  });
});

describe('★ correct and unsafe to assert', () => {
  it('warns before approval, not after', async () => {
    /*
     * "We usually do viewings Thursday and Friday" is true, and an agent
     * stating it promises a slot nobody checked. Nothing else on this screen
     * carries that distinction.
     */
    await renderReview([candidate({ requiresLiveLookup: true, confidence: 1 })]);
    const live = screen.getByTestId('review-live-lookup');
    expect(live).toHaveTextContent(/do not let the AI state this as fact/i);
    expect(live).toHaveTextContent(/check before answering/i);
  });

  it('does not confuse it with low confidence', async () => {
    // Maximally confident AND flagged. The flag is not a quality score.
    await renderReview([candidate({ requiresLiveLookup: false, confidence: 0.1 })]);
    expect(screen.queryByTestId('review-live-lookup')).toBeNull();
  });
});

describe('★ Approve all cannot take a conflict', () => {
  it('counts only what the server would accept, and says so', async () => {
    await renderReview([
      candidate({ confidence: 0.9 }),
      candidate({ id: 'c2', confidence: 0.9, conflict: true }),
      candidate({ id: 'c3', confidence: 0.1 }),
    ]);
    expect(screen.getByTestId('review-bulk')).toHaveTextContent(/approve the 1 that are ready/i);
    expect(screen.getByTestId('review-bulk-safe')).toHaveTextContent(
      /cannot approve a conflict however it is pressed/i,
    );
  });

  it('offers nothing when every suggestion conflicts', async () => {
    await renderReview([candidate({ confidence: 1, conflict: true })]);
    expect(screen.queryByTestId('review-bulk')).toBeNull();
  });

  it('tells the reviewer a conflict is theirs to settle', async () => {
    await renderReview([candidate({ conflict: true })]);
    expect(screen.getByTestId('review-conflict')).toHaveTextContent(/will not pick for you/i);
    expect(screen.queryByTestId('review-actions')).toBeNull();
  });
});

describe('the reviewer’s decision input', () => {
  it('says how much evidence stands behind a suggestion', async () => {
    // One agent once, against forty customers over six months.
    await renderReview([
      candidate({
        occurrenceCount: 40,
        customerCount: 31,
        firstSeenAt: '2026-03-01T00:00:00.000Z',
        lastSeenAt: '2026-09-01T00:00:00.000Z',
      }),
    ]);
    const evidence = screen.getByTestId('review-evidence');
    expect(evidence).toHaveTextContent(/40 times/);
    expect(evidence).toHaveTextContent(/31 customers/);
    expect(evidence).toHaveTextContent(/2026/);
  });

  it('renders the curation verdict the platform wrote', async () => {
    await renderReview([
      candidate({ curationVerdict: 'rewritten', curationNote: 'Trimmed a greeting.' }),
    ]);
    const curation = screen.getByTestId('review-curation');
    expect(curation).toHaveTextContent(/reworded for clarity/i);
    expect(curation).toHaveTextContent(/trimmed a greeting/i);
  });
});

describe('two things said rather than drawn', () => {
  it('promises a re-run will not re-ask about rejections', async () => {
    // One candidate per cluster per import; re-runs update counts. A merchant
    // who fears being re-asked will not press it.
    await renderReview([candidate()]);
    expect(screen.getByTestId('review-rerun-safe')).toHaveTextContent(/already rejected/i);
  });

  it('names the language shortcut that has nowhere to go', async () => {
    await renderReview([candidate()]);
    expect(screen.getByTestId('review-no-language-shortcut')).toHaveTextContent(
      /nowhere to add one/i,
    );
  });
});
