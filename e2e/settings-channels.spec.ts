import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Screen 13 · Settings · Channels — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 * Captured EARLY: the list only, before any connect flow exists.
 *
 * ── RUNNING IT ──
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/settings-channels.spec.ts
 *
 * Shots land in e2e/evidence/s13/.
 *
 * ── NOTHING HERE PRESSES DISCONNECT ──
 * `POST /api/channels/:id/disconnect` is not a local toggle. It revokes at the
 * PLATFORM first — deletes Meta `subscribed_apps`, stops Gmail push, deletes
 * the Microsoft Graph subscription, revokes the Slack token — and only then
 * marks the record DISCONNECTED. Reconnecting needs a real OAuth round trip
 * with real platform credentials, which no test can perform.
 *
 * So disconnect is the same class as emailing a person: exercisable once,
 * reversible never. `DELETE /:id` cascades and is worse. **This spec performs
 * NO writes at all**, and the channel it would be breaking is the demo
 * tenant's live WhatsApp number.
 *
 * ── WHAT THIS TENANT SHOWS ──
 * Two accounts: WhatsApp (CONNECTED, healthy) and Shopify live chat
 * (CONNECTED and carrying *"Shopify Chat app was uninstalled from the
 * store."*). That second row is the health check doing its job on real data,
 * and shot 2 exists for it.
 *
 * Volume looks back 30 days, not 7: nothing on this tenant is newer than
 * 2026-09-08. The row NAMES its window rather than printing "this week" over a
 * longer figure.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's13');

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

async function openChannels(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/settings/channels`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/settings/channels. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  await expect(
    page.getByTestId('channel-list'),
    'The screen rendered but `channel-list` is absent. Either the list failed to load ' +
      '(check the server log for `channels.list_failed`), or the SERVED BUILD predates this ' +
      'screen — run `npm run build` and restart `next start`.',
  ).toBeVisible({ timeout: 15_000 });

  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /* 1 · the list: what is connected, and what could be. */
    test('1 · the channel list', async ({ page }) => {
      await openChannels(page, 'en');

      await expect(page.locator('[data-kind="connected"]')).toHaveCount(2);
      // Something must be offered, or the screen cannot do its main job.
      expect(await page.locator('[data-kind="connectable"]').count()).toBeGreaterThan(0);

      await shoot(page, `${size.name}-1-list`);
    });

    /*
     * 2 · a channel that is CONNECTED and still complaining.
     *
     * The state a health check exists to surface, and this tenant has one
     * without anybody manufacturing it. Trusting `connectionStatus` alone
     * would render it healthy, so the row is marked from the error text too.
     */
    test('2 · connected and still broken is marked as a problem', async ({ page }) => {
      await openChannels(page, 'en');

      const troubled = page.locator('[data-troubled="yes"]');
      await expect(troubled).toHaveCount(1);
      await expect(troubled.locator('[data-testid^="channel-error-"]')).toHaveText(/uninstalled/i);

      // And it sorts above the healthy one: a broken channel is why someone
      // opened this screen.
      const first = page.locator('[data-kind="connected"]').first();
      await expect(first).toHaveAttribute('data-troubled', 'yes');

      await shoot(page, `${size.name}-2-troubled`);
    });

    /*
     * 3 · the volume number names its own window.
     *
     * The design says "this week". A literal trailing week is empty on this
     * tenant — nothing is newer than 2026-09-08 — and a health check whose
     * every number is zero proves nothing. So the window is wider AND stated.
     * Printing "this week" over a 30-day figure would make one number mean two
     * things, which is the Home channel-bar mistake.
     */
    test('3 · the window is stated, not implied', async ({ page }) => {
      await openChannels(page, 'en');

      const detail = page.locator('[data-testid^="channel-detail-"]').first();
      await expect(detail).toHaveText(/last 30 days/i);
      await expect(detail).not.toHaveText(/this week/i);

      await shoot(page, `${size.name}-3-volume-window`);
    });

    /*
     * 4 · controls the backend cannot honour are absent.
     *
     * Two, both ruled out because nothing behind them stores a value: a
     * per-channel owner ("Customer Support AI" / "Support team") and a
     * per-channel greeting or hours. What IS shown is `responseMode`, which is
     * a real routing decision.
     *
     * This test used to assert that "Phone calls" was absent too, and that was
     * WRONG — voice is connectable at `POST /api/voice-channels`, on a separate
     * spine (`CommunicationChannel` → `VoiceChannel`) that a list driven by
     * `ChannelAccount` cannot see. The assertion froze a mistaken conclusion
     * into a test, where it would have survived anyone rechecking it. The
     * claim worth testing is "no control that reaches nothing", which is a
     * different claim from "no voice row".
     */
    test('4 · no owner picker and no per-channel hours', async ({ page }) => {
      await openChannels(page, 'en');

      const list = page.getByTestId('channel-list');
      await expect(list).not.toHaveText(/greeting|opening hours/i);

      // The mode IS rendered, and it is the honest version of "who answers".
      await expect(page.locator('[data-testid^="channel-mode-"]').first()).toHaveText(
        /person answers|AI answers/i,
      );

      await shoot(page, `${size.name}-4-absent-controls`);
    });

    /* 5 · Hebrew, selected by test id — there is no English copy to click. */
    test('5 · Hebrew, right to left', async ({ page }) => {
      await openChannels(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('[data-kind="connected"]')).toHaveCount(2);
      await expect(page.locator('[data-testid^="channel-status-"]').first()).not.toHaveText(
        /Connected|Disconnected/,
      );

      await shoot(page, `${size.name}-5-hebrew`);
    });

    /* 6 · the shell rule, carried to every Settings screen. */
    test('6 · content starts above the fold', async ({ page }) => {
      await openChannels(page, 'en');

      const box = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect(box, 'the page heading has no box — is it rendered?').not.toBeNull();
      expect(
        box!.y,
        `the heading starts ${Math.round(box!.y)}px down a ${size.height}px viewport`,
      ).toBeLessThan(size.height / 2);

      await shoot(page, `${size.name}-6-above-the-fold`);
    });
  });
}
