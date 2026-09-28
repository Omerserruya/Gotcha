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

/** Where nginx proxies to `authentik_server/api/v3/`. Owned by the gateway. */
const executorUrl = (flow: string) => appPath(`/auth-api/flows/executor/${flow}/`);

/**
 * Authentik's CSRF header for this deployment.
 *
 * Not `X-CSRFToken`: measured, this build wants `X-authentik-CSRF`, taken from
 * the `authentik_csrf` cookie. A proxy that drops `Set-Cookie` breaks this in a
 * way that **looks exactly like a wrong password**, which is the worst possible
 * symptom because it sends everybody debugging the wrong layer.
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

async function call(init?: RequestInit): Promise<FlowStep | null> {
  try {
    const response = await fetch(executorUrl(AUTHENTICATION_FLOW), {
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

/** The first challenge, or `null` when the executor could not be reached. */
export async function startFlow(): Promise<FlowStep | null> {
  return call();
}

/** Answer the current stage. */
export async function submitStage(body: Record<string, unknown>): Promise<SubmitOutcome> {
  const step = await call({ method: 'POST', body: JSON.stringify(body) });
  return step ? { ok: true, step } : { ok: false };
}
