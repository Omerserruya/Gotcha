import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';

const { refreshNumber, refreshUnprofiled, disconnectNumber } = vi.hoisted(() => ({
  refreshNumber: vi.fn(async (_id: string): Promise<unknown> => ({ ok: true })),
  refreshUnprofiled: vi.fn(async (_id: string): Promise<unknown> => ({ ok: true })),
  disconnectNumber: vi.fn(async () => {
    throw new Error('a test must never disconnect a number');
  }),
}));
vi.mock('./number-actions', () => ({ refreshNumber, refreshUnprofiled, disconnectNumber }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { PanelFoot } from './PanelFoot';

beforeEach(() => {
  refreshNumber.mockClear();
  refreshUnprofiled.mockClear();
});

const foot = (props: Parameters<typeof PanelFoot>[0]) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels }}>
      <PanelFoot {...props} />
    </NextIntlClientProvider>,
  );

describe('★ the foot’s "Refresh from Meta" for dev’s number, which has no record here', () => {
  it('★ is a live button, and reads the account from Meta by its id', async () => {
    foot({ numbers: [], unprofiled: ['ca1'] });
    const button = screen.getByTestId('whatsapp-foot-refresh');
    expect(button.tagName).toBe('BUTTON');
    await userEvent.click(button);
    expect(refreshUnprofiled).toHaveBeenCalledWith('ca1');
    expect(refreshNumber).not.toHaveBeenCalled();
    expect(await screen.findByTestId('whatsapp-foot-refresh-result')).toHaveTextContent(
      'Updated just now',
    );
  });

  it('★ once a minute: the refusal is said in words', async () => {
    refreshUnprofiled.mockResolvedValueOnce({ ok: false, reason: 'too_soon' });
    foot({ numbers: [], unprofiled: ['ca1'] });
    await userEvent.click(screen.getByTestId('whatsapp-foot-refresh'));
    const said = await screen.findByTestId('whatsapp-foot-refresh-result');
    expect(said).toHaveAttribute('role', 'alert');
    expect(said).toHaveTextContent('It was refreshed a moment ago. Try again in a minute.');
  });

  it('Disconnect still cannot name it - and says only that, not "nothing to refresh"', () => {
    foot({ numbers: [], unprofiled: ['ca1'] });
    const off = screen.getByTestId('whatsapp-foot-disconnect');
    expect(off).toHaveAttribute('title', expect.stringMatching(/can't be disconnected from here/));
    expect(off.getAttribute('title')).not.toMatch(/refresh/);
  });

  it('with no number at all, Refresh is still a status', () => {
    foot({ numbers: [] });
    expect(screen.getByTestId('whatsapp-foot-refresh').tagName).not.toBe('BUTTON');
  });
});
