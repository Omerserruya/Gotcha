import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdleAutomation } from '@/api/contracts/idle-automation';
import messages from '@/i18n/messages/en/workspace.json';

import { IdleDrawer, minutesOf } from './IdleDrawer';
import type { BotIdleSetup } from './load-idle';

/** S3's drawer. The save is mocked: what it is asked to store. */
const { saveIdleAutomation, saveBotIdleAutomation } = vi.hoisted(() => ({
  saveIdleAutomation: vi.fn(),
  saveBotIdleAutomation: vi.fn(),
}));
vi.mock('./idle-actions', () => ({ saveIdleAutomation, saveBotIdleAutomation }));
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
    fireEvent.click(screen.getByTestId('idle-close-enabled'));
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

/** The AI employee's part (Omer, 2026-11-19): two groups, the server's values. */
const g = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  reminderAfterMinutes: 10,
  closeAfterReminderMinutes: 10,
  reminderText: 'Still here? You can pick this up any time.',
  closeText: 'We’ve closed this chat for now. You can write here again any time.',
  source: 'default' as const,
  ...over,
});
const READ: BotIdleSetup = {
  kind: 'read',
  groups: {
    liveChat: g(),
    messaging: g({ reminderAfterMinutes: 30, closeAfterReminderMinutes: 15 }),
  },
};
const showBoth = (bot: BotIdleSetup = READ) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ workspace: messages }}>
      <IdleDrawer settings={settings} bot={bot} />
    </NextIntlClientProvider>,
  );

describe('★★ the AI employee’s conversations: two groups, one Save, only what changed', () => {
  beforeEach(() => {
    saveBotIdleAutomation.mockReset();
    saveBotIdleAutomation.mockResolvedValue({ ok: true });
  });

  it('★★ two named parts; each group one closed row saying what happens today, and whose values', () => {
    showBoth();
    expect(screen.getByTestId('idle-part-person')).toHaveTextContent(
      'Conversations a person handles',
    );
    expect(screen.getByTestId('idle-part-bot')).toHaveTextContent(
      'Your AI employee’s conversations',
    );
    expect(screen.getByTestId('bot-idle-liveChat-summary')).toHaveTextContent(
      'A reminder after 10 minutes of quiet, and the close 10 minutes after it.',
    );
    expect(screen.getByTestId('bot-idle-messaging-summary')).toHaveTextContent(
      'A reminder after 30 minutes of quiet, and the close 15 minutes after it.',
    );
    expect(screen.getByTestId('bot-idle-liveChat-source')).toHaveTextContent('The default');
    expect(screen.getByTestId('bot-idle-liveChat-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByTestId('bot-idle-liveChat-body')).toBeNull();
    expect(screen.getByTestId('bot-idle-finished')).toBeInTheDocument();
  });

  it('★★ opening a group and saving untouched writes nothing at all', async () => {
    showBoth();
    fireEvent.click(screen.getByTestId('bot-idle-messaging-toggle'));
    expect(screen.getByTestId('bot-idle-messaging-reminder-count')).toHaveValue('30');
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    expect(await screen.findByTestId('idle-nothing')).toHaveTextContent('Nothing changed.');
    expect(saveIdleAutomation).not.toHaveBeenCalled();
    expect(saveBotIdleAutomation).not.toHaveBeenCalled();
  });

  it('★★ one changed group goes alone and whole; the person-held part is not sent', async () => {
    showBoth();
    fireEvent.click(screen.getByTestId('bot-idle-messaging-toggle'));
    fireEvent.change(screen.getByTestId('bot-idle-messaging-reminder-count'), {
      target: { value: '45' },
    });
    expect(screen.getByTestId('bot-idle-messaging-source')).toHaveTextContent('Not saved');
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    await waitFor(() => expect(saveBotIdleAutomation).toHaveBeenCalledTimes(1));
    expect(saveBotIdleAutomation).toHaveBeenCalledWith({
      messaging: {
        enabled: true,
        reminderAfterMinutes: 45,
        closeAfterReminderMinutes: 15,
        reminderText: READ.kind === 'read' ? READ.groups.messaging!.reminderText : '',
        closeText: READ.kind === 'read' ? READ.groups.messaging!.closeText : '',
      },
    });
    expect(saveIdleAutomation).not.toHaveBeenCalled();
    expect(await screen.findByTestId('idle-saved')).toBeInTheDocument();
    // Saved: the row says so, and what happens now.
    expect(screen.getByTestId('bot-idle-messaging-source')).toHaveTextContent('Your own');
    expect(screen.getByTestId('bot-idle-messaging-summary')).toHaveTextContent('45 minutes');
  });

  it('★ switching a group off sends it off, its values kept', async () => {
    showBoth();
    fireEvent.click(screen.getByTestId('bot-idle-liveChat-toggle'));
    fireEvent.click(screen.getByTestId('bot-idle-liveChat-enabled'));
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    await waitFor(() => expect(saveBotIdleAutomation).toHaveBeenCalledTimes(1));
    expect(saveBotIdleAutomation.mock.calls[0]![0]).toEqual({
      liveChat: expect.objectContaining({ enabled: false, reminderAfterMinutes: 10 }),
    });
    expect(await screen.findByTestId('bot-idle-liveChat-summary')).toHaveTextContent(
      'Off: these conversations don’t close by themselves.',
    );
  });

  it('★★ a closed group keeps its edits, and Save still sends them', async () => {
    showBoth();
    fireEvent.click(screen.getByTestId('bot-idle-liveChat-toggle'));
    fireEvent.change(screen.getByTestId('bot-idle-liveChat-close-text'), {
      target: { value: 'Bye for now.' },
    });
    fireEvent.click(screen.getByTestId('bot-idle-liveChat-toggle'));
    expect(screen.queryByTestId('bot-idle-liveChat-body')).toBeNull();
    fireEvent.click(screen.getByTestId('bot-idle-liveChat-toggle'));
    expect(screen.getByTestId('bot-idle-liveChat-close-text')).toHaveValue('Bye for now.');
    fireEvent.click(screen.getByTestId('bot-idle-liveChat-toggle'));
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    await waitFor(() => expect(saveBotIdleAutomation).toHaveBeenCalledTimes(1));
    expect(saveBotIdleAutomation.mock.calls[0]![0].liveChat.closeText).toBe('Bye for now.');
  });

  it('★★ a refused field in a closed group opens it and takes focus; nothing is sent', async () => {
    showBoth();
    fireEvent.click(screen.getByTestId('bot-idle-messaging-toggle'));
    fireEvent.change(screen.getByTestId('bot-idle-messaging-reminder-text'), {
      target: { value: '  ' },
    });
    fireEvent.click(screen.getByTestId('bot-idle-messaging-toggle'));
    expect(screen.queryByTestId('bot-idle-messaging-body')).toBeNull();
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    expect(await screen.findByTestId('idle-problem')).toHaveTextContent(
      'Fix the highlighted values first.',
    );
    expect(screen.getByTestId('bot-idle-messaging-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await waitFor(() =>
      expect(screen.getByTestId('bot-idle-messaging-reminder-text')).toHaveFocus(),
    );
    expect(saveBotIdleAutomation).not.toHaveBeenCalled();
    expect(saveIdleAutomation).not.toHaveBeenCalled();
  });

  it('★ both parts changed, one refused: the line names the part that did not save', async () => {
    saveBotIdleAutomation.mockResolvedValue({ ok: false, reason: 'failed' });
    showBoth();
    fireEvent.click(screen.getByTestId('idle-close-enabled'));
    fireEvent.click(screen.getByTestId('bot-idle-liveChat-toggle'));
    fireEvent.click(screen.getByTestId('bot-idle-liveChat-enabled'));
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    await waitFor(() => expect(saveBotIdleAutomation).toHaveBeenCalledTimes(1));
    expect(saveIdleAutomation).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('idle-problem')).toHaveTextContent(
      /^Your AI employee’s conversations: /,
    );
    expect(screen.getByTestId('idle-problem')).not.toHaveTextContent('a person handles');
    // The person-held part saved: a second Save sends only the group again.
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    await waitFor(() => expect(saveBotIdleAutomation).toHaveBeenCalledTimes(2));
    expect(saveIdleAutomation).toHaveBeenCalledTimes(1);
  });

  it('★★ not released (the flat route): no part, no heading, no error - and the person-held part saves as before', async () => {
    showBoth({ kind: 'absent' });
    expect(screen.queryByTestId('idle-part-bot')).toBeNull();
    expect(screen.queryByTestId('idle-part-person')).toBeNull();
    expect(screen.queryByTestId('bot-idle-unread')).toBeNull();
    expect(screen.queryByText(/AI employee/)).toBeNull();
    fireEvent.click(screen.getByTestId('idle-close-enabled'));
    fireEvent.click(screen.getByTestId('drawer-save-idle'));
    await waitFor(() => expect(saveIdleAutomation).toHaveBeenCalledTimes(1));
    expect(saveIdleAutomation.mock.calls[0]![0]).toMatchObject({ autoCloseEnabled: true });
    expect(saveBotIdleAutomation).not.toHaveBeenCalled();
    expect(await screen.findByTestId('idle-saved')).toBeInTheDocument();
  });

  it('a failed read: the part says so and offers nothing to change', () => {
    showBoth({ kind: 'unread' });
    expect(screen.getByTestId('bot-idle-unread')).toHaveTextContent(
      'We couldn’t read your AI employee’s settings just now',
    );
    expect(screen.queryByTestId('bot-idle-liveChat-toggle')).toBeNull();
  });

  it('one group unread: that group says so, the other is offered', () => {
    showBoth({ kind: 'read', groups: { liveChat: null, messaging: g() } });
    expect(screen.getByTestId('bot-idle-liveChat-unread')).toBeInTheDocument();
    expect(screen.queryByTestId('bot-idle-liveChat-toggle')).toBeNull();
    expect(screen.getByTestId('bot-idle-messaging-toggle')).toBeInTheDocument();
  });
});
