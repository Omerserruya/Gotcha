import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { embeddedSignupLaunchSchema } from '@/api/contracts/whatsapp-connect';
import messages from '@/i18n/messages/en/channels.json';

/* Nothing here reaches Meta: the SDK is stubbed, and inspect is a spy. */
const inspectNumbers = vi.hoisted(() => vi.fn());
vi.mock('./whatsapp-actions', () => ({ inspectNumbers, connectNumber: vi.fn() }));
vi.mock('./signup/facebook-sdk', () => ({ useFacebookSdk: () => 'ready' }));

import { MetaLauncher } from './MetaLauncher';

const launch = embeddedSignupLaunchSchema.parse({
  appId: 'app',
  configId: 'cfg-1',
  responseType: 'code',
  extras: { sessionInfoVersion: '3' },
  configured: true,
});
const show = (l: typeof launch | null) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
      <MetaLauncher launch={l} />
    </NextIntlClientProvider>,
  );

const login = vi.fn();
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  inspectNumbers.mockReset();
  login.mockReset();
  window.FB = { init: vi.fn(), login };
});
afterEach(() => {
  vi.useRealTimers();
  delete window.FB;
});

describe('★★ 13c — Meta’s launcher, with the server’s parameters', () => {
  it('not configured (or unread): drawn, with why — no SDK call', () => {
    const one = show(embeddedSignupLaunchSchema.parse({ ...launch, configured: false }));
    expect(screen.getByTestId('whatsapp-add-number')).toHaveAttribute('aria-disabled', 'true');
    one.unmount();
    show(null);
    expect(screen.getByTestId('whatsapp-add-number')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('whatsapp-add-number').getAttribute('title')).toMatch(/isn't set up/);
  });

  it('the click opens Meta with exactly the server’s config; nothing before it', async () => {
    show(launch);
    expect(login).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('whatsapp-add-number'));
    expect(login.mock.calls[0]![1]).toStrictEqual({
      config_id: 'cfg-1',
      response_type: 'code',
      override_default_response_type: true,
      extras: { sessionInfoVersion: '3' },
    });
  });

  it('a code: inspected with the popup’s assets (from Meta only) — then the numbers to choose', async () => {
    inspectNumbers.mockResolvedValue({ sessionId: 's1', candidates: [] });
    show(launch);
    await userEvent.click(screen.getByTestId('whatsapp-add-number'));
    const post = (origin: string, waba: string) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin,
            data: JSON.stringify({
              type: 'WA_EMBEDDED_SIGNUP',
              event: 'FINISH',
              data: { business_id: 'b1', waba_ids: [waba] },
            }),
          }),
        );
      });
    post('https://www.facebook.com', 'w1');
    // Last, so it would win if it were believed.
    post('https://evilfacebook.com', 'w-evil');
    await act(async () => {
      login.mock.calls[0]![0]({ authResponse: { code: 'abc' } });
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(inspectNumbers).toHaveBeenCalledTimes(1);
    const [code, assets] = inspectNumbers.mock.calls[0]!;
    expect(code).toBe('abc');
    expect(assets.wabaIds).toEqual(['w1']);
    expect(await screen.findByTestId('connect-none')).toBeInTheDocument();
  });

  it('closed without a code: nothing inspected; a failed read is said', async () => {
    show(launch);
    await userEvent.click(screen.getByTestId('whatsapp-add-number'));
    act(() => login.mock.calls[0]![0]({ authResponse: null, status: 'unknown' }));
    expect(inspectNumbers).not.toHaveBeenCalled();
    inspectNumbers.mockResolvedValue(null);
    await userEvent.click(screen.getByTestId('whatsapp-add-number'));
    await act(async () => {
      login.mock.calls[1]![0]({ authResponse: { code: 'x' } });
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(await screen.findByTestId('launcher-problem')).toHaveTextContent(
      "We couldn't read the numbers on that account.",
    );
  });
});
