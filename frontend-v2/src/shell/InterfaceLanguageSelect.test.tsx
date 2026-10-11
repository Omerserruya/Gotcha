import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 12d's own-row switch: the account menu's switch in a select. Every write
 * is mocked: nothing here reaches the platform.
 */
const { saveMyLanguage, replace } = vi.hoisted(() => ({
  saveMyLanguage: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('./locale-actions', () => ({ saveMyLanguage }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/settings/people',
}));
vi.mock('next/navigation', () => ({
  unstable_rethrow: () => {},
  useSearchParams: () => new URLSearchParams('person=u1'),
}));

import { InterfaceLanguageSelect } from './InterfaceLanguageSelect';

beforeEach(() => {
  saveMyLanguage.mockReset();
  saveMyLanguage.mockResolvedValue({ ok: true });
  replace.mockReset();
});

const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{}}>
      <InterfaceLanguageSelect />
    </NextIntlClientProvider>,
  );

describe('★★ 12d - my own Interface language', () => {
  it('the language I see now, each named in itself', () => {
    show();
    const select = screen.getByTestId('person-language-mine') as HTMLSelectElement;
    expect(select.value).toBe('en');
    expect([...select.options].map((o) => o.textContent)).toEqual(['English', 'עברית']);
  });

  it('★★ choosing: kept on my account, then this drawer reopens in it; the choice shows while it saves', async () => {
    let keep!: (value: { ok: true }) => void;
    saveMyLanguage.mockReturnValueOnce(new Promise((resolve) => (keep = resolve)));
    show();
    const select = screen.getByTestId('person-language-mine') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'he');
    expect(saveMyLanguage).toHaveBeenCalledWith('he');
    expect(select.value).toBe('he');
    expect(select).toBeDisabled();
    expect(replace).not.toHaveBeenCalled();
    await act(async () => keep({ ok: true }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        { pathname: '/settings/people', query: { person: 'u1' } },
        { locale: 'he' },
      ),
    );
  });
});
