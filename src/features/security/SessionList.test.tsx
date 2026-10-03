import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { sessionSchema } from '@/api/contracts/security';
import en from '@/i18n/messages/en/security.json';

import { SessionList } from './SessionList';

/**
 * Where this account is signed in — screen 16's first section.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ NOTHING HERE PRESSES A REVOKE
 * ════════════════════════════════════════════════════════════════════════════
 * `revokeSession` and `revokeOtherSessions` end real sessions on a real
 * identity provider, and the sessions on the dev tenant belong to people who
 * are using them right now — including the capture runner. Both are mocked for
 * this whole file and both throw.
 *
 * So what is tested is which controls exist in which state, and **what the
 * screen says before anybody presses anything**, which is the part that decides
 * whether somebody signs themselves out of thirty-eight devices by accident.
 *
 * ── AND THIS FILE DID NOT EXIST ──
 * A browser walk reported "no sign out everywhere" on this screen. The control
 * was mounted the whole time, wired to the route, thirty-eight rows below the
 * fold. **A control nobody can reach is indistinguishable from one that does
 * not exist**, so the finding was true and its stated cause was not.
 */

const revokeSession = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('a test must never call revokeSession');
  }),
);
const revokeOtherSessions = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('a test must never call revokeOtherSessions');
  }),
);
vi.mock('./actions', () => ({ revokeSession, revokeOtherSessions }));

const session = (over: Record<string, unknown> = {}) =>
  sessionSchema.parse({ id: 's1', userAgent: 'Firefox on Linux', ...over });

/** `n` other devices plus the current one. */
const many = (n: number) => [
  session({ id: 'me', current: true, userAgent: 'Chrome on macOS' }),
  ...Array.from({ length: n }, (_, i) => session({ id: `s${i}`, userAgent: `Device ${i}` })),
];

const show = (sessions: ReturnType<typeof session>[], available = true) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ security: en }}>
      <SessionList sessions={sessions} available={available} />
    </NextIntlClientProvider>,
  );

describe('★★ a long list does not bury its own bulk action', () => {
  it('★★ shows three devices and says how many it is holding back', async () => {
    /*
     * The dev tenant has 38 sessions, one per capture mint. Thirty-eight rows
     * put "sign out all other devices" past the bottom of the viewport.
     *
     * The hidden count is asserted because a collapsed list that does not say
     * how much it is holding reads as the whole list — and on a security screen
     * that is the difference between "these are my devices" and "these are five
     * of my devices".
     */
    show(many(37));
    expect(screen.getAllByTestId(/^session-/).filter((el) => el.tagName === 'LI')).toHaveLength(3);
    expect(screen.getByTestId('sessions-hidden-note')).toHaveTextContent('35 more devices');
    expect(screen.getByTestId('sessions-show-all')).toHaveTextContent('Show all 38 devices');
  });

  it('★★ shows the current device first, because that is the question the list answers', async () => {
    /*
     * "Is one of these not me?" cannot be answered without seeing which one IS
     * you, and the platform does not return the current session first. Sorting
     * it to the top is what makes a collapsed list usable at all.
     */
    show([...many(9).slice(1), many(1)[0]!]);
    const rows = screen.getAllByTestId(/^session-/).filter((el) => el.tagName === 'LI');
    expect(rows[0]).toHaveAttribute('data-current', 'yes');
  });

  it('reveals the rest and can collapse again', async () => {
    show(many(37));
    await userEvent.click(screen.getByTestId('sessions-show-all'));
    expect(screen.getAllByTestId(/^session-/).filter((el) => el.tagName === 'LI')).toHaveLength(38);
    expect(screen.queryByTestId('sessions-hidden-note')).toBeNull();
    await userEvent.click(screen.getByTestId('sessions-show-fewer'));
    expect(screen.getAllByTestId(/^session-/).filter((el) => el.tagName === 'LI')).toHaveLength(3);
  });

  it('★ offers no expander when the whole list already fits', async () => {
    // A "show all" on a list of three is a control that does nothing.
    show(many(2));
    expect(screen.queryByTestId('sessions-show-all')).toBeNull();
    expect(screen.queryByTestId('sessions-show-fewer')).toBeNull();
  });

  it('★★ keeps the bulk action reachable without expanding the list', async () => {
    /*
     * The whole point. The control must not be behind the expander, or the fix
     * would have moved the defect rather than removed it.
     */
    show(many(37));
    expect(screen.getByTestId('sessions-revoke-others')).toBeInTheDocument();
  });
});

describe('★★ signing out everywhere asks first, and says what survives', () => {
  it('★★ the first press only opens the confirm — it does not revoke', async () => {
    show(many(37));
    await userEvent.click(screen.getByTestId('sessions-revoke-others'));
    expect(screen.getByTestId('sessions-revoke-others-confirm')).toBeInTheDocument();
    // The action module throws on call, so reaching it would fail this test
    // loudly. Asserting it was not called says so directly.
    expect(revokeOtherSessions).not.toHaveBeenCalled();
  });

  it('★★ the confirm names the number AND says this session survives', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * A CONTROL NOBODY DARES PRESS IS THE SAME AS NO CONTROL
     * ════════════════════════════════════════════════════════════════════════
     * Naming the count is the obvious half. The second sentence is the one that
     * makes it usable: a reader who cannot tell whether they are about to lock
     * themselves out will not press it, and then the control they can now reach
     * is still no use to them.
     *
     * Both halves asserted, because the count alone reads as a warning and the
     * reassurance alone reads as a shrug.
     */
    show(many(37));
    await userEvent.click(screen.getByTestId('sessions-revoke-others'));
    const note = screen.getByTestId('sessions-revoke-others-confirm');
    expect(note).toHaveTextContent('37 other devices');
    expect(note).toHaveTextContent(/stay signed in here/i);
  });

  it('★★ the confirm counts other devices, never the current one', async () => {
    /*
     * Off by one here is a promise about somebody's own session. With 10 rows
     * and one of them current, the number is 9.
     */
    show(many(9));
    await userEvent.click(screen.getByTestId('sessions-revoke-others'));
    const note = screen.getByTestId('sessions-revoke-others-confirm');
    expect(note).toHaveTextContent('9 other devices');
    expect(note).not.toHaveTextContent('10');
  });

  it('★★ backing out leaves every session alone', async () => {
    show(many(9));
    await userEvent.click(screen.getByTestId('sessions-revoke-others'));
    await userEvent.click(screen.getByTestId('sessions-revoke-others-cancel'));
    expect(screen.queryByTestId('sessions-revoke-others-confirm')).toBeNull();
    expect(screen.getByTestId('sessions-revoke-others')).toBeInTheDocument();
    expect(revokeOtherSessions).not.toHaveBeenCalled();
  });

  it('★ offers nothing to sign out when this is the only device', async () => {
    show(many(0));
    expect(screen.queryByTestId('sessions-revoke-others')).toBeNull();
  });

  it('★★ still distinguishes "we could not ask" from "you have no other sessions"', async () => {
    // Unchanged by the pagination, and the reason the section exists at all.
    show(many(37), false);
    expect(screen.getByTestId('sessions-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('sessions-show-all')).toBeNull();
  });
});

describe('★★ the list states its totals, because counting its rows gives three', () => {
  it('★★ carries the real total and the real other-count while collapsed', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * COLLAPSING THE LIST BROKE A THING THAT USED TO WORK
     * ════════════════════════════════════════════════════════════════════════
     * A probe counting rendered rows got the true number of sessions before the
     * pagination and gets five after. Somebody checking that a bulk revoke did
     * what it said would read five, then five, and conclude nothing happened —
     * and a supervisor's script did report a wrong number off this screen for a
     * neighbouring reason.
     *
     * Read from the props, so they are right collapsed or expanded. Asserted in
     * the collapsed state specifically, because that is the one where the DOM
     * disagrees with the truth.
     */
    show(many(37));
    const list = screen.getByTestId('session-list');
    expect(list).toHaveAttribute('data-total', '38');
    expect(list).toHaveAttribute('data-others', '37');
    // And the DOM really does disagree, which is why the attributes exist.
    expect(screen.getAllByTestId(/^session-\w/).filter((el) => el.tagName === 'LI')).toHaveLength(
      3,
    );
  });

  it('★ the totals do not change when the list is expanded', async () => {
    show(many(9));
    await userEvent.click(screen.getByTestId('sessions-show-all'));
    const list = screen.getByTestId('session-list');
    expect(list).toHaveAttribute('data-total', '10');
    expect(list).toHaveAttribute('data-others', '9');
  });

  it('★★ says zero others when this is the only device, rather than omitting it', async () => {
    /*
     * An absent attribute and a zero are different readings to an instrument, and
     * "no other sessions" is the answer somebody is checking for after a revoke.
     */
    show(many(0));
    const list = screen.getByTestId('session-list');
    expect(list).toHaveAttribute('data-total', '1');
    expect(list).toHaveAttribute('data-others', '0');
  });
});
