import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';
import { shoot as captureScreen } from './shoot';

/**
 * Screen 09 · Studio · Automations — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/automations.spec.ts
 *
 * **Run this spec alone.**
 *
 * Shots land in e2e/evidence/s09/.
 *
 * ── WHAT THIS TENANT SHOWS ──
 * **Zero automations.** Not worked around: creating one means wiring a rule
 * that acts on real conversations without anyone watching, which is the last
 * thing to build for a screenshot. The row judgements live in
 * `src/api/contracts/automations.test.ts`.
 *
 * ── NOTHING IS WRITTEN ──
 * No `.click()` creates, activates or deletes anything.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's09');

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

async function openAutomations(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/studio/automations`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/studio/automations. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  const states = ['automations-empty', 'automations-screen', 'automations-unavailable'];
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
    page.getByTestId('automations-unavailable'),
    'the automations could not be read, so this run would photograph an error panel',
  ).toHaveCount(0);

  return page;
}

/**
 * Shots land in `EVIDENCE`. The helper grows the viewport before capturing:
 * this app scrolls `main`, not the document, so `fullPage` alone captured
 * exactly one screenful — see `e2e/shoot.ts`.
 */
async function shoot(page: Page, name: string) {
  await captureScreen(page, EVIDENCE, name);
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /* 1 · nothing automated yet, as a state with its consequence. */
    test('1 · none yet reads as a state', async ({ page }) => {
      await openAutomations(page, 'en');

      const empty = page.getByTestId('automations-empty');
      await expect(empty).toBeVisible();
      await expect(empty).toHaveText(/no automations yet/i);
      // What it costs: every message waits for a person or an AI employee.
      await expect(empty).toHaveText(/waits for a person/i);

      await shoot(page, `${size.name}-1-none-yet`);
    });

    /* 2 · THE PINNED OMISSIONS. */
    test('2 · no weekly counts, no revenue, no run history', async ({ page }) => {
      await openAutomations(page, 'en');
      const main = page.locator('main');

      // `runCount` is cumulative with no clock, and there are no run records.
      await expect(main).not.toHaveText(/this week|this month|today\b/i);

      // Attributed revenue — FIFTH appearance across five screens.
      await expect(main).not.toHaveText(/recovered|revenue|₪\s?\d/i);

      // `isActive` is a bare boolean: no actor, no timestamp.
      await expect(main).not.toHaveText(/paused by you|paused on/i);

      // Neither exists.
      await expect(main).not.toHaveText(/dry.?run|watch.only|stop reason/i);

      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-2-pinned-omissions`);
    });

    /* 3 · Hebrew, right to left. */
    test('3 · Hebrew, right to left', async ({ page }) => {
      await openAutomations(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('automations-empty')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-3-hebrew`);
    });

    /* 4 · the two standing shell rules. */
    test('4 · content above the fold, no placeholders', async ({ page }) => {
      await openAutomations(page, 'en');

      const box = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect(box, 'the page heading has no box — is it rendered?').not.toBeNull();
      expect(
        box!.y,
        `the heading starts ${Math.round(box!.y)}px down a ${size.height}px viewport`,
      ).toBeLessThan(size.height / 2);

      await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-4-above-the-fold`);
    });
  });
}
