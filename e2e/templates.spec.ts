import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Screen 05c · Outreach · templates — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/templates.spec.ts
 *
 * Shots land in e2e/evidence/s05c/.
 *
 * ── WHAT THIS TENANT CAN SHOW ──
 * **Zero templates.** The sixth screen in a row whose real state is the sparse
 * one. Not worked around: creating a template would mean submitting it to Meta
 * for review, which is an outward-facing act against a third party, and the
 * row states are checked in `src/api/contracts/templates.test.ts` instead.
 *
 * The empty state is the shot that matters here, because an empty template
 * list is not a tidy starting point — **it is the reason you cannot reach
 * anyone who has not written to you first**, and the screen says so.
 *
 * ── NOTHING IS WRITTEN ──
 * No `.click()` submits, duplicates or deletes anything.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's05c');

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

async function openTemplates(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/outreach/templates`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/outreach/templates. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  const states = ['templates-empty', 'template-list', 'templates-unavailable'];
  await expect
    .poll(
      async () => {
        const counts = await Promise.all(states.map((id) => page.getByTestId(id).count()));
        return counts.reduce((a, b) => a + b, 0);
      },
      {
        message:
          `none of ${states.join(', ')} is present — the SERVED BUILD may predate this screen. ` +
          'Run `npm run build` and restart `next start`.',
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(0);

  await expect(
    page.getByTestId('templates-unavailable'),
    'the templates could not be read, so this run would photograph an error panel',
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
     * 1 · no templates, stated as the consequence rather than the absence.
     */
    test('1 · an empty list says what it costs you', async ({ page }) => {
      await openTemplates(page, 'en');

      const empty = page.getByTestId('templates-empty');
      await expect(empty).toBeVisible();
      await expect(empty).toHaveText(/no templates yet/i);
      // The half that matters: without a template you cannot begin a
      // conversation at all, only continue one somebody else started.
      await expect(empty).toHaveText(/only continue conversations other people start/i);

      await shoot(page, `${size.name}-1-no-templates`);
    });

    /*
     * 2 · THE PINNED OMISSIONS.
     */
    test('2 · no ETA, no rewrite, no usage, no reply rate', async ({ page }) => {
      await openTemplates(page, 'en');
      const main = page.locator('main');

      // (a) Nothing models how long a provider takes to review.
      await expect(main).not.toHaveText(/·\s*\d+\s*day|takes a day|estimated|eta\b/i);

      // (b) `rejectionReason` is stored and nothing proposes a fix.
      await expect(main).not.toHaveText(/rewrote|rewrite|suggested wording/i);

      // (c) The `broadcasts` relation would join cleanly; the list route has
      //     no `include`, so neither number exists.
      await expect(main).not.toHaveText(/reply rate|used \d|usage/i);

      // (d) Nothing records which employees or automations may use a template.
      await expect(main).not.toHaveText(/who may send|may use it/i);

      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-2-pinned-omissions`);
    });

    /*
     * 3 · the one sentence that stays, and how it is phrased.
     *
     * It is a fact about WhatsApp — no row in our database can make it false,
     * which is what separates it from a promise needing a mechanism. And it
     * must read as something WhatsApp does, never as something GOTCHA does on
     * the user's behalf, which would imply a control we track for them.
     */
    test('3 · the 24-hour window is attributed to WhatsApp', async ({ page }) => {
      await openTemplates(page, 'en');
      const main = page.locator('main');

      await expect(main).toHaveText(/whatsapp lets you reply freely for 24 hours/i);
      // Never phrased as GOTCHA's doing.
      await expect(main).not.toHaveText(/gotcha (lets|replies|keeps).{0,24}24 hours/i);

      await shoot(page, `${size.name}-3-window-sentence`);
    });

    /* 4 · Hebrew, right to left. */
    test('4 · Hebrew, right to left', async ({ page }) => {
      await openTemplates(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('templates-empty')).toBeVisible();
      await expect(page.getByTestId('templates-empty')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-4-hebrew`);
    });

    /* 5 · the two standing shell rules. */
    test('5 · content above the fold, no placeholders', async ({ page }) => {
      await openTemplates(page, 'en');

      const box = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect(box, 'the page heading has no box — is it rendered?').not.toBeNull();
      expect(
        box!.y,
        `the heading starts ${Math.round(box!.y)}px down a ${size.height}px viewport`,
      ).toBeLessThan(size.height / 2);

      await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-5-above-the-fold`);
    });
  });
}
