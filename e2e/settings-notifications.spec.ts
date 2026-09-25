import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  NOTIFIABLE_EVENTS,
  UNFIRING_EVENTS,
  eventsInFamily,
} from '../src/features/notifications-settings/events';

import { missingIds } from './diagnose';
import { shoot as captureScreen } from './shoot';

/**
 * Screen 15 · Settings · Notifications — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/settings-notifications.spec.ts
 *
 * Shots land in e2e/evidence/s15/.
 *
 * ── WHAT THIS TENANT CAN AND CANNOT SHOW ──
 * **This tenant has zero notification rules**, so the rule list itself cannot
 * be photographed here. That is a fact about the tenant, not a defect, and it
 * is NOT worked around: seeding a rule would be a write that makes the
 * platform send real messages to real people.
 *
 * So the day-one state IS the screen in this evidence, and it is asserted as a
 * first-class state rather than as an empty one. The list's own judgements —
 * an event nothing raises, a channel never delivered, a tenant-wide rule
 * displaced by a department rule — are checked in `rule-view.test.ts`, which
 * says so at the top for the same reason.
 *
 * ── NOTHING IS WRITTEN ──
 * There is no `.click()` in this spec that changes anything. Creating a
 * notification rule causes the platform to email people.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's15');

const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 800 },
  { name: '390', width: 390, height: 844 },
] as const;

/** 3 · 1 · 4 · 14 — the shape that made the billing skew visible. */
const FAMILY_COUNTS = {
  work: 3,
  systems: 1,
  commerce: 4,
  billing: 14,
} as const;

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

async function openNotifications(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/settings/notifications`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/settings/notifications. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  /*
   * One of the two real states must be on screen. If neither is, something
   * upstream went wrong — and `missingIds` orders the candidates rather than
   * naming one, because the message used to say "stale build" and sent a
   * reader past a rate limit to check a build that was current.
   */
  const empty = page.getByTestId('rules-empty');
  const list = page.getByTestId('rule-list');
  const unavailable = page.getByTestId('rules-unavailable');
  await expect
    .poll(async () => (await empty.count()) + (await list.count()) + (await unavailable.count()), {
      message: missingIds('none of `rules-empty`, `rule-list` or `rules-unavailable`'),
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  /*
   * And refuse to photograph a failed read as though it were the screen. A
   * 401 or a 500 renders the unavailable panel, which is correct behaviour
   * and worthless as acceptance evidence — screen 16's wrong path survived
   * six runs because the broken state looked like a state.
   */
  await expect(
    unavailable,
    'the rules could not be read, so this run would photograph an error panel rather than the screen',
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

    /*
     * 1 · THE SHOT THAT MATTERS ON THIS TENANT.
     *
     * Zero rules. The screen must read as a real configuration with a real
     * consequence, not as a blank waiting for a button. Asserted positively by
     * content: an empty state that merely fails to show an error would pass a
     * test that proves nothing.
     */
    test('1 · day one reads as a configuration, not an absence', async ({ page }) => {
      await openNotifications(page, 'en');

      const empty = page.getByTestId('rules-empty');
      await expect(empty).toBeVisible();

      // The consequence, not the count. "No rules" describes the table;
      // "telling nobody about anything" is what an admin needs to know.
      await expect(empty).toHaveText(/telling nobody about anything/i);

      await shoot(page, `${size.name}-1-day-one`);
    });

    /*
     * 2 · the whole vocabulary, grouped, before any rule exists.
     *
     * 22 events in four families. The counts are pinned because the imbalance
     * is a product finding in its own right — fourteen of the twenty-two are
     * about our billing — and a later curation back down to eight pretty rows
     * should fail this capture rather than quietly ship.
     */
    test('2 · all 22 events, in four families', async ({ page }) => {
      await openNotifications(page, 'en');

      await expect(page.getByTestId('event-families')).toBeVisible();
      await expect(page.locator('li[data-testid^="event-"]')).toHaveCount(NOTIFIABLE_EVENTS.length);

      for (const [family, count] of Object.entries(FAMILY_COUNTS)) {
        const section = page.getByTestId(`family-${family}`);
        await expect(section, `family ${family} is missing`).toBeVisible();
        await expect(
          section.locator('li[data-testid^="event-"]'),
          `family ${family} should hold ${count} events`,
        ).toHaveCount(count);
        // And the constant must still match the source of truth.
        expect(eventsInFamily(family as keyof typeof FAMILY_COUNTS)).toHaveLength(count);
      }

      await shoot(page, `${size.name}-2-vocabulary`);
    });

    /*
     * 3 · the caveats sit WITH their events.
     *
     * The design's wording for `integration.check_failed` promises a watch the
     * product does not run. The correction is only useful at the moment
     * somebody decides whether to be told, so it is asserted next to the row
     * rather than anywhere on the page.
     */
    test('3 · an event that means less than it sounds says so, in place', async ({ page }) => {
      await openNotifications(page, 'en');

      const caveat = page.getByTestId('caveat-integration.check_failed');
      await expect(caveat).toBeVisible();
      await expect(caveat).toHaveText(/connection test/i);
      await expect(caveat).toHaveText(/not continuous monitoring/i);

      await expect(page.getByTestId('caveat-conversation.assigned')).toHaveText(
        /never when they pick one up themselves/i,
      );
      await expect(page.getByTestId('caveat-broadcast.completed')).toHaveText(
        /including the ones that failed/i,
      );

      await shoot(page, `${size.name}-3-caveats-in-place`);
    });

    /*
     * 4 · THE PINNED OMISSIONS.
     *
     * Every one of these is a ruling, and a ruling outlives the person who
     * made it only if something fails when it is undone.
     */
    test('4 · six events, three channels and two controls that must not appear', async ({
      page,
    }) => {
      await openNotifications(page, 'en');
      const main = page.locator('main');

      // (a) Events that are templated and that NOTHING emits. Offering one
      //     gives an admin a rule they believe is configured and that can
      //     never fire.
      for (const type of UNFIRING_EVENTS) {
        await expect(
          page.getByTestId(`event-${type}`),
          `${type} is never emitted and must not be offered`,
        ).toHaveCount(0);
      }

      // (b) Channels the route accepts and the dispatcher drops on the floor.
      await expect(main).not.toHaveText(/\bslack\b/i);
      await expect(main).not.toHaveText(/\bsms\b/i);
      await expect(main).not.toHaveText(/\bwebhook\b/i);

      // (c) Priority is validated, stored, and read by nothing. A CRITICAL
      //     beside a LOW would promise urgency the platform does not have.
      await expect(main).not.toHaveText(/critical|high priority|low priority/i);

      // (d) Omer's ruling: this screen configures the TENANT's rules. There is
      //     no per-user preference control, and no quiet hours — the store
      //     behind both is read by nothing but its own route.
      await expect(main).not.toHaveText(/quiet hours|do not disturb/i);
      await expect(main.locator('input[type="checkbox"], [role="switch"]')).toHaveCount(0);

      await shoot(page, `${size.name}-4-pinned-omissions`);
    });

    /* 5 · Hebrew, selected by test id, with the same 22. */
    test('5 · Hebrew, right to left', async ({ page }) => {
      await openNotifications(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('rules-empty')).toBeVisible();
      await expect(page.locator('li[data-testid^="event-"]')).toHaveCount(NOTIFIABLE_EVENTS.length);
      await expect(page.getByTestId('caveat-integration.check_failed')).toBeVisible();

      // Hebrew copy, not an untranslated fallback sitting in an RTL page.
      await expect(page.getByTestId('rules-empty')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-5-hebrew`);
    });

    /* 6 · the two standing shell rules. */
    test('6 · content above the fold, no placeholders', async ({ page }) => {
      await openNotifications(page, 'en');

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
