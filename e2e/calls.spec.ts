import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

/**
 * Screen 05d · Outreach · calls — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/calls.spec.ts
 *
 * **Run this spec alone.** The whole suite in parallel trips the BFF's rate
 * limiter, and a 429 renders as "the ids are missing" — which is why
 * `missingIds` lists the causes in the order worth checking rather than
 * naming one.
 *
 * Shots land in e2e/evidence/s05d/.
 *
 * ── WHAT THIS TENANT SHOWS ──
 * `voiceCopilotEnabled` is **false**, so `voiceCopilotGate` 404s the entire
 * voice router. That is **not** an error state and the screen does not render
 * one: it reads the flag from `tenant-settings`, which is outside the gate,
 * and says plainly that voice is not switched on.
 *
 * **That is the shot that matters**, because a 404 from the gate and a 404
 * from a missing route are identical on the wire — one means "this workspace
 * has not switched voice on", the other means "we shipped a broken build",
 * and a screen that guessed between them would eventually tell somebody the
 * wrong one.
 *
 * ── NOTHING IS WRITTEN ──
 * No `.click()` dials, answers or ends anything.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's05d');

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

async function openCalls(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/outreach/calls`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/outreach/calls. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  const states = ['calls-not-enabled', 'call-log', 'calls-empty', 'calls-unavailable'];
  await expect
    .poll(
      async () => {
        const counts = await Promise.all(states.map((id) => page.getByTestId(id).count()));
        return counts.reduce((a, b) => a + b, 0);
      },
      { message: missingIds(`none of ${states.join(', ')}`), timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  /*
   * `calls-unavailable` is the one state that must never be photographed: it
   * means voice IS on and the read failed, which is a fault rather than a
   * screen. The not-enabled state is a different thing entirely and is the
   * point of this run.
   */
  await expect(
    page.getByTestId('calls-unavailable'),
    'voice is on and the calls could not be read — this run would photograph a fault',
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
     * 1 · THE SHOT THAT MATTERS ON THIS TENANT.
     *
     * Voice is off, and the screen says so as a fact with the action that
     * would change it — rather than as the error a bare 404 would produce.
     */
    test('1 · voice off reads as a fact, not a fault', async ({ page }) => {
      await openCalls(page, 'en');

      const off = page.getByTestId('calls-not-enabled');
      await expect(off).toBeVisible();
      await expect(off).toHaveText(/aren't switched on for this workspace/i);
      // And it names what would change it, so the state is actionable rather
      // than merely explained.
      await expect(off).toHaveText(/ask whoever set up gotcha/i);

      await shoot(page, `${size.name}-1-voice-off`);
    });

    /*
     * 2 · it is not dressed as an error.
     *
     * The distinction this screen exists to make: "not switched on" and "we
     * could not read your calls" are opposite conclusions from the same 404,
     * and only one of them is true here.
     */
    test('2 · not an error panel', async ({ page }) => {
      await openCalls(page, 'en');
      const main = page.locator('main');

      await expect(main).not.toHaveText(/couldn't read|could not read|something went wrong/i);
      await expect(main).not.toHaveText(/error|failed|try again/i);

      await shoot(page, `${size.name}-2-not-an-error`);
    });

    /*
     * 3 · THE PINNED OMISSIONS.
     */
    test('3 · no calling campaign, no conversion, no sentiment', async ({ page }) => {
      await openCalls(page, 'en');
      const main = page.locator('main');

      // (a) No AI calling campaign: no model, no list-driven object, no
      //     per-call outcome capture tied to one.
      await expect(main).not.toHaveText(/have gotcha call a list|calling campaign/i);

      // (b) `converted` — FOURTH appearance across four screens.
      await expect(main).not.toHaveText(/ended in a sale|\bconverted\b/i);

      // (c) Sentiment: 9 of 89 conversations, 48+ days old where present.
      await expect(main).not.toHaveText(/\bupset\b|\bmood\b/i);

      // (d) No mute anywhere in the platform — pinned here too because 05e
      //     puts it in the call header beside two controls that work.
      await expect(main).not.toHaveText(/\bmute\b/i);

      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-3-pinned-omissions`);
    });

    /* 4 · Hebrew, right to left. */
    test('4 · Hebrew, right to left', async ({ page }) => {
      await openCalls(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('calls-not-enabled')).toBeVisible();
      await expect(page.getByTestId('calls-not-enabled')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-4-hebrew`);
    });

    /* 5 · the two standing shell rules. */
    test('5 · content above the fold, no placeholders', async ({ page }) => {
      await openCalls(page, 'en');

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
