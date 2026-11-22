import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import he from '@/i18n/messages/he/security.json';

const beginGoogleConnect = vi.hoisted(() => vi.fn());
vi.mock('./google-connect-action', () => ({ beginGoogleConnect }));
const signOut = vi.hoisted(() => vi.fn());
vi.mock('@/auth/sign-out', () => ({ signOut }));

const { ConnectGoogleButton } = await import('./ConnectGoogleButton');

const show = () =>
  render(
    <NextIntlClientProvider locale="he" messages={{ security: he }}>
      <ConnectGoogleButton />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  beginGoogleConnect.mockReset().mockResolvedValue('ready');
  signOut.mockReset().mockResolvedValue(undefined);
});

describe('★★ connect Google: remember who, THEN sign out', () => {
  it('★★ in that order', async () => {
    show();
    await userEvent.click(screen.getByTestId('google-connect-go'));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(beginGoogleConnect.mock.invocationCallOrder[0]).toBeLessThan(
      signOut.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('⚠⚠ nothing remembered: never a sign-out, and it says so', async () => {
    beginGoogleConnect.mockResolvedValue('failed');
    show();
    await userEvent.click(screen.getByTestId('google-connect-go'));
    expect(await screen.findByTestId('google-connect-failed')).toHaveTextContent(he.google.failed);
    expect(signOut).not.toHaveBeenCalled();
  });
});
