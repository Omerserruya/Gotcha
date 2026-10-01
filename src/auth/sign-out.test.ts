import { beforeEach, describe, expect, it, vi } from 'vitest';

import { signOut } from './sign-out';

/**
 * Signing out, which has been got wrong three times today.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE ONLY OUTCOME WORSE THAN THE PROVIDER'S PAGE IS A CLEAN PAGE AND A
 *    LIVING SESSION
 * ════════════════════════════════════════════════════════════════════════════
 * Three designs have produced exactly that: a server-side end-session call, a
 * fetch of the flow, and a hidden iframe. Each looked right and each left
 * `authentik_session` alive — proven by asking for a fresh code and getting
 * one.
 *
 * ★ The popup works because it is a TOP-LEVEL browsing context. An iframe is a
 *   nested one. The requirement was never visibility.
 */
const END_SESSION = 'https://auth-dev.gotcha.co.il/application/o/gotcha/end-session/?x=1';
const assign = vi.fn();

/*
 * ⚠ A FAITHFUL POPUP, AND THE FIDELITY IS THE POINT. A real window's
 *   `location.href` THROWS once it has navigated cross-origin — that throw is
 *   the only signal available, so a stub whose `href` stays readable models a
 *   window that never left our origin and makes the wait run to its deadline.
 */
const popup = (opts: { navigatesAway?: boolean } = {}) => {
  const { navigatesAway = true } = opts;
  let replaced = false;
  return {
    closed: false,
    close: vi.fn(),
    location: {
      replace: vi.fn(() => {
        replaced = true;
      }),
      get href(): string {
        if (replaced && navigatesAway) throw new Error('cross-origin');
        return replaced ? 'https://dev.gotcha.co.il/v2/en/home' : 'about:blank';
      },
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => ({ redirectTo: END_SESSION }) })),
  );
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
});

describe('⚠⚠ a blocked popup must not land on our own page', () => {
  it('⚠⚠ navigates top-level when `window.open` returns null', async () => {
    /*
     * ★ THE FOURTH CHANCE TO SHIP A SIGN-OUT THAT DOES NOT SIGN OUT. A blocked
     *   popup with a fall-through to `/` would be exactly that. It goes to the
     *   provider instead: its page, and a session that genuinely dies.
     */
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    );

    await signOut();
    expect(assign).toHaveBeenCalledWith(END_SESSION);
    expect(assign).not.toHaveBeenCalledWith('https://gotcha.co.il/');
  });

  it('⚠⚠ and when the person closes it before the flow runs', async () => {
    const win = popup();
    win.closed = true;
    vi.stubGlobal(
      'open',
      vi.fn(() => win),
    );

    await signOut();
    expect(assign).toHaveBeenCalledWith(END_SESSION);
  });

  it('⚠⚠ and when it never leaves our origin', async () => {
    /*
     * A readable `href` that is not `about:blank` means the window went
     * somewhere we own — so it never reached the provider and nothing was
     * invalidated.
     */
    const win = popup({ navigatesAway: false });
    vi.stubGlobal(
      'open',
      vi.fn(() => win),
    );

    await signOut();
    expect(assign).toHaveBeenCalledWith(END_SESSION);
  });
});

describe('★★ the popup is opened inside the gesture, before the fetch', () => {
  it('⚠⚠ opens on about:blank BEFORE awaiting anything', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * `window.open` AFTER AN `await` HAS LOST THE USER GESTURE
     * ════════════════════════════════════════════════════════════════════════
     * Browsers block it. The failure would look INTERMITTENT — some people,
     * some settings — rather than like a bug, which is the worst way for this
     * to break.
     */
    const order: string[] = [];
    const win = popup();

    vi.stubGlobal(
      'open',
      vi.fn((url: string) => {
        order.push(`open:${url}`);
        return win;
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        order.push('fetch');
        return { json: async () => ({ redirectTo: END_SESSION }) };
      }),
    );

    await signOut();
    expect(order[0]).toBe('open:about:blank');
    expect(order[1]).toBe('fetch');
  });

  it('★ and the URL still comes from the server, not from the client', async () => {
    const win = popup();
    vi.stubGlobal(
      'open',
      vi.fn(() => win),
    );

    await signOut();
    expect(win.location.replace).toHaveBeenCalledWith(END_SESSION);
  });
});

describe('★★ the success path: our own page, and nothing of the provider seen', () => {
  it('★★ closes the popup and lands the person on our root', async () => {
    const win = popup();
    vi.stubGlobal(
      'open',
      vi.fn(() => win),
    );

    await signOut();

    expect(win.close).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('https://gotcha.co.il/');
    // And the main tab never went to the provider.
    expect(assign).not.toHaveBeenCalledWith(END_SESSION);
  });

  it('⚠⚠ the popup is the ONLY thing that ever sees the end-session URL', async () => {
    /*
     * ★ The id token travels in that URL. Keeping it out of the main tab's
     *   address bar is a second benefit of the popup that nobody designed for.
     */
    const win = popup();
    vi.stubGlobal(
      'open',
      vi.fn(() => win),
    );

    await signOut();
    expect(win.location.replace).toHaveBeenCalledWith(END_SESSION);
    for (const call of assign.mock.calls) {
      expect(String(call[0])).not.toContain('end-session');
    }
  });
});

describe('⚠ the landing is the marketing site, and that is a ruling', () => {
  it('★★ lands on the apex, not the product root and not www', async () => {
    /*
     * Omer: "not `/` — I mean jump to `gotcha.co.il/`, not
     * `app.gotcha.co.il/`", and separately: "signing out to production is
     * fine with me."
     *
     * ★ So there is no environment variable on purpose. This asserts the
     *   ruling rather than a default, because the next reader will see a
     *   hard-coded production URL and recognise it as the absolute-path
     *   defect this repo has had four times — and it is not that.
     *
     * ★ `www.gotcha.co.il` does not resolve. Measured.
     */
    const win = popup();
    vi.stubGlobal(
      'open',
      vi.fn(() => win),
    );

    await signOut();
    const landed = assign.mock.calls.at(-1)?.[0] as string;

    expect(landed).toBe('https://gotcha.co.il/');
    expect(landed).not.toContain('app.gotcha.co.il');
    expect(landed).not.toContain('www.');
  });

  it('⚠⚠ but a FALLBACK never lands there — it goes to the provider', async () => {
    /*
     * The marketing site is not on the provider's allow-list, and does not
     * need to be: the popup does the invalidation and the provider is never
     * asked to send anyone there. On the fallback the provider IS asked, and
     * it shows its own page — today's behaviour, with a session that dies.
     */
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    );

    await signOut();
    expect(assign).toHaveBeenCalledWith(END_SESSION);
    expect(assign).not.toHaveBeenCalledWith('https://gotcha.co.il/');
  });
});
