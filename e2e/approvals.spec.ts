import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';
import { shoot as captureScreen } from './shoot';

/**
 * Screen 03 · Approvals — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/approvals.spec.ts
 *
 * Shots land in e2e/evidence/s03/.
 *
 * ── WHAT THIS TENANT CAN AND CANNOT SHOW ──
 * Counted before this spec was written:
 *
 *     PENDING                       0
 *     APPROVED · SUCCEEDED         14
 *     APPROVED · FAILED            13   ← 48% of everything approved
 *     REJECTED                      2
 *     EXPIRED                       2
 *
 * **Zero pending.** So 03 (the queue) and 03b (the moment after) cannot be
 * photographed here at all, and what this evidence covers is **03c**, which is
 * the state the tenant is genuinely in.
 *
 * That is not worked around. An `ApprovalRequest` is a bot-initiated request to
 * perform a real action — approving one moves real money, and there is no
 * create route because the only thing that makes one is the bot path. The
 * screen-15 seeding pattern does not transfer: `system.error.critical` was
 * inert because nothing emitted it, and there is no inert approval.
 *
 * The keyboard model, the lapsed row and the moment-after panel are checked in
 * `src/features/approvals/ApprovalsScreen.test.tsx`, which says at the top that
 * it is the only place they can be.
 *
 * ── AND THE NUMBER THIS EVIDENCE EXISTS TO SHOW ──
 * **Thirteen approvals on this tenant were granted and never executed.** The
 * screen's whole thesis — that `status` and `executionState` are two axes and
 * collapsing them hides the case that matters — is not an argument here. It is
 * nearly half of this tenant's approved actions, and test 2 photographs it.
 *
 * ── NOTHING IS WRITTEN ──
 * There is no `.click()` in this spec on anything that decides, retries or
 * changes a threshold.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's03');

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

async function openApprovals(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/approvals`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/approvals. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  // One of the real states must be present. If none is, something between
  // the session and the build is wrong — `missingIds` orders the
  // candidates rather than naming one.
  const states = ['nothing-waiting', 'approvals-screen', 'approvals-unavailable'];
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

  // And refuse to photograph a failed read as though it were the screen.
  await expect(
    page.getByTestId('approvals-unavailable'),
    'the approvals could not be read, so this run would photograph an error panel',
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
     * 1 · 03c — an empty queue is the product working.
     *
     * Asserted positively by content. A screen that merely fails to show an
     * error would pass a test that proves nothing, and "nothing waiting" read
     * as a fault is the exact failure this state is designed against.
     */
    test('1 · nothing waiting reads as the product working', async ({ page }) => {
      await openApprovals(page, 'en');

      const rest = page.getByTestId('nothing-waiting');
      await expect(rest).toBeVisible();
      await expect(page.getByTestId('nothing-waiting-lead')).toHaveText(/needs a decision/i);
      // And the record of what was already decided is part of this state.
      await expect(page.getByTestId('decided-section')).toBeVisible();

      await shoot(page, `${size.name}-1-nothing-waiting`);
    });

    /*
     * 2 · THE SHOT THAT MATTERS ON THIS TENANT.
     *
     * Thirteen approvals were granted and never ran. A screen that shows only
     * `status` would render all 27 approved rows identically, and the customer
     * behind each of the thirteen was told nothing.
     */
    test('2 · approved and never ran is visible, not hidden', async ({ page }) => {
      await openApprovals(page, 'en');

      const list = page.getByTestId('decided-list');
      await expect(list).toBeVisible();

      const failed = page.locator('[data-testid^="failed-"]');
      await expect(
        failed,
        'no row reports a failed execution — either the tenant changed or the two axes ' +
          'have been collapsed back into one',
      ).not.toHaveCount(0);
      await expect(failed.first()).toHaveText(/didn't run|did not run/i);

      await shoot(page, `${size.name}-2-approved-but-never-ran`);
    });

    /*
     * 3 · THE PINNED OMISSIONS.
     *
     * Every one is a ruling, and a ruling survives only if something fails
     * when it is undone.
     */
    test('3 · no reversal, no edit, no invented customer facts', async ({ page }) => {
      await openApprovals(page, 'en');
      const main = page.locator('main');

      // (a) There is no undo in this platform — no route, no gateway path, no
      //     `undoneAt` or `reversalOf` field. The design puts Undo on every
      //     decided row and "reversible for 24h" in the header.
      await expect(main).not.toHaveText(/\bundo\b/i);
      await expect(main).not.toHaveText(/reversible|take it back|within 24h/i);

      // (b) The permission governing parameter edits is read by nobody, and
      //     this is the one control that changes how much money moves.
      await expect(main).not.toHaveText(/edit amount/i);

      // (c) The customer card. "Previous refunds: None" collapses "we asked
      //     and found none" with "we could not ask", on an approval about a
      //     refund — the fact most likely to swing the decision.
      await expect(main).not.toHaveText(/previous refunds|lifetime|with you since/i);
      await expect(main).not.toHaveText(/\bmood\b/i);

      // (d) "31 actions handled without asking you" has correct data behind it
      //     and no route that serves it. Unbuilt, so unclaimed — and never
      //     rendered as a zero, which would be a different claim entirely.
      await expect(main).not.toHaveText(/handled without asking/i);

      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-3-pinned-omissions`);
    });

    /*
     * 4 · no machine identifiers reach a person.
     *
     * `requestedBy` is `ai-agent:<cuid>` for every AI employee and the list
     * route explicitly refuses to resolve it. This is the `ai_voice` class.
     */
    test('4 · no raw identifiers on screen', async ({ page }) => {
      await openApprovals(page, 'en');
      const main = page.locator('main');

      await expect(main).not.toHaveText(/ai-agent:|flow:/);
      // A bare cuid, which is what a failed name resolution leaves behind.
      await expect(main).not.toHaveText(/\bc[a-z0-9]{24,}\b/);

      await shoot(page, `${size.name}-4-no-raw-identifiers`);
    });

    /* 5 · Hebrew, right to left. */
    test('5 · Hebrew, right to left', async ({ page }) => {
      await openApprovals(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('nothing-waiting')).toBeVisible();
      // Hebrew copy, not an untranslated fallback sitting in an RTL page.
      await expect(page.getByTestId('nothing-waiting-lead')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-5-hebrew`);
    });

    /* 6 · the two standing shell rules. */
    test('6 · content above the fold, no placeholders', async ({ page }) => {
      await openApprovals(page, 'en');

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
