import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/customers.json';

import { FIXTURE_DETAIL } from './capture-fixtures';
import { CustomerActions } from './CustomerActions';
import { CustomerDetail } from './CustomerDetail';
import { CustomerNotes } from './CustomerNotes';

/**
 * Does the capture fixture actually produce what the capture spec asserts?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ THE ONE THING THIS SESSION CAN DO ABOUT A RUN IT CANNOT EXECUTE
 * ════════════════════════════════════════════════════════════════════════════
 * `e2e/customers.spec.ts` is authored here and run by somebody else on a
 * machine this session cannot reach. So a fixture that disagrees with the
 * spec — an empty `coverage` map, a missing imported event, a `page.types`
 * that does not include the kinds the events use — is discovered during
 * THEIR run, after a restart, a fresh cookie and a smoke test.
 *
 * Every assertion below mirrors one in the spec, against the real component
 * and the real fixture. It cannot prove the capture will pass: it says
 * nothing about the server, the session, the route or the gate. It proves
 * only that the fixture and the spec agree about what is on the page, which
 * is the half that has already been wrong once — `coverage: {}` would have
 * rendered no caveats at all and failed the run.
 *
 * ── AND IT IS NOT A SUBSTITUTE FOR THE CAPTURE ──
 * Recorded plainly because the temptation is to read a green file named
 * "agreement" as evidence the screen works. It is evidence that two things
 * this session wrote say the same thing.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'customers') =>
    createTranslator({ locale: 'en', messages: { customers: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const show = async () => render(await CustomerDetail({ detail: FIXTURE_DETAIL }));

describe('the capture fixture agrees with the capture spec', () => {
  it('renders the name the gate checks for', async () => {
    // The spec refuses to photograph unless "Avery Stone" is on the page —
    // that string IS the proof the fixtures engaged.
    await show();
    expect(screen.getByTestId('detail-name')).toHaveTextContent(/Avery Stone/);
  });

  it('renders a brief that is not the canned no-conversations string', async () => {
    await show();
    const brief = screen.getByTestId('customer-brief');
    expect(brief).toHaveTextContent(/\S/);
    expect(brief).not.toHaveTextContent(/New customer with no recorded prior interactions/i);
  });

  it('renders the count in the "showing N of M" form the spec matches', async () => {
    await show();
    const count = screen.getByTestId('timeline-count');
    expect(count).toHaveTextContent(/showing \d/i);
    expect(count).toHaveTextContent(/of [\d,]+ messages/i);
  });

  it('★ renders coverage caveats — the fixture had an empty map and would have failed the run', async () => {
    await show();
    expect(screen.getByTestId('timeline-coverage')).toHaveTextContent(/\S/);
    // The available-and-incomplete one specifically: it is the entry a screen
    // is most likely to skip, and the only warning that a Shopify refund the
    // AI performed is not in this list.
    expect(screen.getByTestId('coverage-ai_action')).toHaveTextContent(/not recorded here/i);
  });

  it('renders an imported message, a handover and an AI action', async () => {
    await show();
    expect(screen.getByTestId('event-imported')).toHaveTextContent(/imported/i);
    expect(screen.getByTestId('event-handover')).toHaveTextContent(/Handed to Dana/);
    expect(screen.getByTestId('event-action')).toHaveTextContent(/get_customer_orders/);
  });

  it('renders the notes section in its linked state, with the anonymity sentence', async () => {
    await show();
    // Two notes in the fixture, so `getAllBy`. The count matters: a capture
    // of a single note would not show that they stack.
    const notes = screen.getAllByTestId('crm-note');
    expect(notes).toHaveLength(2);
    for (const note of notes) expect(note).toHaveTextContent(/\S/);
    expect(screen.getByTestId('notes-anonymous')).toHaveTextContent(/doesn't record who wrote/i);
    expect(screen.getByTestId('notes-read-only')).toHaveTextContent(/written in your CRM/i);
  });

  it('★ contains nothing the spec forbids', async () => {
    /*
     * Tenure, money and un-substituted placeholders, asserted against the
     * fixture so one that introduced any of them fails here before a run.
     *
     * ★ THE TEXTAREA CHECK IS SCOPED TO `CustomerDetail`, AND THAT IS WHY IT
     * SURVIVED 04f. The spec's version covered the whole page and had to be
     * re-aimed when the notes composer arrived; this one has always been
     * about the 04b panel, where the prohibition actually lives — the CRM
     * write is conversation-keyed and would file against the wrong chat.
     *
     * The narrower assertion outlived the broader one, which is the argument
     * for saying what you mean rather than what happens to be true.
     */
    const { container } = await show();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/customer since/i);
    expect(text).not.toMatch(/lifetime value/i);
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(container.querySelector('textarea')).toBeNull();
  });
});

describe('★ and so does 04e — the fixture the audit shots are taken of', () => {
  /*
   * Mounted on its own, exactly as the page mounts it: a sibling, never a
   * child. An async server component nested inside another yields a tree
   * with an unresolved node and renders nothing, with no error to say so.
   */
  const showActions = async () =>
    render(await CustomerActions({ actions: FIXTURE_DETAIL.actions }));

  it('renders the four rows the spec counts', async () => {
    await showActions();
    expect(screen.getAllByTestId(/^action-fx-audit-/)).toHaveLength(4);
  });

  it('★★ shows the executed commerce row with its outcome UNRECORDED', async () => {
    /*
     * The shot that carries the screen's argument. The row's name says it
     * was executed; nothing wrote down whether it was, and the screen says
     * so rather than letting the name decide.
     */
    await showActions();
    expect(screen.getByTestId('action-outcome-fx-audit-4')).toHaveAttribute(
      'data-outcome',
      'not_recorded',
    );
  });

  it('★★ does NOT ask for the parameter the fixture supplied', async () => {
    // `coverage` still declares `requires: shopifyCustomerId`, because it is
    // a constant. The screen must not print it beneath the rows that
    // parameter fetched — and must still print the order gap.
    await showActions();
    expect(screen.queryByTestId('actions-gap-customer')).toBeNull();
    expect(screen.getByTestId('actions-gap-order')).toBeInTheDocument();
  });

  it('★ photographs no row the platform cannot write', async () => {
    /*
     * The rule this fixture file exists to keep, asserted rather than
     * trusted. `contradicts` and the name-hints need an emitter that sets a
     * verdict disagreeing with its own action name; the only writer of such
     * a name sets both from one boolean. A fixture row showing either would
     * be evidence of something that cannot happen — the same mistake as the
     * WhatsApp-plus-Instagram contact this file already records.
     */
    await showActions();
    expect(screen.queryByTestId(/^action-hint-/)).toBeNull();
    for (const cell of screen.getAllByTestId(/^action-outcome-/)) {
      expect(cell).not.toHaveAttribute('data-outcome', 'contradicts');
    }
  });
});

describe('★ and so does 04f — the notes the capture photographs', () => {
  /*
   * Wrapped, because the composer and the per-note controls are CLIENT
   * components inside this server tree. Fifth time this session, and the
   * tell is always the same sentence about `NextIntlClientProvider`.
   */
  const showNotes = async () =>
    render(
      <NextIntlClientProvider locale="en" messages={{ customers: messages }}>
        {await CustomerNotes({
          notes: FIXTURE_DETAIL.notes,
          contactId: 'fixture-1',
          viewerUserId: FIXTURE_DETAIL.viewerUserId,
        })}
      </NextIntlClientProvider>,
    );

  it('renders the four notes the spec counts', async () => {
    await showNotes();
    expect(screen.getAllByTestId(/^note-fx-note-/)).toHaveLength(4);
  });

  it('★★ every note says where it lives, which is what the shot is for', async () => {
    await showNotes();
    const wheres = screen.getAllByTestId(/^note-where-/);
    expect(wheres).toHaveLength(4);
    for (const where of wheres) expect(where).toHaveTextContent(/\S/);
  });

  it('★★ the failed push is visible as a failure, not as a kept note', async () => {
    // The row the fixture exists for. A push that was refused must never
    // read as one that quietly stayed here.
    await showNotes();
    expect(screen.getByTestId('note-where-fx-note-3')).toHaveAttribute(
      'data-destination',
      'failed',
    );
  });

  it('★★ shows BOTH halves of the authorship rule in one shot', async () => {
    /*
     * The viewer owns two of the four notes. A fixture where they owned all
     * of them would photograph a screen that cannot tell an editable note
     * from a teammate's — which is the thing the rule is.
     */
    await showNotes();
    expect(screen.getByTestId('note-controls-fx-note-1')).toBeInTheDocument();
    expect(screen.queryByTestId('note-controls-fx-note-3')).toBeNull();
  });

  it('★ and the toggle in the shot is OFF', async () => {
    // A capture showing it on would be evidence of the wrong default on the
    // one control that decides whether a note can reach the model.
    await showNotes();
    expect(screen.getByTestId('note-ai-usable')).not.toBeChecked();
  });
});
