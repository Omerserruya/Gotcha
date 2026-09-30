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
  /*
   * ⚠ The page now asks for a SCOPED namespace (`auth.editorial`) as well as
   *   `auth`, so this mock has to honour the argument rather than always
   *   returning the same translator. Typed through `createTranslator`'s own
   *   parameter, because `string` is wider than the key union it accepts.
   */
  getTranslations: async (namespace?: string) =>
    createTranslator({
      locale: 'en',
      messages: { auth: messages },
      /*
       * The key union is generated from the catalogue, so it is narrower than
       * the `string` the page hands in. The cast sits here, at the mock's
       * boundary, rather than loosening anything the real code is checked
       * against.
       */
      namespace: (namespace ?? 'auth') as 'auth',
    }),
  getLocale: async () => 'en',
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
    expect(await show()).toHaveAttribute('href', '/api/auth/login?handover=1');
  });

  it('⚠⚠ is the configured product URL when sign-in lives elsewhere', async () => {
    serverEnv.mockReturnValue({
      PRODUCT_LOGIN_URL: 'https://dev.gotcha.co.il/v2/api/auth/login',
    });
    expect(await show()).toHaveAttribute(
      'href',
      'https://dev.gotcha.co.il/v2/api/auth/login?handover=1',
    );
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
      '/api/auth/login?handover=1&returnTo=%2Fen%2Finbox%3Fc%3Dabc',
    );

    serverEnv.mockReturnValue({ PRODUCT_LOGIN_URL: 'https://dev.gotcha.co.il/v2/api/auth/login' });
    expect(await show({ returnTo: '/en/inbox?c=abc' })).toHaveAttribute(
      'href',
      'https://dev.gotcha.co.il/v2/api/auth/login?handover=1&returnTo=%2Fen%2Finbox%3Fc%3Dabc',
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

it('⚠⚠ always carries the hand-over marker, or this panel loops on itself', async () => {
  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * `/api/auth/login` now sends anyone WITHOUT the marker to the sign-in
   * surface — reaching the OIDC start cold renders the identity provider's
   * own login page, which is the screen the separation exists to prevent.
   * This panel is the one legitimate direct caller.
   *
   * Without it: panel → `/api/auth/login` → panel → … **on the front door**,
   * with no error anywhere and nothing to read but a spinning tab.
   *
   * Asserted for every shape this URL takes, because the loop does not care
   * which branch built it.
   */
  for (const env of [{}, { PRODUCT_LOGIN_URL: 'https://dev.gotcha.co.il/v2/api/auth/login' }]) {
    for (const search of [{}, { returnTo: '/en/inbox?c=abc' }]) {
      serverEnv.mockReturnValue(env);
      const href = (await show(search)).getAttribute('href') ?? '';
      const query = new URL(href, 'https://dev.gotcha.co.il').searchParams;
      expect(query.get('handover'), href).toBe('1');
    }
  }
});

describe('★★ the rotating panel and its three ticks', () => {
  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * 00a: "The dark panel rotates through three live figures — one every five
   * seconds … with the position marked by three ticks."
   * ═══════════════════════════════════════════════════════════════════════════
   * ⚠ WHAT THIS CAN AND CANNOT SEE, SAID FIRST. The rotation is a CSS opacity
   *   animation and all three statements are in the DOM at every instant, so
   *   **no text assertion can observe the rotation** — a probe sampling text at
   *   t+0 and t+20 reads the same string both times and concludes there is one
   *   figure. That is what happened on the live panel, and the rotation was
   *   working. These tests assert the STRUCTURE the animation needs; whether
   *   pixels move is a screenshot's question.
   */
  it('⚠⚠ renders three ticks, one per figure', async () => {
    serverEnv.mockReturnValue({});
    const { container } = render(await SignInPage({ searchParams: Promise.resolve({}) }));
    const ticks = within(container).getByTestId('editorial-ticks');
    expect(ticks.children).toHaveLength(3);
  });

  it('★★ one tick per statement, or the position marker lies about the count', async () => {
    /*
     * The number is not three because three is a nice number — it is one per
     * figure. Counting the slides rather than hard-coding 3 means adding a
     * fourth statement reddens this instead of leaving a marker that silently
     * undercounts.
     */
    serverEnv.mockReturnValue({});
    const { container } = render(await SignInPage({ searchParams: Promise.resolve({}) }));
    const slides = container.querySelectorAll('[class*="editorialSlide"]');
    const ticks = within(container).getByTestId('editorial-ticks');
    expect(slides.length).toBeGreaterThan(0);
    expect(ticks.children).toHaveLength(slides.length);
  });

  it('⚠⚠ the ticks sit inside the status row, not in a block above it', async () => {
    /*
     * The mock is ONE footer row: ticks, a 1×12px rule, the status dot, the
     * status text — `margin-top:auto; padding-top:36px; gap:14px`. My first
     * version made the ticks a separate block with a margin, which renders
     * close enough to look right and is a different structure.
     *
     * ★ Asserted as containment rather than by class name, because what the
     *   design specifies is that they share a row — not what the row is called.
     */
    serverEnv.mockReturnValue({});
    const { container } = render(await SignInPage({ searchParams: Promise.resolve({}) }));
    const ticks = within(container).getByTestId('editorial-ticks');
    const row = ticks.parentElement;
    expect(row, 'the ticks have no parent row').not.toBeNull();
    expect(row?.textContent ?? '').toMatch(/systems operational/i);
    // The rule and the dot are its siblings, in that order after the ticks.
    expect(row?.children.length).toBeGreaterThanOrEqual(3);
    expect(row?.children[0]).toBe(ticks);
  });

  it('★ the ticks are hidden from assistive technology, like the stage they mark', async () => {
    /*
     * The stage is `aria-hidden` on purpose: ambient copy changing every five
     * seconds while somebody is trying to sign in would be hostile. Ticks that
     * announced themselves would be announcing the furniture of something
     * deliberately not read.
     */
    serverEnv.mockReturnValue({});
    const { container } = render(await SignInPage({ searchParams: Promise.resolve({}) }));
    expect(within(container).getByTestId('editorial-ticks')).toHaveAttribute('aria-hidden', 'true');
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
