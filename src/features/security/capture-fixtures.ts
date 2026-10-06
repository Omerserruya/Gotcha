import 'server-only';

import type { LoginEvent, SecuritySession } from '@/api/contracts/security';

/**
 * Stand-in sessions and sign-ins, for capturing evidence without banking
 * somebody's real IP address and city into a committed screenshot.
 *
 * ── WHY THIS EXISTS AT ALL ──
 * Screen 16 is the first to render personal data: a real address and the city
 * a person signs in from. The acceptance capture writes full-page screenshots
 * into `e2e/evidence/`, so photographing the live list would put personal data
 * into files.
 *
 * **Correction, 2026-09-20.** This used to say those screenshots "are
 * committed". They are not, and never have been - `e2e/evidence/` has been
 * gitignored since the commit that introduced it. The gate is unchanged
 * because it was never about git: the files are written to disk, opened by
 * whoever runs the capture, and relayed between sessions. *Not committed is
 * not not disclosed*, and being ignored is worse - a committed file has a
 * history someone could purge and a review that would have seen it. See
 * `e2e/README.md`, gate 2.
 *
 * ── WHY IT IS HERE AND NOT IN THE TEST ──
 * I would rather have intercepted at the network layer and left this file
 * unwritten. That is not possible: the page is a SERVER component, so these
 * calls leave the Node process rather than the browser and Playwright's
 * `page.route` never sees them.
 *
 * ── WHY IT IS NOT A MOCK API LAYER ──
 * It substitutes two arrays, in one file, on one screen, only when an env var
 * is set **and the app is serving itself on a loopback address**. Everything
 * else on the screen still reads live, including the audit log and the MFA
 * policy, and the rendering path is the same one a real person gets. No
 * component knows this file exists.
 *
 * The values are RFC 5737 documentation addresses, reserved so they can never
 * belong to anyone, and they are deliberately DISTINCT from each other: the
 * screen's claim is that an unfamiliar session is recognisable, and fixtures
 * that made every row identical would pass a capture that proved nothing.
 */

/**
 * Both conditions, and the second is the one doing the work.
 *
 * ── WHY NOT `NODE_ENV !== 'production'` ──
 * That was the first guard and it was broken: `next start` IS production mode,
 * Next sets `NODE_ENV` itself, so the clause was always false and the fixtures
 * could never engage. The capture caught it - 42 tests refused rather than
 * photographing live data - but the intent was wrong as well as the code.
 * Build mode describes how the bundle was compiled; it says nothing about
 * whose machine is serving it.
 *
 * ── WHY THE ORIGIN ──
 * `APP_ORIGIN` is the address this app answers on, and a host serving real
 * people cannot be on a loopback address - a browser elsewhere could never
 * reach it. So "am I only reachable from this machine?" is the question that
 * actually distinguishes a capture run from a deployment, and it holds
 * whatever `NODE_ENV` says.
 *
 * **Fail closed.** A missing, malformed or non-loopback origin yields `false`.
 * Someone setting `E2E_SECURITY_FIXTURES=1` on the real app - by accident or
 * otherwise - gets live behaviour, which is the property this guard exists to
 * preserve.
 */
export function captureFixturesEnabled(): boolean {
  if (process.env.E2E_SECURITY_FIXTURES !== '1') return false;
  /*
   * `process.env` directly rather than `serverEnv()`, because the layer rules
   * forbid `features → config` and this is not worth an exception. It is the
   * same source: `serverEnv()` parses `process.env`, and Next loads
   * `.env.local` into it at runtime under `next start` as well as in dev.
   *
   * The value is only ever compared, never rendered, so an unvalidated read
   * costs nothing here - and `isLoopbackOrigin` fails closed on anything it
   * cannot parse.
   */
  return isLoopbackOrigin(process.env.APP_ORIGIN);
}

/** Exported for its own test: this predicate is the whole safety property. */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    // An origin we cannot parse is not one we can vouch for.
    return false;
  }
  /*
   * `hostname` KEEPS the brackets on an IPv6 literal - `http://[::1]:3000`
   * yields `[::1]`, not `::1`. I had that backwards in a comment and the test
   * caught it, which is the reason this predicate has one.
   */
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

export const FIXTURE_SESSIONS: readonly SecuritySession[] = [
  {
    id: 'sess-current',
    current: true,
    ip: '203.0.113.10',
    userAgent: 'Chrome 141 on macOS',
    city: 'Tel Aviv',
    country: 'IL',
    lastUsed: '2026-09-17T09:40:00.000Z',
    expires: '2026-10-17T09:40:00.000Z',
  },
  {
    id: 'sess-other',
    current: false,
    ip: '203.0.113.77',
    userAgent: 'Firefox 132 on Windows',
    city: 'Haifa',
    country: 'IL',
    lastUsed: '2026-09-15T18:02:00.000Z',
    expires: '2026-10-15T18:02:00.000Z',
  },
];

export const FIXTURE_LOGINS: readonly LoginEvent[] = [
  {
    id: 'login-ok',
    action: 'login',
    success: true,
    ip: '203.0.113.10',
    city: 'Tel Aviv',
    country: 'IL',
    userAgent: 'Chrome 141 on macOS',
    timestamp: '2026-09-17T09:40:00.000Z',
  },
  {
    // The row a person is actually scanning for.
    id: 'login-failed',
    action: 'login_failed',
    success: false,
    ip: '203.0.113.201',
    city: 'Frankfurt',
    country: 'DE',
    userAgent: 'Chrome 138 on Windows',
    timestamp: '2026-09-16T02:14:00.000Z',
  },
];
