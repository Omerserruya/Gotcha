import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { approvalSchema, type Approval } from '@/api/contracts/approvals';
import messages from '@/i18n/messages/en/approvals.json';

import { NothingWaiting } from './NothingWaiting';

/**
 * What you decided — screen 03's other list, and the state this tenant is in.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS FILE DID NOT EXIST, AND IT IS THE ONLY LIST DEV CAN SHOW
 * ════════════════════════════════════════════════════════════════════════════
 * The pending queue is empty on the demo tenant, so every walk of Approvals has
 * been photographing THIS list — twenty-nine rows of decided history — while the
 * grouping and paging arguments were all about the queue nobody can see.
 *
 * A walk read the rows as *"Approved by someone at 12:43 AM"*, cycling through
 * morning and afternoon across what must be several days, with no date anywhere.
 * Two mutations of the fix survived the whole suite, because nothing tested this
 * component at all.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'approvals') =>
    createTranslator({ locale: 'en', messages: { approvals: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const approval = (over: Partial<Approval> = {}): Approval =>
  approvalSchema.parse({
    id: 'a1',
    tool: 'issue_refund',
    summary: 'Refund 179 for order 1842',
    status: 'APPROVED',
    decidedByName: 'Dana',
    decidedAt: '2026-09-15T12:43:00.000Z',
    expiresAt: '2026-09-15T13:00:00.000Z',
    createdAt: '2026-09-15T12:00:00.000Z',
    ...over,
  });

const show = async (decided: readonly Approval[] | null, mayBeIncomplete = false) =>
  render(await NothingWaiting({ decided, mayBeIncomplete, requesterNames: {} }));

describe('★★ a decision carries the day it was made, not just the time', () => {
  it('★★ names the date as well as the time', async () => {
    /*
     * A list spanning several days with times only cannot be read at all: "12:43
     * AM" is the same string on every one of those days. This is a REFERENCE
     * list, not a work queue — the decisions are made, and when is the thing a
     * reader wants from it.
     */
    await show([approval()]);
    const row = screen.getByTestId('decided-a1');
    expect(row).toHaveTextContent('Sep 15, 2026');
    expect(row).toHaveTextContent('Approved by Dana');
  });

  it('★★ says nothing about a time it does not have, rather than a dangling "at"', async () => {
    /*
     * `decidedAt` is nullable on the contract, so this is a real row. It used to
     * interpolate `''`, so the row read "Approved by someone at " — a sentence
     * with a hole in it, which reads as a rendering fault rather than as missing
     * data.
     */
    await show([approval({ decidedAt: null, decidedByName: null })]);
    const row = screen.getByTestId('decided-a1');
    expect(row).toHaveTextContent(/approved by someone/i);

    /*
     * ★★ THE PROPERTY, NOT THE OLD SYMPTOM. The first version of this asserted
     * the absence of a dangling "at", because that is what the defect looked
     * like. A mutation forcing the timed branch then PASSED it — `new Date(null)`
     * is the epoch, so the row read "Approved by someone at Jan 1, 1970, 12:00
     * AM". A different defect, worse than the original, and invisible to an
     * assertion aimed at the wording of the first one.
     *
     * What must be true is that a row with no recorded time claims no time: no
     * year, no clock. That holds against the empty string, the epoch, and
     * whatever the next accident interpolates.
     */
    expect(row.textContent).not.toMatch(/\b(19|20)\d{2}\b/);
    expect(row.textContent).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('★ keeps the same treatment for a rejection', async () => {
    await show([approval({ id: 'a2', status: 'REJECTED', decidedAt: null })]);
    expect(screen.getByTestId('decided-a2')).toHaveTextContent(/rejected by Dana/i);
  });

  it('names "someone" only when the platform gave no name', async () => {
    await show([approval({ decidedByName: null })]);
    expect(screen.getByTestId('decided-a1')).toHaveTextContent(/approved by someone/i);
  });
});

describe('★★ the three states of the decided list', () => {
  it('★★ a failed read is not an empty history', async () => {
    /*
     * The house rule on the screen where it matters most: "we could not read your
     * past decisions" and "you have not decided anything" are opposite facts about
     * somebody's own record.
     */
    await show(null);
    expect(screen.getByTestId('decided-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('decided-empty')).toBeNull();
  });

  it('an empty history says so', async () => {
    await show([]);
    expect(screen.getByTestId('decided-empty')).toBeInTheDocument();
  });

  it('★★ says the list may be cut, when the route says it may be', async () => {
    // `take: 100` per kind. A list that is silently partial is a record somebody
    // will trust as complete.
    await show([approval()], true);
    expect(screen.getByText(/not all of them/i)).toBeInTheDocument();
  });
});
