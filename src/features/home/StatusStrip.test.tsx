import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/home.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: React.ReactNode;
    scroll?: boolean;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query)}`} {...rest}>
      {children}
    </a>
  ),
}));

import { StatusStrip } from './StatusStrip';

/**
 * The first line on Home, which its own doc says "has to be true".
 *
 * A failed notifications read rendered as "No signals" — the reassuring
 * answer, to a count nobody obtained. It is the same shape as the billing
 * screen rounding an unread failure count to zero, and it is the version
 * nobody reports, because the screen looks fine.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'home.status') =>
    createTranslator({ locale: 'en', messages: { home: messages }, namespace }),
}));

const strip = (over: Partial<Parameters<typeof StatusStrip>[0]> = {}) =>
  StatusStrip({ waiting: 3, signals: 0, isQuiet: false, ...over });

describe('★ an unread count is not a calm one', () => {
  it('says signals are unavailable rather than claiming there are none', async () => {
    render(await strip({ signals: null }));
    expect(screen.getByText(/signals unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/^No signals$/i)).toBeNull();
  });

  it('still says "No signals" when the count really is zero', async () => {
    // The reassuring answer is correct here, and must not be lost to caution.
    render(await strip({ signals: 0 }));
    expect(screen.getByText(/^No signals$/i)).toBeInTheDocument();
  });

  it('counts them when there are some', async () => {
    render(await strip({ signals: 4 }));
    expect(screen.getByText(/4 signals/i)).toBeInTheDocument();
  });
});

describe('quiet is only claimed when something checked', () => {
  it('shows the quiet line when the queue was read and was empty', async () => {
    // `isQuiet` is `queue !== null && queue.waiting === 0` — already correct.
    render(await strip({ isQuiet: true }));
    expect(screen.getByText(/nothing needs you/i)).toBeInTheDocument();
  });

  it('says the waiting count is unavailable rather than dropping the clause', async () => {
    /*
     * It used to render nothing. The argument was that a primary count beside
     * it always renders, so an absence could not read as calm — but that is a
     * layout fact. Reorder the strip and the silence is a reassuring answer
     * given by nobody.
     */
    render(await strip({ waiting: null }));
    expect(screen.getByText(/waiting count unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting on you/i)).toBeNull();
  });

  it('still counts them when the read succeeded', async () => {
    render(await strip({ waiting: 3 }));
    expect(screen.getByText(/3 waiting on you/i)).toBeInTheDocument();
  });
});

describe('★ 01d — the signals pill opens the notifications panel', () => {
  it('links to Home with the panel open', async () => {
    render(await strip({ signals: 2 }));
    expect(screen.getByTestId('signals')).toHaveAttribute('href', '/home?notifications=1');
    expect(screen.getByTestId('signals')).toHaveTextContent('2 signals');
  });
});

describe('★ 01b — the quiet strip names the last handover, as "—"', () => {
  it('quiet: "Last handover —" with why', async () => {
    render(await strip({ isQuiet: true, waiting: 0 }));
    expect(screen.getByTestId('last-handover')).toHaveTextContent('Last handover —');
    expect(screen.getByTestId('last-handover')).toHaveAttribute(
      'title',
      expect.stringMatching(/Nothing records/),
    );
  });

  it('busy: not drawn', async () => {
    render(await strip({ isQuiet: false }));
    expect(screen.queryByTestId('last-handover')).toBeNull();
  });
});

describe('★ 01c — the day-one status line', () => {
  it('not live yet, and the trial', async () => {
    render(await strip({ dayOne: { trialDays: 14 } }));
    expect(screen.getByTestId('setup-pill')).toHaveTextContent('Setting up · not live yet');
    expect(screen.getByTestId('setup-pill')).not.toHaveTextContent(/only to your team/);
    expect(screen.getByTestId('trial')).toHaveTextContent('Trial · 14 days left');
    expect(screen.queryByTestId('signals')).toBeNull();
  });

  it('no trial: no trial line', async () => {
    render(await strip({ dayOne: { trialDays: null } }));
    expect(screen.queryByTestId('trial')).toBeNull();
  });
});
