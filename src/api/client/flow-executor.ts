'use client';

import { appPath } from '@/lib/base-path';

import { AUTHENTICATION_FLOW, readChallenge, type FlowStep } from '../contracts/auth-flow';

/**
 * Driving Authentik's flow executor from the browser.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE PASSWORD MUST NOT ENTER OUR NODE PROCESS. THAT IS THE WHOLE DESIGN.
 * ════════════════════════════════════════════════════════════════════════════
 * These are `fetch` calls **from the browser** to a path nginx proxies straight
 * to `authentik_server`. Not a route handler, not a server action, not a
 * `serverApi()` call. If any of this ever moves server-side, our application is
 * in the credential path and the reason we are allowed our own sign-in screen
 * collapses entirely.
 *
 * The argument is that our nginx already fronts `auth-dev.gotcha.co.il`, so
 * every password typed on the existing login page already crosses this proxy —
 * a same-origin path under `/v2` adds no new exposure. That holds only while the
 * request goes browser → nginx → Authentik with nothing of ours in between.
 *
 * ★ To be precise about what is and is not claimed: **our server never receives
 *   the password, never logs it, and it never enters Node.** Our JavaScript does
 *   render the field, so an XSS in our bundle could read it — true of any
 *   first-party login form, and why this route gets a narrowed CSP. Saying "our
 *   application is not in the credential path" would be a stronger claim than
 *   the architecture supports.
 *
 * ★★ AND THE SECOND CLAUSE DEPENDS ON SOMETHING NOT WRITTEN HERE: that no code
 *   in this app replaces `window.fetch`. The legacy product does exactly that —
 *   `installTenantFetchInterceptor` wraps it to attach a tenant header — and it
 *   is a reasonable thing for somebody to add here too. A wrapper would sit in
 *   this call's path, reading the URL and possibly the body, while **this file
 *   would look completely unchanged**. A `console.log` of its arguments in
 *   development would make "never logs it" false without anybody editing the
 *   module that says it. Verified absent, and guarded in the test beside it.
 *
 * ── WHY IT LIVES IN `api/client` AND NOT BESIDE THE PANEL ──
 * `no-restricted-globals` forbids `fetch` in UI code, and the rule is right:
 * network access belongs in `src/api`. This is an API client — it is simply a
 * client for somebody else's API, which is why it does **not** go through
 * `HttpClient` beside `browserApi`. That client adds our envelope, our contracts
 * and our `ApiError` taxonomy, none of which describe Authentik, and it would
 * put this call on the same code path as every request that carries our session
 * cookie and tenant header.
 *
 * ── AND `appPath`, BECAUSE FETCH IS NOT PREFIXED ──
 * Next prefixes `next/link` and `redirect()` with `basePath`. It does not touch
 * `fetch`. A bare `/auth-api/...` here would leave `/v2` and hit the legacy
 * app's origin — the same defect that sent the sign-in button to the wrong
 * application's login route.
 */

/**
 * The executor's base, which is not the same on both builds of this source.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ★★ ON THE PRODUCT ORIGIN THIS IS A PROXY. ON AN AUTH ORIGIN IT IS NOT.
 * ═════════════════════════════════════════════════════════════════════════════
 * Under `/v2`, `/v2/auth-api/…` is a gateway location that proxies to
 * `authentik_server/api/v3/`. That indirection exists only because the panel is
 * served from the PRODUCT’s origin and Authentik is not.
 *
 * Served from the identity provider’s own origin, the panel and the API are
 * already same-origin and the proxy is **not needed at all** — `/api/v3/…` is
 * the real path. Keeping the proxy there would be a hop invented to preserve a
 * URL shape.
 *
 * ★ So it is a variable, and it is `NEXT_PUBLIC_` because this runs in the
 *   browser. Like `BASE_PATH` it is **inlined at build time**: setting it on a
 *   running container does nothing, and the two builds differ by their build
 *   arguments rather than by their source.
 *
 * ★★ AND THE BASE-PATH LESSON APPLIES TO IT, WHICH IS WHY THE DEFAULT IS THE
 *   CURRENT BEHAVIOUR AND NOT A VALUE. Unset, this composes exactly the string
 *   it has always composed. A build that forgets it is the product’s build,
 *   not a broken one — the failure mode of the base path was that an absent
 *   value silently produced a DIFFERENT working URL, and that is what an
 *   explicit fallback to today’s behaviour avoids.
 *
 *   The remaining risk is the honest one: a build whose configuration does not
 *   match the origin it is served from. Nothing in the page can show that, so
 *   it is asserted in the test beside this file for both shapes rather than
 *   left to a walk to discover.
 */
const EXECUTOR_BASE = process.env.NEXT_PUBLIC_FLOW_EXECUTOR_BASE ?? '';

/**
 * Where the flow executor answers.
 *
 * `appPath` when nothing overrides it, because `fetch` is not prefixed: Next
 * prefixes `next/link` and `redirect()` with `basePath` and does not touch
 * this. A bare `/auth-api/…` would leave `/v2` and hit the legacy app’s
 * origin — the same defect that sent the sign-in button to the wrong
 * application’s login route.
 *
 * An override is used verbatim, because a value naming another origin’s layout
 * has nothing to do with where THIS app is mounted, and prefixing it would
 * reproduce that defect in the other direction.
 */
const executorUrl = (flow: string) =>
  EXECUTOR_BASE === ''
    ? appPath(`/auth-api/flows/executor/${flow}/`)
    : `${EXECUTOR_BASE}/flows/executor/${flow}/`;

/**
 * Authentik's CSRF header for this deployment.
 *
 * Not `X-CSRFToken`: this build wants `X-authentik-CSRF`, taken from the
 * `authentik_csrf` cookie.
 *
 * ⚠ AND THE WARNING THAT USED TO BE HERE WAS WRONG. It said a proxy dropping
 * `Set-Cookie` would break this "in a way that looks exactly like a wrong
 * password". **It would not**, on this path: DRF's `SessionAuthentication`
 * enforces CSRF only for requests carrying an **authenticated session**, and
 * every stage of the login flow — identification, authenticator-validate,
 * user-login — runs *before* anybody is signed in. Measured 2026-09-28: our
 * POSTs succeed whether or not the cookie is there, and always have.
 *
 * So the header is sent because it is correct and free, not because this path
 * depends on it. **Enrolment is where it is enforced** — that stage runs after
 * sign-in, and a POST to it without the pair fails with `CSRF cookie not set`,
 * surfaced as an opaque `ak-stage-flow-error`. Anybody building 00b's second
 * half needs the cookie and the header; anybody debugging a failed sign-in
 * should look elsewhere.
 */
const CSRF_HEADER = 'X-authentik-CSRF';
const CSRF_COOKIE = 'authentik_csrf';

function csrfToken(): string {
  const match = new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]*)`).exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

/**
 * What a submit produced.
 *
 * `ok: false` is deliberately NOT a handover. A network blip while somebody is
 * signing in should let them press the button again — not throw away what they
 * typed and move them to a different screen.
 */
export type SubmitOutcome = { readonly ok: true; readonly step: FlowStep } | { readonly ok: false };

async function call(
  init?: RequestInit,
  flow: string = AUTHENTICATION_FLOW,
): Promise<FlowStep | null> {
  try {
    const response = await fetch(executorUrl(flow), {
      /*
       * The flow is stateful and its state is a cookie. Without this the
       * executor issues a fresh flow on every request and the second stage never
       * arrives — with the symptom being an identification stage that repeats.
       */
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json', [CSRF_HEADER]: csrfToken() } : {}),
      },
      ...init,
    });
    /*
     * A non-2xx is not a stage. Authentik answers **200** with `response_errors`
     * for a refused submit, so a 4xx or 5xx here is the transport or the proxy
     * failing — and must never be rendered as "wrong password".
     */
    if (!response.ok) return null;
    return readChallenge(await response.json());
  } catch {
    return null;
  }
}

/**
 * The first challenge, or `null` when the executor could not be reached.
 *
 * ★ `flow` defaults to the one this application authorises against, so every
 *   existing caller is unchanged. Recovery passes its own — a DIFFERENT flow,
 *   with its own cookie and its own stages, driven through the same executor.
 */
export async function startFlow(flow?: string): Promise<FlowStep | null> {
  return call(undefined, flow);
}

/**
 * Answer the current stage.
 *
 * ⚠ The flow must match the one `startFlow` opened. Submitting to the wrong
 *   slug does not error — it starts a fresh flow of that kind and answers ITS
 *   first stage, so the symptom is a stage that repeats rather than a failure.
 */
export async function submitStage(
  body: Record<string, unknown>,
  flow?: string,
): Promise<SubmitOutcome> {
  const step = await call({ method: 'POST', body: JSON.stringify(body) }, flow);
  return step ? { ok: true, step } : { ok: false };
}

/**
 * Finish the OAuth hop without ever rendering the provider's page.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE SLUG IS THE WHOLE DIFFERENCE, AND IT IS WHY THIS EXISTS
 * ════════════════════════════════════════════════════════════════════════════
 * Started BY SLUG, as `startFlow()` does, a flow has no continuation and
 * completes to the provider's root — `to: "/"`. Started through
 * `/application/o/authorize/`, the plan carries the OAuth continuation and
 * completes to **our callback with the code**.
 *
 * So `to` is not one field with two meanings. It is one field reporting where
 * the flow it was given actually ends, and both answers are right about their
 * own flow.
 *
 * ── THE THREE CALLS, AS MEASURED 2026-09-30 ──
 *   1. the authorize URL is minted by our own login route — PKCE and state
 *      are its secrets and this function never constructs one
 *   2. `fetch(authorizeUrl)` answers a 302 the fetch FOLLOWS. The HTML of
 *      `/if/flow/` comes back in the body and is simply never rendered —
 *      no navigation, nothing displayed. `response.url` is how the slug and
 *      the query are learned.
 *   3. the executor for that slug, with the `/if/flow/` URL's query
 *
 * ⚠⚠ THE QUERY IS THE ONE FROM STEP 2, NOT FROM THE AUTHORIZE URL. They
 *    differ, and this is the detail that would have been wrong by inference.
 *
 * ⚠ PRECONDITION: a completed sign-in, so a provider session exists. Without
 *   one this lands on the authentication flow instead and answers a stage
 *   rather than a redirect — which is not an error here, it is `null`, and
 *   the caller hands over exactly as it does for anything else it cannot use.
 *
 * ⚠⚠ IT REPORTS WHY IT FAILED, AND THE FIRST VERSION DID NOT. Four different
 *    outcomes returned `null`: no slug, a non-OK executor, a stage instead of
 *    a redirect, and a thrown fetch. On the first live walk the hop fell back
 *    correctly and **there was no way to tell which of the four had happened**
 *    — empty, absent and literal collapsed into one nothing, on the one path
 *    a walk cannot otherwise see into.
 *
 * @returns `{ to }` on success, or `{ reason }` naming which step gave up.
 *          `to` is UNVALIDATED — the caller decides whether it is somewhere a
 *          browser may be sent. See `followableCompletion`.
 */
export type AuthorizationOutcome =
  | { readonly to: string; readonly reason?: undefined; readonly component?: undefined }
  | {
      readonly to?: undefined;
      /** Which step gave up. Named so a walk can distinguish them. */
      readonly reason: 'no-flow' | 'executor-refused' | 'stage' | 'threw';
      /** The component the executor answered with, when it answered one. */
      readonly component?: string;
    };

export async function completeAuthorization(authorizeUrl: string): Promise<AuthorizationOutcome> {
  try {
    /*
     * `credentials: 'include'`, not `same-origin`: the authorize endpoint is
     * on the provider's origin and the whole point is to carry the session
     * cookie there. It is the same request the browser would make by
     * navigating — we simply keep the answer instead of rendering it.
     */
    const planned = await fetch(authorizeUrl, { credentials: 'include' });

    /*
     * ⚠ `response.url` AFTER THE REDIRECTS, NOT THE URL WE ASKED FOR. That is
     *   where the slug lives. If the fetch did not move, there is no plan to
     *   drive and this is not the situation we are in.
     */
    const landed = new URL(planned.url);
    const slug = /\/if\/flow\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(landed.pathname)?.[1];
    if (!slug) return { reason: 'no-flow' };

    const answer = await fetch(
      `${executorUrl(slug)}?query=${encodeURIComponent(landed.search.replace(/^\?/, ''))}`,
      { credentials: 'include', headers: { Accept: 'application/json' } },
    );
    if (!answer.ok) return { reason: 'executor-refused' };

    const step = readChallenge(await answer.json());
    if (step.kind === 'done') return { to: step.idpPath };

    /*
     * ⚠ A STAGE, NOT A REDIRECT. The most likely one here is consent: this
     *   deployment's flow is `…-explicit-consent`, and an account without a
     *   standing grant is asked. That is not a defect in this function — it
     *   is a screen we do not render — but it is the difference between
     *   "the mechanism is broken" and "the mechanism worked and the flow
     *   wants something", and the first walk could not tell them apart.
     */
    return { reason: 'stage', component: step.kind === 'handOver' ? step.because : step.kind };
  } catch {
    /*
     * Never throws. This runs on a screen where somebody has just finished
     * signing in; an exception here would surface as a crash at the last
     * moment instead of a hand-over that completes.
     */
    return { reason: 'threw' };
  }
}
