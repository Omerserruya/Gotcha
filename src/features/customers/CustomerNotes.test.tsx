import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { noteSchema, type Note } from '@/api/contracts/customer-notes';
import messages from '@/i18n/messages/en/customers.json';

import { CustomerNotes } from './CustomerNotes';

/**
 * Screen 04f.
 *
 * ★ THE FIRST CUSTOMER SCREEN WHOSE POPULATED STATE IS NOT FORECLOSED.
 * The table is live and empty on this tenant, so the empty state is the real
 * one and the rows below are the variants a real workspace produces. Nothing
 * here presses a write: a note is real tenant data, and a synced one lands in
 * the merchant's own CRM where we cannot correct it.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'customers') =>
    createTranslator({ locale: 'en', messages: { customers: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const note = (over: Partial<Note> = {}): Note =>
  noteSchema.parse({
    id: 'n1',
    body: 'Prefers delivery after 4pm.',
    authorName: 'Dana Levi',
    authorUserId: 'u1',
    createdAt: '2026-09-18T09:21:00.000Z',
    updatedAt: '2026-09-18T09:21:00.000Z',
    ...over,
  });

const show = async (
  notes: readonly Note[] | null,
  viewerUserId: string | null = 'u1',
  // The composer and the controls are CLIENT components inside this server
  // tree, so `useTranslations` needs a context the server mock does not give.
) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ customers: messages }}>
      {await CustomerNotes({ notes, contactId: 'c1', viewerUserId })}
    </NextIntlClientProvider>,
  );

describe('★★ a failed read is not an empty one', () => {
  it('★★ never says nobody wrote anything from a request that did not return', async () => {
    await show(null);
    const unread = screen.getByTestId('notes-04f-unread');
    expect(unread).toHaveTextContent(/couldn't read/i);
    // And it says so explicitly, because the empty screen is the plausible
    // misreading rather than an obviously broken one.
    expect(unread).toHaveTextContent(/doesn't mean there are none/i);
  });

  it('an empty list IS a fact about the customer', async () => {
    await show([]);
    expect(screen.getByTestId('notes-04f-empty')).toHaveTextContent(/nobody has written/i);
  });

  it('★ still offers the composer when the read failed', async () => {
    // Writing a note does not depend on having read the old ones, and
    // removing the control would turn a read failure into a lost thought.
    await show(null);
    expect(screen.getByTestId('note-composer')).toBeInTheDocument();
  });
});

describe('★★ where each note lives, in the server’s words', () => {
  it('★★ distinguishes no-CRM from this-person-is-not-in-it', async () => {
    await show([
      note({ id: 'a', externalSyncError: 'no_crm_configured' }),
      note({ id: 'b', externalSyncError: 'no_crm_link' }),
    ]);
    expect(screen.getByTestId('note-where-a')).toHaveTextContent(/no CRM is connected/i);
    const linked = screen.getByTestId('note-where-b');
    expect(linked).toHaveTextContent(/isn't matched to a record/i);
    // And never the instruction meant for the other one.
    expect(linked).not.toHaveTextContent(/no CRM is connected/i);
  });

  it('★★ a failed push says so, with the provider’s own words', async () => {
    /*
     * Never render a failed push as saved. The reason is shown verbatim for
     * the same reason 04d renders the provider's chips: a paraphrase is a
     * second, vaguer copy of a sentence they already wrote.
     */
    await show([note({ externalSyncStatus: 'FAILED', externalSyncError: 'rate_limited' })]);
    const where = screen.getByTestId('note-where-n1');
    expect(where).toHaveAttribute('data-destination', 'failed');
    expect(where).toHaveTextContent(/did NOT reach your CRM/i);
    expect(where).toHaveTextContent(/rate_limited/);
  });

  it('★ says a not-yet-known push is not known', async () => {
    await show([note({ externalSyncStatus: 'PENDING' })]);
    expect(screen.getByTestId('note-where-n1')).toHaveTextContent(/don't know yet/i);
  });

  it('names the system a synced note reached', async () => {
    await show([note({ externalSyncStatus: 'SYNCED', externalSystem: 'hubspot', aiUsable: true })]);
    expect(screen.getByTestId('note-where-n1')).toHaveTextContent(/hubspot/i);
  });

  it('★★ a team-only note says it stayed here, and why', async () => {
    // The cost of `aiUsable` being off is real and deliberate, and the
    // screen's job is to make it legible rather than leave a sync looking
    // like it quietly did not happen.
    await show([note({ aiUsable: false, externalSyncError: 'not_ai_usable' })]);
    expect(screen.getByTestId('note-where-n1')).toHaveTextContent(/isn't marked for GOTCHA/i);
  });
});

describe('★★ the controls follow authorship, not access', () => {
  it('★★ offers edit and delete to the author only', async () => {
    const { unmount } = await show([note({ authorUserId: 'u1' })], 'u1');
    expect(screen.getByTestId('note-controls-n1')).toBeInTheDocument();
    unmount();

    await show([note({ authorUserId: 'someone-else' })], 'u1');
    expect(screen.queryByTestId('note-controls-n1')).toBeNull();
  });

  it('★ offers nothing when we could not find out who is reading', async () => {
    await show([note({ authorUserId: 'u1' })], null);
    expect(screen.queryByTestId('note-controls-n1')).toBeNull();
  });
});

describe('★ classic notes, and what the cut left out', () => {
  it('★ says THAT a note was edited and never what it said before', async () => {
    await show([note({ editHistory: [{ at: '2026-09-18T10:02:00.000Z', previousBody: 'old' }] })]);
    expect(screen.getByTestId('note-edited-n1')).toBeInTheDocument();
    // No revisions UI: the previous body must not be anywhere on screen.
    expect(screen.queryByText(/old/)).toBeNull();
  });

  it('★★ draws no pin, no revision list and no suggestion decision', async () => {
    /*
     * `pinned`, `editHistory` and `status: AI_SUGGESTED` all exist on the
     * table. Omer's cut was "classic notes only", so they are left unused
     * rather than given surfaces — and a ruling survives only if something
     * fails when it is undone.
     */
    const { container } = await show([note()]);
    expect(container.textContent ?? '').not.toMatch(/\bpin\b|\bpinned\b/i);
    expect(container.textContent ?? '').not.toMatch(/revision|version history|previous version/i);
    expect(container.textContent ?? '').not.toMatch(/\baccept\b|\breject\b|suggest/i);
  });

  it('★ shows no control for TEAM versus PRIVATE, which is a different question', async () => {
    // The two axes were untangled at a cost and must not be re-merged on
    // screen. 04f shows the one that decides whether the note leaves.
    const { container } = await show([note()]);
    expect(container.textContent ?? '').not.toMatch(/\bprivate\b|visibility/i);
    expect(screen.getByTestId('note-ai-usable')).toBeInTheDocument();
  });

  it('★★ the AI toggle defaults OFF, because it fails closed', async () => {
    /*
     * A note marked AI-usable reaches the merchant's CRM and returns through
     * `recent_crm_notes` into the model's context. A teammate reading a note
     * they should not have is a privacy problem; the bot repeating one to
     * the customer is a product incident.
     */
    await show([]);
    expect(screen.getByTestId('note-ai-usable')).not.toBeChecked();
    expect(screen.getByTestId('note-composer')).toHaveTextContent(/stays in GOTCHA/i);
  });
});
