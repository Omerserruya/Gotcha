import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/capabilities.json';
import heMessages from '@/i18n/messages/he/capabilities.json';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));
/* Disconnecting is real: the action is a spy. */
const disconnectSystem = vi.hoisted(() => vi.fn());
vi.mock('./connect-actions', () => ({ disconnectSystem }));

import { DisconnectSystem } from './DisconnectSystem';

const show = (slug: string, name: string, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ capabilities: locale === 'en' ? messages : heMessages }}
    >
      <DisconnectSystem slug={slug} name={name} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  disconnectSystem.mockReset();
  refresh.mockReset();
});

describe('★★ Disconnect - confirmed first, saying what stops', () => {
  it('the first press only asks; the confirmation says exactly what the route does', async () => {
    show('pipedrive', 'Pipedrive');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    expect(disconnectSystem).not.toHaveBeenCalled();
    expect(screen.getByTestId('disconnect-what')).toHaveTextContent(
      'GOTCHA will stop using Pipedrive: its actions stop working and the sign-in details saved for it are deleted. Its action settings are not deleted.',
    );
  });

  it('confirmed: sent once, and the screen is read again', async () => {
    disconnectSystem.mockResolvedValue({ ok: true });
    show('pipedrive', 'Pipedrive');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    await userEvent.click(screen.getByTestId('disconnect-confirm'));
    expect(disconnectSystem).toHaveBeenCalledExactlyOnceWith('pipedrive');
    expect(refresh).toHaveBeenCalled();
  });

  it('kept: nothing is sent', async () => {
    show('pipedrive', 'Pipedrive');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    await userEvent.click(screen.getByTestId('disconnect-cancel'));
    expect(disconnectSystem).not.toHaveBeenCalled();
    expect(screen.getByTestId('disconnect-start')).toBeInTheDocument();
  });

  it.each([
    ['forbidden', "You don't have permission to disconnect systems."],
    ['inactive', 'Disconnecting needs an active workspace.'],
    ['failed', "Pipedrive wasn't disconnected. Try again."],
  ])('refused (%s): said in words, nothing refreshed', async (reason, words) => {
    disconnectSystem.mockResolvedValue({ ok: false, reason });
    show('pipedrive', 'Pipedrive');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    await userEvent.click(screen.getByTestId('disconnect-confirm'));
    expect(await screen.findByTestId('disconnect-problem')).toHaveTextContent(words);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Hebrew: GOTCHA is feminine, and the name follows a one-letter prefix unbroken', async () => {
    show('pipedrive', 'Pipedrive', 'he');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    expect(screen.getByTestId('disconnect-what')).toHaveTextContent(
      'GOTCHA תפסיק להשתמש ב‑Pipedrive',
    );
  });
});

describe('★★ Shopify and the calendars are a status, never a button', () => {
  it.each([
    [
      'shopify',
      'Shopify',
      'Shopify is disconnected by removing the GOTCHA app in your Shopify admin.',
    ],
    [
      'google_calendar',
      'Google Calendar',
      "A calendar is connected for each AI employee, and can't be disconnected from here yet.",
    ],
    [
      'calendly',
      'Calendly',
      "A calendar is connected for each AI employee, and can't be disconnected from here yet.",
    ],
  ])('%s: the reason, aria-disabled, nothing to press', (slug, name, why) => {
    show(slug, name);
    const status = screen.getByTestId('disconnect-unavailable');
    expect(status).toHaveAttribute('aria-disabled', 'true');
    expect(status).toHaveAttribute('title', why);
    expect(screen.getByTestId('disconnect').querySelector('button')).toBeNull();
  });
});
