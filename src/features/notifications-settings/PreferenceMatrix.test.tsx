import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

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

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { PreferenceMatrix } from './PreferenceMatrix';

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
    const row = screen.getByTestId('pref-row-actionFailed');
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
    expect(screen.getByTestId('pref-row-actionFailed')).toHaveTextContent('Nothing sends this yet');
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
