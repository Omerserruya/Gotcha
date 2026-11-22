import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleHe from '@/i18n/messages/he/console.json';

const saveSignUpSettings = vi.hoisted(() => vi.fn());
vi.mock('./signup-settings-actions', () => ({ saveSignUpSettings }));

const { SignUpSettings } = await import('./SignUpSettings');

const SETTINGS = {
  enabled: false,
  trialDays: 14,
  cardRequiredAfterDays: 14,
  trialCredits: 5000,
  envEnabled: true,
  bounds: {
    trialDays: { min: 1, max: 60 },
    cardRequiredAfterDays: { min: 1, max: 60 },
    trialCredits: { min: 500, max: 20000 },
  },
};
const show = (settings: typeof SETTINGS | null = SETTINGS) =>
  render(
    <NextIntlClientProvider locale="he" messages={{ console: consoleHe }}>
      <SignUpSettings settings={settings} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  saveSignUpSettings.mockReset().mockResolvedValue('saved');
});

describe('★★ הרשמה עצמית (console)', () => {
  it('⚠⚠ unread is said, never drawn as "off"', () => {
    show(null);
    expect(screen.getByTestId('signup-settings-unread')).toHaveTextContent(consoleHe.signup.unread);
    expect(screen.queryByTestId('signup-enabled')).toBeNull();
  });

  it('★★ saves the switch and both numbers, whole', async () => {
    show();
    await userEvent.click(screen.getByTestId('signup-enabled'));
    await userEvent.clear(screen.getByTestId('signup-cardRequiredAfterDays'));
    await userEvent.type(screen.getByTestId('signup-cardRequiredAfterDays'), '21');
    await userEvent.click(screen.getByTestId('signup-save'));
    await waitFor(() =>
      expect(saveSignUpSettings).toHaveBeenCalledWith({
        enabled: true,
        trialDays: 14,
        cardRequiredAfterDays: 21,
        trialCredits: 5000,
      }),
    );
    expect(await screen.findByTestId('signup-saved')).toHaveTextContent('נשמר.');
  });

  it('⚠⚠ out of the server’s bounds: the range in its numbers, and no save', async () => {
    show();
    await userEvent.clear(screen.getByTestId('signup-trialDays'));
    await userEvent.type(screen.getByTestId('signup-trialDays'), '120');
    expect(screen.getByText('מספר שלם בין 1 ל‑60.')).toBeInTheDocument();
    expect(screen.getByTestId('signup-save')).toBeDisabled();
  });

  it('⚠ a refused save says so', async () => {
    saveSignUpSettings.mockResolvedValue('failed');
    show();
    await userEvent.click(screen.getByTestId('signup-save'));
    expect(await screen.findByTestId('signup-failed')).toHaveTextContent(consoleHe.signup.failed);
  });
});

describe('★ the env switch and the credits (2026-11-22)', () => {
  it('★ env off: said on the card, and the card still saves', () => {
    show({ ...SETTINGS, envEnabled: false });
    expect(screen.getByTestId('signup-env-off')).toHaveTextContent(consoleHe.signup.envOff);
    expect(screen.getByTestId('signup-save')).toBeEnabled();
  });

  it('⚠ credits under the server’s floor: its own range, and no save', async () => {
    show();
    await userEvent.clear(screen.getByTestId('signup-trialCredits'));
    await userEvent.type(screen.getByTestId('signup-trialCredits'), '100');
    expect(screen.getByText('מספר שלם בין 500 ל‑20000.')).toBeInTheDocument();
    expect(screen.getByTestId('signup-save')).toBeDisabled();
  });
});
