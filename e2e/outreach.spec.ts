import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

/**
 * Screens 05 + 05b · Outreach — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/outreach.spec.ts
 *
 * Shots land in e2e/evidence/s05/.
 *
 * ── WHAT THIS TENANT CAN SHOW ──
 * **Zero campaigns.** So the evidence is the never-sent state, and the card
 * with its five counters cannot be photographed — the fifth screen in a row
 * whose real state is the sparse one, which is in the reviewer's note as a
 * pattern.
 *
 * Not worked around. Seeding a campaign would mean creating something whose
 * only purpose is to be sent to real contacts, and `POST /:id/send` is not a
 * button anyone should press to make a screenshot. The card's judgements are
 * in `src/api/contracts/outreach.test.ts`, which says so at the top.
 *
 * ── NOTHING IS WRITTEN ──
 * There is no `.click()` in this spec on anything that sends or stops. The
 * stop control is destructive by construction — it drains the queue and skips
 * every pending recipient — so it is never exercised here at all.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's05');

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

async function openOutreach(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/outreach`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/outreach. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  // One of the real states must be present. If none is, something between
  // the session and the build is wrong — `missingIds` orders the
  // candidates rather than naming one.
  const states = ['outreach-empty', 'outreach-screen', 'outreach-unavailable'];
  await expect
    .poll(
      async () => {
        const counts = await Promise.all(states.map((id) => page.getByTestId(id).count()));
        return counts.reduce((a, b) => a + b, 0);
      },
      {
        message: missingIds('an id this screen emits'),
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(0);

  await expect(
    page.getByTestId('outreach-unavailable'),
    'the campaigns could not be read, so this run would photograph an error panel',
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
     * 1 · nothing sent yet, as a state rather than a blank.
     *
     * Asserted positively by content: a screen that merely fails to show an
     * error would pass a test proving nothing.
     */
    test('1 · never sent reads as a state', async ({ page }) => {
      await openOutreach(page, 'en');

      const empty = page.getByTestId('outreach-empty');
      await expect(empty).toBeVisible();
      await expect(empty).toHaveText(/nothing has gone out yet/i);
      // And it says what will happen here later, so the emptiness is
      // explained rather than merely observed.
      await expect(empty).toHaveText(/shows up here while it's sending/i);

      await shoot(page, `${size.name}-1-never-sent`);
    });

    /*
     * 2 · THE PINNED OMISSIONS.
     *
     * Every one is a ruling, and a ruling survives only if something fails
     * when it is undone.
     */
    test('2 · no pause, no conversion, no revenue, no quiet hours', async ({ page }) => {
      await openOutreach(page, 'en');
      const main = page.locator('main');

      // (a) THE ONE THAT MATTERS. There is no PAUSED status and no resume
      //     route; `cancel` drains the queue and skips every pending
      //     recipient. "Pause" promises it halts AND resumes, and only the
      //     first is true.
      await expect(main).not.toHaveText(/\bpause\b|\bresume\b/i);

      // (b) `converted` is not a concept anywhere in this platform.
      await expect(main).not.toHaveText(/\bbought\b|\bconverted\b|conversion/i);

      // (c) Attributed revenue has no inputs at all — third appearance across
      //     three screens.
      await expect(main).not.toHaveText(/revenue|brought in|₪\s?\d/i);

      // (d) `outboundQuietHours` is validated, stored, and read by NO send
      //     path. A control would promise something the product breaks on a
      //     customer's behalf.
      await expect(main).not.toHaveText(/quiet hours|sending window|do not disturb/i);

      // (e) One `channel`, one `channelAccountId`. No fallback field.
      await expect(main).not.toHaveText(/falls back to|fallback/i);

      // (f) No approval field on Broadcast, and ApprovalRequest is the bot
      //     path exclusively by its own comment.
      await expect(main).not.toHaveText(/waiting for your approval/i);

      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-2-pinned-omissions`);
    });

    /* 3 · Hebrew, right to left. */
    test('3 · Hebrew, right to left', async ({ page }) => {
      await openOutreach(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('outreach-empty')).toBeVisible();
      // Hebrew copy, not an untranslated fallback sitting in an RTL page.
      await expect(page.getByTestId('outreach-empty')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-3-hebrew`);
    });

    /* 4 · the two standing shell rules. */
    test('4 · content above the fold, no placeholders', async ({ page }) => {
      await openOutreach(page, 'en');

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
