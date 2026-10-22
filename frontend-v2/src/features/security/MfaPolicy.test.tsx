import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import security from '@/i18n/messages/en/security.json';

vi.mock('./actions', () => ({
  setMfaPolicy: () => {
    throw new Error('no test may write');
  },
}));

import { MfaPolicy } from './MfaPolicy';

const show = (mfaRequiredForAdmins: boolean, mfaRequiredForAllUsers: boolean) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ security }}>
      <MfaPolicy policy={{ mfaRequiredForAdmins, mfaRequiredForAllUsers }} />
    </NextIntlClientProvider>,
  );

describe('★ 16 - "Two-step sign-in" says the rule it holds, and only that', () => {
  it.each([
    [true, true, 'Required for everyone'],
    [true, false, 'Required for admins'],
    [false, false, 'Not required'],
  ])('admins %s, everyone %s → %s', (admins, everyone, words) => {
    show(admins, everyone);
    expect(screen.getByTestId('mfa-state')).toHaveTextContent(new RegExp(`^${words}$`));
    // Nothing reads who has enrolled: no "4 of 4 set up" is invented.
    expect(screen.getByTestId('mfa-policy')).not.toHaveTextContent(/set up/);
  });
});

describe('★ 16 - the level sits at the row’s end, the stored one dark', () => {
  it.each([
    [true, true, 'everyone'],
    [true, false, 'admins'],
    [false, false, 'none'],
  ])('admins %s, everyone %s → %s is current, and only it', (admins, everyone, level) => {
    show(admins, everyone);
    for (const l of ['none', 'admins', 'everyone']) {
      expect(screen.getByTestId(`mfa-level-${l}`)).toHaveAttribute(
        'aria-pressed',
        String(l === level),
      );
    }
  });
});
