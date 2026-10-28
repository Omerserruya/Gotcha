import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/capabilities.json';
import heMessages from '@/i18n/messages/he/capabilities.json';

const replace = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/studio/capabilities',
}));
/* Disconnecting is real: the actions are spies. */
const disconnectSystem = vi.hoisted(() => vi.fn());
vi.mock('./connect-actions', () => ({ disconnectSystem }));
const uninstallShopify = vi.hoisted(() => vi.fn());
const readShopifyConnectorStatus = vi.hoisted(() => vi.fn());
vi.mock('./shopify-actions', () => ({ uninstallShopify, readShopifyConnectorStatus }));

import { DisconnectSystem } from './DisconnectSystem';
import { UNINSTALL_POLL_MS, UNINSTALL_POLL_TRIES } from './ShopifyUninstall';

const show = (slug: string, name: string, locale: 'en' | 'he' = 'en', pending = false) =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ capabilities: locale === 'en' ? messages : heMessages }}
    >
      <DisconnectSystem slug={slug} name={name} pending={pending} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  disconnectSystem.mockReset();
  uninstallShopify.mockReset();
  readShopifyConnectorStatus.mockReset();
  replace.mockReset();
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

  it('confirmed: sent once, and the screen is read again with what came of it', async () => {
    disconnectSystem.mockResolvedValue({ ok: true, chatDisabled: false });
    show('pipedrive', 'Pipedrive');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    await userEvent.click(screen.getByTestId('disconnect-confirm'));
    expect(disconnectSystem).toHaveBeenCalledExactlyOnceWith('pipedrive');
    expect(replace).toHaveBeenCalledExactlyOnceWith(
      { pathname: '/studio/capabilities', query: { system: 'pipedrive', disconnected: '1' } },
      { scroll: false },
    );
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
    expect(replace).not.toHaveBeenCalled();
  });

  it('Hebrew: GOTCHA is feminine, and the name follows a one-letter prefix unbroken', async () => {
    show('pipedrive', 'Pipedrive', 'he');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    expect(screen.getByTestId('disconnect-what')).toHaveTextContent(
      'GOTCHA תפסיק להשתמש ב‑Pipedrive',
    );
  });
});

describe('★★ split billing (132211) - Shopify is uninstalled through Shopify, then waits for it', () => {
  it('the confirmation says Shopify is asked, and that Shopify ends the Connector and its billing', async () => {
    show('shopify', 'Shopify');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    expect(uninstallShopify).not.toHaveBeenCalled();
    const what = screen.getByTestId('disconnect-what');
    expect(what).toHaveTextContent(
      'GOTCHA will ask Shopify to uninstall the GOTCHA app from your store. Once Shopify confirms, the chat in your store and every Shopify action stop, and Shopify ends the Shopify Connector subscription and its billing. Connecting again later starts afresh.',
    );
    // The old copy promised the opposite.
    expect(what).not.toHaveTextContent(/keeps billing|stays installed/i);
  });

  it('confirmed: the uninstall endpoint, never the local disconnect - and "Waiting for Shopify to confirm"', async () => {
    uninstallShopify.mockResolvedValue({ ok: true });
    readShopifyConnectorStatus.mockResolvedValue('uninstall_pending');
    show('shopify', 'Shopify');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    await userEvent.click(screen.getByTestId('disconnect-confirm'));
    expect(uninstallShopify).toHaveBeenCalledOnce();
    expect(disconnectSystem).not.toHaveBeenCalled();
    expect(screen.getByTestId('disconnect-awaiting')).toHaveTextContent(
      'Waiting for Shopify to confirm.',
    );
    // Not "disconnected" until the server says so.
    expect(replace).not.toHaveBeenCalled();
  });

  it('the landing says "disconnected" only once the server says the store is gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      readShopifyConnectorStatus
        .mockResolvedValueOnce('uninstall_pending')
        .mockResolvedValueOnce('uninstalled');
      show('shopify', 'Shopify', 'en', true);
      expect(screen.getByTestId('disconnect-awaiting')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(UNINSTALL_POLL_MS);
      expect(replace).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(UNINSTALL_POLL_MS);
      expect(replace).toHaveBeenCalledExactlyOnceWith(
        { pathname: '/studio/capabilities', query: { system: 'shopify', disconnected: '1' } },
        { scroll: false },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a reload during the wait (server: uninstall_pending) opens on the wait, with no Disconnect to press', () => {
    readShopifyConnectorStatus.mockResolvedValue('uninstall_pending');
    show('shopify', 'Shopify', 'en', true);
    expect(screen.getByTestId('disconnect-awaiting')).toBeInTheDocument();
    expect(screen.queryByTestId('disconnect-start')).toBeNull();
  });

  it('no confirmation after the last try: said, and "Check again" asks again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      readShopifyConnectorStatus.mockResolvedValue('uninstall_pending');
      show('shopify', 'Shopify', 'en', true);
      await vi.advanceTimersByTimeAsync(UNINSTALL_POLL_MS * UNINSTALL_POLL_TRIES);
      await screen.findByTestId('disconnect-check-again');
      expect(screen.getByTestId('disconnect-awaiting')).toHaveTextContent(
        "Shopify hasn't confirmed yet.",
      );
      const asked = readShopifyConnectorStatus.mock.calls.length;
      expect(asked).toBe(UNINSTALL_POLL_TRIES);
      screen.getByTestId('disconnect-check-again').click();
      await vi.advanceTimersByTimeAsync(UNINSTALL_POLL_MS);
      expect(readShopifyConnectorStatus.mock.calls.length).toBe(asked + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['not_connected', "There's no Shopify store connected to disconnect."],
    ['no_token', 'Remove the GOTCHA app in your Shopify admin, under Apps.'],
    ['no_shop_domain', 'Remove the GOTCHA app in your Shopify admin, under Apps.'],
    ['shopify_refused', "Shopify didn't accept the request, so nothing changed."],
    ['forbidden', "You don't have permission to disconnect systems."],
    ['failed', "Shopify wasn't asked to uninstall the app. Try again."],
  ])('refused %s: said in plain words, and no wait', async (reason, text) => {
    uninstallShopify.mockResolvedValue({ ok: false, reason });
    show('shopify', 'Shopify');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    await userEvent.click(screen.getByTestId('disconnect-confirm'));
    expect(screen.getByTestId('disconnect-problem')).toHaveTextContent(text);
    expect(screen.queryByTestId('disconnect-awaiting')).toBeNull();
  });

  it('Hebrew: Shopify is feminine, plural address, and the wait is said', () => {
    expect(heMessages.disconnect.confirmShopify).toBe(
      'GOTCHA תבקש מ‑Shopify להסיר את האפליקציה של GOTCHA מהחנות שלכם. ברגע ש‑Shopify תאשר, הצ׳אט בחנות וכל הפעולות ב‑Shopify ייעצרו, ו‑Shopify תסיים את המנוי ל‑Shopify Connector ואת החיוב עליו. חיבור מחדש בהמשך יתחיל מההתחלה.',
    );
    expect(heMessages.disconnect.shopify.awaiting).toMatch(/^ממתינים לאישור מ‑Shopify\./);
    expect(heMessages.landing.disconnected_chat_off).toBe('{name} נותקה, והצ׳אט בחנות כובה.');
  });
});

describe('★★ ai 547ec625 - a calendar disconnects here, and every AI employee’s calendar with it', () => {
  it.each([
    ['google_calendar', 'Google Calendar'],
    ['calendly', 'Calendly'],
  ])('%s: a button, and the confirmation says no employee books through it', async (slug, name) => {
    disconnectSystem.mockResolvedValue({ ok: true, chatDisabled: false });
    show(slug, name);
    await userEvent.click(screen.getByTestId('disconnect-start'));
    expect(disconnectSystem).not.toHaveBeenCalled();
    expect(screen.getByTestId('disconnect-what')).toHaveTextContent(
      `GOTCHA will stop using ${name}: its actions stop working, the sign-in details saved for it are deleted, and every AI employee's calendar is disconnected, so none of them books through it. Its action settings are not deleted.`,
    );
    await userEvent.click(screen.getByTestId('disconnect-confirm'));
    expect(disconnectSystem).toHaveBeenCalledExactlyOnceWith(slug);
  });

  it('Hebrew says it too', () => {
    expect(heMessages.disconnect.confirmCalendar).toContain('והיומן של כל עובד AI ינותק');
  });
});
