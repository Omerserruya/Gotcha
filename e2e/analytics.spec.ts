import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';
import { recordUnreached, shoot as captureScreen } from './shoot';

/**
 * Screen 06 · Analytics — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/analytics.spec.ts
 *
 * **Run this spec alone.** Shots land in e2e/evidence/s06/.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS SCREEN HAD NEVER BEEN PHOTOGRAPHED BECAUSE IT DID NOT EXIST
 * ════════════════════════════════════════════════════════════════════════════
 * `TeamLoad` and `AskedAbout` were built and tested and imported by nothing;
 * `/analytics` was the placeholder stub and so were its five sub-routes.
 * Analytics was reported finished on three commits and a passing suite — and
 * one of those three had gone onto screen 01 instead.
 *
 * So the first test here is deliberately the dullest available: **are both
 * panels on the page at all.** The whole area's evidence was missing because
 * nobody asked that question in a browser.
 *
 * ── NOTHING IS PRESSED, AND THERE IS NOTHING TO PRESS ──
 * This screen is read-only by construction: two panels of figures. That is
 * itself asserted below, because the design draws a rename and a merge on the
 * topics panel and **a "topic" is a `groupBy` over one unconstrained column
 * with no model behind it** — a rename would have nowhere to persist and the
 * next request would regroup from the raw column and show the old name back.
 *
 * ── AND WHAT THE TENANT MAY NOT BE ABLE TO SHOW ──
 * Anything state-dependent is recorded with `recordUnreached` rather than
 * asserted. A capture test asserting something the tenant cannot produce is a
 * test that fails for being honest.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's06');

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

/**
 * One project captures. `ltr` and `rtl` differ only in the browser's locale and
 * this screen's direction comes from the URL, so both would write the same
 * filenames and race. See `scripts/capture-guard-sweep.ts`.
 */
const CAPTURING_PROJECT = 'ltr';

function onlyOneProject(): boolean {
  const project = test.info().project.name;
  if (project === CAPTURING_PROJECT) return false;
  test.skip(true, `Captured by the ${CAPTURING_PROJECT} project; direction comes from the URL.`);
  return true;
}

async function openAnalytics(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/analytics`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/analytics. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(async () => page.getByTestId('analytics-screen').count(), {
      message: missingIds('analytics-screen'),
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  return page;
}

async function shoot(page: Page, name: string) {
  await captureScreen(page, EVIDENCE, name);
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /*
     * 1 · BOTH PANELS ON THE PAGE. The test whose absence hid the whole area.
     *
     * Each panel renders its own unavailable state, so a missing region here
     * is the component not running at all — which is what an unmounted
     * component and a nested async server component both look like.
     */
    test('1 · both panels, and the section that is not here', async ({ page }) => {
      if (onlyOneProject()) return;

      await openAnalytics(page, 'en');

      const asked = page.getByTestId('asked-about').or(page.getByTestId('asked-unavailable'));
      const team = page.getByTestId('team-load').or(page.getByTestId('team-unavailable'));
      await expect(asked, 'the questions panel is not on the page').toBeVisible();
      await expect(team, 'the team panel is not on the page').toBeVisible();

      /*
       * ★ AND THE ABSENCE IS ON THE SCREEN. "What GOTCHA did" was held on an
       * escalation aggregation that does not exist, so it is a sentence rather
       * than an empty tab — and the sentence is part of the evidence.
       */
      await expect(page.getByTestId('analytics-no-gotcha-section')).toBeVisible();

      await shoot(page, `${size.name}-1-analytics`);
    });

    /*
     * 2 · THE GROUPING IS GOTCHA'S, AND IT SAYS SO.
     *
     * `detectedIntent` is model-written and unconstrained, so "where is my
     * order" and "order status" are two rows with two counts. The caption is
     * what stops a reader concluding the counts are broken.
     */
    test('2 · model-written labels, with the grouping owned', async ({ page }) => {
      if (onlyOneProject()) return;

      await openAnalytics(page, 'en');

      if ((await page.getByTestId('asked-about').count()) === 0) {
        recordUnreached(
          EVIDENCE,
          `${size.name}-2-asked-about`,
          'The questions panel could not be read — `analytics:dashboard:read` is a ' +
            'permission this session may not hold, and the panel says so itself in ' +
            'shot 1. Not a defect in this screen: an unreadable panel is a state it ' +
            'renders deliberately.',
        );
        test.skip();
        return;
      }

      await expect(page.getByTestId('asked-caption')).toHaveText(/GOTCHA grouped these/i);

      /*
       * ★★ THE PINNED OMISSION. The route sends `automatable`, and it is
       * `count > 5` — a threshold relabelled as a property. Rendered as
       * "GOTCHA could handle this" it asserts a capability from a frequency.
       */
      const main = page.locator('main');
      await expect(main).not.toHaveText(/could handle this|automatable|answers confidently/i);
      /* And no topic strength, which has no source at all. */
      await expect(main).not.toHaveText(/topic strength|guesses sometimes/i);

      await shoot(page, `${size.name}-2-asked-about`);
    });

    /*
     * 3 · THE TEAM PANEL, AND THE TWO THINGS IT REFUSES TO SAY.
     */
    test('3 · today’s numbers, no reply speed, humans only', async ({ page }) => {
      if (onlyOneProject()) return;

      await openAnalytics(page, 'en');

      if ((await page.getByTestId('team-load').count()) === 0) {
        recordUnreached(
          EVIDENCE,
          `${size.name}-3-team`,
          'The team panel could not be read — `analytics:workspace:read` is a ' +
            'permission this session may not hold, and the panel says so itself in ' +
            'shot 1.',
        );
        test.skip();
        return;
      }

      /*
       * ★ THE PERIOD IS STATED AND NO LONGER ONE IS IMPLIED. `claimedToday` is
       * a Redis day-key and the open count is a live queue depth; the design's
       * header says "Last 7 days, compared with the week before", which cannot
       * sit above either figure.
       */
      await expect(page.getByTestId('team-period')).toHaveText(/today's numbers/i);
      await expect(page.locator('main')).not.toHaveText(
        /last 7 days|seven days|compared with the week/i,
      );

      /*
       * ★★ NO REPLY-SPEED COLUMN, AND THE PANEL SAYS WHY. `avgResponseTimeMs`
       * measures from `claim_time`, which is set once and never deleted — so it
       * grows with the length of the conversation. Beside a name it would read
       * as that person being slow.
       */
      await expect(page.getByTestId('team-no-speed')).toBeVisible();
      await expect(page.locator('main')).not.toHaveText(/reply time|average reply|response time/i);

      /* Humans only, stated, because the design puts AI employees in this table. */
      await expect(page.getByTestId('team-humans-only')).toBeVisible();

      await shoot(page, `${size.name}-3-team`);
    });

    /*
     * 4 · NOTHING ON THIS SCREEN CAN BE PRESSED.
     *
     * The design draws rename and merge on the topics panel. A "topic" is a
     * `groupBy` recomputed per request over `detectedIntent`; there is no
     * `Topic` model, so a rename has nowhere to persist and the next request
     * would show the old name back. The control's absence is the ruling, and
     * this is where it is pinned in a browser rather than in a unit test.
     */
    test('4 · no rename, no merge, nothing to press', async ({ page }) => {
      if (onlyOneProject()) return;

      await openAnalytics(page, 'en');

      const main = page.locator('main');
      await expect(main.getByRole('button')).toHaveCount(0);
      await expect(main.locator('input, textarea, select')).toHaveCount(0);
      await expect(main).not.toHaveText(/rename|merge|combine these/i);

      await shoot(page, `${size.name}-4-read-only`);
    });

    /* 5 · Hebrew, which is half the product. */
    test('5 · Hebrew, right to left', async ({ page }) => {
      if (onlyOneProject()) return;

      await openAnalytics(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      /* Hebrew copy, not an untranslated fallback sitting in an RTL page. */
      await expect(page.locator('main')).toHaveText(/[֐-׿]/);

      /*
       * ★★ AND THE SENTENCES THAT POINTED AT THINGS THAT NO LONGER EXIST.
       * Two captions were written for the screen as designed: one cited "the
       * seven days shown above" and one sent the reader to "the GOTCHA tab".
       * Assembling the screen removed both of those things and left the
       * sentences. Checked in Hebrew because that is the copy nobody rereads.
       */
      await expect(page.locator('main')).not.toHaveText(/לשונית GOTCHA|שבעת הימים/);

      await shoot(page, `${size.name}-5-hebrew`);
    });
  });
}

/*
 * 6 · THE SUB-ROUTES ARE GONE, NOT EMPTY.
 *
 * Five placeholder routes were deleted when the screen was assembled: a link to
 * a room with nothing in it is the same promise as an empty tab, made in the
 * navigation, and it survives longer there because nobody opens every item in a
 * sub-nav. This proves they are not reachable — a 404 is more honest than a
 * heading over nothing.
 *
 * Once, not per viewport: it is a fact about the routes.
 */
test('6 · the deleted analytics sections do not resolve', async ({ page }) => {
  if (onlyOneProject()) return;

  for (const section of ['overview', 'ai', 'humans', 'sales', 'topics']) {
    const response = await page.goto(`/en/analytics/${section}`);
    expect(
      response?.status(),
      `/en/analytics/${section} still resolves. It was deleted because it had no data ` +
        'behind it; a placeholder that renders a heading over nothing reads as a screen ' +
        'still being built, which is what this whole area looked like.',
    ).toBe(404);
  }
});
