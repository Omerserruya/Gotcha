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

      /*
       * ★ AND SCREEN 14d IS ABSENT HERE, FOR THE SAME REASON — ASSERTED AS A
       * PAIR SO IT CANNOT DRIFT.
       *
       * 14d draws each capability's current stance as a disabled three-state
       * control. It needs a stance to draw, and on a disconnected system
       * there is none: the route omits these 68 tools entirely, so every
       * `stance` is null and `CapabilityControls` renders nothing.
       *
       * The ruling that commissioned 14d assumed reading the current value
       * "works without a connection". For this platform it does not — the
       * same `status: CONNECTED` filter that stops the tools running is what
       * keeps them out of the policy response.
       *
       * So this is asserted as an implication rather than a bare absence: if
       * "we couldn't check" is on screen, the controls must NOT be. A bare
       * `toHaveCount(0)` would also pass on a page where the whole block was
       * deleted, or renamed, or never built — which is precisely the inert
       * guard this suite has been bitten by twice.
       */
      await expect(page.getByTestId('stance-unknown-shopify')).toBeVisible();
      await expect(
        page.getByTestId('tools-shopify'),
        'the 14d controls rendered for a system whose stances are all unknown — ' +
          'every radio would be showing a decision nobody made',
      ).toHaveCount(0);

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

    /*
     * ★ 14b/14c · the state the platform actually produces.
     *
     * Four of five parts have nothing to choose from and the fifth's only
     * candidate is CONNECTED-and-BROKEN. So this photographs a screen that
     * routes somebody to the marketplace, not one with five filled dropdowns
     * — and the two sentences that must differ.
     */
    test('business core · a broken connection is not an empty one', async ({ page }) => {
      await openSystems(page, 'en');

      const core = page.getByTestId('business-core');
      await expect(core).toBeVisible();

      /*
       * The ecommerce part. "Connect one" would send a merchant to redo work
       * they have already done — asserted by CONTENT, because the empty and
       * the broken states differ only in what they say.
       */
      const ecommerce = page.getByTestId('core-part-ecommerce');
      await expect(ecommerce).toHaveAttribute('data-state', 'connected_but_failing');
      await expect(ecommerce).toHaveText(/connected and not working/i);
      await expect(ecommerce).not.toHaveText(/nothing connected/i);

      // Shipping: nothing can ever serve it, and that is not the merchant's
      // doing. An empty dropdown here reads as an unfinished setup.
      const shipping = page.getByTestId('core-part-shipping');
      await expect(shipping).toHaveAttribute('data-state', 'impossible');
      await expect(shipping).toHaveText(/not something you are missing/i);

      await shoot(page, `${size.name}-core-parts`);
    });

    /*
     * ★ The two sentences that keep this screen honest.
     */
    test('business core · the CRM lives elsewhere, and the save is unproven', async ({ page }) => {
      await openSystems(page, 'en');

      // One place for the CRM decision, so this screen can never disagree
      // with the system the AI actually calls.
      await expect(page.getByTestId('core-part-crm-elsewhere')).toHaveText(
        /never disagree with the system the AI actually calls/i,
      );

      /*
       * ★ AND THE CAVEAT IS GONE, WHICH IS WHAT THE ASSERTION WAS FOR.
       *
       * This spec asserted, for about twenty minutes, that the screen said
       * electing "does not change how the AI behaves yet" — true while
       * `config.roles` was read only by the displacement logic inside its
       * own write. Backend landed the read at 2d1abf88 and the live bot path
       * consumes it, so the sentence became false and came out.
       *
       * The assertion is inverted rather than deleted. A caveat nobody is
       * obliged to revisit becomes a lie the day it stops being true, and
       * the guard against that is a test that fails while it is still on
       * screen.
       */
      const choosing = page.getByTestId('core-choosing');
      await expect(choosing).toBeVisible();
      await expect(choosing).not.toHaveText(/does not change how the AI behaves yet/i);
      await expect(choosing).not.toHaveText(/being built|once it is wired/i);

      /*
       * ★ AND THE CONTROL ITSELF IS ABSENT HERE — ASSERTED AS AN IMPLICATION.
       *
       * `electable()` needs a CONNECTED candidate. Shopify is the only
       * integration on this deployment and it is in ERROR, so no part has
       * one and the dropdown renders for nobody. Its success path, its
       * displacement sentence and all three of its failures live in
       * ElectPart.test.tsx, where they can be constructed.
       *
       * Paired with the sentence that explains it rather than asserted bare:
       * a lone toHaveCount(0) also passes on a page where the control was
       * deleted or renamed, which is the inert guard this suite keeps
       * rediscovering.
       *
       * ── AND NOTHING HERE CLICKS SAVE ──
       * `PUT /business-core/role` writes config.roles on a live tenant and
       * DISPLACES whatever held the part. There is no `.click()` in this
       * spec on anything that writes.
       */
      await expect(page.getByTestId('core-part-failing')).toBeVisible();
      await expect(
        page.getByTestId('core-elect-ecommerce'),
        'the election dropdown rendered for a part whose only candidate is broken — ' +
          'the write refuses a system that is not CONNECTED, so every save would fail',
      ).toHaveCount(0);

      await shoot(page, `${size.name}-core-honesty`);
    });

    /*
     * ══════════════════════════════════════════════════════════════════════
     * 14e · ABSENT IS NOT UNSET
     * ══════════════════════════════════════════════════════════════════════
     * The design draws a panel of write-back settings. There are none, and
     * the whole screen turns on one distinction: a thing not offered as a
     * setting is not a blank somebody forgot to fill in — it means the
     * connected system decides and GOTCHA follows it.
     *
     * A merchant who reads the absence as an omission goes looking for the
     * screen that turns it on. There is no such screen, because there is no
     * such choice, so the paragraph has to do the work a disabled control
     * would only pretend to do. A greyed-out toggle still promises that
     * somewhere, for somebody, it is not greyed out.
     *
     * Unlike 14d, this renders on this tenant: it is a statement about the
     * product and needs no connection.
     */
    test('core · what is written back, and why an absence is not a gap', async ({ page }) => {
      await openSystems(page, 'en');

      const block = page.getByTestId('core-writeback');
      await expect(block, missingIds('the 14e write-back paragraph')).toBeVisible();

      // The load-bearing sentence, by its content.
      const source = page.getByTestId('core-writeback-source');
      await expect(source).toHaveText(/not a blank/i);
      await expect(source).toHaveText(/the system itself decides/i);

      /*
       * ★ NEVER THE VOCABULARY OF AN UNFINISHED SETUP.
       *
       * Each of these is a decision the product has already made. "Not
       * configured", "coming soon" or "set this up" would turn every one of
       * them into a promise, which is the exact failure the paragraph exists
       * to prevent — asserted here as well as in the unit test because a
       * sentence can arrive from a catalogue the unit test does not read.
       */
      await expect(block).not.toHaveText(/not configured|unconfigured/i);
      await expect(block).not.toHaveText(/coming soon|not yet available/i);
      await expect(block).not.toHaveText(/set (this|it) up/i);

      // The three that are fixed, each named with where it is fixed.
      await expect(page.getByTestId('core-writeback-per-rule')).toHaveText(/no per-rule choice/i);
      await expect(page.getByTestId('core-writeback-one-board')).toHaveText(/single Monday board/i);
      await expect(page.getByTestId('core-writeback-identity')).toHaveText(
        /fixed in the product's code/i,
      );

      /*
       * The language claim, in BOTH halves. `post-chat-pipeline.service.ts`
       * resolves the tenant default with no userId, so the AI-written summary
       * really is in the workspace language; `crm-adapter-resolver.ts` has no
       * locale reference at all, so field values cross untranslated.
       *
       * Asserting only the first half would pass on the design's original
       * sentence — "everything written back is in the workspace language" —
       * which is false for the half a merchant cares most about.
       */
      const language = page.getByTestId('core-writeback-language');
      await expect(language).toHaveText(/workspace language/i);
      await expect(language).toHaveText(/customer's own data/i);
      await expect(language).toHaveText(/exactly as they are/i);

      await shoot(page, `${size.name}-core-writeback`);
    });
  });
}
