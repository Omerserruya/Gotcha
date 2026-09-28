import { render, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/auth.json';

/**
 * Where the panel hands over, and why it is configurable.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A RELATIVE PATH ASSUMES THE PANEL AND THE PRODUCT SHARE A HOST
 * ════════════════════════════════════════════════════════════════════════════
 * They do today. They will not once sign-in is served from its own origin, and
 * the failure is the confusing kind: the password is accepted, the identity
 * provider session is created, and the browser then asks the AUTH host for a
 * route only the PRODUCT host serves. Behind a gateway allowlist that is a
 * **404 at the end of a successful sign-in** — which reads as the panel being
 * broken when the panel has just done its job.
 *
 * ★ This page had no test at all, which is how a URL built three different
 *   ways in one file stayed unexamined: `appPath` for the anchor, a raw path
 *   for the fetch, and `appUrl` for the callback. The anchor was already wrong
 *   once before, for the opposite reason — unprefixed, so it started the
 *   LEGACY product's OIDC flow.
 */

const { serverEnv } = vi.hoisted(() => ({ serverEnv: vi.fn() }));

vi.mock('@/config/env.server', () => ({ serverEnv }));

vi.mock('next-intl/server', () => ({
  getTranslations: async () =>
    createTranslator({ locale: 'en', messages: { auth: messages }, namespace: 'auth' }),
}));

/*
 * The panel drives a stage machine over `fetch` and is tested on its own. Here
 * it is replaced by something that only reports the two props this page
 * computes, so a failure names the URL rather than the flow.
 */
vi.mock('@/features/auth/SignInPanel', () => ({
  SignInPanel: ({ handOverHref, returnTo }: { handOverHref: string; returnTo?: string }) => (
    <a data-testid="hand-over" href={handOverHref}>
      {returnTo ?? 'no-return'}
    </a>
  ),
}));

const { default: SignInPage } = await import('./page');

/*
 * Queried WITHIN this render rather than from the document. Testing Library
 * cleans up between tests, not between renders, so a second `render` in one
 * test leaves two panels on the page and `getByTestId` throws "found multiple"
 * — which reads as a duplicated element rather than as a test that rendered
 * twice on purpose.
 */
const show = async (search: { error?: string; returnTo?: string } = {}) => {
  const { container } = render(await SignInPage({ searchParams: Promise.resolve(search) }));
  return within(container).getByTestId('hand-over');
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('⚠⚠ the hand-over target', () => {
  it('★ is a path on this host when nothing says otherwise', async () => {
    // Unset is the whole product today, and this asserts nothing changed.
    serverEnv.mockReturnValue({});
    expect(await show()).toHaveAttribute('href', '/api/auth/login');
  });

  it('⚠⚠ is the configured product URL when sign-in lives elsewhere', async () => {
    serverEnv.mockReturnValue({
      PRODUCT_LOGIN_URL: 'https://dev.gotcha.co.il/v2/api/auth/login',
    });
    expect(await show()).toHaveAttribute('href', 'https://dev.gotcha.co.il/v2/api/auth/login');
  });

  it('⚠⚠ carries `returnTo` either way, or the deep link is lost at the hop', async () => {
    /*
     * The round trip the design requires — signing in returns you to the exact
     * conversation you were reading — now crosses an origin. `returnTo` is
     * appended to whichever base is in use, and a test for only the relative
     * case would have passed while the absolute one dropped it.
     */
    serverEnv.mockReturnValue({});
    expect(await show({ returnTo: '/en/inbox?c=abc' })).toHaveAttribute(
      'href',
      '/api/auth/login?returnTo=%2Fen%2Finbox%3Fc%3Dabc',
    );

    serverEnv.mockReturnValue({ PRODUCT_LOGIN_URL: 'https://dev.gotcha.co.il/v2/api/auth/login' });
    expect(await show({ returnTo: '/en/inbox?c=abc' })).toHaveAttribute(
      'href',
      'https://dev.gotcha.co.il/v2/api/auth/login?returnTo=%2Fen%2Finbox%3Fc%3Dabc',
    );
  });

  it('★ and the panel is told where it came from, not only the anchor', async () => {
    /*
     * `returnTo` is passed to the panel as well, because the panel says "we
     * will bring you back" only when there is somewhere to bring them back to.
     * Two consumers of one value, and the anchor is the one that was tested.
     */
    serverEnv.mockReturnValue({});
    expect(await show({ returnTo: '/en/home' })).toHaveTextContent('/en/home');
    expect(await show()).toHaveTextContent('no-return');
  });
});

describe('★ the error a person is sent back with', () => {
  it('★ shows a known one and ignores anything else', async () => {
    /*
     * `error` comes off the query string, so it is whatever somebody typed.
     * Rendering it would put an attacker's sentence on our sign-in page; the
     * allowlist is why only three reach a message.
     */
    serverEnv.mockReturnValue({});
    const known = render(await SignInPage({ searchParams: Promise.resolve({ error: 'expired' }) }));
    expect(within(known.container).getByRole('alert')).toBeInTheDocument();

    const unknown = render(
      await SignInPage({ searchParams: Promise.resolve({ error: 'you have been hacked' }) }),
    );
    expect(within(unknown.container).queryAllByRole('alert')).toHaveLength(0);
  });
});
