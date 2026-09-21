import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

/**
 * Screen 16 · Settings · Security — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/settings-security.spec.ts
 *
 * Shots land in e2e/evidence/s16/.
 *
 * ══ NO REAL PERSONAL DATA REACHES AN EVIDENCE FILE ══
 * This is the first screen that renders a real IP address and the city someone
 * signs in from. Evidence files persist and are committed, so a screenshot of
 * the live sessions list would put personal data in the repository — which the
 * standing instruction forbids in messages AND in evidence.
 *
 * I would have intercepted at the network layer and left the app untouched.
 * That is not possible here: the page is a SERVER component, so those calls
 * leave the Node process rather than the browser and `page.route` never sees
 * them. So the substitution is server-side, in `capture-fixtures.ts`, gated on
 * `E2E_SECURITY_FIXTURES=1` AND `NODE_ENV !== 'production'`.
 *
 *   E2E_SECURITY_FIXTURES=1 npx next start
 *
 * The fixtures use RFC 5737 documentation addresses (`203.0.113.x`), reserved
 * so they can never belong to anyone, and they are DISTINCT from each other.
 * That matters: the screen's claim is that an unfamiliar session is
 * recognisable, so fixtures that made every row identical would pass a capture
 * that proved nothing. The assertions name the fixed values.
 *
 * `openSecurity` REFUSES to photograph if it does not see them, so a run
 * against live data fails rather than quietly banking somebody's address.
 *
 * ── WHAT IS NOT SUBSTITUTED ──
 * Everything else reads live: the MFA policy, the audit log and its facets.
 *
 * ── AND NOTHING IS REVOKED ──
 * Sign-out is real and irreversible for the person holding that session. The
 * button is photographed, never pressed.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's16');

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

async function openSecurity(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/settings/security`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/settings/security. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  await expect(
    page.getByTestId('section-sessions'),
    missingIds('an id this screen emits'),
  ).toBeVisible({ timeout: 15_000 });

  /*
   * The guard that keeps personal data out of the repository.
   *
   * If the sessions list rendered live data, the shots below would bank a real
   * IP and a real city into a committed file. Rather than trust that the
   * fixtures were wired, every run proves it: the fixed documentation address
   * must be on the page before anything is photographed.
   */
  const sessions = page.getByTestId('session-list');
  if (await sessions.isVisible()) {
    await expect(
      sessions,
      'The sessions list is showing LIVE data. Start the server with ' +
        'E2E_SECURITY_FIXTURES=1 before capturing — screenshots are committed, and a real ' +
        'IP address and city must never land in an evidence file.',
    ).toHaveText(/203\.0\.113\./);
  }

  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /*
     * 1 · where you are signed in.
     *
     * The design's *"an unfamiliar session is flagged in the list"* needs the
     * rows to be distinguishable, so the assertions name both fixtures rather
     * than checking that two rows exist.
     */
    test('1 · sessions, and this device is marked', async ({ page }) => {
      await openSecurity(page, 'en');

      await expect(page.locator('[data-current="yes"]')).toHaveCount(1);
      await expect(page.getByTestId('session-detail-sess-current')).toHaveText(/Tel Aviv/);
      await expect(page.getByTestId('session-detail-sess-other')).toHaveText(/Haifa/);

      // The current device offers no sign-out: it cannot report its own result.
      await expect(page.getByTestId('session-revoke-sess-current')).toHaveCount(0);
      await expect(page.getByTestId('session-revoke-sess-other')).toBeVisible();

      await shoot(page, `${size.name}-1-sessions`);
    });

    /*
     * 2 · a failed sign-in is marked, not left to be spotted.
     *
     * It is the row a person is actually scanning for, and the one that means
     * somebody else tried.
     */
    test('2 · the failed sign-in stands out', async ({ page }) => {
      await openSecurity(page, 'en');

      const failed = page.locator('[data-failed="yes"]');
      await expect(failed).toHaveCount(1);
      await expect(failed).toHaveText(/Frankfurt/);
      await expect(failed).toHaveText(/Failed sign-in/i);

      await shoot(page, `${size.name}-2-failed-signin`);
    });

    /*
     * 3 · the activity log, and the three-state verdict.
     *
     * `succeeded` is `true`, `false` or **null**, and null is not false: it
     * means the emitter recorded no verdict. Collapsing them would mark every
     * un-instrumented action as a failure — the reassuring-direction error
     * inverted, alarming a reader about things that did not go wrong.
     *
     * The tenant has 22 `adapter.err.shopify.process_refund` rows: refunds
     * that failed and that nobody was ever told about, because the
     * notification path emits only on success. This screen does not fix that.
     * It is the first place they are visible at all.
     */
    test('3 · the activity log, with failures marked and unrecorded left alone', async ({
      page,
    }) => {
      await openSecurity(page, 'en');

      await expect(page.getByTestId('audit-list')).toBeVisible();
      // Whatever else is true, it must not claim the log is empty.
      await expect(page.getByTestId('audit-empty')).toHaveCount(0);
      await expect(page.getByTestId('audit-unavailable')).toHaveCount(0);

      /*
       * Three distinct states must be representable, and a row may only be
       * marked failed when the backend said so. `unrecorded` must never carry
       * the failure styling.
       */
      const rows = page.locator('[data-succeeded]');
      expect(await rows.count()).toBeGreaterThan(0);
      await expect(page.locator('[data-succeeded="unrecorded"] .failed')).toHaveCount(0);

      await shoot(page, `${size.name}-3-activity-log`);
    });

    /*
     * 3b · the vocabulary, not a taxonomy we invented.
     *
     * The log conflates actions that had an effect with lookups the AI made
     * while composing one answer, and the schema does not distinguish them —
     * so the screen shows what is actually in the log with counts, rather than
     * categories we chose. A new tool appears here on its own.
     */
    test('3b · the action facet shows real actions with counts', async ({ page }) => {
      await openSecurity(page, 'en');

      const facets = page.getByTestId('audit-facets');
      await expect(facets).toBeVisible();
      // Real action names, which are dotted machine strings, not our words.
      await expect(facets).toHaveText(/ai\.responded|adapter\.|message\.sent/);

      await shoot(page, `${size.name}-3b-action-facet`);
    });

    /*
     * 4 · two-factor, and the implication stated rather than silent.
     *
     * Requiring it of everyone includes admins, so the narrower switch is
     * disabled with its reason shown. A control that stops responding without
     * saying why reads as broken.
     */
    test('4 · the MFA switches explain the one they disable', async ({ page }) => {
      await openSecurity(page, 'en');

      /*
       * The section must be present EITHER WAY — that is the assertion that
       * would have caught the wrong URL immediately. It 404'd, the section
       * rendered nothing at all, and a missing control looked like a screen
       * that simply has no control.
       */
      await expect(page.getByTestId('section-mfa')).toBeVisible();
      // And with the path right, it must be the switches rather than the
      // "we couldn't read this" state.
      await expect(page.getByTestId('mfa-unavailable')).toHaveCount(0);
      await expect(page.getByTestId('mfa-policy')).toBeVisible();
      await expect(page.getByTestId('mfa-admins')).toBeVisible();
      await expect(page.getByTestId('mfa-everyone')).toBeVisible();

      await shoot(page, `${size.name}-4-mfa`);
    });

    /* 5 · Hebrew, selected by test id. */
    test('5 · Hebrew, right to left', async ({ page }) => {
      await openSecurity(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('section-sessions')).toBeVisible();

      /*
       * Assert what the Hebrew page MUST CONTAIN, not what it must lack.
       *
       * This line previously read `expect(audit-unavailable).not.toHaveText(…)`
       * — which fails when the element is absent, because `.not.toHaveText()`
       * still requires the element to exist. Once the audit routes shipped the
       * section rendered properly, `audit-unavailable` correctly vanished, and
       * a passing screen failed the test.
       *
       * It is the screen-14 asymmetry inverted: there a negative assertion
       * passed when it should have failed, here one failed when the screen was
       * right. Both come from asserting the absence of something wrong instead
       * of the presence of something correct.
       */
      await expect(page.getByTestId('section-audit')).toBeVisible();
      await expect(page.getByTestId('section-audit')).not.toHaveText(/Everything that happened/);

      await shoot(page, `${size.name}-5-hebrew`);
    });

    /* 6 · the two standing shell rules. */
    test('6 · content above the fold, no placeholders', async ({ page }) => {
      await openSecurity(page, 'en');

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
