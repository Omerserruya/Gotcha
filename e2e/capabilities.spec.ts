import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

/**
 * Screen 10 · Studio · Capabilities — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/capabilities.spec.ts
 *
 * **Run this spec alone**, and check gate 0 first: if `.next/BUILD_ID` is
 * older than HEAD you are photographing the previous screen.
 *
 * Shots land in e2e/evidence/s10/.
 *
 * ── WHAT THIS TENANT SHOWS ──
 * **Seventeen capabilities, every one a platform default.** Eleven ask first,
 * six act on their own. `kind` is `action` on all of them, so there are no
 * read-only capabilities and no "what it can see" side to draw.
 *
 * This is the only Studio screen besides 07 with a full populated render, so
 * the assertions below are on the real thing rather than on fixtures.
 *
 * ── NOTHING IS WRITTEN ──
 * No `.click()` changes a permission. Every row here governs whether GOTCHA
 * can act on a real customer's order without being asked.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's10');

const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 800 },
  { name: '390', width: 390, height: 844 },
] as const;

test.beforeAll(() => {
  if (!SESSION) {
    throw new Error(
      'GOTCHA_SESSION is not set. This spec captures an authenticated screen; ' +
        'without a session it would photograph the sign-in page instead.',
    );
  }
  mkdirSync(EVIDENCE, { recursive: true });
});

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: SESSION!,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
});

async function openCapabilities(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/studio/capabilities`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/studio/capabilities. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  const states = ['capability-screen', 'capabilities-empty', 'capabilities-unavailable'];
  await expect
    .poll(
      async () => {
        const counts = await Promise.all(states.map((id) => page.getByTestId(id).count()));
        return counts.reduce((a, b) => a + b, 0);
      },
      { message: missingIds(`none of ${states.join(', ')}`), timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  await expect(
    page.getByTestId('capabilities-unavailable'),
    'the capabilities could not be read, so this run would photograph an error panel',
  ).toHaveCount(0);

  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /*
     * 1 · the headline a reader wants first: how many act unasked.
     */
    test('1 · how many act without asking', async ({ page }) => {
      await openCapabilities(page, 'en');

      const summary = page.getByTestId('acts-alone');
      await expect(summary).toBeVisible();
      await expect(summary).toHaveText(/without asking you/i);

      // And the capabilities themselves rendered, so the sentence above is
      // describing something.
      await expect(page.locator('li[data-testid^="capability-"]').first()).toBeVisible();

      await shoot(page, `${size.name}-1-acts-alone`);
    });

    /*
     * 2 · THE SHOT THAT MATTERS.
     *
     * Four settings are identical on all seventeen rows, so they are said
     * once. Seventeen identical toggles would read as seventeen decisions
     * somebody made rather than one default nobody has changed.
     */
    test('2 · the uniform facts, said once', async ({ page }) => {
      await openCapabilities(page, 'en');

      const facts = page.getByTestId('uniform-facts');
      await expect(facts).toBeVisible();

      // Nobody has customised anything.
      await expect(page.getByTestId('all-default')).toHaveText(/has been customised/i);
      // D49: nobody can edit an approved action before it runs.
      await expect(page.getByTestId('no-editing')).toHaveText(/approve it as proposed/i);
      // Every approval dies after thirty minutes — and screen 03 found 13 of
      // 27 approved actions never executed.
      await expect(page.getByTestId('expiry')).toHaveText(/expires after 30 minutes/i);
      // "Who approves this" has no answer.
      await expect(page.getByTestId('no-approver')).toHaveText(/no particular person/i);

      await shoot(page, `${size.name}-2-uniform-facts`);
    });

    /*
     * 3 · grouped by what it is about, never by the risk regex.
     */
    test('3 · grouped by category, not by a regex on the name', async ({ page }) => {
      await openCapabilities(page, 'en');
      const main = page.locator('main');

      // Real category headings are present…
      await expect(page.locator('[data-testid^="group-"]').first()).toBeVisible();

      // …and none of the risk-group names appear as a heading. `riskGroup` is
      // computed from a name pattern with `create_update` as its no-match
      // fallback, so "13 create/update" would mean "13 matched nothing".
      await expect(main).not.toHaveText(/create_update|sensitive_data|read_only|administrative/i);
      await expect(main).not.toHaveText(/risk level|risk group/i);

      await shoot(page, `${size.name}-3-grouped-by-category`);
    });

    /*
     * 4 · THE PINNED OMISSIONS.
     */
    test('4 · no usage counts, no limits, no per-employee overrides', async ({ page }) => {
      await openCapabilities(page, 'en');
      const main = page.locator('main');

      // The only usage route reads a table with zero rows; the populated one
      // has no route at all.
      await expect(main).not.toHaveText(/used \d|never failed|failure count/i);
      // "permission state and numeric limits" — no row carries a limit.
      await expect(main).not.toHaveText(/up to ₪|maximum of|limit of/i);
      // Neither has a source.
      await expect(main).not.toHaveText(/narrow per employee|per-employee|raise the limit/i);

      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-4-pinned-omissions`);
    });

    /* 5 · Hebrew, right to left. */
    test('5 · Hebrew, right to left', async ({ page }) => {
      await openCapabilities(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('uniform-facts')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-5-hebrew`);
    });

    /* 6 · the two standing shell rules. */
    test('6 · content above the fold, no placeholders', async ({ page }) => {
      await openCapabilities(page, 'en');

      const box = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect(box, 'the page heading has no box — is it rendered?').not.toBeNull();
      expect(
        box!.y,
        `the heading starts ${Math.round(box!.y)}px down a ${size.height}px viewport`,
      ).toBeLessThan(size.height / 2);

      await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-6-above-the-fold`);
    });
  });
}
