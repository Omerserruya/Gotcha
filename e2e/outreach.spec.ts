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
 * ── WHAT THIS TENANT CAN SHOW, ASKED RATHER THAN ASSUMED ──
 * **Zero campaigns** when this spec was written, so the evidence was the
 * never-sent state and the card could not be photographed at all.
 *
 * ★ THAT IS NO LONGER WRITTEN DOWN AS A PREMISE. The calls spec asserted
 * "voice is off" for weeks and was correct until somebody flipped a flag,
 * at which point it was asserting a world that had moved and nothing said
 * so. So this run **reads `/api/broadcasts` first** and reports the count,
 * and the card's assertions run if and only if a card is on screen.
 *
 * The card no longer carries five counters. Three of the five —
 * `deliveredCount`, `openedCount`, `repliedCount` — are columns **nothing
 * in the platform increments**, so they rendered as a permanent zero on a
 * shipped screen. They were removed and replaced by two sentences, and
 * those sentences are what a card shot is now evidence of.
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

/**
 * How many campaigns exist, from the endpoint the screen reads.
 *
 * ⚠ SPENDS a cookie rotation — `gotcha_session` rotates on every BFF
 * request, and inside the browser context the jar handles it.
 *
 * A READ. Nothing here creates a campaign: a broadcast exists only to be
 * sent to real contacts, and `POST /:id/send` is not a button anybody should
 * press to make a screenshot.
 */
async function countCampaigns(page: Page): Promise<number> {
  const res = await page.request.get('/api/bff/api/broadcasts');
  expect(res.status(), 'the broadcasts endpoint did not answer 200').toBe(200);
  const body = (await res.json()) as { data?: unknown[] } | unknown[];
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  return rows.length;
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
     * 1b · THE CARD'S TWO SENTENCES, IF THERE IS A CARD.
     *
     * ★★ WHAT THEY REPLACED. `deliveredCount`, `openedCount` and
     * `repliedCount` are written by nothing in this platform. The card
     * rendered all three as counters, so a merchant who sent to 250 people
     * read "0 delivered · 0 opened · 0 replied" and would reasonably have
     * concluded the send had failed.
     *
     * They are now two sentences that say the numbers are not collected,
     * which is the true statement and the one a capture is worth taking of.
     */
    test('1b · a campaign card says what is not counted, and counts nothing false', async ({
      page,
    }) => {
      const campaigns = await countCampaigns(page);
      await openOutreach(page, 'en');

      test.skip(
        campaigns === 0,
        'This tenant has no campaigns, so the card is NOT photographed. Seeding one would mean ' +
          'creating something whose only purpose is to be sent to real contacts. The two ' +
          'sentences are covered by src/features/outreach/CampaignCard.test.tsx and are ' +
          'UNEXERCISED against a real broadcast.',
      );

      const card = page.getByTestId(/^campaign-/).first();
      await expect(card, missingIds('a campaign card')).toBeVisible();

      /*
       * ★ THE SENTENCES, ASSERTED POSITIVELY. A test that only checked the
       * counters were gone would pass on a card that rendered nothing at
       * all, which is a different and worse screen.
       */
      await expect(card.getByTestId(/^pending-/).first()).toHaveText(/\S/);
      await expect(card.getByTestId(/^no-replies-/).first()).toHaveText(/\S/);

      /*
       * ★★ AND NO ZERO WHERE A REAL NUMBER WOULD GO. `sent` and `failed`
       * ARE incremented and stay; delivered, opened and replied must not
       * appear as counters at all, at any value.
       */
      await expect(card).not.toHaveText(/\b\d+\s*(delivered|opened|replied)/i);

      await shoot(page, `${size.name}-1b-campaign-card`);
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
