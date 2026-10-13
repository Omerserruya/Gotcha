import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/workspace.json';
import he from '@/i18n/messages/he/workspace.json';

import { IdleRow } from './IdleRow';
import type { IdleSetup } from './load-idle';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));

const show = (setup: IdleSetup, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ workspace: locale === 'he' ? he : messages }}
    >
      <IdleRow setup={setup} />
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
