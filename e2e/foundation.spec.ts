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

test('an unauthenticated visitor is handed to the identity provider with PKCE', async ({
  page,
}) => {
  await page.goto('/en/home');

  // The app must not render a protected page, and the handoff must be a real
  // Authorization Code + PKCE request - not an implicit flow, and not a
  // challenge method we would accept but should not.
  const url = new URL(page.url());
  expect(url.origin).not.toBe('http://localhost:3000');
  expect(url.pathname).toContain('/authorize');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toBeTruthy();
  // `state` is what defeats CSRF on the callback; its absence is a real bug.
  expect(url.searchParams.get('state')).toBeTruthy();
  expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/callback');
});

test('the sign-in page renders in English', async ({ page }) => {
  await page.goto('/en/sign-in');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading')).toBeVisible();
});

test('Hebrew renders as a right-to-left document', async ({ page }) => {
  await page.goto('/he/sign-in');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});

test('the two locales render different copy from the same route', async ({ page }) => {
  await page.goto('/en/sign-in');
  const english = await page.getByRole('heading').textContent();
  await page.goto('/he/sign-in');
  const hebrew = await page.getByRole('heading').textContent();
  expect(english).not.toBe(hebrew);
  expect(hebrew).toMatch(/[֐-׿]/);
});

test('the rail holds the design proportion across viewport widths', async ({ page }) => {
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
  // next-intl prefixes the default locale rather than accepting `zz`, so the
  // document must never claim to be in a language the app does not have.
  await page.goto('/zz/sign-in');
  await expect(page.locator('html')).not.toHaveAttribute('lang', 'zz');
});
