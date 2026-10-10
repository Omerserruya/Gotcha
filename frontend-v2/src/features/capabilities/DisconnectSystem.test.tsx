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

describe('★★ ai 9d583f03 - Shopify disconnects here, and says what it does not do', () => {
  it('the confirmation: the chat stops now; the app stays installed and Shopify keeps billing', async () => {
    show('shopify', 'Shopify');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    expect(disconnectSystem).not.toHaveBeenCalled();
    expect(screen.getByTestId('disconnect-what')).toHaveTextContent(
      'GOTCHA will stop using Shopify: the chat in your store stops now, and its actions stop working. The GOTCHA app stays installed in Shopify, and Shopify keeps billing for it until you remove the app in your Shopify admin. Connecting again later links the store afresh.',
    );
  });

  it.each([
    [true, { system: 'shopify', disconnected: '1', chat: 'off' }],
    [false, { system: 'shopify', disconnected: '1' }],
  ])('done (chatDisabled %s): the landing says it', async (chatDisabled, query) => {
    disconnectSystem.mockResolvedValue({ ok: true, chatDisabled });
    show('shopify', 'Shopify');
    await userEvent.click(screen.getByTestId('disconnect-start'));
    await userEvent.click(screen.getByTestId('disconnect-confirm'));
    expect(disconnectSystem).toHaveBeenCalledExactlyOnceWith('shopify');
    expect(replace).toHaveBeenCalledExactlyOnceWith(
      { pathname: '/studio/capabilities', query },
      { scroll: false },
    );
  });

  it('Hebrew: Shopify is feminine and keeps billing until the app is removed there', () => {
    expect(heMessages.disconnect.confirmShopify).toBe(
      'GOTCHA תפסיק להשתמש ב‑{name}: הצ׳אט בחנות נעצר עכשיו, והפעולות שלה יפסיקו לעבוד. האפליקציה של GOTCHA נשארת מותקנת ב‑Shopify, ו‑Shopify ממשיכה לחייב עליה עד שמסירים את האפליקציה מהניהול של Shopify. חיבור מחדש בהמשך יקשר את החנות מחדש.',
    );
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
