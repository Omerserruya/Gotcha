import { expect, test } from '@playwright/test';

/**
 * Foundation smoke tests.
 *
 * These cover the things that must never silently break: the app boots, an
 * unauthenticated visitor is sent to sign-in rather than into the shell, the
 * locale in the URL is the locale that renders, and Hebrew produces a genuine
 * RTL document.
 *
 * They deliberately do not sign in: authentication runs through Authentik, and
 * an end-to-end flow against a real identity provider belongs in its own suite
 * with its own credentials.
 */

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS READ `page.url()` AND THE BROWSER HAD ALREADY MOVED ON
 * ════════════════════════════════════════════════════════════════════════════
 * It navigated to `/en/home` and then inspected the address bar for the
 * authorize URL's PKCE parameters. There are TWO redirects, not one:
 *
 *   /en/home  →  /api/auth/login  →  Authentik /authorize
 *             →  Authentik /if/flow/default-authentication-flow/
 *
 * The last hop is Authentik showing its login form, which is what an
 * unauthenticated visitor is supposed to get. By the time `page.url()` was
 * read it held the flow page, and the parameters had gone with the URL that
 * carried them. The received value was
 * `/if/flow/default-authentication-flow/`.
 *
 * ── AND IT WAS ASSERTING SOMEBODY ELSE'S BEHAVIOUR ──
 * Whether Authentik bounces straight to a flow, shows a chooser, or honours
 * an existing IdP session is **Authentik's decision and can change without
 * us**. Reading the final URL made this test depend on it. Whether it ever
 * passed for the right reason or only when the timing favoured us is no
 * longer knowable, which is its own argument.
 *
 * So the two facts that are OURS are asserted where they are observable, on
 * the redirects our own code emits, with no dependency on what the IdP does
 * next:
 *
 *   A · a protected page hands an unauthenticated visitor to `/api/auth/login`
 *   B · that route issues a real Authorization Code + PKCE handoff
 */
/**
 * ★★ ONE PROJECT CAPTURES, BECAUSE BOTH WOULD WRITE THE SAME FILES.
 *
 * `ltr` and `rtl` differ only in the browser's `locale`, and every screen here
 * takes its direction from the URL — `/en/…` and `/he/…` — which is what
 * next-intl reads. So the two projects rendered identical pixels into
 * identical filenames and, with `fullyParallel: true`, raced to write them.
 *
 * Two costs, and the second is why this landed before a shoot:
 *   · a torn PNG is not a missing shot, it is a corrupt one, and it reads as
 *     a rendering defect;
 *   · it doubled the request budget. The limit is 1,000 requests per fifteen
 *     minutes per IP per service — see `missingIds` — and half of every run
 *     was a re-run of the English tests under a Hebrew locale that changes
 *     nothing.
 *
 * Hebrew is not lost: the specs that cover it navigate to `/he/…` themselves.
 *
 * ── AND THE GUARD IS THE FIRST STATEMENT INSIDE EACH TEST, NOT AT DESCRIBE
 *    SCOPE ──
 * `settings-notifications-seeded.spec.ts` records the trap and it was
 * re-verified before this change: a describe-scope
 * `test.skip(({}, testInfo) => …)` receives FIXTURES ONLY — there is no
 * second argument — so `testInfo` is `undefined` and reading `.project`
 * throws **in both projects**. The guard meant to separate them runs in both
 * and crashes on the value it exists to read.
 */
const CAPTURING_PROJECT = 'ltr';

function onlyOneProject(): boolean {
  const project = test.info().project.name;
  if (project === CAPTURING_PROJECT) return false;
  test.skip(true, `Captured by the ${CAPTURING_PROJECT} project; direction comes from the URL.`);
  return true;
}

test('a protected page hands an unauthenticated visitor to sign-in', async ({ page }) => {
  if (onlyOneProject()) return;

  // No redirect following: the thing under test IS the redirect, and letting
  // the browser chase it is what hid the defect above.
  const response = await page.request.get('/en/home', { maxRedirects: 0 });

  expect(
    [302, 303, 307, 308],
    `a protected page answered ${response.status()} instead of redirecting an anonymous visitor`,
  ).toContain(response.status());
  expect(response.headers()['location']).toContain('/api/auth/login');
});

test('the handoff is Authorization Code + PKCE, not something weaker', async ({ page }) => {
  if (onlyOneProject()) return;

  /*
   * Asserted on the `Location` OUR route sets, so this says nothing about
   * Authentik and cannot be broken by Authentik changing what it shows.
   */
  const response = await page.request.get('/api/auth/login', { maxRedirects: 0 });
  expect(
    [302, 303, 307, 308],
    `the login route answered ${response.status()} instead of redirecting to the provider`,
  ).toContain(response.status());

  const location = response.headers()['location'];
  expect(location, 'the login route redirected without a Location header').toBeTruthy();

  const url = new URL(location!);
  expect(url.origin, 'the handoff stayed on our own origin').not.toBe('http://localhost:3000');
  expect(url.pathname).toContain('/authorize');
  // Not an implicit flow, and not a challenge method we would accept but
  // should not.
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toBeTruthy();
  // `state` is what defeats CSRF on the callback; its absence is a real bug.
  expect(url.searchParams.get('state')).toBeTruthy();
  expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/callback');

  /*
   * ★ AND THE VERIFIER MUST NOT BE READABLE BY SCRIPT.
   *
   * The code verifier and the CSRF state travel in this cookie. It was not
   * asserted before, and it is the half of PKCE the URL cannot show: a
   * challenge in the query string proves nothing if the verifier that
   * matches it is exposed.
   */
  const cookie = response.headers()['set-cookie'] ?? '';
  expect(cookie, 'the login route set no state cookie').toMatch(/gotcha_login/i);
  expect(cookie, 'the PKCE verifier cookie is readable by script').toMatch(/HttpOnly/i);
});

test('the sign-in page renders in English', async ({ page }) => {
  if (onlyOneProject()) return;

  await page.goto('/en/sign-in');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading')).toBeVisible();
});

test('Hebrew renders as a right-to-left document', async ({ page }) => {
  if (onlyOneProject()) return;

  await page.goto('/he/sign-in');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});

test('the two locales render different copy from the same route', async ({ page }) => {
  if (onlyOneProject()) return;

  await page.goto('/en/sign-in');
  const english = await page.getByRole('heading').textContent();
  await page.goto('/he/sign-in');
  const hebrew = await page.getByRole('heading').textContent();
  expect(english).not.toBe(hebrew);
  expect(hebrew).toMatch(/[֐-׿]/);
});

test('the rail holds the design proportion across viewport widths', async ({ page }) => {
  if (onlyOneProject()) return;

  /*
   * The design draws a 210px rail on a 1440px frame - 14.6%. A fixed 210px
   * would honour that at exactly 1440 and nowhere else, so the rail is a
   * proportion with a floor and a cap. This locks the behaviour in.
   *
   * Runs unauthenticated against the sign-in frame's editorial panel would not
   * exercise the rail, so it asserts on the token instead of the shell - which
   * is the value the shell reads.
   */
  await page.goto('/en/sign-in');

  const railWidthAt = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    return page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.inlineSize = 'var(--size-rail)';
      probe.style.position = 'absolute';
      document.body.append(probe);
      const measured = probe.getBoundingClientRect().width;
      probe.remove();
      return measured;
    });
  };

  // Never tighter than the design draws it.
  expect(await railWidthAt(1280)).toBeCloseTo(210, 0);
  // Exactly the design at the width the design was drawn for.
  expect(await railWidthAt(1440)).toBeCloseTo(210, 0);
  // Grows with the frame rather than shrinking away proportionally.
  const wide = await railWidthAt(1920);
  expect(wide).toBeGreaterThan(260);
  expect(wide / 1920).toBeCloseTo(0.146, 2);
  // Capped, because past this the rail is only empty space.
  expect(await railWidthAt(2560)).toBeCloseTo(300, 0);
});

test('an unrecognised locale segment is never treated as a locale', async ({ page }) => {
  if (onlyOneProject()) return;

  // next-intl prefixes the default locale rather than accepting `zz`, so the
  // document must never claim to be in a language the app does not have.
  await page.goto('/zz/sign-in');
  await expect(page.locator('html')).not.toHaveAttribute('lang', 'zz');
});
