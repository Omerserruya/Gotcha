import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { identityLinksSchema } from '@/api/contracts/identity';
import channels from '@/i18n/messages/en/channels.json';
import customers from '@/i18n/messages/en/customers.json';
import he from '@/i18n/messages/he/customers.json';
import heChannels from '@/i18n/messages/he/channels.json';

import { LinkedAccounts } from './LinkedAccounts';

/** F1 (Omer, 2026-10-13). The unlink write is mocked: what it is asked. */
const { unlinkContacts, refresh } = vi.hoisted(() => ({
  unlinkContacts: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('./identity-actions', () => ({ unlinkContacts }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/* The route's answer for Dana on WhatsApp, as Backend 196fea72 shapes it. */
const LINKS = identityLinksSchema.parse({
  personId: 'p1',
  linked: [
    {
      contactId: 'ig1',
      label: 'dana.k',
      channel: 'INSTAGRAM',
      link: {
        id: 'l1',
        contactIds: ['me', 'ig1'],
        signal: 'same_name',
        fromSignal: null,
        automatic: true,
        at: '2026-10-01T09:00:00.000Z',
        by: 'auto:link',
        direct: true,
        evidence: { type: 'name', names: ['Dana K', 'Dana K'] },
      },
      unlink: { contactIds: ['me', 'ig1'] },
    },
    {
      contactId: 'em1',
      label: 'Dana Kaplan',
      channel: 'EMAIL',
      link: {
        id: 'l2',
        contactIds: ['ig1', 'em1'],
        signal: 'unproven_identifier',
        automatic: false,
        at: null,
        direct: false,
        evidence: { type: 'email', value: 'd***@gmail.com' },
      },
      unlink: null,
    },
    { contactId: 42, label: 'broken row' },
  ],
});

const show = (links = LINKS as typeof LINKS | null, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      timeZone="Asia/Jerusalem"
      messages={locale === 'he' ? { customers: he, channels: heChannels } : { customers, channels }}
    >
      <LinkedAccounts links={links} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  unlinkContacts.mockReset();
  refresh.mockReset();
});

describe('★★ each linked account: its channel, its name, how it was linked', () => {
  it('a row per account the read could parse - a broken row is left out, not the list', () => {
    show();
    expect(screen.getByTestId('link-ig1')).toBeInTheDocument();
    expect(screen.getByTestId('link-em1')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid^="link-name-"]')).toHaveLength(2);
  });

  it('★ the name links to that customer, with its channel mark', () => {
    show();
    const name = screen.getByTestId('link-name-ig1');
    expect(name).toHaveAttribute('href', '/customers/ig1');
    expect(name.querySelector('[data-glyph="instagram"]')).not.toBeNull();
    expect(name).toHaveTextContent('dana.k');
  });

  it('★★ how: the duplicates card’s reason and proof, automatic or by a person, and when', () => {
    show();
    expect(screen.getByTestId('link-why-ig1')).toHaveTextContent('The same name on two channels.');
    expect(screen.getByTestId('link-how-ig1')).toHaveTextContent(
      /^Linked automatically · on Oct 1$/,
    );
    expect(screen.getByTestId('link-why-em1')).toHaveTextContent('The same email address.');
    expect(screen.getByTestId('link-em1')).toHaveTextContent('d***@gmail.com');
  });

  it('★★ joined through another account: says which', () => {
    show();
    expect(screen.getByTestId('link-how-em1')).toHaveTextContent(
      /^Linked by a person · through dana\.k$/,
    );
  });

  it('nothing linked: no block; a failed read: said', () => {
    const { unmount } = show({ personId: null, linked: [] });
    expect(screen.queryByTestId('customer-links')).toBeNull();
    unmount();
    show(null);
    expect(screen.getByTestId('customer-links-unavailable')).toBeInTheDocument();
  });
});

describe('★★ "Unlink" asks first, and sends the link’s own body', () => {
  it('★ no unlink body: no button', () => {
    show();
    expect(screen.queryByTestId('unlink-em1')).toBeNull();
  });

  it('★★ asks, Cancel sends nothing, the yes sends exactly the offered pair', async () => {
    show();
    fireEvent.click(screen.getByTestId('unlink-ig1'));
    expect(screen.getByTestId('link-ig1')).toHaveTextContent(
      'Unlink dana.k? They will show as a separate customer again.',
    );
    fireEvent.click(screen.getByTestId('unlink-cancel-ig1'));
    expect(unlinkContacts).not.toHaveBeenCalled();

    unlinkContacts.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByTestId('unlink-ig1'));
    fireEvent.click(screen.getByTestId('unlink-confirm-ig1'));
    await waitFor(() => expect(unlinkContacts).toHaveBeenCalledWith(['me', 'ig1']));
    expect(await screen.findByTestId('link-undone-ig1')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('a refusal is said in words', async () => {
    unlinkContacts.mockResolvedValueOnce({ ok: false, reason: 'not_linked' });
    show();
    fireEvent.click(screen.getByTestId('unlink-ig1'));
    fireEvent.click(screen.getByTestId('unlink-confirm-ig1'));
    expect(await screen.findByTestId('unlink-problem-ig1')).toHaveTextContent(
      'This link no longer exists.',
    );
  });

  it('in Hebrew', () => {
    show(LINKS, 'he');
    expect(screen.getByTestId('unlink-ig1')).toHaveTextContent('ביטול צימוד');
    expect(screen.getByTestId('link-how-ig1')).toHaveTextContent('קושר אוטומטית');
  });
});
