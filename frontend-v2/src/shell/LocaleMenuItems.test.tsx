import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type * as Navigation from 'next/navigation';
import { Component, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Menu, MenuContent, MenuTrigger } from '@/design-system/primitives/overlay/Menu';
import common from '@/i18n/messages/en/common.json';

/**
 * ★★ THE personal language switch (Omer, 2026-10-11). Every write is
 * mocked: nothing here reaches the platform.
 */
const { saveMyLanguage, replace, warn } = vi.hoisted(() => ({
  saveMyLanguage: vi.fn(),
  replace: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('./locale-actions', () => ({ saveMyLanguage }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/settings/people',
}));
vi.mock('next/navigation', async (actual) => ({
  ...(await actual<typeof Navigation>()),
  // 12d's drawer open, and a repeated key: both must survive the switch.
  useSearchParams: () => new URLSearchParams('person=u1&tag=a&tag=b'),
}));

import { redirect } from 'next/navigation';

import { LocaleMenuItems } from './LocaleMenuItems';
import { useInterfaceLanguage } from './use-interface-language';

beforeEach(() => {
  saveMyLanguage.mockReset();
  saveMyLanguage.mockResolvedValue({ ok: true });
  replace.mockReset();
  warn.mockReset();
});

const intl = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={{ common }}>
    {children}
  </NextIntlClientProvider>
);

const menu = () =>
  render(
    <Menu open>
      <MenuTrigger>open</MenuTrigger>
      <MenuContent>
        <LocaleMenuItems />
      </MenuContent>
    </Menu>,
    { wrapper: intl },
  );

const SWITCHED = [
  { pathname: '/settings/people', query: { person: 'u1', tag: ['a', 'b'] } },
  { locale: 'he' },
];

describe('★★ the account menu is the personal switch', () => {
  it('the current language is checked; the other is not', () => {
    menu();
    const en = screen.getByTestId('locale-en');
    const he = screen.getByTestId('locale-he');
    expect(en).toHaveAttribute('role', 'menuitemradio');
    expect(en).toHaveAttribute('aria-checked', 'true');
    expect(he).toHaveAttribute('aria-checked', 'false');
    expect(he).toHaveTextContent('עברית');
  });

  it('★★ choosing one keeps it on the account FIRST, then reopens this page in it, query kept', async () => {
    let keep!: (value: { ok: true }) => void;
    saveMyLanguage.mockReturnValueOnce(new Promise((resolve) => (keep = resolve)));
    menu();
    await userEvent.click(screen.getByTestId('locale-he'));
    expect(saveMyLanguage).toHaveBeenCalledWith('he');
    // Not before the keep has answered.
    expect(replace).not.toHaveBeenCalled();
    await act(async () => keep({ ok: true }));
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith(...SWITCHED);
    expect(warn).not.toHaveBeenCalled();
  });

  it('choosing the language already shown: no write, no navigation', async () => {
    menu();
    await userEvent.click(screen.getByTestId('locale-en'));
    expect(saveMyLanguage).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('⚠ a keep that fails still switches the page, quietly, and is logged', () => {
  it('the platform refused: switched, logged', async () => {
    saveMyLanguage.mockResolvedValueOnce({ ok: false });
    menu();
    await userEvent.click(screen.getByTestId('locale-he'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(...SWITCHED));
    expect(warn).toHaveBeenCalledWith('shell.my_locale_not_kept', { locale: 'he' });
  });

  it('the action never answered (the network): switched, logged', async () => {
    saveMyLanguage.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    menu();
    await userEvent.click(screen.getByTestId('locale-he'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(...SWITCHED));
    expect(warn).toHaveBeenCalledWith(
      'shell.my_locale_not_kept',
      expect.objectContaining({ locale: 'he' }),
    );
  });
});

/** Catches what the transition rethrows, so the test can look at it. */
class Caught extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    return this.state.error ? <p data-testid="caught" /> : this.props.children;
  }
}

describe('★ one navigation, never two', () => {
  it('signed out: the action’s redirect to sign-in is let through, and the page is NOT switched', async () => {
    let signIn: unknown;
    try {
      redirect('/api/auth/login');
    } catch (error) {
      signIn = error;
    }
    saveMyLanguage.mockRejectedValueOnce(signIn);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useInterfaceLanguage(), {
      wrapper: ({ children }) => intl({ children: <Caught>{children}</Caught> }),
    });
    act(() => result.current.choose('he'));
    expect(await screen.findByTestId('caught')).toBeInTheDocument();
    quiet.mockRestore();
    expect(replace).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a second choice while the first is in flight is dropped', async () => {
    let keep!: (value: { ok: true }) => void;
    saveMyLanguage.mockReturnValueOnce(new Promise((resolve) => (keep = resolve)));
    const { result } = renderHook(() => useInterfaceLanguage(), { wrapper: intl });
    act(() => {
      result.current.choose('he');
      result.current.choose('he');
    });
    await act(async () => keep({ ok: true }));
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(saveMyLanguage).toHaveBeenCalledTimes(1);
  });
});
