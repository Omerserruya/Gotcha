import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import home from '@/i18n/messages/en/home.json';

/* Going live puts GOTCHA in front of real customers: the action is a spy. */
const goLive = vi.hoisted(() => vi.fn());
vi.mock('./go-live-action', () => ({ goLive }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { GoLiveButton } from './GoLiveButton';

beforeEach(() => {
  goLive.mockReset();
  refresh.mockReset();
});
const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ home }}>
      <GoLiveButton />
    </NextIntlClientProvider>,
  );

describe('★★ Go live asks once, then goes live', () => {
  it('the first press only asks; the second goes live and the page re-reads', async () => {
    goLive.mockResolvedValue({ ok: true });
    show();
    await userEvent.click(screen.getByTestId('go-live-button'));
    expect(goLive).not.toHaveBeenCalled();
    expect(screen.getByTestId('go-live-confirm')).toHaveTextContent(
      'GOTCHA starts answering real customers.',
    );
    await userEvent.click(screen.getByTestId('go-live-yes'));
    expect(goLive).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
  });

  it('Not yet sends nothing; a refusal is said, with the way to clear it', async () => {
    show();
    await userEvent.click(screen.getByTestId('go-live-button'));
    await userEvent.click(screen.getByTestId('go-live-cancel'));
    expect(goLive).not.toHaveBeenCalled();
    goLive.mockResolvedValue({ ok: false, reason: 'store' });
    await userEvent.click(screen.getByTestId('go-live-button'));
    await userEvent.click(screen.getByTestId('go-live-yes'));
    expect(screen.getByTestId('go-live-problem')).toHaveTextContent('Connect your store first');
    expect(screen.getByTestId('go-live-problem').querySelector('a')).toHaveAttribute(
      'href',
      '/settings/systems',
    );
  });
});
