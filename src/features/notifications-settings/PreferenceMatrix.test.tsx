import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { notificationPreferencesSchema } from '@/api/contracts/notifications';
import messages from '@/i18n/messages/en/notifications-settings.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'notifications-settings.matrix') =>
    createTranslator({
      locale: 'en',
      messages: { 'notifications-settings': messages },
      namespace,
    }),
  getFormatter: async () => createFormatter({ locale: 'en' }),
}));

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ refresh }),
}));
/* A real write to the person's own row: a spy, always. */
const save = vi.hoisted(() => vi.fn());
vi.mock('./preference-actions', () => ({ savePreferenceSwitch: save }));

import { PreferenceMatrix } from './PreferenceMatrix';

// The switches are client components: they read their words from the provider.
const render = (ui: ReactNode) =>
  rtlRender(
    <NextIntlClientProvider locale="en" messages={{ 'notifications-settings': messages }}>
      {ui}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  save.mockReset();
  refresh.mockReset();
});

const prefs = (over: Record<string, unknown> = {}) =>
  notificationPreferencesSchema.parse({ inApp: true, email: false, whatsapp: true, ...over });

describe('★ 15 - "Tell me when" × the channels', () => {
  it('★ a cell is the channel reaching you - approvals also need the approvals switch', async () => {
    render(
      await PreferenceMatrix({
        preferences: prefs({ approvals: false }),
        volume: null,
        whatsappDestination: null,
      }),
    );
    expect(screen.getByTestId('pref-campaign-inApp')).toHaveAttribute('data-on', 'yes');
    expect(screen.getByTestId('pref-campaign-email')).toHaveAttribute('data-on', 'no');
    // Approvals are off for this person, whatever the channel says.
    expect(screen.getByTestId('pref-approval-inApp')).toHaveAttribute('data-on', 'no');
  });

  it('★★ a row no event sends is "-", never an "off" switch', async () => {
    render(
      await PreferenceMatrix({ preferences: prefs(), volume: null, whatsappDestination: null }),
    );
    const row = screen.getByTestId('pref-row-employeeDown');
    expect(row).toHaveTextContent('Nothing sends this yet');
    expect(row.querySelectorAll('[role="img"]')).toHaveLength(0);
    expect(row.textContent?.match(/-/g)).toHaveLength(3);
  });

  it('⚠ a failed preferences read is "-" everywhere, not every switch off', async () => {
    render(await PreferenceMatrix({ preferences: null, volume: null, whatsappDestination: null }));
    expect(screen.queryByTestId('pref-campaign-inApp')).toBeNull();
    expect(screen.getByTestId('pref-quiet')).toHaveTextContent('-');
  });

  it('the cards: the window, where WhatsApp goes, and how many - "at least" when it is', async () => {
    render(
      await PreferenceMatrix({
        preferences: prefs({ quietHours: { from: '21:00', to: '08:00' } }),
        volume: { count: 42, days: 7, atLeast: true, perDay: 6 },
        whatsappDestination: '+972 54 220 8814',
      }),
    );
    expect(screen.getByTestId('pref-quiet')).toHaveTextContent('21:00 - 08:00');
    expect(screen.getByTestId('pref-whatsapp')).toHaveTextContent('+972 54 220 8814');
    expect(screen.getByTestId('pref-volume')).toHaveTextContent('You get at least 6 a day');
  });
});

describe('★ 15 corrections (measurement of 204d715)', () => {
  const volume = (count: number, atLeast = false) => ({
    count,
    days: 7,
    atLeast,
    perDay: Math.round(count / 7),
  });

  it('zero is "nothing reached you", never "about 0 a day"', async () => {
    render(
      await PreferenceMatrix({
        preferences: prefs(),
        volume: volume(0),
        whatsappDestination: null,
      }),
    );
    const card = screen.getByTestId('pref-volume');
    expect(card).toHaveTextContent('Nothing reached you in the last 7 days.');
    expect(card).not.toHaveTextContent(/about|Counted/);
  });

  it('a non-zero count keeps "about"', async () => {
    render(
      await PreferenceMatrix({
        preferences: prefs(),
        volume: volume(42),
        whatsappDestination: null,
      }),
    );
    expect(screen.getByTestId('pref-volume')).toHaveTextContent('You get about 6 a day');
  });

  it('02’s line under a live event; a dead one keeps "Nothing sends this yet"', async () => {
    render(
      await PreferenceMatrix({ preferences: prefs(), volume: null, whatsappDestination: null }),
    );
    expect(screen.getByTestId('pref-about-systemDown')).toHaveTextContent('Shopify, CRM, returns');
    // No count behind approvals, so no "3 so far today".
    expect(screen.getByTestId('pref-row-approval')).not.toHaveTextContent(/today/);
    expect(screen.getByTestId('pref-row-employeeDown')).toHaveTextContent('Nothing sends this yet');
    // tool.action_failed is emitted (refund, discount, meeting errors): its marks, like the others.
    expect(screen.getByTestId('pref-row-actionFailed')).not.toHaveTextContent(
      'Nothing sends this yet',
    );
    expect(screen.getByTestId('pref-actionFailed-email')).toHaveAttribute('role', 'img');
  });

  it('the foot leads to the workspace’s rules', async () => {
    render(
      await PreferenceMatrix({ preferences: prefs(), volume: null, whatsappDestination: null }),
    );
    expect(screen.getByTestId('pref-rules-link')).toHaveAttribute(
      'href',
      '/settings/notifications/rules',
    );
  });
});

describe('★★ 15 - the switches the platform has: a channel for everything, and approvals', () => {
  const show = async (
    over: Record<string, unknown> = {},
    number: string | null = '+972 54 220 8814',
  ) =>
    render(
      await PreferenceMatrix({
        preferences: prefs(over),
        volume: null,
        whatsappDestination: number,
      }),
    );

  it('one switch per channel, in its column’s head, set as stored; approvals on its row', async () => {
    await show({ approvals: false });
    expect(screen.getByTestId('pref-switch-inApp')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('pref-switch-email')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('pref-switch-approvals')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('pref-switch-email')).toHaveAccessibleName(
      'Email, for everything below',
    );
    expect(screen.getByTestId('pref-row-approval')).toContainElement(
      screen.getByTestId('pref-switch-approvals'),
    );
  });

  it('★ a cell is what reaches you - a mark, never a control', async () => {
    await show();
    const cell = screen.getByTestId('pref-campaign-email');
    expect(cell.tagName).not.toBe('BUTTON');
    expect(cell).not.toHaveAttribute('role', 'switch');
    expect(screen.getByTestId('pref-row-campaign').querySelectorAll('button')).toHaveLength(0);
  });

  it('a switch saves only its own key; the page reads again', async () => {
    save.mockResolvedValueOnce({ ok: true, preferences: prefs({ email: true }) });
    await show();
    await act(async () => {
      fireEvent.click(screen.getByTestId('pref-switch-email'));
    });
    expect(save).toHaveBeenCalledWith('email', true);
    expect(screen.getByTestId('pref-switch-email')).toHaveAttribute('aria-checked', 'true');
    expect(refresh).toHaveBeenCalled();
  });

  it('a refused save goes back, and says so', async () => {
    save.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    await show();
    await act(async () => {
      fireEvent.click(screen.getByTestId('pref-switch-inApp'));
    });
    expect(save).toHaveBeenCalledWith('inApp', false);
    expect(screen.getByTestId('pref-switch-inApp')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('pref-switch-inApp-problem')).toHaveTextContent('Not saved');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('★ WhatsApp alerts to a person do not exist: a status, with or without a number - its cells "-"', async () => {
    for (const [stored, number] of [
      [true, '+972 54 220 8814'],
      [false, null],
    ] as const) {
      const { unmount } = await show({ whatsapp: stored }, number);
      expect(screen.queryByTestId('pref-switch-whatsapp')).toBeNull();
      const status = screen.getByTestId('pref-switch-whatsapp-unavailable');
      expect(status).toHaveAttribute('aria-disabled', 'true');
      expect(status).toHaveTextContent('Not available yet');
      // Never a mark saying WhatsApp reaches you.
      expect(screen.queryByTestId('pref-campaign-whatsapp')).toBeNull();
      expect(screen.getByTestId('pref-row-campaign')).toHaveTextContent('-');
      unmount();
    }
  });

  it('preferences not read: no switches at all - never a guess to save over', async () => {
    render(await PreferenceMatrix({ preferences: null, volume: null, whatsappDestination: null }));
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
