import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds, readFailed } from './diagnose';
import { shoot as captureScreen } from './shoot';

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

/**
 * Wait for a credits element, and say WHICH failure it was.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ A LONGER TIMEOUT WOULD NOT HAVE FIXED THE FLAKE THAT PROMPTED THIS
 * ════════════════════════════════════════════════════════════════════════════
 * `credits · no metering is not no activity` failed once at 390px in a
 * 78-test parallel run and passed alone in 2.1s. The obvious reading is that
 * the assertion's default 5s was too short while the helpers use 15s.
 *
 * But `Credits` is a SERVER component. By the time `openBilling` returns —
 * having already waited 15s for `section-runway` — the whole page HTML
 * exists, and `credits-no-metering` is either in it or it is not. There is no
 * later fetch for a longer timeout to catch.
 *
 * What CAN remove it is the credit-summary read failing: `loadBilling`
 * catches, `credits` is null, and the section renders `credits-unavailable`
 * instead. Against a 1,000-request-per-fifteen-minutes budget, with a billing
 * page costing ~10 reads per load and 78 tests in flight, a 429 on that one
 * endpoint is the likeliest cause by some distance.
 *
 * In that case a 15s timeout fails slower rather than passing, and a retry
 * that happens to pass teaches us nothing. So the wait is raised to 15s for
 * parity with every other data-dependent assertion in this file AND the
 * failure now names the alternative it can actually distinguish.
 */
async function creditsElement(page: Page, testId: string) {
  const unavailable = page.getByTestId('credits-unavailable');
  if ((await unavailable.count()) > 0) throw new Error(readFailed(testId, 'credits-unavailable'));

  /*
   * ⚠ THIS 15s IS PARITY, NOT THE FIX. Do not read it as one.
   *
   * The failure that prompted this helper was three 503s on
   * /api/billing/credit-summary — verified in the server log, with zero 429s
   * in the whole run. A timeout of any length catches none of that: the
   * element was never in the HTML.
   *
   * It is here only because every other data-dependent assertion in this
   * file carries an explicit 15s, and that inconsistency is precisely what
   * attracted a confident wrong diagnosis the first time. The check ABOVE is
   * the fix.
   */
  const target = page.getByTestId(testId);
  await expect(target, missingIds(testId)).toBeVisible({ timeout: 15_000 });
  return target;
}

/**
 * Shots land in `EVIDENCE`. The helper grows the viewport before capturing:
 * this app scrolls `main`, not the document, so `fullPage` alone captured
 * exactly one screenful — see `e2e/shoot.ts`.
 */
async function shoot(page: Page, name: string) {
  await captureScreen(page, EVIDENCE, name);
}

/**
 * ★★ ONE PROJECT CAPTURES, BECAUSE BOTH WOULD WRITE THE SAME FILES.
 *
 * `ltr` and `rtl` differ only in the browser's `locale`, and every screen here
 * takes its direction from the URL — `/en/…` and `/he/…` — which is what
 * next-intl reads. So the two projects rendered identical pixels into
 * identical filenames and, with `fullyParallel: true`, raced to write them.
 *
 * Two costs, and the second is why this landed before a shoot:
 *   · a torn PNG is not a missing shot, it is a corrupt one, and it reads as
 *     a rendering defect;
 *   · it doubled the request budget. The limit is 1,000 requests per fifteen
 *     minutes per IP per service — see `missingIds` — and half of every run
 *     was a re-run of the English tests under a Hebrew locale that changes
 *     nothing.
 *
 * Hebrew is not lost: the specs that cover it navigate to `/he/…` themselves.
 *
 * ── AND THE GUARD IS THE FIRST STATEMENT INSIDE EACH TEST, NOT AT DESCRIBE
 *    SCOPE ──
 * `settings-notifications-seeded.spec.ts` records the trap and it was
 * re-verified before this change: a describe-scope
 * `test.skip(({}, testInfo) => …)` receives FIXTURES ONLY — there is no
 * second argument — so `testInfo` is `undefined` and reading `.project`
 * throws **in both projects**. The guard meant to separate them runs in both
 * and crashes on the value it exists to read.
 */
const CAPTURING_PROJECT = 'ltr';

function onlyOneProject(): boolean {
  const project = test.info().project.name;
  if (project === CAPTURING_PROJECT) return false;
  test.skip(true, `Captured by the ${CAPTURING_PROJECT} project; direction comes from the URL.`);
  return true;
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
      if (onlyOneProject()) return;

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
      if (onlyOneProject()) return;

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
      if (onlyOneProject()) return;

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
      if (onlyOneProject()) return;

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
      if (onlyOneProject()) return;

      await openBilling(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('section-runway')).toBeVisible();
      await expect(page.getByTestId('runway-unmetered')).toBeVisible();

      await shoot(page, `${size.name}-5-hebrew`);
    });

    /* 6 · the two standing shell rules. */
    test('6 · content above the fold, no placeholders', async ({ page }) => {
      if (onlyOneProject()) return;

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
      if (onlyOneProject()) return;

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
      if (onlyOneProject()) return;

      await openBilling(page, 'en');

      /*
       * ── WHY THIS IS NOT A BARE `toBeVisible` ANY MORE ──
       * This block depends on TWO parallel reads, and it failed roughly one
       * run in six at a random viewport with a clear request budget. The old
       * assertion could not tell "the fetch lost" from "the warning is gone",
       * so a real defect — the most consequential sentence on the screen
       * vanishing silently — presented as a flake for as long as it existed.
       *
       * Now BOTH outcomes render something, so the assertion is: the block is
       * here in one of its forms. A transient read failure gives the
       * read-failed sentence and this still passes; the warning disappearing
       * entirely fails, which is what it should always have done.
       */
      const nothing = page.getByTestId('nothing-to-charge');
      const unknown = page.getByTestId('methods-unknown');
      await expect(nothing.or(unknown).first()).toBeVisible();

      if ((await unknown.count()) > 0) {
        // The payment-methods read lost. Say so, do not silently pass.
        await expect(unknown).toHaveText(/charges will fail/i);
        /*
         * An annotation, not a `console.warn`. Two reasons, and the second is the
         * one that matters: `no-console` exists here because a stray log leaks
         * whatever was in scope, and in this product that can be a customer's
         * message — so the rule is not worth an exemption for a diagnostic. And a
         * console line in a Playwright run scrolls past, while an annotation lands
         * in the report somebody actually reads when they wonder why a run took
         * the other branch.
         */
        test.info().annotations.push({
          type: 'degraded',
          description: 'payment-methods read failed this run — the warning is the unread form',
        });
      } else {
        await expect(nothing).toHaveText(/no payment method on file/i);
        // Either the count, or an admission that it could not be counted —
        // never a silent demotion to the reassuring version.
        await expect(nothing).toHaveText(
          /charges have already failed|couldn't load your invoices/i,
        );
      }

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
      if (onlyOneProject()) return;

      await openBilling(page, 'en');

      const credits = page.getByTestId('credits');
      await expect(credits).toBeVisible();
      await expect(credits).toHaveAttribute('data-consumption', 'withheld');

      const withheld = await creditsElement(page, 'credits-consumption-withheld');
      await expect(withheld).toHaveText(/expired credits as if they had been spent/i);

      // The number that must never appear. This is the whole finding.
      await expect(credits).not.toHaveText(/100\s?%/);

      /*
       * 17's framing is CREDITS, per the design: "Everything GOTCHA does uses
       * credits. You see what's left, and how far it goes."
       *
       * And the two lines from that block the screen refuses: "Used 7,360",
       * which is `consumedCredits` counting expiry as spend — the same claim
       * as the bar — and "Top-up 2,000 · kept until used", which is a
       * permanence the route's stripped `expiresAt` cannot support.
       */
      await expect(credits).not.toHaveText(/kept until used/i);
      await expect(page.getByRole('heading', { name: /credits left/i })).toBeVisible();

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
      if (onlyOneProject()) return;

      await openBilling(page, 'en');

      const notice = await creditsElement(page, 'credits-awaiting-grant');
      await expect(notice).toHaveText(/have been issued/i);
      await expect(notice).toHaveText(/7,000/);
      // The sentence that stops a zero being read as overspending.
      await expect(notice).toHaveText(/not credits you have spent/i);

      /*
       * ── THE FOUR LINES THAT WERE IN EVERY SHOT AND IN NO ASSERTION ──
       * Found by comparing the rendered evidence against the assertions
       * rather than the file tree against the design. All four are visible in
       * `1440-6-above-the-fold.png` and none had ever been read by a test.
       *
       * They are asserted HERE, inside a test that already has the page open,
       * because the rate limit is a 1,000-request window and a billing page
       * costs six requests every time it loads. A new test per line would
       * have spent a fifth of the budget to assert four sentences.
       */

      // The headline number on the block. Nothing checked it said anything.
      const balance = page.getByTestId('credits-balance');
      await expect(balance).toHaveText(/\d/);
      await expect(balance).toHaveText(/credits available/i);

      /*
       * ★ NO FORECAST FROM A BALANCE THE SCREEN HAS JUST DISOWNED.
       *
       * This shot used to carry "At your plan's rate that is about 0 more
       * conversations" directly beneath "no credits have been issued for this
       * period yet" — a projection standing on an input the paragraph above
       * calls absent, and read as a measurement precisely because the reader
       * has just been taught that this screen is careful.
       *
       * Both estimates divide a balance by a rate, so while `awaitingGrant()`
       * the quotient is not an estimate. It is suppressed, and the sentence
       * that replaces it is asserted POSITIVELY.
       *
       * The first draft of this test wrapped the estimate in `if count > 0`,
       * which after the suppression would have skipped every assertion and
       * passed in silence — the inert guard again. A test for something that
       * must not be there has to assert what IS.
       */
      const withheld = page.getByTestId('credits-estimate-withheld');
      await expect(
        withheld,
        'the estimate was withheld with no sentence explaining why — a gap where a number was reads as broken',
      ).toBeVisible();
      await expect(withheld).toHaveText(/credits are granted/i);
      await expect(page.getByTestId('credits-estimate-plan')).toHaveCount(0);
      await expect(page.getByTestId('credits-estimate-observed')).toHaveCount(0);
      // The words themselves, not just the id: a key can change and a
      // forecast can come back under a different testid.
      await expect(page.getByTestId('credits')).not.toHaveText(/0 more conversations/i);

      /*
       * Unserved, and saying so. `breakdown-unavailable` is the difference
       * between "we could not read this" and "there is nothing here", and it
       * is the branch this tenant actually renders.
       */
      const breakdown = page.getByTestId('breakdown-unavailable');
      if ((await breakdown.count()) > 0) {
        await expect(breakdown).toHaveText(/\S/);
        await expect(breakdown).toHaveText(/can.t show the breakdown/i);
      }

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
      if (onlyOneProject()) return;

      await openBilling(page, 'en');

      const note = await creditsElement(page, 'credits-no-metering');
      await expect(note).toHaveText(/\d+ conversations/);
      await expect(note).toHaveText(/no credits were recorded/i);
      await expect(note).toHaveText(/not about how much you have used/i);

      await shoot(page, `${size.name}-credits-no-metering`);
    });

    /*
     * ══════════════════════════════════════════════════════════════════════
     * 17d · BUYING CREDITS
     * ══════════════════════════════════════════════════════════════════════
     * ⚠⚠ THERE IS NO `.click()` ON THE BUY BUTTON IN THIS SPEC, EVER.
     * `POST /billing/credits/buy` charges a live card against a real tenant.
     * It is disabled on this deployment anyway — `buyCredits()` checks
     * `no_billable_entity` first and this workspace has no billing profile —
     * but "the button happens to be disabled today" is not a safety
     * mechanism, so the rule is stated rather than relied upon.
     *
     * Four packs are sellable on this plan and every one is `expiryPolicy
     * NEVER`, which is why the expiry line is assertable by its words.
     */
    test('17d · the packs, the VAT, and a button that says why it cannot work', async ({
      page,
    }) => {
      if (onlyOneProject()) return;

      await openBilling(page, 'en');

      const buy = page.getByTestId('buy-credits');
      await expect(buy, missingIds('the 17d buy-credits block')).toBeVisible();

      /*
       * Four sellable, and the design draws three. The catalogue that exists
       * wins over the one the mockup expected — rendering three would mean
       * choosing which real pack a merchant is not allowed to see.
       */
      const packs = page.getByTestId('buy-packs').locator('> li');
      expect(await packs.count(), 'the plan-eligible catalogue has four packs').toBe(4);

      /*
       * ★ THE ONLY PLACE PER-PACK EXPIRY EVER REACHES A CUSTOMER.
       * `/billing/credit-summary` strips `expiresAt` from the lots and keeps
       * only `grantType`, so after the purchase nothing can say when these
       * credits die. Asserted by its WORDS: a missing key renders as the
       * empty string in this build, so a presence check would pass on a blank
       * line — which is exactly how it shipped wrong the first time.
       */
      for (let i = 0; i < 4; i += 1) {
        await expect(packs.nth(i)).toHaveText(/expire/i);
      }
      // Never read from the summary, which cannot know.
      await expect(buy).not.toHaveText(/based on your balance/i);

      /*
       * ★ AND THE TOTAL IS THE GROSS.
       *
       * Catalogue prices are NET and `taxed` carries what is actually
       * charged. Our contract was stripping it, so this screen could only
       * have shown the smaller number — the reassuring direction, and the
       * worst thing a buy screen can do.
       *
       * Either the totals are shown, or the screen says it cannot state one.
       * A tenant with no billing country gets no tax block, and
       * `taxSummaryForTenant` REFUSES rather than defaulting to 0% — so both
       * branches are legitimate here and exactly one must be present.
       */
      const totals = page.getByTestId('buy-totals');
      const unknown = page.getByTestId('buy-total-unknown');
      const shown = await totals.count();
      expect(
        shown + (await unknown.count()),
        'neither a total nor a sentence explaining why there is none',
      ).toBe(1);

      if (shown === 1) {
        await expect(page.getByTestId('buy-total')).toHaveText(/\d/);
        await expect(page.getByTestId('buy-tax-label')).toHaveText(/\S/);
      } else {
        await expect(unknown).toHaveText(/VAT depends on the country/i);
      }

      /*
       * The button, disabled, with the reason — the 14d shape.
       * `no_billable_entity` is checked first by the server, so "nobody to
       * invoice" is the sentence this tenant must get, NOT the no-card one:
       * they are different problems with different repairs.
       */
      await expect(page.getByTestId('buy-button')).toBeDisabled();
      const blocked = page.getByTestId('buy-blocked');
      await expect(blocked).toBeVisible();
      await expect(blocked).toHaveText(/nobody to invoice|no payment method/i);

      // Nothing on this screen may claim a purchase happened.
      await expect(buy).not.toHaveText(/credits added/i);

      await shoot(page, `${size.name}-17d-buy-credits`);
    });

    /*
     * ══════════════════════════════════════════════════════════════════════
     * auto-purchase · THE BLOCK THAT WAS IN EVERY SHOT AND IN NO ASSERTION
     * ══════════════════════════════════════════════════════════════════════
     * `AutoPurchase.tsx` shipped with eight testids and nineteen new message
     * keys, and was photographed at three viewports — while **not one test
     * had ever looked at it.** A green capture is evidence about the
     * assertions that ran, and there were none.
     *
     * This is screen 11d exactly: an `IntlError` sat in a shot for a full
     * capture because the test asserted only that Save was visible. It is
     * worse here, because `getMessageFallback` returns `''` in a production
     * build — a wrong key renders NOTHING, the page looks tidy, and every
     * billing test still passes. There is no error to notice.
     *
     * So every assertion below is on CONTENT. Presence proves nothing about
     * a block whose failure mode is being present and empty.
     */
    test('auto-purchase · the block that was photographed but never read', async ({ page }) => {
      if (onlyOneProject()) return;

      await openBilling(page, 'en');

      const unset = page.getByTestId('auto-purchase-unset');
      const block = page.getByTestId('auto-purchase');

      /*
       * Exactly one. "Nothing is configured" and "here is the configuration"
       * are different facts, and rendering neither is the empty-key failure
       * this whole test exists to catch.
       */
      const unsetCount = await unset.count();
      const blockCount = await block.count();
      expect(
        unsetCount + blockCount,
        missingIds('the auto-purchase block (neither the unset sentence nor the policy)'),
      ).toBe(1);

      if (unsetCount === 1) {
        /*
         * No policy row. The sentence must still name the DEFAULT outcome —
         * "nothing is set up" alone leaves a merchant believing nothing
         * happens, when in fact the AI stops answering.
         */
        await expect(unset).toHaveText(/\S/);
        await expect(unset).toHaveText(/default/i);
        await expect(unset).toHaveText(/stops answering/i);
        await shoot(page, `${size.name}-auto-unset`);
        return;
      }

      // ── No placeholder ever reaches a merchant ──────────────────────────
      // `{threshold}`, `{warn}`, `{cap}`, `{spent}`, `{currency}`, `{used}`.
      // An un-substituted placeholder renders literally and looks like a
      // template someone forgot, which is the one thing worse than empty.
      await expect(block).not.toHaveText(/\{[a-zA-Z]/);

      // ── 1 · does it buy, and at what ────────────────────────────────────
      const state = page.getByTestId('auto-state');
      await expect(state).toHaveText(/\S/);
      const stateText = (await state.textContent()) ?? '';
      const buysAutomatically = /Buys more automatically/i.test(stateText);
      if (buysAutomatically) {
        // The trigger is the number. A sentence saying it buys without saying
        // when is the part a merchant came here to read.
        await expect(state).toHaveText(/\d+%/);
      } else {
        expect(stateText, 'auto-state said neither that it buys nor that it does not').toMatch(
          /Doesn.t buy more automatically/i,
        );
      }

      // ── 2 · TWO thresholds, not one ─────────────────────────────────────
      // `warningThresholdPct` tells the owner and `thresholdPct` buys. The
      // design drew one control; a warning that fires at the same instant as
      // the purchase is not a warning, so when buying is on, the screen must
      // say somebody is told FIRST — and must say at what.
      const warning = page.getByTestId('auto-warning');
      if (buysAutomatically) {
        await expect(warning).toBeVisible();
        await expect(warning).toHaveText(/\d+%/);
        await expect(warning).toHaveText(/before anything is bought/i);
      } else {
        await expect(warning).toHaveCount(0);
      }

      // ── 3 · the ceiling, and what has gone against it ───────────────────
      const cap = page.getByTestId('auto-cap');
      await expect(cap).toHaveText(/\S/);
      const capText = (await cap.textContent()) ?? '';
      const hasCeiling = !/No monthly limit/i.test(capText);
      if (hasCeiling) {
        /*
         * A ceiling with no figure is not a ceiling. Both numbers are
         * required: the limit and the spend so far — one without the other
         * cannot answer "how close am I".
         */
        expect(capText, 'a monthly ceiling was claimed with no amount in it').toMatch(/\d/);
        await expect(cap).toHaveText(/a month on automatic purchases/i);
        await expect(cap).toHaveText(/so far this cycle/i);
      }

      /*
       * ★ AND IT IS A MONEY CEILING, NOT A PURCHASE-COUNT CAP.
       *
       * The design asks "at most how many times a month". `AutoPurchasePolicy`
       * stores `packageKey`, `thresholdPct`, `warningThresholdPct` and
       * `maxMonthlySpend` — there is nowhere to put a count. Five ₪100 buys
       * and one ₪500 buy are identical to a money ceiling and opposite to a
       * count, so the screen must not imply the guarantee it cannot make.
       */
      await expect(cap).not.toHaveText(/\btimes a month\b/i);
      await expect(cap).not.toHaveText(/\bpurchases? per month\b/i);

      // ── 4 · what happens when it runs out ───────────────────────────────
      // The key is COMPUTED from the enum (`autoPurchase.behavior.${value}`).
      // A sixth value on the platform renders the empty string here, and the
      // most consequential sentence on the block silently disappears.
      const behavior = page.getByTestId('auto-behavior');
      await expect(behavior).toHaveText(/\S/);
      const behaviorText = (await behavior.textContent()) ?? '';
      expect(
        behaviorText,
        'auto-behavior rendered something that is none of the five known outcomes — ' +
          'most likely a limitBehavior this build has no message key for, which renders ' +
          'as the empty string in a production build',
      ).toMatch(/When it runs out|Never buys more/i);
      // Never the raw enum at a merchant.
      await expect(behavior).not.toHaveText(
        /STOP_AI|HUMAN_ONLY|REQUIRE_APPROVAL|PREPAID_ONLY|PAYG/,
      );

      // ── 5 · pay-as-you-go, and the two things it implies ────────────────
      const isPayg = /keeps working and the extra usage is billed/i.test(behaviorText);

      /*
       * `SETTABLE_BEHAVIORS` excludes PAYG and nothing else, so the notice
       * and the behaviour are a BICONDITIONAL — asserted in both directions.
       * One direction alone passes on a screen that shows the notice for
       * every behaviour, which would tell four merchants out of five that a
       * setting they can change is out of their hands.
       */
      const unsettable = page.getByTestId('auto-unsettable');
      if (isPayg) {
        await expect(unsettable).toBeVisible();
        await expect(unsettable).toHaveText(/can.t be switched on or off from here/i);
        // And it must not leave them thinking the whole page is read-only.
        await expect(unsettable).toHaveText(/other options on this page can be changed/i);
      } else {
        await expect(unsettable).toHaveCount(0);
      }

      /*
       * ★ THE COMBINATION THAT LOOKS SAFE AND IS NOT.
       *
       * A ceiling stops the auto-PURCHASE. With PAYG, usage past zero is
       * accrued and billed at the end of the cycle anyway — so a merchant who
       * set a limit and reads it as "this is the most I can be charged" is
       * wrong, and nothing else on the screen would tell them.
       *
       * Asserted in both directions, which is what makes it catch an inverted
       * `spendsPastZero`: present when a ceiling meets PAYG, absent otherwise.
       */
      const contradiction = page.getByTestId('auto-cap-not-a-cap');
      if (hasCeiling && isPayg) {
        await expect(contradiction).toBeVisible();
        await expect(contradiction).toHaveText(/doesn.t stop the bill/i);
        await expect(contradiction).toHaveText(/still charged at the end of the cycle/i);
      } else {
        await expect(contradiction).toHaveCount(0);
      }

      await shoot(page, `${size.name}-auto-purchase`);
    });
  });
}
