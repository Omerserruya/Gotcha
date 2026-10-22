import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import onboardingMessages from '@/i18n/messages/en/onboarding.json';

import { WorkspaceGate } from './WorkspaceGate';

const show = (setupAdmin: string | null) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingMessages }}>
      <WorkspaceGate route="waiting" setupAdmin={setupAdmin} />
    </NextIntlClientProvider>,
  );

describe('★ the waiting screen names who is setting it up - when the server does', () => {
  it('named', () => {
    show('Maya Levi');
    expect(screen.getByTestId('gate-lead')).toHaveTextContent('Maya Levi is setting up GOTCHA');
  });

  it('not named: the sentence without a name - never a made-up one', () => {
    show(null);
    expect(screen.getByTestId('gate-lead')).toHaveTextContent('An admin is setting up GOTCHA');
  });
});
