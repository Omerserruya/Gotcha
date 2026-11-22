import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/workspace.json';
import he from '@/i18n/messages/he/workspace.json';

import { IdleRow } from './IdleRow';
import type { BotIdleSetup, IdleSetup } from './load-idle';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));

const show = (setup: IdleSetup, locale: 'en' | 'he' = 'en', bot?: BotIdleSetup) =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ workspace: locale === 'he' ? he : messages }}
    >
      <IdleRow setup={setup} bot={bot} />
    </NextIntlClientProvider>,
  );
const owner = (over: Record<string, unknown> = {}): IdleSetup => ({
  kind: 'owner',
  settings: {
    reminderEnabled: true,
    reminderDelayMinutes: 180,
    reminderMessage: 'Still there?',
    autoCloseEnabled: true,
    autoCloseDelayMinutes: 1440,
    autoCloseMessage: '',
    ...over,
  },
});

describe('★★ S3 - follow-up and auto-close’s row', () => {
  it('both on: each delay in its own words, and Edit opens the drawer', () => {
    show(owner());
    expect(screen.getByTestId('fact-value-idle')).toHaveTextContent(
      'Reminder after 3 hours · Close after 1 day',
    );
    expect(screen.getByTestId('fact-edit-idle')).toHaveAttribute(
      'href',
      JSON.stringify({ pathname: '/settings/workspace', query: { panel: 'idle' } }),
    );
  });

  it('only one on: only that one; neither: Off', () => {
    show(owner({ reminderEnabled: false }));
    expect(screen.getByTestId('fact-value-idle')).toHaveTextContent(/^Close after 1 day$/);
  });

  it('neither on', () => {
    show(owner({ reminderEnabled: false, autoCloseEnabled: false }));
    expect(screen.getByTestId('fact-value-idle')).toHaveTextContent(/^Off$/);
  });

  it('★★ anyone but an Owner: whose it is, no Edit', () => {
    show({ kind: 'forbidden' });
    expect(screen.getByTestId('fact-value-idle')).toHaveTextContent(
      'Only an Owner can see or change this.',
    );
    expect(screen.queryByTestId('fact-edit-idle')).toBeNull();
  });

  it('a failed read: said, no Edit', () => {
    show({ kind: 'failed' });
    expect(screen.queryByTestId('fact-edit-idle')).toBeNull();
  });

  it('in Hebrew, with its dual forms', () => {
    show(owner({ reminderDelayMinutes: 120, autoCloseDelayMinutes: 2880 }), 'he');
    expect(screen.getByTestId('fact-value-idle')).toHaveTextContent(
      'תזכורת אחרי שעתיים · סגירה אחרי יומיים',
    );
  });
});

const BOT: BotIdleSetup = {
  kind: 'read',
  groups: {
    liveChat: {
      enabled: true,
      reminderAfterMinutes: 10,
      closeAfterReminderMinutes: 10,
      reminderText: 'x',
      closeText: '',
      source: 'default',
    },
    messaging: {
      enabled: false,
      reminderAfterMinutes: 30,
      closeAfterReminderMinutes: 15,
      reminderText: 'x',
      closeText: '',
      source: 'custom',
    },
  },
};

describe('★★ the AI employee’s line, under the person-held one', () => {
  it('each group read: what it does, or off', () => {
    show(owner(), 'en', BOT);
    expect(screen.getByTestId('fact-value-idle-bot')).toHaveTextContent(
      /^AI employee: Chat - reminder after 10 minutes, close 10 minutes after it · Messaging - off$/,
    );
  });

  it('in Hebrew, the AI employee named with its non-breaking hyphen', () => {
    show(owner(), 'he', BOT);
    expect(screen.getByTestId('fact-value-idle-bot')).toHaveTextContent('עובד ה\u2011AI:');
  });

  it.each([
    ['unread', owner(), { kind: 'unread' } as BotIdleSetup],
    ['not released (flat route)', owner(), { kind: 'absent' } as BotIdleSetup],
    ['not an Owner', { kind: 'forbidden' } as IdleSetup, BOT],
    ['not given', owner(), undefined],
  ])('%s: no second line', (_, setup, bot) => {
    show(setup, 'en', bot);
    expect(screen.queryByTestId('fact-value-idle-bot')).toBeNull();
  });
});
