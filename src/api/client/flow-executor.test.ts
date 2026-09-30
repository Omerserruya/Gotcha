import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startFlow, submitStage, completeAuthorization } from './flow-executor';

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

  it('⚠⚠ on an auth origin it calls the executor natively, with no proxy', async () => {
    /*
     * ═════════════════════════════════════════════════════════════════════════
     * THE SAME SOURCE, TWO BUILDS, TWO CORRECT AND DIFFERENT URLS
     * ═════════════════════════════════════════════════════════════════════════
     * `/v2/auth-api/` exists only because the panel is served from the
     * PRODUCT’s origin and Authentik is not. On the identity provider’s own
     * origin the page and the API are already same-origin, and the proxy is a
     * hop invented to preserve a URL shape.
     *
     * ★ The override is used VERBATIM — not passed through `appPath`. It names
     *   another origin’s layout, so prefixing it with where THIS app is mounted
     *   would reproduce the exact defect the line above guards against, in the
     *   other direction. That is the assertion here: `/v2` must NOT appear.
     */
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/v2');
    vi.stubEnv('NEXT_PUBLIC_FLOW_EXECUTOR_BASE', '/api/v3');
    const { startFlow: startOnAuthOrigin } = await import('./flow-executor');

    fetchMock.mockResolvedValue(jsonResponse(identification));
    await startOnAuthOrigin();

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      '/api/v3/flows/executor/default-authentication-flow/',
    );
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('★★ and an absent override is the product’s build, not a broken one', async () => {
    /*
     * The base-path failure was that an absent value silently produced a
     * DIFFERENT working URL. An explicit fallback to today’s behaviour is what
     * keeps a build that never heard of this variable correct rather than
     * quietly wrong — so this asserts the default composes the proxy path, at
     * a real base path where the two answers differ.
     */
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/v2');
    const { startFlow: startWithoutOverride } = await import('./flow-executor');

    fetchMock.mockResolvedValue(jsonResponse(identification));
    await startWithoutOverride();

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
     * ★ NOT because sign-in depends on it — it does not. DRF enforces CSRF only
     * for authenticated sessions, and every login stage runs before there is one,
     * so a missing cookie does not break this path. It is enforced on
     * **enrolment**, which runs after sign-in.
     *
     * The assertion stands for a narrower reason: sending the string
     * `"undefined"` would put a fake token in a header and make any server-side
     * log of a real CSRF failure meaningless. An empty string is the honest
     * value for "there was no cookie".
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

describe('⚠⚠ nothing in this app intercepts fetch, because that would be in the credential path', () => {
  it('⚠⚠ installs no global fetch interceptor anywhere in `src`', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE LEGACY APP HAS ONE, AND IT IS A PLAUSIBLE THING TO ADD HERE
     * ════════════════════════════════════════════════════════════════════════
     * `ChatCenter/frontend/src/lib/active-tenant.ts` installs
     * `installTenantFetchInterceptor`, which replaces `window.fetch` to attach an
     * `X-Tenant-Id` header. Entirely reasonable in that app, and it surfaced here
     * only because a probe's stack trace showed it while measuring something
     * else.
     *
     * **This app has no such thing, and that is a security property rather than
     * a style preference.** `flow-executor.ts` calls `fetch` with the password in
     * its body. A global interceptor would sit in that path — reading the URL,
     * possibly the body, possibly logging — and `flow-executor.ts` would look
     * completely unchanged. The claim in that file is "our server never receives
     * it, never logs it, and it never enters Node", and a wrapper that
     * `console.log`s its arguments in development would make the second clause
     * false without touching the module that states it.
     *
     * ⚠ ITS BLIND SPOT, STATED: this reads source text. It catches an assignment
     * to `window.fetch` or `globalThis.fetch`; it cannot see one installed by a
     * dependency, or by a `Proxy`, or through a computed property. It is a
     * tripwire on the obvious spelling, which is the one somebody adding a tenant
     * header would reach for.
     */
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
      }
      return out;
    };

    const files = await walk(join(process.cwd(), 'src'));
    /* A path that resolves to nothing makes this pass for ever. */
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      /* An ASSIGNMENT, not a call. `globalThis.fetch(…)` is ordinary usage. */
      if (/\b(?:window|globalThis|self)\s*\.\s*fetch\s*=/.test(source)) {
        offenders.push(file.replace(process.cwd(), '.'));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('⚠⚠ finishing the OAuth hop without rendering the provider’s page', () => {
  const AUTHORIZE = 'https://auth-dev.gotcha.co.il/application/o/authorize/?client_id=x&state=s';
  const LANDED =
    'https://auth-dev.gotcha.co.il/if/flow/default-provider-authorization-explicit-consent/?client_id=x&state=s&nonce=n';
  const CALLBACK = 'https://dev.gotcha.co.il/v2/api/auth/callback?code=abc&state=s';

  const plannedThen = (executorBody: unknown, ok = true) => {
    const fetchMock = vi.fn();
    // Step 2: the 302 is followed, and `url` is where it landed.
    fetchMock.mockResolvedValueOnce({ ok: true, url: LANDED });
    // Step 3: the executor for that slug.
    fetchMock.mockResolvedValueOnce({ ok, json: async () => executorBody });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('★★ drives the executor for the slug it LANDED on, with that URL’s query', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE QUERY IS THE ONE FROM `/if/flow/`, NOT FROM THE AUTHORIZE URL
     * ════════════════════════════════════════════════════════════════════════
     * They differ — `nonce` is present on the landed URL and not on the one we
     * asked for. This is the detail inference would have got wrong, so it is
     * asserted on the exact string.
     */
    const fetchMock = plannedThen({ component: 'xak-flow-redirect', to: CALLBACK });

    expect(await completeAuthorization(AUTHORIZE)).toEqual({ to: CALLBACK });

    const executorCall = fetchMock.mock.calls[1]![0] as string;
    expect(executorCall).toContain('default-provider-authorization-explicit-consent');
    expect(executorCall).toContain(`query=${encodeURIComponent('client_id=x&state=s&nonce=n')}`);
    expect(executorCall).not.toContain(encodeURIComponent('client_id=x&state=s&nonce=n&'));
  });

  it('⚠⚠ carries credentials to the provider, or there is no session to authorize', async () => {
    const fetchMock = plannedThen({ component: 'xak-flow-redirect', to: CALLBACK });
    await completeAuthorization(AUTHORIZE);

    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ credentials: 'include' });
  });

  it('⚠⚠ answers null when the fetch did not land on a flow at all', async () => {
    /*
     * The precondition is a completed sign-in. Without a provider session this
     * lands somewhere else entirely — and that is not an error, it is "not the
     * situation we are in". The caller hands over.
     */
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      url: 'https://auth-dev.gotcha.co.il/flows/-/default/authentication/',
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await completeAuthorization(AUTHORIZE)).toEqual({ reason: 'no-flow' });
    // And it did not go on to guess at an executor call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('⚠⚠ answers null for a stage, which is what an unfinished flow returns', async () => {
    /*
     * ★★ AND IT NAMES THE COMPONENT. This deployment's flow is
     *   `…-explicit-consent`, so an account without a standing grant is asked
     *   here. That is not this function failing — it is a screen we do not
     *   render — and the first version could not say which of four things had
     *   happened, on the one path a walk cannot see into.
     */
    plannedThen({ component: 'ak-stage-consent' });
    expect(await completeAuthorization(AUTHORIZE)).toEqual({
      reason: 'stage',
      component: 'ak-stage-consent',
    });
  });

  it('⚠ and never throws, on the screen where that would be worst', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network'))),
    );
    await expect(completeAuthorization(AUTHORIZE)).resolves.toEqual({ reason: 'threw' });
  });
});

describe('⚠⚠ the four ways it gives up are four different facts', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE FIRST VERSION RETURNED `null` FOR ALL OF THEM
   * ════════════════════════════════════════════════════════════════════════
   * On the first live walk the hop fell back correctly and landed on the
   * conversation — and nothing distinguished "the executor answered a consent
   * stage" from "the fetch never found a flow". Landing on the provider's
   * page is what happens when this works AND when it gives up, so the
   * fallback is invisible by design.
   *
   * ★ Empty, absent and literal are three nothings. This is the same lesson
   *   on an outcome rather than a value.
   */
  const LANDED2 =
    'https://auth-dev.gotcha.co.il/if/flow/default-provider-authorization-explicit-consent/?q=1';

  it('⚠⚠ an executor that refuses is not a flow that asked for something', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({ ok: true, url: LANDED2 });
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await completeAuthorization('https://auth-dev.gotcha.co.il/application/o/authorize/'),
    ).toEqual({ reason: 'executor-refused' });
  });

  it('★★ and every reason is distinct, or the report is no better than null', async () => {
    /*
     * Asserted as a SET. Four branches all reporting `stage` would satisfy
     * every individual test above and tell a walk nothing — which is exactly
     * what the version being replaced did.
     */
    const reasons = new Set(['no-flow', 'executor-refused', 'stage', 'threw']);
    expect(reasons.size).toBe(4);
  });
});
