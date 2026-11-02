import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/notifications-settings.json';
import he from '@/i18n/messages/he/notifications-settings.json';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));
/* The person's own number: spies, always - nothing is sent. */
const actions = vi.hoisted(() => ({
  sendWhatsAppCode: vi.fn(),
  confirmWhatsAppCode: vi.fn(),
  removeWhatsAppNumber: vi.fn(),
}));
vi.mock('./preference-actions', () => actions);

import { WhatsAppAlerts } from './WhatsAppAlerts';

const show = (phone: string | null, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ 'notifications-settings': locale === 'en' ? messages : he }}
    >
      <WhatsAppAlerts phone={phone} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  refresh.mockReset();
});

const typeNumber = async (value: string) => {
  fireEvent.click(screen.getByTestId('pref-whatsapp-edit'));
  fireEvent.change(screen.getByTestId('pref-whatsapp-number'), { target: { value } });
  await act(async () => fireEvent.click(screen.getByTestId('pref-whatsapp-send')));
};

describe('★★ where WhatsApp alerts go - a number kept only once its code comes back', () => {
  it('none yet: said, and "Add number"', () => {
    show(null);
    expect(screen.getByTestId('pref-whatsapp-value')).toHaveTextContent('No number set');
    expect(screen.getByTestId('pref-whatsapp-edit')).toHaveTextContent('Add number');
    expect(screen.queryByTestId('pref-whatsapp-remove')).toBeNull();
  });

  it('★★ the number, then the code: kept and the page reads again only once it is confirmed', async () => {
    actions.sendWhatsAppCode.mockResolvedValue({ ok: true, expiresInSeconds: 600 });
    actions.confirmWhatsAppCode.mockResolvedValue({ ok: true, preferences: {} });
    show(null);
    await typeNumber('054-123 4567');
    expect(actions.sendWhatsAppCode).toHaveBeenCalledWith('054-123 4567');
    expect(screen.getByTestId('pref-whatsapp-sent')).toHaveTextContent(
      'We sent a code on WhatsApp, valid for 10 minutes, to 054-123 4567',
    );
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('pref-whatsapp-code'), { target: { value: '123456' } });
    await act(async () => fireEvent.click(screen.getByTestId('pref-whatsapp-confirm')));
    expect(actions.confirmWhatsAppCode).toHaveBeenCalledWith('054-123 4567', '123456');
    expect(refresh).toHaveBeenCalled();
  });

  it('★ a refusal is said in its own words, and nothing moves on', async () => {
    actions.sendWhatsAppCode.mockResolvedValue({ ok: false, reason: 'rateLimited' });
    show(null);
    await typeNumber('054-123 4567');
    expect(screen.getByTestId('pref-whatsapp-problem')).toHaveTextContent(
      'Too many codes in a row',
    );
    expect(screen.queryByTestId('pref-whatsapp-code')).toBeNull();
  });

  it('★ a wrong code: said, the code form stays; "Send again" sends to the same number', async () => {
    actions.sendWhatsAppCode.mockResolvedValue({ ok: true, expiresInSeconds: 600 });
    actions.confirmWhatsAppCode.mockResolvedValue({ ok: false, reason: 'codeExpired' });
    show(null);
    await typeNumber('054-123 4567');
    fireEvent.change(screen.getByTestId('pref-whatsapp-code'), { target: { value: '111111' } });
    await act(async () => fireEvent.click(screen.getByTestId('pref-whatsapp-confirm')));
    expect(screen.getByTestId('pref-whatsapp-problem')).toHaveTextContent(
      'That code has expired. Send a new one.',
    );
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByTestId('pref-whatsapp-resend')));
    expect(actions.sendWhatsAppCode).toHaveBeenLastCalledWith('054-123 4567');
  });

  it('★★ a kept number: removed only once asked, saying alerts stop', async () => {
    actions.removeWhatsAppNumber.mockResolvedValue({ ok: true, preferences: {} });
    show('+972541234567');
    expect(screen.getByTestId('pref-whatsapp-value')).toHaveTextContent('+972541234567');
    fireEvent.click(screen.getByTestId('pref-whatsapp-remove'));
    expect(screen.getByTestId('pref-whatsapp-remove-ask')).toHaveTextContent(
      'WhatsApp alerts stop until you add one again',
    );
    expect(actions.removeWhatsAppNumber).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByTestId('pref-whatsapp-remove-yes')));
    expect(actions.removeWhatsAppNumber).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
  });

  it('in Hebrew, in Hebrew', async () => {
    actions.sendWhatsAppCode.mockResolvedValue({ ok: false, reason: 'invalid' });
    show(null, 'he');
    expect(screen.getByTestId('pref-whatsapp-value')).toHaveTextContent('לא הוגדר מספר');
    await typeNumber('abc');
    expect(screen.getByTestId('pref-whatsapp-problem')).toHaveTextContent('זה לא מספר טלפון');
  });
});
