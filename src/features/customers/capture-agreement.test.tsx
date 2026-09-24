import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/customers.json';

import { FIXTURE_DETAIL } from './capture-fixtures';
import { CustomerDetail } from './CustomerDetail';

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
    // Tenure, money and un-substituted placeholders. The spec asserts their
    // absence against the whole page; this asserts it against the fixture,
    // so a fixture that introduced one fails here first.
    const { container } = await show();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/customer since/i);
    expect(text).not.toMatch(/lifetime value/i);
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(container.querySelector('textarea')).toBeNull();
  });
});
