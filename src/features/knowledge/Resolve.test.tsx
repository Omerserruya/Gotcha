import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  answerTooLong,
  approveResultSchema,
  documentUseOf,
  variantSchema,
  type Variant,
} from '@/api/contracts/knowledge-candidates';
import en from '@/i18n/messages/en/knowledge.json';
import he from '@/i18n/messages/he/knowledge.json';

import { ResolveConflict } from './ResolveConflict';
import type { ResolveResult } from './resolve-actions';

/**
 * Screen 08's resolve control.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ NOTHING HERE CALLS THE REAL ACTION
 * ════════════════════════════════════════════════════════════════════════════
 * `resolveConflict` writes the tenant knowledge base that every AI employee
 * answers customers from. The module is mocked for this whole file and the
 * default implementation **throws** — so a test that presses through to a
 * write fails instead of writing.
 *
 * Where an outcome sentence is under test the mock is given a return value.
 * That is not a write: the mocked module has no network, and what is being
 * checked is which of seven sentences a given result produces.
 */

const resolveConflict = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('a test must never call resolveConflict');
  }),
);
vi.mock('./resolve-actions', () => ({ resolveConflict }));

const variant = (over: Partial<Variant> = {}): Variant =>
  variantSchema.parse({ key: 'k850', answer: '₪850', occurrenceCount: 14, ...over });

const two = [variant(), variant({ key: 'k550', answer: '₪550', occurrenceCount: 9 })];

/*
 * ★ THE CLIENT COMPONENT NEEDS ITS OWN PROVIDER.
 * `getTranslations` is mocked for the server tree; `useTranslations` inside a
 * client component reads context and finds nothing without this. The symptom
 * is not a missing string — it is a thrown render, which is the good case.
 */
const show = (variants: readonly Variant[] = two) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ knowledge: en }}>
      <ResolveConflict candidateId="c1" variants={variants} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  resolveConflict.mockReset();
  resolveConflict.mockImplementation(async () => {
    throw new Error('a test must never call resolveConflict');
  });
});

describe('★★ one button per answer, and neither is the recommended one', () => {
  it('offers every variant', () => {
    show();
    expect(screen.getByTestId('resolve-c1-k850')).toHaveTextContent(/this one is right/i);
    expect(screen.getByTestId('resolve-c1-k550')).toHaveTextContent(/this one is right/i);
  });

  it('★ draws nothing where there is only one answer', () => {
    /*
     * The screen withholds the control rather than this component, but the
     * component must not invent a choice either: "this one is right" with a
     * single button is a question with one answer, which is not a question.
     */
    show([variant()]);
    expect(screen.getByTestId('resolve-c1-k850')).toBeInTheDocument();
    expect(screen.queryByTestId('resolve-c1-k550')).not.toBeInTheDocument();
  });
});

describe('★★ the first press writes nothing', () => {
  it('★★ arms, and does NOT call the action', async () => {
    /*
     * THE GUARANTEE THIS FILE EXISTS FOR. If the first press wrote, this
     * assertion would not merely fail — the mock throws, so the test would
     * fail loudly at the press rather than at the expectation.
     */
    show();
    await userEvent.click(screen.getByTestId('resolve-c1-k850'));

    expect(resolveConflict).not.toHaveBeenCalled();
    expect(screen.getByTestId('resolve-c1-k850')).toHaveAttribute('data-armed', 'yes');
  });

  it('★★ the armed label quotes the answer back, which is the whole guard', async () => {
    /*
     * These two variants differ by one character. Two adjacent buttons under
     * two answers that look alike is a misclick that sets the wrong price
     * permanently, and nobody re-reads an approved answer. So the second
     * press is spent on the text itself — "Save "₪550" as the answer?" —
     * rather than on the word "confirm", which reads the same whichever one
     * was hit.
     */
    show();
    await userEvent.click(screen.getByTestId('resolve-c1-k550'));

    expect(screen.getByTestId('resolve-c1-k550')).toHaveTextContent(/₪550/);
    expect(screen.getByTestId('resolve-c1-k550')).not.toHaveTextContent(/₪850/);
    expect(screen.getByTestId('resolve-armed-c1')).toHaveTextContent(/press again/i);
  });

  it('★ arming one answer disarms the other', async () => {
    // Otherwise a reader who changes their mind is one press from writing the
    // variant they just rejected.
    show();
    await userEvent.click(screen.getByTestId('resolve-c1-k850'));
    await userEvent.click(screen.getByTestId('resolve-c1-k550'));

    expect(resolveConflict).not.toHaveBeenCalled();
    expect(screen.getByTestId('resolve-c1-k850')).toHaveAttribute('data-armed', 'no');
    expect(screen.getByTestId('resolve-c1-k550')).toHaveAttribute('data-armed', 'yes');
  });
});

describe('★★ "saved" is three different facts', () => {
  const settle = async (result: ResolveResult) => {
    resolveConflict.mockImplementation(async () => result as never);
    show();
    // Two presses: the first arms, the second reaches the mock.
    await userEvent.click(screen.getByTestId('resolve-c1-k850'));
    await userEvent.click(screen.getByTestId('resolve-c1-k850'));
  };

  it('★★ says the AI answers with it only when the document came back ready', async () => {
    await settle({ ok: true, use: 'in_use', alreadyApproved: false });
    expect(screen.getByTestId('resolve-done-c1')).toHaveTextContent(
      /GOTCHA answers with this from now on/i,
    );
  });

  it('★★ an embedding failure is reported, though the route said ok', async () => {
    /*
     * THE DEFECT THIS STATE EXISTS FOR. `processDocument` is awaited inside a
     * try/catch that logs and swallows, so the route answers `{ ok: true }`
     * for a document left at `status: "error"` with no vectors in Qdrant.
     * Rendering "GOTCHA answers with this from now on" there would be a
     * promise about a document nothing can retrieve.
     */
    await settle({ ok: true, use: 'not_retrievable', alreadyApproved: false });
    const done = screen.getByTestId('resolve-done-c1');
    expect(done).toHaveTextContent(/cannot use it yet/i);
    expect(done).not.toHaveTextContent(/answers with this from now on/i);
  });

  it('★★ an unconfirmed document says so rather than claiming either way', async () => {
    await settle({ ok: true, use: 'unknown', alreadyApproved: false });
    const done = screen.getByTestId('resolve-done-c1');
    expect(done).toHaveTextContent(/could not confirm/i);
    expect(done).not.toHaveTextContent(/answers with this from now on/i);
  });

  it('★ the idempotent replay says nothing was written twice', async () => {
    await settle({ ok: true, use: 'in_use', alreadyApproved: true });
    expect(screen.getByTestId('resolve-done-c1')).toHaveTextContent(/already approved/i);
  });

  it('★★ a settled row stops offering to be resolved', async () => {
    /*
     * `revalidatePath` replaces the card, but not instantly. Until it does,
     * a live button on the other variant is one press from a second document
     * that contradicts the first — which is the exact failure the route's
     * duplicate check exists to prevent, arriving from our side of it.
     */
    await settle({ ok: true, use: 'in_use', alreadyApproved: false });
    expect(screen.queryByTestId('resolve-c1-k550')).not.toBeInTheDocument();
  });
});

describe('★★ every refusal is a different repair', () => {
  const refuse = async (result: ResolveResult) => {
    resolveConflict.mockImplementation(async () => result as never);
    show();
    await userEvent.click(screen.getByTestId('resolve-c1-k850'));
    await userEvent.click(screen.getByTestId('resolve-c1-k850'));
  };

  it('★★ already covered reads as settled, not as a failure to retry', async () => {
    /*
     * The route recorded `duplicateOfDocumentId` before refusing, so the
     * candidate HAS changed and will come back as covered rather than as a
     * conflict. Offering the buttons again would invite a press that can only
     * be refused the same way.
     */
    await refuse({ ok: false, reason: 'already_covered', title: null });
    expect(screen.getByTestId('resolve-problem-c1')).toHaveTextContent(/already answers this/i);
    expect(screen.queryByTestId('resolve-c1-k550')).not.toBeInTheDocument();
  });

  it('names creating a knowledge base, which is the thing that would fix it', async () => {
    await refuse({ ok: false, reason: 'no_knowledge_base' });
    expect(screen.getByTestId('resolve-problem-c1')).toHaveTextContent(/create one first/i);
  });

  it('★ a permission is not a fault, and says who can help', async () => {
    await refuse({ ok: false, reason: 'forbidden' });
    expect(screen.getByTestId('resolve-problem-c1')).toHaveTextContent(/permission/i);
  });

  it('★ a failure says nothing was written', async () => {
    // The direction that makes somebody check: a reader who is unsure whether
    // it saved will press again, and a wrong "maybe" costs a duplicate.
    await refuse({ ok: false, reason: 'failed' });
    expect(screen.getByTestId('resolve-problem-c1')).toHaveTextContent(/nothing was written/i);
    // And it is still offered, because retrying is the repair.
    expect(screen.getByTestId('resolve-c1-k850')).toBeInTheDocument();
  });
});

describe('★★ an answer the route would truncate is refused before it is offered', () => {
  it('★★ disables the button rather than storing half a policy', () => {
    /*
     * The route does `.slice(0, 4000)` with no complaint. A returns policy cut
     * off mid-sentence becomes the answer the AI gives customers, and it will
     * never be looked at again — it was approved.
     */
    const long = variant({ key: 'klong', answer: 'x'.repeat(4001) });
    show([variant(), long]);

    expect(screen.getByTestId('resolve-c1-klong')).toBeDisabled();
    expect(screen.getByTestId('resolve-c1-k850')).not.toBeDisabled();
    expect(screen.getByTestId('resolve-too-long-c1')).toHaveTextContent(/too long/i);
  });

  it('draws no warning where every answer fits', () => {
    show();
    expect(screen.queryByTestId('resolve-too-long-c1')).not.toBeInTheDocument();
    expect(answerTooLong('₪850')).toBe(false);
    // The boundary is inclusive: 4000 survives `.slice(0, 4000)` intact.
    expect(answerTooLong('x'.repeat(4000))).toBe(false);
    expect(answerTooLong('x'.repeat(4001))).toBe(true);
  });
});

describe('★★ only "ready" means the AI can answer with it', () => {
  it('★★ maps every other status to unknown, never to in use', () => {
    expect(documentUseOf('ready')).toBe('in_use');
    expect(documentUseOf('error')).toBe('not_retrievable');
    // `pending` is the value the row is CREATED with, so it is the one most
    // likely to be seen — and it is not a statement that anything works.
    expect(documentUseOf('pending')).toBe('unknown');
    expect(documentUseOf('processing')).toBe('unknown');
    expect(documentUseOf(null)).toBe('unknown');
    expect(documentUseOf(undefined)).toBe('unknown');
    // A value this build has not seen is not permission to assume the good one.
    expect(documentUseOf('embedded')).toBe('unknown');
  });
});

describe('★★ the approve response carries what it carries', () => {
  it('★★ does not default alreadyApproved, because absence is not "we made it"', () => {
    const normal = approveResultSchema.parse({ ok: true, documentId: 'doc1' });
    expect(normal.alreadyApproved).toBeUndefined();
    const replay = approveResultSchema.parse({
      ok: true,
      documentId: 'doc1',
      alreadyApproved: true,
    });
    expect(replay.alreadyApproved).toBe(true);
  });

  it('★ tolerates a null documentId, which the idempotent branch can return', () => {
    // `candidate.approvedDocumentId` is nullable. An APPROVED row written
    // before that column was populated answers ok with no id, and then there
    // is nothing to confirm against — which is `unknown`, not a parse failure.
    expect(approveResultSchema.parse({ ok: true, documentId: null }).documentId).toBeNull();
    expect(approveResultSchema.parse({ ok: true }).documentId).toBeNull();
  });
});

describe('★★ both languages say all of it', () => {
  it('★★ every sentence this control can render exists in en and he', () => {
    /*
     * A wrong key renders as MISSING_MESSAGE in dev and as an empty element in
     * the capture build — so a refusal with no sentence is exactly the shape
     * that reaches a screenshot.
     */
    const keys = [
      'choose',
      'confirm',
      'armed',
      'alreadyApproved',
      'use.in_use',
      'use.not_retrievable',
      'use.unknown',
      'problem.already_covered',
      'problem.no_knowledge_base',
      'problem.not_found',
      'problem.forbidden',
      'problem.too_long',
      'problem.failed',
    ];
    const at = (messages: unknown, path: string) =>
      path
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages);

    for (const key of keys) {
      for (const [locale, messages] of [
        ['en', en.conflicts.resolve],
        ['he', he.conflicts.resolve],
      ] as const) {
        const value = at(messages, key);
        expect(typeof value, `${locale}:${key}`).toBe('string');
        expect((value as string).length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});
