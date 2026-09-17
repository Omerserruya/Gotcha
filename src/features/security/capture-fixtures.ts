import 'server-only';

import type { LoginEvent, SecuritySession } from '@/api/contracts/security';

/**
 * Stand-in sessions and sign-ins, for capturing evidence without banking
 * somebody's real IP address and city into a committed screenshot.
 *
 * ── WHY THIS EXISTS AT ALL ──
 * Screen 16 is the first to render personal data: a real address and the city
 * a person signs in from. The acceptance capture writes full-page screenshots
 * into `e2e/evidence/`, which are committed — so photographing the live list
 * would put personal data in the repository permanently.
 *
 * ── WHY IT IS HERE AND NOT IN THE TEST ──
 * I would rather have intercepted at the network layer and left this file
 * unwritten. That is not possible: the page is a SERVER component, so these
 * calls leave the Node process rather than the browser and Playwright's
 * `page.route` never sees them.
 *
 * ── WHY IT IS NOT A MOCK API LAYER ──
 * It substitutes two arrays, in one file, on one screen, only when an env var
 * is set, and **never when `NODE_ENV` is `production`** — both conditions, so
 * setting the variable on a production host does nothing. Everything else on
 * the screen still reads live, including the audit log and the MFA policy, and
 * the rendering path is the same one a real person gets. No component knows
 * this file exists.
 *
 * The values are RFC 5737 documentation addresses, reserved so they can never
 * belong to anyone, and they are deliberately DISTINCT from each other: the
 * screen's claim is that an unfamiliar session is recognisable, and fixtures
 * that made every row identical would pass a capture that proved nothing.
 */

export function captureFixturesEnabled(): boolean {
  return process.env.E2E_SECURITY_FIXTURES === '1' && process.env.NODE_ENV !== 'production';
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
