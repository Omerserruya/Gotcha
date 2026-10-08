import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { PersonName } from '@/features/customers/PersonName';
import { initialsOf } from '@/features/customers/CustomerScreen';
import { initials as queueInitials } from '@/features/home/queue-row';
import { initials as inboxInitials } from '@/features/inbox/initials';
import enCommon from '@/i18n/messages/en/common.json';
import heCommon from '@/i18n/messages/he/common.json';

import { personName, personNameLater, storedShopper } from '@/lib/shopper-name';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(),
  getLocale: vi.fn(),
  getFormatter: vi.fn(),
}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a', useRouter: vi.fn(), usePathname: vi.fn() }));
vi.mock('server-only', () => ({}));

const SHOPPER = 'Shopper on urban-supply-gotcha-demo.myshopify.com';
const SIGNED_IN = 'Signed-in shopper on urban-supply-gotcha-demo.myshopify.com';

describe('★★ a Shopify visitor stored as "Shopper on <shop>" reads as a website shopper', () => {
  it('only the exact stored pattern - a real name that starts with "Shopper" is a name', () => {
    expect(storedShopper(SHOPPER)).toBe('shopper');
    expect(storedShopper(SIGNED_IN)).toBe('signedInShopper');
    expect(storedShopper('Shopper Cohen')).toBeNull();
    expect(storedShopper('Shopper on my-shop.com')).toBeNull();
    expect(storedShopper('Dana Cohen')).toBeNull();
    expect(storedShopper(null)).toBeNull();
  });

  it('the words: the reader’s; a real name passes through untouched', async () => {
    const t = (kind: 'shopper' | 'signedInShopper') => enCommon.person[kind];
    expect(personName(SHOPPER, t)).toBe('Website shopper');
    expect(personName(SIGNED_IN, t)).toBe('Signed-in website shopper');
    expect(personName('Shopper Cohen', t)).toBe('Shopper Cohen');
    // A loader asks for words only when a stored shopper is there.
    const words = vi.fn(async () => t);
    expect(await personNameLater('Dana', words)).toBe('Dana');
    expect(words).not.toHaveBeenCalled();
    expect(await personNameLater(SHOPPER, words)).toBe('Website shopper');
  });

  it('on screen, in Hebrew: "קונה באתר" / "קונה מחובר באתר"; a name stays the data’s', () => {
    render(
      <NextIntlClientProvider locale="he" messages={{ common: heCommon }}>
        <span data-testid="a">
          <PersonName name={SHOPPER} />
        </span>
        <span data-testid="b">
          <PersonName name={SIGNED_IN} />
        </span>
        <span data-testid="c">
          <PersonName name="דנה כהן" />
        </span>
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('a')).toHaveTextContent(/^קונה באתר$/);
    expect(screen.getByTestId('b')).toHaveTextContent(/^קונה מחובר באתר$/);
    expect(screen.getByTestId('c')).toHaveTextContent('דנה כהן');
  });

  it('no "SO" in any avatar: the neutral, empty mark', () => {
    for (const make of [inboxInitials, queueInitials, initialsOf]) {
      expect(make(SHOPPER)).toBe('');
      expect(make(SIGNED_IN)).toBe('');
      expect(make('Dana Cohen')).toBe('DC');
    }
  });
});
