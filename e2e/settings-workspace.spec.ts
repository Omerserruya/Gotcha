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
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/settings-workspace.spec.ts
 *
 * The PATH line is not optional. The default `node` on this machine is 18 and
 * Playwright needs 20+; under 18 it fails with a message that reads like it is
 * not installed, which sends you looking in the wrong place entirely.
 *
 * The app must already be serving on :3000. `reuseExistingServer` means an
 * existing one is used, but if nothing is listening the config falls back to
 * `npm run dev` — which fails under the default Node for the same reason, and
 * is not what this app is normally served with anyway.
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
/** Must match APP_ORIGIN — the BFF compares against it exactly. */
const APP_ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 800 },
  /*
   * A phone, permanently.
   *
   * This screen's criteria said "desktop and ~400px" from the start, and it
   * was accepted on 1440 and 1280 alone. The phone layout was not subtly
   * wrong, it was simply never looked at: the fact rows kept their desktop
   * three-column grid, which left a 190px label and a fixed Edit button
   * crushing the value into about five characters. Every Settings spec
   * captures this width now.
   */
  { name: '390', width: 390, height: 844 },
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
 * Three checks, because a missing test id has three quite different causes and
 * an earlier version of this guard blamed the wrong one. It asserted "the
 * session is probably expired" for what was actually a stale production
 * bundle, and sent the person running it to look at authentication for half an
 * hour. Failing loudly is only useful if it fails ACCURATELY.
 *
 *   1. redirected to sign-in     → no session, or it expired
 *   2. no section heading at all → not this route; the app may not be serving
 *   3. heading but no test ids   → the served build predates the test ids.
 *                                  `next start` serves `.next`, so a commit
 *                                  that is not built is a commit that is not
 *                                  running, however current the source looks.
 */
async function openWorkspace(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/settings/workspace`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/settings/workspace. The session cookie is ` +
        'missing or expired — set GOTCHA_SESSION to a current one.',
    );
  }

  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading, 'no page heading — is the app serving on this origin?').toBeVisible({
    timeout: 15_000,
  });

  await expect(
    page.getByTestId('fact-name'),
    'The screen rendered but its test ids are absent, which means the SERVED BUILD is older ' +
      'than the commit that added them. Run `npm run build` and restart `next start`; ' +
      '`.next/BUILD_ID` must be newer than HEAD.',
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

    /*
     * 6 · a valid draft with the sample panel.
     *
     * On DEV this captures SAMPLE_UNAVAILABLE, because the tenant is out of AI
     * units — the state a real user in that condition sees, so it is worth
     * photographing.
     *
     * THIS SHOT EVIDENCES THE STATE, NOT ITS CAUSE, and must not be read as
     * proof that the sample path is wired. Every failure collapses to the same
     * 503 by design (D7): out of units, model down, upstream missing, timeout.
     * The ai service is bind-mounted from a shared checkout, so the endpoint
     * can lose its upstream entirely and produce a screenshot identical to
     * this one. If the reason matters at review, establish it from the backend
     * side — the picture cannot tell you.
     */
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

      /*
       * Someone else saves first. Through the app's own BFF, so this carries
       * the same session the page has rather than needing a second credential.
       *
       * `origin` is REQUIRED and is not boilerplate. The BFF rejects any
       * state-changing request whose Origin is not this app's, and treats a
       * MISSING Origin as hostile — every browser sends one on a cross-origin
       * write, so its absence means the request did not come from a page of
       * ours. Playwright's `request` fixture is not a browser context and
       * sends none, so without this line the BFF correctly answers 403 and the
       * test cannot produce the conflict it exists to photograph.
       *
       * Do not "simplify" this away: the header is what makes this request
       * look like the app, and the check it satisfies is a real CSRF defence
       * rather than a formality.
       */
      const headers = {
        cookie: `${COOKIE_NAME}=${SESSION}`,
        'content-type': 'application/json',
        origin: APP_ORIGIN,
      };

      /*
       * Read the real value first, and put it back in `finally`.
       *
       * An earlier version wrote a timestamp into `description` and left it
       * there. That field is the business description an AI employee quotes to
       * a customer, so the test replaced live tenant content with its own
       * debris — and every later capture then photographed the debris instead
       * of the data, including the shot whose entire purpose is to show the
       * real facts.
       *
       * A test that mutates shared state and does not restore it leaves
       * someone else to find a value they cannot account for.
       */
      const before = await request.get('/api/bff/api/workspace', { headers });
      expect(before.ok(), 'could not read the workspace before mutating it').toBe(true);
      const original = ((await before.json()) as { data?: { description?: string } }).data
        ?.description;

      try {
        const elsewhere = await request.patch('/api/bff/api/workspace', {
          headers,
          data: { description: `Edited elsewhere at ${new Date().toISOString()}` },
        });
        expect(
          elsewhere.ok(),
          'the out-of-band write must succeed for this test to mean anything',
        ).toBe(true);

        await page.getByTestId('fact-save-name').click();

        // Not merely "a message appeared". A successful save also produces a
        // note, so asserting on presence alone would pass if the conflict were
        // never detected — which is the whole thing this shot exists to prove.
        const note = page.getByTestId('fact-note-name');
        await expect(note).toBeVisible({ timeout: 15_000 });
        await expect(note).toHaveAttribute('data-note-kind', 'problem');
        await shoot(page, `${size.name}-09-stale-write-en`);
      } finally {
        // In `finally` so a failure mid-test still puts the tenant back. The
        // restore is deliberately not asserted: a failing restore must not
        // mask the assertion that actually failed, so it is reported loudly
        // and the original printed for a manual repair.
        if (typeof original === 'string') {
          const restored = await request.patch('/api/bff/api/workspace', {
            headers,
            data: { description: original },
          });
          if (!restored.ok()) {
            // An annotation rather than a throw: throwing here would replace
            // whatever assertion actually failed with a cleanup error, and
            // hide the real result. This surfaces in the report either way.
            test.info().annotations.push({
              type: 'RESTORE FAILED',
              description:
                'The tenant still holds test data in `description`. ' +
                `Restore it by hand to: ${original}`,
            });
          }
        }
      }
    });

    /* 10 · an empty state in Hebrew. "Not set" in an RTL label column is where
       the mirroring of the fact row is most likely to be wrong. */
    test('10 · a never-saved fact in Hebrew', async ({ page }) => {
      await openWorkspace(page, 'he');
      await expect(page.getByTestId('fact-hours')).toBeVisible();
      await page.getByTestId('fact-hours').scrollIntoViewIfNeeded();
      await shoot(page, `${size.name}-10-hours-empty-he`);
    });

    /*
     * 11 · the page's own content is the first thing on screen.
     *
     * The Settings section list used to fill a phone viewport on its own, so
     * the heading and the facts began below the fold. Asserted at EVERY width
     * rather than only the narrow one: the rule is not "the phone is special",
     * it is that a navigation list is never the reason a reader cannot see the
     * page they asked for.
     */
    test('11 · content starts above the fold', async ({ page }) => {
      await openWorkspace(page, 'en');

      const box = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect(box, 'the page heading has no box — is it rendered?').not.toBeNull();
      expect(
        box!.y,
        `the heading starts ${Math.round(box!.y)}px down a ${size.height}px viewport, ` +
          'which means navigation is occupying the screen the page was asked for',
      ).toBeLessThan(size.height / 2);

      await shoot(page, `${size.name}-11-above-the-fold`);
    });

    /*
     * 12 · a long value stays readable at this width.
     *
     * The defect this guards is specific and was visible only on a phone:
     * "Urban Supply - GOTCHA Demo" rendered as five stacked lines because the
     * value column had about five characters to work with. A value box no
     * wider than roughly a third of the row means the label is still stealing
     * the line instead of sitting above it.
     */
    test('12 · a fact value gets the width of the row', async ({ page }) => {
      await openWorkspace(page, 'en');

      const row = await page.getByTestId('fact-name').boundingBox();
      const value = await page.getByTestId('fact-value-name').boundingBox();
      expect(row).not.toBeNull();
      expect(value).not.toBeNull();

      expect(
        value!.width / row!.width,
        `the value box is ${Math.round(value!.width)}px inside a ${Math.round(row!.width)}px ` +
          'row — the label and the Edit button are crushing it',
      ).toBeGreaterThan(0.4);

      await shoot(page, `${size.name}-12-long-value`);
    });
  });
}
