import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const completeAuthorization = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/flow-executor', () => ({ completeAuthorization }));

const { logger } = await import('@/observability/logger');
const { FinishSignIn } = await import('./FinishSignIn');

const AUTHORIZE = 'https://auth-dev.gotcha.co.il/application/o/authorize/?state=s';
const CALLBACK = 'https://dev.gotcha.co.il/v2/api/auth/callback';
const replace = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { replace }, writable: true });
});

const show = () => render(<FinishSignIn authorizeUrl={AUTHORIZE} callbackUrl={CALLBACK} />);

describe('⚠⚠ the last hop, without the provider drawing it', () => {
  it('★★ goes to our callback when the flow completes there', async () => {
    const to = `${CALLBACK}?code=abc&state=s`;
    completeAuthorization.mockResolvedValue({ to });

    show();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(to));
  });

  it('⚠⚠ falls back to AUTHORIZE, never to the route that sent us here', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE FALLBACK IS WHAT MAKES THIS SAFE TO SHIP
     * ════════════════════════════════════════════════════════════════════════
     * `/api/auth/login?finish=1` is what redirected here. Returning to it
     * would redirect here again, forever. Going to `authorize` is exactly
     * what the browser would have done without this component — the worst
     * outcome is the provider's page, which is where we started.
     */
    completeAuthorization.mockResolvedValue({ reason: 'stage', component: 'ak-stage-consent' });

    show();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(AUTHORIZE));
    expect(replace).not.toHaveBeenCalledWith(expect.stringContaining('/api/auth/login'));
  });

  it('⚠⚠ refuses a completion that is not our callback, even when one came back', async () => {
    /*
     * `completeAuthorization` returns `to` unvalidated by design. A provider
     * that answered with somebody else's URL would otherwise be followed.
     */
    completeAuthorization.mockResolvedValue({
      to: 'https://evil.example/v2/api/auth/callback?code=abc&state=s',
    });

    show();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(AUTHORIZE));
  });

  it('⚠ and refuses the provider’s root, which is what the OTHER flow returns', async () => {
    completeAuthorization.mockResolvedValue({ to: '/' });
    show();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(AUTHORIZE));
  });

  it('★ draws nothing — it is a hop, not a screen', () => {
    /*
     * ⚠ THIS ASSERTED AN EMPTY CONTAINER AND HAD TO BE RE-AIMED. The rule is
     *   that nothing is DRAWN: it renders over a screen the person is already
     *   looking at, and a spinner that appears and vanishes reads as a fault
     *   rather than as progress.
     *
     *   "No DOM at all" was a proxy for that, and it held only while the
     *   component had nothing to say. It now carries its outcome in
     *   attributes — because a log did not arrive anywhere — and the proxy
     *   failed on a correct component. Assert the rule.
     */
    completeAuthorization.mockResolvedValue({ reason: 'stage', component: 'ak-stage-consent' });
    show();
    const marker = screen.getByTestId('finish-sign-in');
    expect(marker).not.toBeVisible();
    expect(marker.textContent).toBe('');
  });

  it('⚠ uses replace, so the back button cannot land on a spent authorize URL', async () => {
    completeAuthorization.mockResolvedValue({ to: `${CALLBACK}?code=abc&state=s` });
    show();
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect((window.location as unknown as { assign?: unknown }).assign).toBeUndefined();
  });
});

describe('⚠⚠ the fallback says why, because it is invisible otherwise', () => {
  it('★★ logs the reason when it gives up, and names the component', async () => {
    /*
     * Landing on the provider's page is what happens when this WORKS and when
     * it gives up. The first live walk fell back correctly and nothing said
     * which of four things had happened.
     */
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    completeAuthorization.mockResolvedValue({ reason: 'stage', component: 'ak-stage-consent' });

    show();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(AUTHORIZE));
    expect(warn).toHaveBeenCalledWith(
      'auth.finish.gave_up',
      expect.objectContaining({ reason: 'stage', component: 'ak-stage-consent' }),
    );
    warn.mockRestore();
  });

  it('⚠ and says nothing when it succeeds', async () => {
    // A line on the happy path would be noise on every sign-in.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    completeAuthorization.mockResolvedValue({ to: `${CALLBACK}?code=abc&state=s` });

    show();
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('⚠⚠ it says what happened in the DOM, not only in a log', () => {
  /*
   * ═════════════════════════════════════════════════════════════════════
   * THE LOG DID NOT ARRIVE, ANYWHERE
   * ═════════════════════════════════════════════════════════════════════
   * Not the browser console, not either container. So "it ran and gave up"
   * and "it never ran" were indistinguishable — the same collapse the
   * four-reason outcome had just fixed one level down.
   *
   * ★ A log must survive a level filter, a sink, a bundle boundary and a
   *   navigation. An attribute survives none of those.
   */
  it('★★ records the reason and the component it was given', async () => {
    completeAuthorization.mockResolvedValue({ reason: 'stage', component: 'ak-stage-consent' });

    show();
    const marker = await screen.findByTestId('finish-sign-in');
    await waitFor(() => expect(marker).toHaveAttribute('data-phase', 'gave-up'));
    expect(marker).toHaveAttribute('data-reason', 'stage');
    expect(marker).toHaveAttribute('data-component', 'ak-stage-consent');
  });

  it('★★ is FINDABLE before anything resolves, which `null` was not', async () => {
    /*
     * The distinction that mattered. A component rendering `null` leaves
     * nothing to look at, so a harness cannot tell it mounted — only that the
     * page was a different size.
     */
    let release!: (outcome: unknown) => void;
    completeAuthorization.mockReturnValue(new Promise((resolve) => (release = resolve)));

    show();
    const marker = await screen.findByTestId('finish-sign-in');
    expect(marker).toHaveAttribute('data-phase', 'working');
    expect(marker).toHaveAttribute('data-reason', '');

    release({ reason: 'threw' });
    await waitFor(() => expect(marker).toHaveAttribute('data-phase', 'gave-up'));
  });

  it('★ marks a success as done, not as gave-up', async () => {
    completeAuthorization.mockResolvedValue({ to: `${CALLBACK}?code=abc&state=s` });
    show();
    const marker = await screen.findByTestId('finish-sign-in');
    await waitFor(() => expect(marker).toHaveAttribute('data-phase', 'done'));
  });

  it('⚠⚠ and `hold` stops before navigating, so the outcome can be read', async () => {
    completeAuthorization.mockResolvedValue({ reason: 'no-flow' });

    render(<FinishSignIn authorizeUrl={AUTHORIZE} callbackUrl={CALLBACK} hold />);
    const marker = await screen.findByTestId('finish-sign-in');
    await waitFor(() => expect(marker).toHaveAttribute('data-phase', 'gave-up'));
    expect(replace).not.toHaveBeenCalled();
  });

  it('⚠ while without it, it still navigates — hold is opt-in', async () => {
    completeAuthorization.mockResolvedValue({ reason: 'no-flow' });
    show();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(AUTHORIZE));
  });
});

describe('⚠⚠ the give-up that had no name', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * MEASURED: phase "gave-up", reason ""
   * ════════════════════════════════════════════════════════════════════════
   * `completeAuthorization` SUCCEEDING and `followableCompletion` refusing its
   * answer is a fifth outcome. `answer.reason` is undefined on the success
   * branch, so the attribute rendered empty while the phase said gave-up —
   * the same collapse as the four nulls, one level up, in the code written to
   * fix it.
   */
  it('★★ names it when the completion is not our callback', async () => {
    completeAuthorization.mockResolvedValue({
      to: 'https://auth-dev.gotcha.co.il/api/auth/callback?code=abc&state=s',
    });

    show();
    const marker = await screen.findByTestId('finish-sign-in');
    await waitFor(() => expect(marker).toHaveAttribute('data-phase', 'gave-up'));
    expect(marker).toHaveAttribute('data-reason', 'not-our-callback');
  });

  it('⚠⚠ so a gave-up is NEVER nameless, whichever branch produced it', async () => {
    /*
     * ★ The general property, asserted as a property rather than case by case.
     *   A sixth branch added later must not be able to report `""` — which is
     *   exactly how the fifth arrived.
     */
    for (const answer of [
      { reason: 'no-flow' },
      { reason: 'executor-refused' },
      { reason: 'stage', component: 'ak-stage-consent' },
      { reason: 'threw' },
      { to: 'https://evil.example/v2/api/auth/callback?code=a&state=b' },
      { to: '/' },
    ]) {
      completeAuthorization.mockResolvedValue(answer);
      const { unmount } = render(
        <FinishSignIn authorizeUrl={AUTHORIZE} callbackUrl={CALLBACK} hold />,
      );
      const marker = await screen.findByTestId('finish-sign-in');
      await waitFor(() => expect(marker).toHaveAttribute('data-phase', 'gave-up'));
      expect(marker.getAttribute('data-reason'), JSON.stringify(answer)).not.toBe('');
      unmount();
    }
  });

  it('★ and a success still reports no reason at all', async () => {
    completeAuthorization.mockResolvedValue({ to: `${CALLBACK}?code=abc&state=s` });
    show();
    const marker = await screen.findByTestId('finish-sign-in');
    await waitFor(() => expect(marker).toHaveAttribute('data-phase', 'done'));
    expect(marker).toHaveAttribute('data-reason', '');
  });
});
