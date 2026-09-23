import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

/**
 * Screen 17 · Settings · Usage & billing — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/settings-billing.spec.ts
 *
 * Shots land in e2e/evidence/s17/.
 *
 * ── WHAT THIS TENANT CAN AND CANNOT SHOW ──
 * Verified through the BFF before this spec was written:
 *
 *     { used: 0, limit: null, projectedExhaustionAt: null,
 *       periodStart: 2026-09-08, periodEnd: 2027-09-08 }
 *
 * So the design's centrepiece — "3,160 of 5,000 · enough until 12 September" —
 * **cannot be photographed here.** The subscription carries no chat volume
 * option, so there is no allowance to draw a bar against, nothing to project,
 * and no count to show. The period is also a YEAR, not a month.
 *
 * That is a fact about the tenant, not a defect, and it is NOT worked around:
 * setting a volume option would be a write to real billing data.
 *
 * So the shot that matters most here is the opposite of the design's: a plan
 * with no conversation cap must read as a WORKING screen rather than a broken
 * one. A page showing 0 and no bar looks like a failure unless it says why,
 * and test 2 asserts that sentence positively — by its content, not by the
 * absence of an error.
 *
 * ── NOTHING IS WRITTEN ──
 * Changing a plan is a real billing action. There is no `.click()` in this
 * spec on anything that charges money.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's17');

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

async function openBilling(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/settings/billing`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/settings/billing. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  await expect(
    page.getByTestId('section-runway'),
    missingIds('an id this screen emits'),
  ).toBeVisible({ timeout: 15_000 });

  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /*
     * 1 · the plan, in the currency it is actually charged in.
     *
     * The demo tenant is on `ai_voice` at **$1,499.00 USD**. The design says
     * ₪1,290, which is a mockup number — converting it, or showing a shekel
     * sign the subscription does not carry, would put a price in front of
     * somebody that nobody agreed to.
     */
    test('1 · the plan line, real currency', async ({ page }) => {
      await openBilling(page, 'en');

      const plan = page.getByTestId('plan-line');
      await expect(plan).toBeVisible();

      /*
       * A NAME, never a key. `ai_voice` shipped as the most prominent line on
       * this screen and was caught in a screenshot — the same class as
       * rendering a cuid where an object name belongs, in a more visible
       * place. A key is also untranslatable, which half these shots are.
       */
      await expect(page.getByTestId('plan-name')).not.toHaveText(/^[a-z][a-z0-9]*_[a-z0-9_]+$/);
      await expect(plan).toHaveText(/\$|US\$/);
      // Never the mockup's currency.
      await expect(plan).not.toHaveText(/₪/);
      // Renewing and ending are opposite facts; one of them must be stated.
      await expect(plan).toHaveText(/renews|ends/i);

      await shoot(page, `${size.name}-1-plan`);
    });

    /*
     * 2 · THE SHOT THAT MATTERS ON THIS TENANT.
     *
     * No chat volume option, so `limit` is null. There is no bar, no "1,840
     * left" and no exhaustion date — and the screen must still read as
     * working. A page showing 0 with nothing else looks broken.
     *
     * Asserted POSITIVELY by content: the explanation must be present and must
     * say what is true. Asserting merely that no error appears would pass on a
     * blank section, which is the failure this test exists to prevent.
     */
    test('2 · a plan with no conversation cap reads as working', async ({ page }) => {
      await openBilling(page, 'en');

      const runway = page.getByTestId('runway');
      await expect(runway).toHaveAttribute('data-metered', 'no');

      const explanation = page.getByTestId('runway-unmetered');
      await expect(explanation).toBeVisible();
      await expect(explanation).toHaveText(/doesn't cap conversations/i);
      // And it names the period it actually has, which here is a YEAR.
      await expect(explanation).toHaveText(/2027/);

      await shoot(page, `${size.name}-2-no-allowance`);
    });

    /*
     * 3 · three things the design draws that have nothing behind them.
     *
     * No overage rate field, no spending-cap field, and nothing computing
     * hours saved or revenue attributed. All three are ABSENT rather than
     * softened — a wrong claim about money belongs least of all here.
     */
    test('3 · no invented money claims', async ({ page }) => {
      await openBilling(page, 'en');

      const main = page.locator('main');
      await expect(main).not.toHaveText(/per extra conversation|spending cap/i);
      await expect(main).not.toHaveText(/hours your team didn't spend|revenue/i);
      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-3-no-invented-claims`);
    });

    /*
     * 4 · the unbuilt halves say they are unbuilt.
     *
     * Invoices and the period breakdown are contracted and not yet served, so
     * they render "we cannot show this" — never an empty list. Four real
     * invoices exist on this tenant and are unreachable; an empty list would
     * say they do not exist, which on a billing screen is a claim about
     * whether someone was charged.
     */
    test('4 · unserved sections say so rather than showing nothing', async ({ page }) => {
      await openBilling(page, 'en');

      await expect(page.getByTestId('section-invoices')).toBeVisible();
      await expect(page.getByTestId('section-breakdown')).toBeVisible();

      // Whichever state each is in, it must never be the silently-empty one.
      const invoicesEmpty = await page.getByTestId('invoices-empty').count();
      const invoicesUnavailable = await page.getByTestId('invoices-unavailable').count();
      expect(
        invoicesEmpty + invoicesUnavailable + (await page.getByTestId('invoices').count()),
        'the invoices section rendered neither content, an empty state, nor an explanation',
      ).toBeGreaterThan(0);

      await shoot(page, `${size.name}-4-unserved-sections`);
    });

    /* 5 · Hebrew, selected by test id. */
    test('5 · Hebrew, right to left', async ({ page }) => {
      await openBilling(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('section-runway')).toBeVisible();
      await expect(page.getByTestId('runway-unmetered')).toBeVisible();

      await shoot(page, `${size.name}-5-hebrew`);
    });

    /* 6 · the two standing shell rules. */
    test('6 · content above the fold, no placeholders', async ({ page }) => {
      await openBilling(page, 'en');

      const box = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect(box, 'the page heading has no box — is it rendered?').not.toBeNull();
      expect(
        box!.y,
        `the heading starts ${Math.round(box!.y)}px down a ${size.height}px viewport`,
      ).toBeLessThan(size.height / 2);

      await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-6-above-the-fold`);
    });
    /*
     * ★ THE SHOT THAT MATTERS NOW.
     *
     * This section used to say "We can't show your invoices yet", beside a
     * comment claiming no tenant-facing route existed. The route was mounted
     * the whole time — at bare `/api`, like every billing router — and what
     * it was hiding is four FAILED charges worth $5,996.
     */
    test('invoices · the failed charges are surfaced, not hidden', async ({ page }) => {
      await openBilling(page, 'en');

      // The old message must not come back.
      await expect(page.locator('main')).not.toHaveText(/can't show your invoices yet/i);

      const failed = page.getByTestId('invoices-failed');
      await expect(failed).toBeVisible();
      await expect(failed).toHaveText(/didn't go through/i);
      await expect(failed).toHaveText(/nothing has been paid/i);

      // And a failed invoice explains its missing receipt rather than
      // leaving a blank that reads as a lost document.
      await expect(page.locator('[data-testid^="no-receipt-"]').first()).toHaveText(
        /a receipt is issued when a charge is paid, and this one wasn't/i,
      );

      await shoot(page, `${size.name}-invoices-failed`);
    });
    /*
     * ★ The two facts that belong together.
     *
     * Four charges failed against an entity with ZERO payment methods. A
     * card that does not exist cannot be charged — arithmetic, not a
     * diagnosis — and it is the only actionable thing on this page.
     */
    test('profile · nothing to charge, said beside the failures', async ({ page }) => {
      await openBilling(page, 'en');

      const nothing = page.getByTestId('nothing-to-charge');
      await expect(nothing).toBeVisible();
      await expect(nothing).toHaveText(/no payment method on file/i);
      await expect(nothing).toHaveText(/charges have already failed/i);

      /*
       * FOUR states, not one blank form — and this tenant is the second.
       *
       * `billingIdentity()` used to return `profile ?? empty`, so a tenant
       * with no profile row and a tenant whose details were DELETED produced
       * the same blank fields, a layer below the screen where nothing in the
       * frontend could tell them apart. Backend now sends
       * `state: "no_billing_profile"`.
       *
       * Asserted by WHICH sentence renders, not merely that one does.
       */
      await expect(page.getByTestId('profile-none')).toBeVisible();
      await expect(page.getByTestId('profile-none')).toHaveText(/have been entered yet/i);
      // Not the emptied sentence: they never had details, they did not lose any.
      await expect(page.getByTestId('profile-blank')).toHaveCount(0);
      // And not the no-account sentence: a billable entity DOES exist here.
      await expect(page.getByTestId('profile-no-account')).toHaveCount(0);

      // And the fields the design asks for that do not exist are named.
      await expect(page.getByTestId('profile-absent-fields')).toHaveText(
        /one invoice email address, not a list/i,
      );

      await shoot(page, `${size.name}-profile-nothing-to-charge`);
    });

    /*
     * ★★ Screen 17c · THE BAR THAT IS NOT DRAWN.
     *
     * `GET /billing/credit-summary` reports `consumedCredits: 7000` and
     * `consumedPct: 100` for this tenant. The ledger says otherwise:
     *
     *     GRANT    +7,000.00   2026-07-28
     *     CONSUME    -340.01   2026-07-28 → 2026-08-07   (1,077 rows)
     *     EXPIRE  -6,659.99    2026-08-28
     *
     * `consumedCredits` is `includedAllowance - includedRemaining`, so expiry
     * lands in it. Five per cent of an allowance, reported as a hundred.
     *
     * A bar at 100% would tell an owner his AI burned the year's allowance in
     * ten days, and a caveat underneath does not undo it — a bar is a picture
     * and a caveat is a sentence, and people read pictures.
     *
     * So the screen withholds the figure AND SAYS SO. Asserted positively by
     * content: silence would look like a section that failed to load, which
     * is the failure this test exists to prevent.
     */
    test('credits · the usage figure is withheld, and the screen says why', async ({ page }) => {
      await openBilling(page, 'en');

      const credits = page.getByTestId('credits');
      await expect(credits).toBeVisible();
      await expect(credits).toHaveAttribute('data-consumption', 'withheld');

      const withheld = page.getByTestId('credits-consumption-withheld');
      await expect(withheld).toBeVisible();
      await expect(withheld).toHaveText(/expired credits as if they had been spent/i);

      // The number that must never appear. This is the whole finding.
      await expect(credits).not.toHaveText(/100\s?%/);

      await shoot(page, `${size.name}-credits-withheld`);
    });

    /*
     * ★ Credits contracted, never granted.
     *
     * The subscription is ai_voice, ACTIVE since 2026-09-08, for 7,000
     * credits. One `ai_unit_lot` has ever existed for this tenant and it
     * expired on 2026-08-28; `tenant_ai_balances.periodKey` still says
     * 2026-07.
     *
     * "7,000 included" beside "0 available" reads as a loss unless somebody
     * says which is the contract and which is the holding.
     */
    test('credits · zero because none were issued, not because they were spent', async ({
      page,
    }) => {
      await openBilling(page, 'en');

      const notice = page.getByTestId('credits-awaiting-grant');
      await expect(notice).toBeVisible();
      await expect(notice).toHaveText(/have been issued/i);
      await expect(notice).toHaveText(/7,000/);
      // The sentence that stops a zero being read as overspending.
      await expect(notice).toHaveText(/not credits you have spent/i);

      await shoot(page, `${size.name}-credits-awaiting-grant`);
    });

    /*
     * ★ 88 conversations, nothing metered.
     *
     * `observedConversationCost` tests `creditsConsumed <= 0` BEFORE the
     * sample-size gate, so this tenant gets `no_consumption_recorded` with
     * `sample.conversations: 88`.
     *
     * The reason code is about METERING. Rendered as "no activity" it would
     * be a flat falsehood sitting beside the 88 that disproves it, so the
     * screen states the count and says which of the two it means.
     */
    test('credits · no metering is not no activity', async ({ page }) => {
      await openBilling(page, 'en');

      const note = page.getByTestId('credits-no-metering');
      await expect(note).toBeVisible();
      await expect(note).toHaveText(/\d+ conversations/);
      await expect(note).toHaveText(/no credits were recorded/i);
      await expect(note).toHaveText(/not about how much you have used/i);

      await shoot(page, `${size.name}-credits-no-metering`);
    });
  });
}
