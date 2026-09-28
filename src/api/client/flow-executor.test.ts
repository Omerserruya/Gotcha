import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startFlow, submitStage } from './flow-executor';

/**
 * The module that carries the password.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ IT HAD NO TESTS, AND ONE OF ITS DEFENCES WAS ABOUT TO BE NEEDED
 * ════════════════════════════════════════════════════════════════════════════
 * While the gateway's `/v2/auth-api/` location was being brought up, posting the
 * identification stage answered:
 *
 *     302 Location: /api/v3/flows/executor/default-authentication-flow/?query=
 *
 * **An absolute path on the identity provider's own root.** `fetch` follows
 * redirects, the browser resolves that against OUR origin, it misses
 * `/v2/auth-api/`, and the Next app answers — so the panel would have received
 * **a 404 HTML page as a stage response.** Read as a broken or unknown stage,
 * with the real cause two layers away.
 *
 * It is fixed at the proxy with `proxy_redirect /api/v3/ /v2/auth-api/`, and the
 * client's own behaviour under that failure is asserted here rather than
 * assumed, because the proxy line is one edit away from being lost.
 *
 * ★ Same defect class as this app's own sign-in button and as
 *   `new URL('/api/auth/callback', APP_ORIGIN)`: **an absolute path written by
 *   something that assumes it is mounted at the root.** Third instance this week.
 */

const fetchMock = vi.fn();

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const identification = {
  type: 'native',
  component: 'ak-stage-identification',
  user_fields: ['email'],
  password_fields: true,
  recovery_url: '/if/flow/gotcha-recovery-self/',
  primary_action: 'Log in',
  response_errors: {},
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(document, 'cookie', {
    value: 'authentik_csrf=tok%20en; other=1',
    writable: true,
    configurable: true,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('⚠⚠ a body that is not a stage is a transport failure, never a refusal', () => {
  it('⚠⚠ a 404 HTML page — the proxy incident — does not become a stage', async () => {
    /*
     * The exact failure that a missing `proxy_redirect` produces. If this
     * returned a parsed anything, the panel would render it or hand over, and the
     * person debugging would look at Authentik rather than at nginx.
     */
    fetchMock.mockResolvedValue(new Response('<!doctype html><title>404</title>', { status: 404 }));
    expect(await startFlow()).toBeNull();
    expect(await submitStage({ uid_field: 'a@b.c', password: 'x' })).toEqual({ ok: false });
  });

  it('⚠⚠ a failing status is rejected even when its body IS a valid stage', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE ASSERTION ABOVE COULD NOT SEE ITS OWN SUBJECT
     * ════════════════════════════════════════════════════════════════════════
     * That 404 carries an HTML body, so it fails the JSON parse as well as the
     * status check — and deleting `if (!response.ok) return null` left it
     * passing. **The fixture failed for a second reason, so it proved nothing
     * about the first.** Fourth time this week a fixture of mine has been aimed
     * at a case where both behaviours agree.
     *
     * This one discriminates: a gateway answering 502 with a cached or replayed
     * challenge body. Without the status check the panel would render a stage
     * handed to it by a failing proxy, and somebody would type a password into
     * it.
     */
    fetchMock.mockResolvedValue(jsonResponse(identification, 502));
    expect(await startFlow()).toBeNull();
    expect(await submitStage({})).toEqual({ ok: false });
  });

  it('⚠ a 404 with a JSON body is a transport failure, not a handover', async () => {
    /*
     * DRF's own shape. Without the status check this parses to `handOver`, and
     * the person is moved to the identity provider's page for what is actually a
     * proxy misconfiguration — the one failure they cannot do anything about and
     * the one we most want named as ours.
     */
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'Not found.' }, 404));
    expect(await submitStage({})).toEqual({ ok: false });
  });

  it('⚠⚠ a 200 whose body is not JSON is also a transport failure', async () => {
    /*
     * The nastier shape of the same incident: a proxy or a captive portal
     * answering 200 with HTML. `response.ok` is true, so only the parse catches
     * it — and a thrown parse mid-sign-in must not surface as a crash.
     */
    fetchMock.mockResolvedValue(new Response('<html>hello</html>', { status: 200 }));
    expect(await startFlow()).toBeNull();
  });

  it('a network failure is a transport failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await submitStage({})).toEqual({ ok: false });
  });

  it('★★ a REFUSAL is a 200 and stays a stage, which is the whole distinction', async () => {
    /*
     * Authentik answers 200 with `response_errors` when it genuinely refuses. If
     * that were folded in with the failures above, a wrong password would read as
     * "we couldn't reach sign-in" and nobody would ever be told they mistyped.
     */
    const refused = {
      ...identification,
      response_errors: {
        non_field_errors: [{ string: 'Failed to authenticate.', code: 'invalid' }],
      },
    };
    fetchMock.mockResolvedValue(jsonResponse(refused));
    const outcome = await submitStage({ uid_field: 'a@b.c', password: 'wrong' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.step.kind).toBe('identify');
  });
});

describe('★★ how the request is made', () => {
  it('★★ carries the base path, because fetch is not prefixed by Next', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE DEFECT THIS ASSERTS AGAINST HAS HAPPENED TWICE IN THIS APP
     * ════════════════════════════════════════════════════════════════════════
     * Next prefixes `next/link` and `redirect()`. It does **not** touch `fetch`.
     * A bare `/auth-api/…` leaves `/v2` and hits the legacy application's
     * origin — which is how this app's own sign-in button once started the
     * wrong product's OIDC flow, and the shape of the proxy's `/api/v3/`
     * redirect that made the executor answer with Next's 404 page.
     *
     * ★ The env var is stubbed and the module re-imported, because `BASE_PATH`
     *   is read once at module load. The first version of this test asserted the
     *   URL did not start with `/auth-api/` — which is FALSE under the test
     *   environment's empty base path, so it was checking that the helper had
     *   not been used rather than that it had. Asserting the absence of a
     *   prefix that is empty by default proves nothing.
     */
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/v2');
    const { startFlow: startUnderBasePath } = await import('./flow-executor');

    fetchMock.mockResolvedValue(jsonResponse(identification));
    await startUnderBasePath();

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      '/v2/auth-api/flows/executor/default-authentication-flow/',
    );
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('★★ sends the flow cookie, or the second stage never arrives', async () => {
    /*
     * The flow is stateful and its state is a cookie. Without credentials the
     * executor issues a fresh flow per request and the symptom is an
     * identification stage that repeats — which reads as a rejected password.
     */
    fetchMock.mockResolvedValue(jsonResponse(identification));
    await startFlow();
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin' });
  });

  it('★★ sends the CSRF header this deployment wants, decoded, on POST only', async () => {
    /*
     * `X-authentik-CSRF`, not `X-CSRFToken`. And only on a write: sending it on
     * the opening GET would be harmless but would hide that the cookie has to
     * exist first — the GET is what sets it.
     */
    fetchMock.mockResolvedValue(jsonResponse(identification));
    await startFlow();
    const getHeaders = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(getHeaders['X-authentik-CSRF']).toBeUndefined();

    await submitStage({ uid_field: 'a@b.c', password: 'x' });
    const postInit = fetchMock.mock.calls[1]![1] as RequestInit;
    const postHeaders = postInit.headers as Record<string, string>;
    expect(postHeaders['X-authentik-CSRF']).toBe('tok en');
    expect(postInit.method).toBe('POST');
    expect(postInit.body).toBe('{"uid_field":"a@b.c","password":"x"}');
  });

  it('★ an absent CSRF cookie sends an empty token rather than the string "undefined"', async () => {
    /*
     * A missing cookie means the proxy dropped `Set-Cookie`, which fails in a way
     * that looks exactly like a wrong password. Sending `"undefined"` would make
     * the server-side log of that failure meaningless too.
     */
    Object.defineProperty(document, 'cookie', { value: 'other=1', writable: true });
    fetchMock.mockResolvedValue(jsonResponse(identification));
    await submitStage({});
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-authentik-CSRF']).toBe('');
  });

  it('★ reads the right cookie when another one starts with the same letters', async () => {
    // `authentik_csrf` and `authentik_session` share a prefix, and a naive match
    // on `authentik_` would send the session token as a CSRF header.
    Object.defineProperty(document, 'cookie', {
      value: 'authentik_session=SESSION; authentik_csrf=CSRF',
      writable: true,
    });
    fetchMock.mockResolvedValue(jsonResponse(identification));
    await submitStage({});
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-authentik-CSRF']).toBe('CSRF');
  });
});
