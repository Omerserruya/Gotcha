import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { businessAppOptionsSchema, inspectResponseSchema } from '@/api/contracts/whatsapp-connect';
import messages from '@/i18n/messages/en/channels.json';

import { ConnectNumbers } from './ConnectNumbers';

const { connectNumber } = vi.hoisted(() => ({ connectNumber: vi.fn() }));
vi.mock('./whatsapp-actions', () => ({ connectNumber }));

/**
 * Screens 13c and 13d.
 *
 * ★ `connectNumber` IS MOCKED IN EVERY TEST. The real one calls
 * `subscribeApp` and `register` against a live Meta business account and
 * creates a WhatsAppNumber and a ChannelAccount. Dev sends real traffic.
 *
 * And the whole flow is unreachable by any capture: `POST /inspect` needs an
 * authorization code from Meta's Embedded Signup popup, which no Playwright
 * run can produce and no fixture can substitute, because the code is
 * exchanged server-side for a real customer token. These tests are the only
 * evidence this screen will ever have.
 */

beforeEach(() => connectNumber.mockReset());

const candidate = (over: Record<string, unknown> = {}) => ({
  phoneNumberId: 'p1',
  phoneNumber: '+972 50 000 0000',
  name: 'Support',
  scenario: 'NEW_NUMBER',
  message: 'We will set this number up for GOTCHA.',
  ...over,
});

const COEXISTENCE = businessAppOptionsSchema.parse({
  keepUsingBusinessApp: {
    title: 'Keep using the WhatsApp Business app',
    description: 'Both keep working on the same number.',
    throughputNote: 'Meta caps these at 20 messages per second.',
    limitations: ['Group chats stay on your phone and will not appear in GOTCHA.'],
  },
  fullMigration: {
    available: false,
    title: 'Move completely to GOTCHA',
    reason: 'Meta has no way to move a Business app number without deleting the account.',
  },
});

const renderList = (candidates: Record<string, unknown>[], coexistence = COEXISTENCE) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
      <ConnectNumbers
        inspection={inspectResponseSchema.parse({ sessionId: 's1', candidates })}
        coexistence={coexistence}
      />
    </NextIntlClientProvider>,
  );

describe('★ one list, with the decision already attached to each row', () => {
  it('renders every number with its own scenario and sentence', () => {
    renderList([
      candidate(),
      candidate({ phoneNumberId: 'p2', scenario: 'COEXISTENCE', message: 'Both keep working.' }),
    ]);
    const rows = screen.getAllByTestId('connect-candidate');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-scenario', 'NEW_NUMBER');
    expect(rows[1]).toHaveAttribute('data-scenario', 'COEXISTENCE');
  });

  it("★ renders the platform's sentence verbatim", () => {
    // "The text the connect screen shows, so it says what will happen rather
    // than what we detected." Ours would drift the first time a scenario
    // changed meaning.
    renderList([candidate({ message: 'This number is already on the Cloud API.' })]);
    expect(screen.getByTestId('connect-message')).toHaveTextContent(
      'This number is already on the Cloud API.',
    );
  });

  it('calls a reconnect a reconnect', () => {
    renderList([candidate({ scenario: 'RECONNECT', alreadyConnectedHere: true })]);
    expect(screen.getByTestId('connect-already')).toBeInTheDocument();
    expect(screen.getByTestId('connect-action-p1')).toHaveTextContent(/reconnect/i);
  });
});

describe('★ the PIN is named before the click', () => {
  it('warns when the candidate says a PIN will be asked for', () => {
    /*
     * `customerAction` is on the row, so this is known without submitting
     * anything. Afterwards would be telling somebody they need a code they do
     * not have, halfway through a flow at Meta.
     */
    renderList([candidate({ customerAction: 'TWO_STEP_PIN' })]);
    const pin = screen.getByTestId('connect-pin');
    expect(pin).toHaveTextContent(/two-step PIN/i);
    expect(pin).toHaveTextContent(/have it ready/i);
  });

  it('does not warn for the other customer actions', () => {
    renderList([candidate({ customerAction: 'DISPLAY_NAME_REVIEW' })]);
    expect(screen.queryByTestId('connect-pin')).toBeNull();
  });
});

describe('★ two kinds of impossibility, two treatments', () => {
  it('shows a BLOCKED row with its blockers and NO connect button', () => {
    // "Not you, not now" — the blockers say what to clear.
    renderList([
      candidate({
        scenario: 'BLOCKED',
        blockers: ['This number belongs to another GOTCHA workspace.'],
      }),
    ]);
    expect(screen.getByTestId('connect-blocked')).toBeInTheDocument();
    expect(screen.getByTestId('connect-blocker')).toHaveTextContent(/another GOTCHA workspace/i);
    expect(screen.queryByTestId('connect-action-p1')).toBeNull();
  });

  it('★ renders full migration as PROSE, never as a disabled control', () => {
    /*
     * `available` is the literal `false` for every Business app number that
     * will ever exist. A greyed-out option reads as "you did not qualify",
     * and this merchant did not fail a check — the road does not exist.
     */
    renderList([candidate({ scenario: 'COEXISTENCE', usesBusinessApp: true })]);
    const explain = screen.getByTestId('connect-coexistence');
    const migration = within(explain).getByTestId('connect-no-migration');

    expect(migration).toHaveTextContent(/without deleting the account/i);
    expect(migration).toHaveTextContent(/not a step you have missed/i);
    // No control of any kind for it.
    expect(within(explain).queryByRole('button')).toBeNull();
  });

  it('carries the coexistence limits the platform authored', () => {
    renderList([candidate({ usesBusinessApp: true })]);
    expect(screen.getByTestId('connect-throughput')).toHaveTextContent(/20 messages per second/i);
    expect(screen.getByTestId('connect-limitations')).toHaveTextContent(/group chats stay/i);
  });

  it('explains nothing for a number that is not on the Business app', () => {
    renderList([candidate()]);
    expect(screen.queryByTestId('connect-coexistence')).toBeNull();
  });
});

describe('the connect action', () => {
  it('offers a control per number', () => {
    // The browser holds an opaque sessionId and nothing else; the customer's
    // access token stays in Redis, server-side, and never reaches this
    // component to be passed anywhere.
    renderList([candidate(), candidate({ phoneNumberId: 'p2' })]);
    expect(screen.getByTestId('connect-action-p1')).toBeInTheDocument();
    expect(screen.getByTestId('connect-action-p2')).toBeInTheDocument();
  });

  it('★ is not fired by rendering — only by a person', async () => {
    /*
     * The resolved value matters even though nothing asserts it: without it
     * the mock returns `undefined`, the component reads `.ok` of it, and the
     * run reports 13 passing tests AND an unhandled error — which is the
     * shape that looks like success.
     *
     * Fixed in the scaffolding, not with a guard in the component: the types
     * say `connectNumber` cannot resolve undefined, and defending against a
     * case the types forbid would hide the next real one.
     */
    connectNumber.mockResolvedValue({ ok: true });
    renderList([candidate()]);
    expect(connectNumber).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('connect-action-p1'));
    expect(connectNumber).toHaveBeenCalledWith('s1', 'p1');
  });

  it('reports a failure rather than leaving the screen unchanged', async () => {
    connectNumber.mockResolvedValue({ ok: false, message: 'Meta refused the subscription.' });
    renderList([candidate()]);
    await userEvent.click(screen.getByTestId('connect-action-p1'));
    expect(await screen.findByTestId('connect-failed')).toHaveTextContent(/Meta refused/i);
  });
});

describe('an account with no numbers', () => {
  it('says so rather than rendering an empty list', () => {
    renderList([]);
    expect(screen.getByTestId('connect-none')).toHaveTextContent(/no numbers were found/i);
  });
});
