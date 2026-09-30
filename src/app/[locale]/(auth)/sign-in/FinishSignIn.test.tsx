import { render, waitFor } from '@testing-library/react';
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

  it('★ renders nothing — it is a hop, not a screen', () => {
    completeAuthorization.mockResolvedValue({ reason: 'stage', component: 'ak-stage-consent' });
    const { container } = show();
    expect(container).toBeEmptyDOMElement();
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
