import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Screen 11 · Settings · Workspace — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR: this session has no
 * browser, and a capture one of us describes and the other performs is the one
 * place a screen gets accepted on a guess. The spec is the shared artefact.
 *
 * ── RUNNING IT ──
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/settings-workspace.spec.ts
 *
 * The cookie is the value of `gotcha_session` from a signed-in browser on
 * http://localhost:3000. Its name comes from SESSION_COOKIE_NAME.
 *
 * Shots land in e2e/evidence/s11/.
 *
 * ── WHY IT FAILS RATHER THAN CAPTURES ──
 * Every test asserts it is on the workspace screen before it photographs
 * anything. A spec that screenshots whatever it finds will happily produce
 * twenty pictures of a sign-in page, and a set of screenshots nobody examines
 * closely is how a screen gets accepted without ever being seen.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's11');

const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 800 },
] as const;

test.beforeAll(() => {
  if (!SESSION) {
    throw new Error(
      'GOTCHA_SESSION is not set. This spec captures an authenticated screen; ' +
        'without a session it would photograph the sign-in page instead. ' +
        'Copy the `gotcha_session` cookie from a signed-in browser and re-run.',
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
 * Opens the screen and refuses to continue unless it is really the screen.
 *
 * An expired cookie redirects to sign-in and everything downstream would
 * "pass" against the wrong page, so the assertion is on content that only
 * this screen has, not on the URL — the URL survives a redirect back.
 */
async function openWorkspace(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/settings/workspace`);
  await expect(
    page.getByTestId('fact-name'),
    'not on the workspace screen — the session is probably expired',
  ).toBeVisible({ timeout: 15_000 });
  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /* 1 · the six facts, read-only. Includes a never-saved `hours` as "Not set". */
    test('1 · facts, read-only', async ({ page }) => {
      await openWorkspace(page, 'en');
      for (const key of [
        'name',
        'description',
        'address',
        'hours',
        'currencyLanguage',
        'timezone',
      ]) {
        await expect(page.getByTestId(`fact-${key}`)).toBeVisible();
      }
      await shoot(page, `${size.name}-01-facts-en`);
    });

    /* 2 · one row open. The name row: the simplest shape, so the row's own
       editing chrome is what the shot shows rather than a form. */
    test('2 · a row open for editing', async ({ page }) => {
      await openWorkspace(page, 'en');
      await page.getByTestId('fact-edit-name').click();
      await expect(page.getByTestId('fact-save-name')).toBeVisible();
      await shoot(page, `${size.name}-02-edit-name-en`);
    });

    /* 3 · the seven-day form. The week is submitted whole, so the shot has to
       show all seven rows — a form that only rendered the open days would be
       the bug this screen was warned about. */
    test('3 · the hours form', async ({ page }) => {
      await openWorkspace(page, 'en');
      await page.getByTestId('fact-edit-hours').click();
      await expect(page.getByTestId('fact-save-hours')).toBeVisible();
      await shoot(page, `${size.name}-03-edit-hours-en`);
    });

    /* 4 · currency and language, with the note explaining why one language. */
    test('4 · currency and language', async ({ page }) => {
      await openWorkspace(page, 'en');
      await page.getByTestId('fact-edit-currencyLanguage').click();
      await expect(page.getByTestId('fact-save-currencyLanguage')).toBeVisible();
      await shoot(page, `${size.name}-04-edit-currency-language-en`);
    });

    /* 5 · below the minimum: counter in the alert tone, Save unavailable. The
       point of the shot is that the limit is caught here and not by a 422. */
    test('5 · voice below the minimum', async ({ page }) => {
      await openWorkspace(page, 'en');
      await page.getByTestId('voice-field').fill('too short');
      await expect(page.getByTestId('voice-save')).toBeDisabled();
      await shoot(page, `${size.name}-05-voice-too-short-en`);
    });

    /* 6 · a valid draft with the sample panel. On DEV this is
       SAMPLE_UNAVAILABLE, because the tenant is out of AI units — that is the
       state a real user in this condition sees, so it is the state to capture. */
    test('6 · voice with the sample panel', async ({ page }) => {
      await openWorkspace(page, 'en');
      await page
        .getByTestId('voice-field')
        .fill(
          "Open with היי and the customer's first name. Keep replies to two sentences " +
            'unless they asked for detail, and never promise a date the carrier has not given.',
        );
      await expect(page.getByTestId('voice-save')).toBeEnabled();
      // The sample is debounced at 700ms and then may sit up to 20s before its
      // 503. Waiting for the panel to stop saying "writing" is what makes the
      // shot show an outcome rather than a spinner.
      await page.waitForTimeout(3_000);
      await shoot(page, `${size.name}-06-voice-sample-en`);
    });

    /* 7 · the rules, and the field that adds one. */
    test('7 · prohibited claims', async ({ page }) => {
      await openWorkspace(page, 'en');
      await expect(page.getByTestId('claims-list')).toBeVisible();
      await expect(page.getByTestId('claims-add')).toBeVisible();
      await shoot(page, `${size.name}-07-claims-en`);
    });

    /* 8 · Hebrew. The fact-row label column and the counter both mirror, and
       both are where an RTL layout usually breaks first. */
    test('8 · Hebrew, facts and the counter', async ({ page }) => {
      await openWorkspace(page, 'he');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await shoot(page, `${size.name}-08a-facts-he`);
      await page.getByTestId('voice-field').fill('קצר מדי');
      await expect(page.getByTestId('voice-save')).toBeDisabled();
      await shoot(page, `${size.name}-08b-voice-too-short-he`);
    });

    /*
     * 9 · the stale write.
     *
     * Criterion 5, and the one a build most easily forgets, so it is proved by
     * producing a real 409 rather than by reasoning. The page is loaded, the
     * workspace is then moved underneath it by a second write, and the open
     * form submits with the `If-Match` it was rendered from.
     */
    test('9 · a stale write is answered in the row', async ({ page, request }) => {
      await openWorkspace(page, 'en');
      await page.getByTestId('fact-edit-name').click();

      // Someone else saves first. Through the app's own BFF, so this carries
      // the same session the page has rather than needing a second credential.
      const elsewhere = await request.patch('/api/bff/api/workspace', {
        headers: { cookie: `${COOKIE_NAME}=${SESSION}`, 'content-type': 'application/json' },
        data: { description: `Edited elsewhere at ${new Date().toISOString()}` },
      });
      expect(
        elsewhere.ok(),
        'the out-of-band write must succeed for this test to mean anything',
      ).toBe(true);

      await page.getByTestId('fact-save-name').click();
      await expect(page.getByTestId('fact-note-name')).toBeVisible({ timeout: 15_000 });
      await shoot(page, `${size.name}-09-stale-write-en`);
    });

    /* 10 · an empty state in Hebrew. "Not set" in an RTL label column is where
       the mirroring of the fact row is most likely to be wrong. */
    test('10 · a never-saved fact in Hebrew', async ({ page }) => {
      await openWorkspace(page, 'he');
      await expect(page.getByTestId('fact-hours')).toBeVisible();
      await page.getByTestId('fact-hours').scrollIntoViewIfNeeded();
      await shoot(page, `${size.name}-10-hours-empty-he`);
    });
  });
}
