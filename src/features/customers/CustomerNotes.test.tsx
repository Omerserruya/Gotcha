import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { noteSchema, type Note } from '@/api/contracts/customer-notes';
import messages from '@/i18n/messages/en/customers.json';

import { CustomerNotes, NoteFilters, NotesSide, parseNoteFilter } from './CustomerNotes';

/**
 * Screen 04f.
 *
 * ★ THE FIRST CUSTOMER SCREEN WHOSE POPULATED STATE IS NOT FORECLOSED.
 * The table is live and empty on this tenant, so the empty state is the real
 * one and the rows below are the variants a real workspace produces. Nothing
 * here presses a write: a note is real tenant data, and a synced one lands in
 * the merchant's own CRM where we cannot correct it.
 */

// The filters link within the page; the router is not in jsdom.
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: React.ReactNode;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query ?? {})}`} {...rest}>
      {children}
    </a>
  ),
}));
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
    const unread = screen.getByTestId('team-notes-unread');
    expect(unread).toHaveTextContent(/couldn't read/i);
    // And it says so explicitly, because the empty screen is the plausible
    // misreading rather than an obviously broken one.
    expect(unread).toHaveTextContent(/doesn't mean there are none/i);
  });

  it('an empty list IS a fact about the customer', async () => {
    await show([]);
    expect(screen.getByTestId('team-notes-empty')).toHaveTextContent(/nobody has written/i);
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

const showWith = async (
  notes: readonly Note[] | null,
  props: { filter?: 'all' | 'mayUse' | 'teamOnly'; customerName?: string | null } = {},
) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ customers: messages }}>
      {await CustomerNotes({ notes, contactId: 'c1', viewerUserId: 'u1', ...props })}
    </NextIntlClientProvider>,
  );

describe('★★ 04f — the notes as 02 draws them', () => {
  it('★ each card says who may hear it: "Team only" or "GOTCHA may use"', async () => {
    await showWith([note({ id: 'a', aiUsable: true }), note({ id: 'b', aiUsable: false })]);
    expect(screen.getByTestId('note-chip-a')).toHaveTextContent('GOTCHA may use');
    expect(screen.getByTestId('note-chip-a')).toHaveAttribute('data-ai');
    expect(screen.getByTestId('note-chip-b')).toHaveTextContent('Team only');
    expect(screen.getByTestId('note-chip-b')).not.toHaveAttribute('data-ai');
  });

  it('★ the filters keep what they name', async () => {
    const notes = [note({ id: 'a', aiUsable: true }), note({ id: 'b', aiUsable: false })];
    const { unmount } = await showWith(notes, { filter: 'mayUse' });
    expect(screen.getByTestId('note-a')).toBeInTheDocument();
    expect(screen.queryByTestId('note-b')).toBeNull();
    unmount();
    await showWith(notes, { filter: 'teamOnly' });
    expect(screen.getByTestId('note-b')).toBeInTheDocument();
    expect(screen.queryByTestId('note-a')).toBeNull();
  });

  it('⚠ a filter that keeps nothing is not "nobody wrote anything"', async () => {
    await showWith([note({ aiUsable: false })], { filter: 'mayUse' });
    expect(screen.getByTestId('team-notes-filter-empty')).toHaveTextContent('No notes here.');
    expect(screen.queryByTestId('team-notes-empty')).toBeNull();
  });

  it('the composer: 02’s placeholder with their name, and Team only chosen', async () => {
    await showWith([], { customerName: 'Matan Amran' });
    expect(screen.getByTestId('note-body')).toHaveAttribute(
      'placeholder',
      'Write a note about Matan Amran…',
    );
    expect(screen.getByTestId('note-team-only')).toBeChecked();
    expect(screen.getByTestId('note-ai-usable')).not.toBeChecked();
  });

  it('the filter links, and an unknown one is All', async () => {
    render(await NoteFilters({ contactId: 'k1', current: 'teamOnly' }));
    expect(screen.getByTestId('note-filter-teamOnly')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('note-filter-mayUse')).toHaveAttribute(
      'href',
      '/customers/k1?tab=notes&filter=mayUse',
    );
    expect(parseNoteFilter('mayUse')).toBe('mayUse');
    expect(parseNoteFilter('pinned')).toBe('all');
  });
});

describe('★★ 04f’s side — what GOTCHA reads is what the platform gives it', () => {
  it('counts, and the notes marked for GOTCHA — the same rule as `promptSafeNotes`', async () => {
    render(
      await NotesSide({
        notes: [
          note({ id: 'a', aiUsable: true, body: 'Invoices go to Cohen Design.' }),
          note({ id: 'b', aiUsable: false, body: 'Very patient.' }),
          note({
            id: 'gone',
            aiUsable: true,
            body: 'Deleted one.',
            deletedAt: '2026-09-19T00:00:00.000Z',
          }),
        ],
      }),
    );
    const counts = screen.getByTestId('notes-counts');
    expect(counts).toHaveTextContent('notes2');
    expect(counts).toHaveTextContent('GOTCHA may use1');
    expect(counts).toHaveTextContent('team only1');
    const reads = screen.getByTestId('notes-reads');
    expect(reads).toHaveTextContent('Invoices go to Cohen Design.');
    expect(reads).not.toHaveTextContent('Very patient.');
    expect(reads).not.toHaveTextContent('Deleted one.');
    expect(reads).toHaveTextContent('Team-only notes are never shown to the AI');
  });

  it('⚠ unread notes are "—", not zero and not "Nothing yet."', async () => {
    render(await NotesSide({ notes: null }));
    expect(screen.getByTestId('notes-counts').textContent?.match(/—/g)).toHaveLength(3);
    expect(screen.getByTestId('notes-reads')).not.toHaveTextContent('Nothing yet.');
  });
});
