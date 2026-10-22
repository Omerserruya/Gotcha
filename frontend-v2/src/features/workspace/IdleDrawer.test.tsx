import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdleAutomation } from '@/api/contracts/idle-automation';
import messages from '@/i18n/messages/en/workspace.json';

import { IdleDrawer, minutesOf } from './IdleDrawer';

/** S3's drawer. The save is mocked: what it is asked to store. */
const { saveIdleAutomation } = vi.hoisted(() => ({ saveIdleAutomation: vi.fn() }));
vi.mock('./idle-actions', () => ({ saveIdleAutomation }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const settings: IdleAutomation = {
  reminderEnabled: false,
  reminderDelayMinutes: 60,
  reminderMessage: 'Hi, we didn’t hear back. Can we help with anything?',
  autoCloseEnabled: false,
  autoCloseDelayMinutes: 1440,
  autoCloseMessage: '',
};
const show = (s: IdleAutomation = settings) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ workspace: messages }}>
      <IdleDrawer settings={s} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  saveIdleAutomation.mockReset();
  saveIdleAutomation.mockResolvedValue({ ok: true });
});

describe('★★ S3 - the drawer saves exactly what it shows', () => {
  it('★★ the whole object, delays in minutes from count × unit', async () => {
    show();
    fireEvent.click(screen.getByTestId('idle-reminder-enabled'));
    fireEvent.change(screen.getByTestId('idle-reminder-count'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('idle-reminder-unit'), { target: { value: 'hours' } });
    fireEvent.click(screen.getByTestId('idle-close-enabled'));
    fireEvent.change(screen.getByTestId('idle-close-count'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    await waitFor(() => expect(saveIdleAutomation).toHaveBeenCalledTimes(1));
    expect(saveIdleAutomation).toHaveBeenCalledWith({
      reminderEnabled: true,
      reminderDelayMinutes: 180,
      reminderMessage: settings.reminderMessage,
      autoCloseEnabled: true,
      autoCloseDelayMinutes: 2880,
      autoCloseMessage: '',
    });
    expect(await screen.findByTestId('idle-saved')).toBeInTheDocument();
  });

  it('opens on the stored delays in their own units', () => {
    show({ ...settings, reminderDelayMinutes: 180 });
    expect(screen.getByTestId('idle-reminder-count')).toHaveValue('3');
    expect(screen.getByTestId('idle-reminder-unit')).toHaveValue('hours');
    expect(screen.getByTestId('idle-close-count')).toHaveValue('1');
    expect(screen.getByTestId('idle-close-unit')).toHaveValue('days');
  });

  it.each([
    ['idle-reminder-count', '0'],
    ['idle-reminder-count', '1.5'],
    ['idle-close-count', '8'],
  ])('★★ %s = %s is refused before anything is sent', async (field, value) => {
    show();
    fireEvent.change(screen.getByTestId(field), { target: { value } });
    if (field === 'idle-close-count') {
      fireEvent.change(screen.getByTestId('idle-close-unit'), { target: { value: 'days' } });
    }
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    expect(await screen.findByTestId('idle-problem')).toHaveTextContent(
      'Fix the highlighted values first.',
    );
    expect(saveIdleAutomation).not.toHaveBeenCalled();
  });

  it('★ a reminder that is on needs words - an empty one is never sent', async () => {
    show({ ...settings, reminderMessage: '' });
    fireEvent.click(screen.getByTestId('idle-reminder-enabled'));
    expect(screen.getByTestId('idle-reminder-message-problem')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    expect(await screen.findByTestId('idle-problem')).toBeInTheDocument();
    expect(saveIdleAutomation).not.toHaveBeenCalled();
  });

  it('★★ says what the platform does: whose, WhatsApp, and when the close counts', () => {
    show({ ...settings, reminderEnabled: true, autoCloseEnabled: true, reminderDelayMinutes: 180 });
    expect(screen.getByTestId('idle-who')).toHaveTextContent('assigned to a person');
    expect(screen.getByTestId('idle-whatsapp-reminder')).toHaveTextContent(
      'On WhatsApp, after 24 hours the reminder is not sent, unless there is an approved follow-up template.',
    );
    expect(screen.getByTestId('idle-close-timing')).toHaveTextContent(
      '3 hours to the reminder, then 1 day more.',
    );
  });

  it('a refusal is said in words, not "saved"', async () => {
    saveIdleAutomation.mockResolvedValue({ ok: false, reason: 'forbidden' });
    show();
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    expect(await screen.findByTestId('idle-problem')).toHaveTextContent(
      'Only an Owner can change this.',
    );
    expect(screen.queryByTestId('idle-saved')).toBeNull();
  });
});

describe('minutesOf', () => {
  it('count × unit, whole numbers within seven days', () => {
    expect(minutesOf({ count: '7', unit: 'days' })).toBe(10080);
    expect(minutesOf({ count: '8', unit: 'days' })).toBeNull();
    expect(minutesOf({ count: '', unit: 'minutes' })).toBeNull();
  });
});
