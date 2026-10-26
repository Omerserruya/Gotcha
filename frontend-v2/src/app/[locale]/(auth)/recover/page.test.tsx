import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/auth.json';

/**
 * /recover routes three ways: no flow (a dead end that says so), a flow with
 * no token (screen one), a flow with a token (screen two, or "incomplete").
 */
const { serverEnv } = vi.hoisted(() => ({ serverEnv: vi.fn(() => ({})) }));
vi.mock('@/config/env.server', () => ({ serverEnv }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { auth: messages },
      namespace: namespace as 'auth',
    }),
}));
vi.mock('./RecoverPanel', () => ({
  RecoverPanel: ({ flow }: { flow: string }) => <div data-testid="screen-one" data-flow={flow} />,
}));
vi.mock('./ResetPanel', () => ({
  ResetPanel: (
    props: Record<string, string | null> & { link: { kind: string; token: string } },
  ) => (
    <div
      data-testid="screen-two"
      data-flow={props.flow}
      data-link={props.link.kind}
      data-token={props.link.token}
      data-purpose={props.purpose}
      data-login={props.loginHref}
      data-recover={props.recoverHref ?? 'none'}
    />
  ),
}));

const { default: RecoverPage } = await import('./page');

const page = async (query: Record<string, string>) =>
  render(
    await RecoverPage({
      params: Promise.resolve({ locale: 'en' }),
      searchParams: Promise.resolve(query),
    }),
  );

beforeEach(() => serverEnv.mockReturnValue({}));

describe('★ /recover with a token is screen two', () => {
  it('a reset link: its flow, its token, a new link from screen one, and the sign-in hand-over', async () => {
    await page({ flow: 'gotcha-recovery-self', flow_token: 'tok_ABCdef123456' });
    const two = screen.getByTestId('screen-two');
    expect(two).toHaveAttribute('data-flow', 'gotcha-recovery-self');
    expect(two).toHaveAttribute('data-token', 'tok_ABCdef123456');
    expect(two).toHaveAttribute('data-purpose', 'reset');
    expect(two).toHaveAttribute('data-recover', '/en/recover?flow=gotcha-recovery-self');
    // The hand-over's marker, or /api/auth/login sends it back to the panel.
    expect(two).toHaveAttribute('data-login', '/api/auth/login?handover=1&finish=1');
  });

  it('an invite’s setup link is "setup", and has no resend from here', async () => {
    await page({ flow: 'gotcha-recovery', flow_token: 'tok_ABCdef123456' });
    expect(screen.getByTestId('screen-two')).toHaveAttribute('data-purpose', 'setup');
    expect(screen.getByTestId('screen-two')).toHaveAttribute('data-recover', 'none');
  });

  it('★ a setup link since the terms: our own `setup` token, handed on as a setup link', async () => {
    await page({ flow: 'gotcha-recovery', setup: 'setup_XYZuvw987654' });
    const two = screen.getByTestId('screen-two');
    expect(two).toHaveAttribute('data-purpose', 'setup');
    expect(two).toHaveAttribute('data-link', 'setup');
    expect(two).toHaveAttribute('data-token', 'setup_XYZuvw987654');
  });

  it("the provider's token is a flow link, and wins over `setup` when both are there", async () => {
    await page({
      flow: 'gotcha-recovery',
      flow_token: 'tok_ABCdef123456',
      setup: 'setup_XYZuvw987654',
    });
    expect(screen.getByTestId('screen-two')).toHaveAttribute('data-link', 'flow');
  });

  it('`setup` means nothing to a reset flow: that is screen one', async () => {
    await page({ flow: 'gotcha-recovery-self', setup: 'setup_XYZuvw987654' });
    expect(screen.queryByTestId('screen-two')).toBeNull();
    expect(screen.getByTestId('screen-one')).toBeInTheDocument();
  });

  it('a `setup` token that cannot be one is "incomplete"', async () => {
    await page({ flow: 'gotcha-recovery', setup: 'short' });
    expect(screen.queryByTestId('screen-two')).toBeNull();
    expect(screen.getByTestId('reset-malformed')).toBeInTheDocument();
  });

  it('the hand-over goes where the product signs in, when that is another origin', async () => {
    serverEnv.mockReturnValue({ PRODUCT_LOGIN_URL: 'https://app.gotcha.co.il/api/auth/login' });
    await page({ flow: 'gotcha-recovery-self', flow_token: 'tok_ABCdef123456' });
    expect(screen.getByTestId('screen-two')).toHaveAttribute(
      'data-login',
      'https://app.gotcha.co.il/api/auth/login?handover=1&finish=1',
    );
  });

  it.each([['short'], ['has space'], [''], ['tab\there']])(
    'a token that cannot be one (%j) is "incomplete", not "expired", and starts nothing',
    async (token) => {
      await page({ flow: 'gotcha-recovery-self', flow_token: token });
      expect(screen.queryByTestId('screen-two')).toBeNull();
      expect(screen.getByTestId('reset-malformed')).toHaveTextContent('This link is incomplete');
    },
  );

  it('without a token it is screen one, as before', async () => {
    await page({ flow: 'gotcha-recovery-self' });
    expect(screen.getByTestId('screen-one')).toHaveAttribute('data-flow', 'gotcha-recovery-self');
  });

  it('a token with an unusable flow is neither screen', async () => {
    await page({ flow: '../evil', flow_token: 'tok_ABCdef123456' });
    expect(screen.queryByTestId('screen-two')).toBeNull();
    expect(screen.getByTestId('recover-unavailable')).toBeInTheDocument();
  });
});
