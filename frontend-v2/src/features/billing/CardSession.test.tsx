import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/billing.json';

/* Starting a session reaches the provider: a spy, always. */
const startCardSession = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ startCardSession }));

import { CARD_SESSION_KEY } from './card-session';
import { CardSession } from './CardSession';

const assign = vi.fn();
beforeEach(() => {
  startCardSession.mockReset();
  assign.mockReset();
  sessionStorage.clear();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const show = (live: boolean) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ billing: messages }}>
      <CardSession
        live={live}
        label="Add card"
        sentence="This opens the payment provider's secure page to save a card."
        heldTag="Not available here"
        heldWhy="Billing in this environment uses the live payment account."
        testid="add-card"
      />
    </NextIntlClientProvider>,
  );

describe('★★ 17e card session - live only where billing writes are on', () => {
  it('off: the held confirm - Yes is a status, nothing started', async () => {
    show(false);
    await userEvent.click(screen.getByTestId('add-card'));
    const yes = screen.getByTestId('add-card-yes');
    expect(yes.tagName).toBe('SPAN');
    expect(yes).toHaveAttribute('aria-disabled', 'true');
    expect(startCardSession).not.toHaveBeenCalled();
  });

  it('on: the sentence first; Yes starts the session, keeps its id, and goes to the secure page', async () => {
    startCardSession.mockResolvedValue({
      ok: true,
      redirectUrl: 'https://pay.example/p/1',
      sessionId: 's1',
    });
    show(true);
    await userEvent.click(screen.getByTestId('add-card'));
    expect(screen.getByTestId('add-card-confirm')).toHaveTextContent('secure page to save a card');
    expect(startCardSession).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('add-card-yes'));
    expect(startCardSession).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CARD_SESSION_KEY)).toBe('s1');
    expect(assign).toHaveBeenCalledWith('https://pay.example/p/1');
  });

  it('a refusal is said and the page is not left', async () => {
    startCardSession.mockResolvedValue({ ok: false, reason: 'unavailable' });
    show(true);
    await userEvent.click(screen.getByTestId('add-card'));
    await userEvent.click(screen.getByTestId('add-card-yes'));
    expect(screen.getByTestId('add-card-problem')).toHaveTextContent(
      "Adding a card isn't available right now",
    );
    expect(assign).not.toHaveBeenCalled();
  });
});
