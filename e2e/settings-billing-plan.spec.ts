import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

/**
 * Screen 17b · Settings · Plan & pricing — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/settings-billing-plan.spec.ts
 *
 * Shots land in e2e/evidence/s17b/.
 *
 * ── WHAT THIS TENANT CAN AND CANNOT SHOW ──
 * Measured against the database before this spec was written:
 *
 *     subscription              ai_voice v1 · ACTIVE · $1,499 · 2026-09-08 → 2027-09-08
 *     other ACTIVE plans        foundation v4 $39 · ai_workforce v3 $97
 *     pending_subscription_changes   ZERO rows, whole table
 *     credit_packages sellable  4, every one expiryPolicy NEVER
 *     payment methods           ZERO
 *
 * Two consequences, and both shape what is asserted here.
 *
 * **The scheduled-change block cannot be photographed.** There is not one
 * pending change on this database, so `pricing-pending` will not render, and
 * asserting its absence would prove nothing — it is absent on a blank page
 * too. The typed sentences (DOWNGRADE vs CANCEL), the applied-change guard
 * and the year are asserted in `Pricing.test.tsx` and `PlanLine.test.tsx`
 * instead, where the branch can actually be reached.
 *
 * **What CAN be photographed is the more useful half anyway:** this tenant has
 * no payment method, so the screen states that an upgrade would be declined
 * and how to fix it. That is this tenant's real situation and the design has
 * no picture of it.
 *
 * ── NOTHING IS WRITTEN ──
 * Changing a plan charges money and writes a scheduled change. There is no
 * `.click()` in this spec on anything that does either.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's17b');

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

async function openPlan(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/settings/billing/plan`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/settings/billing/plan. ` +
        'Set GOTCHA_SESSION to a current one.',
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId('section-plan'), missingIds('an id this screen emits')).toBeVisible(
    { timeout: 15_000 },
  );

  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /*
     * 1 · the plan, by name, at the price actually contracted.
     */
    test('1 · the plan line', async ({ page }) => {
      await openPlan(page, 'en');

      const plan = page.getByTestId('plan-line');
      await expect(plan).toBeVisible();
      // A NAME, never a key. `ai_voice` reached a screenshot once already.
      await expect(page.getByTestId('plan-name')).not.toHaveText(/^[a-z][a-z0-9]*_[a-z0-9_]+$/);
      await expect(plan).toHaveText(/\$|US\$/);
      await expect(plan).not.toHaveText(/₪/);

      await shoot(page, `${size.name}-1-plan`);
    });

    /*
     * 2 · THE SHOT THAT MATTERS ON THIS TENANT.
     *
     * Every plan available here is cheaper, so every change is a downgrade,
     * deferred to the period end — 8 September 2027.
     *
     * Asserted POSITIVELY: the sentence must be present, must say the change
     * waits for the end of the period, and must carry the YEAR. Eleven and a
     * half months out, "8 September" is read as this year by everybody.
     *
     * `/2027/` asserts the year is PRESENT and says nothing about the format.
     * The date is rendered by `Intl.DateTimeFormat`, so pinning a shape here
     * would break on a locale-data update while the screen stayed correct — a
     * format assertion wearing a presence assertion's clothes, which cost us
     * screen 08.
     */
    test('2 · a change waits eleven months, and the screen says which year', async ({ page }) => {
      await openPlan(page, 'en');

      const deferred = page.getByTestId('change-deferred');
      await expect(deferred).toBeVisible();
      await expect(deferred).toHaveText(/end of your billing period/i);
      await expect(deferred).toHaveText(/2027/);
      // And it says nothing changes before then — the service's own promise.
      await expect(deferred).toHaveText(/[Nn]othing changes/);

      await shoot(page, `${size.name}-2-deferred`);
    });

    /*
     * 3 · no payment method, named as a path rather than a wall.
     *
     * `changePlan` charges the prorated difference BEFORE granting anything
     * and resolves the card as `paymentMethods[0]?.id ?? "nocard"`. With none,
     * every upgrade fails having changed nothing.
     *
     * The recovery is real: the idempotency key is scoped to the payment
     * method deliberately, so a retry after adding a card is not blocked. The
     * sentence must contain BOTH the consequence and the way out — a warning
     * with no exit is the thing this project keeps refusing to ship.
     */
    test('3 · the upgrade that would be declined, and how to fix it', async ({ page }) => {
      await openPlan(page, 'en');

      const noCard = page.getByTestId('change-no-card');
      await expect(noCard).toBeVisible();
      await expect(noCard).toHaveText(/declined/i);
      await expect(noCard).toHaveText(/add a card/i);

      await shoot(page, `${size.name}-3-no-card`);
    });

    /*
     * 4 · the packages, each stating when its credits die.
     *
     * Four are on sale, every one `NEVER`. This is the only place a customer
     * ever learns it: `/billing/credit-summary` selects `expiresAt` from the
     * lots and uses only `grantType`, so after the purchase nothing can say.
     *
     * Asserted by CONTENT on every tile, not by counting them — a count would
     * pass on four tiles that all said nothing.
     */
    test('4 · every package says what happens to the credits', async ({ page }) => {
      await openPlan(page, 'en');

      const packages = page.getByTestId('package');
      const count = await packages.count();
      expect(count, 'no packages rendered — the plan is credit_packages_eligible').toBeGreaterThan(
        0,
      );

      for (let i = 0; i < count; i += 1) {
        await expect(packages.nth(i).getByTestId('package-expiry')).toHaveText(/expire/i);
      }

      // And an empty shelf must never be blamed on their plan. This tenant is
      // eligible, so the ineligible sentence must not be the one showing.
      await expect(page.getByTestId('packages-ineligible')).toHaveCount(0);

      await shoot(page, `${size.name}-4-packages`);
    });

    /*
     * 5 · the estimate disclaimer, in the platform's own words.
     *
     * `ESTIMATE_DISCLAIMER` ships from the backend in en AND he, and it is the
     * same sentence the public pricing pages render. A second translation in
     * our catalogue could drift from the commercial copy with nothing failing,
     * so the screen renders theirs.
     */
    test('5 · the disclaimer is the platform’s', async ({ page }) => {
      await openPlan(page, 'en');

      const disclaimer = page.getByTestId('pricing-disclaimer');
      await expect(disclaimer).toBeVisible();
      await expect(disclaimer).toHaveText(/plan configuration/i);

      await shoot(page, `${size.name}-5-disclaimer`);
    });

    /*
     * 6 · Hebrew, right to left.
     *
     * The plan NAME stays Latin — `Plan.nameHe` is null for ai_voice, and a
     * transliteration would be an invention. What must be Hebrew is every
     * sentence the screen itself writes, and the disclaimer, which the
     * platform ships translated.
     */
    test('6 · Hebrew', async ({ page }) => {
      await openPlan(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      const deferred = page.getByTestId('change-deferred');
      await expect(deferred).toBeVisible();
      await expect(deferred).toHaveText(/[֐-׿]/);
      // The year survives translation; it is the part that gets misread.
      await expect(deferred).toHaveText(/2027/);

      // The platform's Hebrew disclaimer, not ours.
      await expect(page.getByTestId('pricing-disclaimer')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-6-hebrew`);
    });
  });
}
