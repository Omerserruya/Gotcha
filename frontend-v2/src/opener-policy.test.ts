import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ META'S SIGNUP POPUP MUST REACH ITS OPENER (prod, 2026-11-10).
 *
 * `Cross-Origin-Opener-Policy: same-origin` put Meta's Embedded Signup window
 * in another browsing context group: `window.opener` was null in the popup,
 * FB.login answered `{authResponse: null}` within a second, and the
 * WA_EMBEDDED_SIGNUP message never arrived. Measured in Chromium: with
 * `same-origin-allow-popups` the opener survives and the message lands.
 *
 * Global, never per path: COOP is fixed when the document loads, so a client
 * navigation into channels keeps the first page's value.
 *
 * ★ Granularity: the source of next.config.ts (importing it would run the
 *   Sentry and next-intl wrappers). It sees one header entry, not the gateway
 *   or the response; the prod smoke reads the response.
 */
const config = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8');

describe('★★ COOP lets Meta’s popup reach its opener', () => {
  it('next.config.ts sets COOP exactly once, to same-origin-allow-popups, on every path', () => {
    const entries = [
      ...config.matchAll(/key:\s*'Cross-Origin-Opener-Policy',\s*value:\s*'([^']*)'/g),
    ].map((m) => m[1]);
    expect(entries).toEqual(['same-origin-allow-popups']);
    expect(config).toMatch(/source:\s*'\/:path\*',\s*headers:\s*securityHeaders/);
  });
});
