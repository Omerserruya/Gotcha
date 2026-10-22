import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/workspace.json';
import he from '@/i18n/messages/he/workspace.json';

import type { SlaSetup } from './load-sla-setup';
import { SlaRow } from './SlaRow';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));

const show = (setup: SlaSetup, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ workspace: locale === 'he' ? he : messages }}
    >
      <SlaRow setup={setup} />
    </NextIntlClientProvider>,
  );
const owner = (
  enabled: boolean,
  slaMinutes: number | null,
  warningThreshold: number | null,
): SlaSetup => ({
  kind: 'owner',
  settings: { enabled, slaMinutes, warningThreshold },
});

describe('★★ W2 - the response target’s row', () => {
  it('on: the minutes and the warning, and Edit opens the drawer', () => {
    show(owner(true, 30, 70));
    expect(screen.getByTestId('fact-value-sla')).toHaveTextContent(
      'Reply within 30 min · warn at 70%',
    );
    expect(screen.getByTestId('fact-edit-sla')).toHaveAttribute(
      'href',
      JSON.stringify({ pathname: '/settings/workspace', query: { panel: 'sla' } }),
    );
  });

  it('on, no early warning: only the minutes', () => {
    show(owner(true, 15, null));
    expect(screen.getByTestId('fact-value-sla')).toHaveTextContent(/^Reply within 15 min$/);
  });

  it('off', () => {
    show(owner(false, 30, 70));
    expect(screen.getByTestId('fact-value-sla')).toHaveTextContent(/^Off$/);
  });

  it('★★ anyone but an Owner: whose it is, and no Edit that could not save', () => {
    show({ kind: 'forbidden' });
    expect(screen.getByTestId('fact-value-sla')).toHaveTextContent(
      'Only an Owner can see or change this.',
    );
    expect(screen.queryByTestId('fact-edit-sla')).toBeNull();
  });

  it('a failed read: said, and no Edit', () => {
    show({ kind: 'failed' });
    expect(screen.getByTestId('fact-value-sla')).toHaveTextContent(
      "We couldn't read this just now.",
    );
    expect(screen.queryByTestId('fact-edit-sla')).toBeNull();
  });

  it('in Hebrew', () => {
    show(owner(true, 30, 70), 'he');
    expect(screen.getByTestId('fact-value-sla')).toHaveTextContent('מענה תוך 30 דק׳ · התראה ב‑70%');
  });
});
