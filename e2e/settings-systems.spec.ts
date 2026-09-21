import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

/**
 * Screen 14 · Settings · Business systems — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/settings-systems.spec.ts
 *
 * Shots land in e2e/evidence/s14/.
 *
 * ── THIS SPEC PERFORMS NO WRITES ──
 * There is nothing here that a test may press. `POST /:slug/disconnect` deletes
 * every `TenantTool`, and `AgentToolPermission` cascades from those — so it
 * destroys every per-agent narrowing the tenant has made, permanently, and the
 * screen offers no such control. `POST /:slug/test` writes `lastTestedAt`,
 * `lastTestResult` and `status`, so even "just re-check it" mutates the rows
 * these shots are photographing.
 *
 * ── WHAT THIS TENANT SHOWS ──
 * One connected system, Shopify, and it is BROKEN: `status ERROR`,
 * `lastTestResult false`, last checked 2026-09-15, `lastError`
 * "token_refresh_failed:shopify_token_refresh_failed_401…". The banner's own
 * scenario, on real data, without anyone manufacturing it.
 *
 * 68 capabilities, of which exactly ONE is restricted — and that one is the
 * point of shot 3.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's14');

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

async function openSystems(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/settings/systems`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/settings/systems. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId('systems-list'), missingIds('an id this screen emits')).toBeVisible(
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
     * 1 · the banner, which is the screen.
     *
     * What is broken, since when, and in the platform's own words. It must NOT
     * claim anything is being held: a tool call against a dead integration is
     * attempted and fails — there is no queue, nothing to release on recovery,
     * and no state meaning "waiting on Shopify". The design's "GOTCHA is
     * holding them rather than guessing" is custodianship the product does not
     * perform, so the number AND the sentence are both absent.
     */
    test('1 · the failure banner', async ({ page }) => {
      await openSystems(page, 'en');

      const banner = page.getByTestId('banner-shopify');
      await expect(banner).toBeVisible();
      await expect(banner).toHaveText(/stopped responding/i);
      /*
       * The platform's own words, stopping where it stopped writing prose:
       * the message is followed by an entire HTML document, truncated mid-tag
       * at 200 characters. Not one word is rewritten — the markup is simply
       * not rendered as though it were a sentence.
       */
      const error = page.getByTestId('banner-error-shopify');
      await expect(error).toHaveText(/token_refresh_failed/);
      await expect(error).not.toHaveText(/DOCTYPE|<html/i);

      // No custodianship claim, in any wording.
      await expect(banner).not.toHaveText(/holding|waiting|queued/i);

      /*
       * POSITIVE assertions, because the negative ones cannot catch a message
       * that says the wrong thing.
       *
       * This shot passed while the banner read "Reconnecting {system} means…"
       * with the placeholder unreplaced: every forbidden word was absent, so
       * every check held. A test that only forbids is the screenshot that
       * proves nothing.
       *
       * So: the banner must NAME the system, and no ICU placeholder may
       * survive into rendered copy anywhere on the page.
       */
      await expect(banner).toHaveText(/Shopify/);
      await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-1-banner`);
    });

    /*
     * 2 · "last checked", never "last synced".
     *
     * `lastTestedAt` is a CONNECTION TEST. Rendering it as a sync would tell a
     * customer their data is current because a credential check passed —
     * wrong in the reassuring direction, which is the worst direction. And
     * because the check FAILED, the banner says that too.
     */
    test('2 · the timestamp is a check, not a sync', async ({ page }) => {
      await openSystems(page, 'en');

      const banner = page.getByTestId('banner-shopify');
      await expect(banner).toHaveText(/last checked/i);
      await expect(banner).toHaveText(/the check failed/i);
      await expect(banner).not.toHaveText(/synced|sync/i);

      await shoot(page, `${size.name}-2-last-checked`);
    });

    /*
     * 3 · a system that is down tells you it cannot say what it may do.
     *
     * Two facts, and neither is guessable:
     *
     * `GET /api/tool-permissions` builds its list from `getAvailableTools`,
     * which filters `tenantIntegration: { status: "CONNECTED" }`. Shopify is
     * ERROR, so **the route reports nothing at all about its 68 tools** — not
     * "unrestricted", simply absent. Falling through to the activation would
     * render all 68 as "allowed" on approval information we were never given.
     *
     * And the same CONNECTED clause gates the AI's own tool surface, so none
     * of them can run right now however they are configured.
     *
     * TWO EARLIER VERSIONS OF THIS TEST WERE WRONG, in opposite directions.
     * The first asserted "Process Refund — Never" from a
     * `TenantToolPermission` row that nothing enforces. The second asserted 15
     * approval-gated and 53 allowed — the right numbers for a CONNECTED
     * Shopify, and unknowable for this one. Both would have pinned a claim the
     * data does not support.
     */
    test('3 · a disconnected system reports unknown, not allowed', async ({ page }) => {
      await openSystems(page, 'en');

      // We were told nothing about these tools, so we claim nothing.
      await expect(page.getByTestId('stance-unknown-shopify')).toBeVisible();
      await expect(page.getByTestId('stance-allow-shopify')).toHaveCount(0);
      await expect(page.getByTestId('stance-ask-shopify')).toHaveCount(0);
      await expect(page.getByTestId('stance-never-shopify')).toHaveCount(0);

      // No list of restricted capabilities, because none is knowable.
      await expect(page.getByTestId('restricted-shopify')).toHaveCount(0);

      // And the separate, certain fact: nothing runs while it is down.
      await expect(page.getByTestId('not-running-shopify')).toBeVisible();

      await shoot(page, `${size.name}-3-capabilities-unknown`);
    });

    /*
     * 4 · no raw scopes, anywhere.
     *
     * An explicit product rule: "What it can do" speaks in what an employee
     * gains. `GET /api/tool-permissions` really does return `grantedScopes`
     * and `missingScopes`; the contract does not name them, so they are
     * stripped at the API boundary rather than hidden at the leaf.
     */
    test('4 · capabilities are named, never scoped', async ({ page }) => {
      await openSystems(page, 'en');

      const body = page.locator('main');
      await expect(body).not.toHaveText(/read_orders|write_orders|read_customers|write_discounts/);
      await expect(body).not.toHaveText(/scope/i);

      await shoot(page, `${size.name}-4-no-scopes`);
    });

    /*
     * 5 · Reconnect is offered only where it can happen.
     *
     * Shopify authenticates with OAuth2, so repairing it means re-authorising
     * at the provider — and that callback returns to whichever app
     * FRONTEND_URL names, which is not this one. Same blocker as screen 13,
     * same answer: say so, offer nothing.
     */
    test('5 · no button that would start something it cannot finish', async ({ page }) => {
      await openSystems(page, 'en');

      const action = page.getByTestId('banner-action-shopify');
      await expect(action).toHaveText(/isn't available from here/i);
      // It must NAME the system it is talking about, not a placeholder.
      await expect(action).toHaveText(/Reconnecting Shopify/);
      await expect(page.getByTestId('banner-shopify').getByRole('button')).toHaveCount(0);

      await shoot(page, `${size.name}-5-no-dead-action`);
    });

    /* 6 · Hebrew, selected by test id. */
    test('6 · Hebrew, right to left', async ({ page }) => {
      await openSystems(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('banner-shopify')).toBeVisible();
      await expect(page.getByTestId('system-status-shopify')).not.toHaveText(/Working|Not working/);

      await shoot(page, `${size.name}-6-hebrew`);
    });

    /* 7 · the shell rule, carried to every Settings screen. */
    test('7 · content starts above the fold', async ({ page }) => {
      await openSystems(page, 'en');

      const box = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect(box, 'the page heading has no box — is it rendered?').not.toBeNull();
      expect(
        box!.y,
        `the heading starts ${Math.round(box!.y)}px down a ${size.height}px viewport`,
      ).toBeLessThan(size.height / 2);

      await shoot(page, `${size.name}-7-above-the-fold`);
    });
  });
}
