import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

/**
 * Screen 07 · Studio · AI employees — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/employees.spec.ts
 *
 * **Run this spec alone.** The whole suite in parallel trips the rate limiter.
 *
 * Shots land in e2e/evidence/s07/.
 *
 * ── WHAT THIS TENANT SHOWS ──
 * **One ACTIVE employee** — the first Studio screen with real content rather
 * than an empty state.
 *
 * ── NOTHING IS WRITTEN ──
 * The pause confirmation is OPENED to photograph it and then dismissed with
 * "Keep it working". **`pause-go` is never clicked**: pausing stops a live
 * employee answering real customers, and nothing would tell them.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's07');

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

async function openEmployees(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/studio/employees`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/studio/employees. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  const states = ['employees-screen', 'employees-empty', 'employees-unavailable'];
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
    page.getByTestId('employees-unavailable'),
    'the employees could not be read, so this run would photograph an error panel',
  ).toHaveCount(0);

  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /* 1 · the roster, with the counts captioned as what they are. */
    test('1 · the roster', async ({ page }) => {
      await openEmployees(page, 'en');

      await expect(page.getByTestId('employee-list')).toBeVisible();
      const rows = page.locator('li[data-testid^="employee-"]');
      await expect(rows.first()).toBeVisible();

      // "Open right now" — never captioned as live activity, because the
      // count is OPEN + WAITING and WAITING usually means waiting on the
      // customer.
      await expect(page.locator('main')).toHaveText(/open right now/i);
      await expect(page.locator('main')).not.toHaveText(/being handled|handling now/i);

      await shoot(page, `${size.name}-1-roster`);
    });

    /*
     * 2 · THE SHOT THAT MATTERS.
     *
     * The design says "Hire, edit, pause, fire" and the platform has three of
     * those four. Saying which one is missing is the point — omitting it
     * silently would read as an oversight.
     */
    test('2 · firing is named as the thing GOTCHA cannot do', async ({ page }) => {
      await openEmployees(page, 'en');

      const note = page.getByTestId('cannot-fire');
      await expect(note).toBeVisible();
      await expect(note).toHaveText(/no way to retire one/i);
      await expect(note).toHaveText(/pause an ai employee and start it again/i);

      await shoot(page, `${size.name}-2-cannot-fire`);
    });

    /*
     * 3 · THE CONSEQUENCE, STATED BEFORE THE CLICK.
     *
     * Opens the confirmation and photographs it, then dismisses it. `pause-go`
     * is never pressed — pausing stops a live employee answering real
     * customers.
     */
    test('3 · pausing names who stops getting replies', async ({ page }) => {
      await openEmployees(page, 'en');

      const pause = page.locator('[data-testid^="pause-"]').first();
      await expect(pause).toBeVisible();
      await pause.click();

      const consequence = page.locator('[data-testid^="pause-consequence-"]').first();
      await expect(consequence).toBeVisible();
      // The two things that are true either way: no reply, and nobody told.
      await expect(consequence).toHaveText(/no reply|stop getting replies/i);
      await expect(consequence).toHaveText(/nobody (is|will be) told/i);

      await shoot(page, `${size.name}-3-pause-consequence`);

      // Dismiss. Nothing is written by this spec.
      await page.locator('[data-testid^="pause-back-"]').first().click();
      await expect(consequence).toHaveCount(0);
    });

    /* 4 · THE PINNED OMISSIONS. */
    test('4 · no escalations, no rating, no coverage', async ({ page }) => {
      await openEmployees(page, 'en');
      const main = page.locator('main');

      // `isHandedOver` has six-plus writers; the cause would need
      // ConversationHandover.reason, which holds zero rows while five
      // conversations carry the flag.
      await expect(main).not.toHaveText(/escalat/i);
      // Neither rating nor topic coverage has a source.
      await expect(main).not.toHaveText(/rating|satisfaction|coverage by topic/i);
      // And no "fire"/"retire" control, only the sentence saying it cannot.
      await expect(main.getByRole('button', { name: /fire|retire|delete/i })).toHaveCount(0);

      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-4-pinned-omissions`);
    });

    /* 5 · Hebrew, right to left. */
    test('5 · Hebrew, right to left', async ({ page }) => {
      await openEmployees(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('cannot-fire')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-5-hebrew`);
    });

    /* 6 · the two standing shell rules. */
    test('6 · content above the fold, no placeholders', async ({ page }) => {
      await openEmployees(page, 'en');

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
