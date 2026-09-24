import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

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
 *   3. heading but no test ids   → see `missingIds`, which orders FOUR causes
 *                                  rather than naming one. This used to say
 *                                  "stale build", and that sent a reader to
 *                                  check a build that was current while the
 *                                  real cause was a 429 from running the
 *                                  whole suite at once.
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

  await expect(page.getByTestId('fact-name'), missingIds('`fact-name`')).toBeVisible({
    timeout: 15_000,
  });

  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /*
     * 1 · the facts, read-only, in the DESIGN's list.
     *
     * Seven rows, not six: `Website` was missing entirely, and `Language`
     * and `Currency & time zone` are the old `Currency & language` plus
     * `Time zone` recombined the other way. That is structural — 11d is a
     * dedicated Edit language panel, and a row sharing a label with Currency
     * has nothing to open it from.
     *
     * Includes a never-saved `hours` as "Not set".
     */
    test('1 · facts, read-only', async ({ page }) => {
      await openWorkspace(page, 'en');
      for (const key of [
        'name',
        'website',
        'description',
        'address',
        'hours',
        'language',
        'currencyTimezone',
      ]) {
        await expect(page.getByTestId(`fact-${key}`)).toBeVisible();
      }

      // The header the inline badges depend on. Without it, "From website"
      // on a row has no reason to mean anything to a reader.
      await expect(page.getByTestId('facts-intro')).toHaveText(/only updates fields marked/i);

      // And the website row states the domain WITHOUT a page count: `reach`
      // is on the scan response only, and `pagesRead` would be 17 against a
      // `distinctTextPages` of 1 on this tenant.
      await expect(page.getByTestId('fact-value-website')).not.toHaveText(/pages read/i);

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

      /*
       * 11c · what the design draws here and the storage cannot hold.
       *
       * `dayScheduleSchema` is `{ enabled, open?, close? }` — one range, one
       * week, no dates. So "+ Split" on every row and the whole holiday
       * calendar are named rather than omitted: a missing control is
       * indistinguishable from one somebody failed to find.
       */
      await expect(page.getByTestId('hours-one-range')).toHaveText(/split shift/i);
      await expect(page.getByTestId('hours-no-holidays')).toHaveText(/no holiday calendar/i);

      // And the outside-hours pair, which the design sends to Studio and
      // which `ai-bot.service.ts` actually reads from THIS setting.
      await expect(page.getByTestId('hours-ai-outside')).toBeVisible();

      await shoot(page, `${size.name}-03-edit-hours-en`);
    });

    /*
     * 4 · the language row OPEN — the state 11d's evidence never photographed.
     *
     * `workspace.language` was the string "Language" until 11d added
     * `language.system` and `language.replies`, which turned the key into an
     * object. The label rendered an `IntlError` from then on, visible ONLY
     * while this row is open — and a 96/96 capture passed over it, because no
     * shot opened a control.
     *
     * ★ AND THE FIRST VERSION OF THIS GUARD COULD NOT FIRE.
     *
     * It asserted the ABSENCE of a dotted path and of next-intl's error text.
     * Neither is producible here. `src/i18n/request.ts:51`:
     *
     *     getMessageFallback: NODE_ENV === 'production' ? '' : `⟪ns.key⟫`
     *
     * The capture runs `next start` — the production build — so a missing key
     * renders as the EMPTY STRING. An empty label contains no dotted path and
     * no error text, so both assertions passed by absence. Reintroduce 11d's
     * defect today and that test went green.
     *
     * You cannot detect an empty string by asserting the absence of
     * something. So this asserts POSITIVELY: the field must have its
     * accessible name, and the hint must say what it says. A positive
     * assertion fails on the empty fallback, on the dev-mode guillemets, and
     * on error text, without having to enumerate which the environment
     * produces — and enumerating from dev behaviour is exactly how the first
     * version went wrong.
     */
    test('4 · language', async ({ page }) => {
      await openWorkspace(page, 'en');
      await page.getByTestId('fact-edit-language').click();
      await expect(page.getByTestId('fact-save-language')).toBeVisible();

      /*
       * The accessible name. An empty label leaves the input without one, so
       * this query fails outright rather than matching nothing.
       */
      await expect(page.getByLabel('Language', { exact: true })).toBeVisible();

      // And the hint, which is long and specific enough that only the real
      // message satisfies it.
      const row = page.getByTestId('fact-language');
      await expect(row).toHaveText(/One language is stored/i);
      await expect(row).toHaveText(/knowledge documents are tagged/i);

      // Second line, free: catches the dev-mode fallback if this is ever run
      // against a dev server. NOT the thing standing guard.
      await expect(row).not.toHaveText(/⟪|⟫/);

      await shoot(page, `${size.name}-04-edit-language-en`);
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
       * The out-of-band write puts the value back UNCHANGED.
       *
       * This test needs `updatedAt` to move; it does not need the content to
       * differ. `BusinessProfile.updatedAt` is `@updatedAt`, so Prisma stamps
       * it on every `update()` whether or not any column actually changed, and
       * the route has no "nothing changed" short-circuit. Writing the
       * description back over itself therefore produces a genuinely newer ETag
       * and a real 409, with the tenant's data untouched.
       *
       * ── WHY NOT READ-THEN-RESTORE ──
       * Two earlier versions of this test corrupted the tenant.
       *
       * The first wrote a timestamp into `description` and left it there, so
       * every later capture photographed the debris instead of the data.
       *
       * The second read the original and restored it in `finally`, which is
       * correct in isolation and WRONG under `fullyParallel`. Six instances of
       * this shot run at once — three viewports × two locales — so a sibling
       * could write its garbage between this worker's read and its restore.
       * "The original" was then captured from an already-mutated database and
       * faithfully restored as garbage; last writer won. Adding a third
       * viewport did not create that race, it just made the interleaving
       * likely rather than merely possible.
       *
       * Writing the value back over itself removes the class rather than
       * sequencing around it: every worker reads the same true value and
       * writes that same value, so ANY interleaving leaves the field correct.
       * There is nothing to restore, so there is no `finally` to race.
       *
       * ── IT WENT TO `timezone` FOR AN HOUR, AND CAME BACK ──
       * All of the above stayed true and briefly stopped being enough.
       *
       * Backend's `cae1d369` added `stampProvenance` to `PATCH /workspace`.
       * This test had been calling that route all along; the endpoint grew a
       * side effect underneath it. A write that changed no value began
       * recording that a HUMAN had edited the description — on the live
       * tenant, every capture run, in the exact store screen 11b reads.
       *
       * **A write that is value-neutral is not therefore state-neutral**, and
       * the difference is invisible until somebody adds a side effect to the
       * endpoint. Nothing here was wrong and nothing there was wrong; they
       * were only wrong together, across two repositories.
       *
       * The first fix moved the write to `timezone`, which avoids the stamp
       * because a timezone-only patch leaves `profilePatch` empty. It worked
       * and it was the wrong trade: it depended on TWO properties of the
       * route — that an empty patch skips the profile update, and that the
       * hours write still advances `updatedAt` — while this version depends
       * on none. The guard below caught it half-applied within the hour.
       *
       * ── AND IT WAS NEVER REALLY THIS TEST'S BUG ──
       * `3f986b6e` gates the stamp on the value actually differing, and
       * leaves the write unconditional so this capture keeps working. The
       * reason is not about tests at all: **a person who opens the settings
       * screen and presses Save without editing anything was marking every
       * field as theirs**, after which a rescan would only ever OFFER those
       * fields instead of refreshing them.
       *
       * "A human set this value" is not the same claim as "a human submitted
       * a form containing this field." The capture was reproducing a real
       * product bug on every run, and reading it as test pollution nearly
       * cost the diagnosis.
       */
      const before = await request.get('/api/bff/api/workspace', { headers });
      expect(before.ok(), 'could not read the workspace before the conflicting write').toBe(true);
      const current = ((await before.json()) as { data?: { description?: string } }).data
        ?.description;

      /*
       * Guard the premise rather than assume it. If the description were
       * absent, sending `undefined` would build an empty patch, the route
       * would skip the update entirely, `updatedAt` would not move and the
       * save below would SUCCEED — and this shot would quietly photograph a
       * successful save while claiming to prove a conflict.
       */
      expect(
        typeof current,
        'the workspace has no description to write back, so this test cannot move the ETag',
      ).toBe('string');

      const elsewhere = await request.patch('/api/bff/api/workspace', {
        headers,
        data: { description: current },
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

      /*
       * The tenant's content is unchanged — asserted, not assumed.
       *
       * This is the check that would have caught both earlier versions of this
       * test on their first run, instead of leaving the damage for someone to
       * find in a screenshot afterwards.
       */
      const after = await request.get('/api/bff/api/workspace', { headers });
      expect(after.ok()).toBe(true);
      expect(
        ((await after.json()) as { data?: { description?: string } }).data?.description,
        'this test changed the tenant description — it must never do that',
      ).toBe(current);
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

      /*
       * No ICU placeholder may survive into rendered copy.
       *
       * Screen 14 shipped a banner reading "Reconnecting {system} means…" and
       * every assertion passed, because they all forbade wordings rather than
       * requiring one. This is the cheap general guard for that whole class.
       */
      await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);

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

    /*
     * ★★ Screen 11b · the badges are all blank, and the panel says why.
     *
     * `tenant_settings WHERE key='profileFieldProvenance'` → ZERO ROWS,
     * whole database. So every field on every tenant is unmarked, a rescan
     * currently applies nothing and offers everything, and every badge on
     * this panel says "Source not recorded".
     *
     * A panel of identical blank badges with no explanation reads as a broken
     * feature. Asserted POSITIVELY: the explanation must be present and must
     * carry BOTH halves — why the next scan asks about everything, and that
     * it stops asking about what it writes itself. The second half is what
     * makes it a description of a system that improves rather than an apology.
     *
     * Only TWO capture tests were added here on purpose. The rate limit is
     * 1,000 requests per fifteen minutes per service, shared across every
     * spec run in that window, and the attributed branch is unreachable on
     * any tenant anyway — it lives in FieldProvenance.test.tsx.
     */
    test('13 · the panel explains whichever state it is in', async ({ page }) => {
      await openWorkspace(page, 'en');

      const panel = page.getByTestId('provenance');
      await expect(panel).toBeVisible();

      /*
       * ── WHY THIS NO LONGER ASSERTS THE TENANT IS EMPTY ──
       * It used to assert `data-attributed="false"`, which is a claim about
       * the TENANT rather than about the panel. That made it depend on global
       * state anything could change — and something did: test 2's conflict
       * write began stamping provenance when Backend added `stampProvenance`
       * to `PATCH /workspace`. A test earlier in the same file was setting up
       * the state this one asserted against.
       *
       * Ordering would have hidden it rather than fixed it. The panel's job
       * is to explain whichever state it is in, so that is what is asserted:
       * two outcomes, both correct, and the wrong one — a panel that shows
       * badges with no account of them — is rejected either way.
       */
      const attributed = await panel.getAttribute('data-attributed');

      if (attributed === 'false') {
        const notice = page.getByTestId('provenance-none');
        await expect(notice).toBeVisible();
        await expect(notice).toHaveText(/nothing is marked yet/i);
        await expect(notice).toHaveText(/ask you about every change/i);
        // The self-healing half. Without it this is an apology.
        await expect(notice).toHaveText(/it will ask again next time/i);
        // And no badge may claim the website wrote anything.
        await expect(panel).not.toHaveText(/from your website/i);
      } else {
        await expect(page.getByTestId('provenance-some')).toHaveText(
          /refreshes the fields marked/i,
        );
        // Something is marked, so at least one badge must say which.
        await expect(panel).toHaveText(/from your website|you entered this/i);
      }

      // Either way, every field says where it stands. A row with a value and
      // no origin is the state this panel exists to prevent.
      const rows = page.getByTestId('provenance-row');
      const origins = page.getByTestId('provenance-origin');
      expect(await origins.count()).toBe(await rows.count());

      await shoot(page, `${size.name}-13-provenance`);
    });

    /*
     * ★ 11d · three language settings, told apart.
     *
     * `GET /api/analytics/language-share` groups `Conversation.detectedLocale`
     * over the same billable population the allowance bar counts. On this
     * tenant: he 76, en 12, and one conversation whose language was never
     * worked out.
     *
     * The reply rule comes FIRST. A merchant who reads "12 conversations in
     * English" before it spends the next paragraph worrying about a setting
     * that does not decide anything.
     */
    test('15 · languages, with the reassurance before the numbers', async ({ page }) => {
      await openWorkspace(page, 'en');

      const panel = page.getByTestId('languages');
      await expect(panel).toBeVisible();

      await expect(page.getByTestId('languages-replies')).toHaveText(
        /in the language they wrote in/i,
      );

      // The mix, or an honest account of why there is none. Both are correct
      // outcomes; silence is not.
      const mix = page.getByTestId('languages-mix');
      const none = page.getByTestId('languages-none');
      const unavailable = page.getByTestId('languages-unavailable');
      await expect(mix.or(none).or(unavailable).first()).toBeVisible();

      // What GOTCHA writes in is a different setting from what this person
      // reads, and both are stated.
      await expect(page.getByTestId('languages-system')).toBeVisible();
      await expect(page.getByTestId('languages-mine')).toBeVisible();

      // And the setting that does not exist is named rather than omitted.
      await expect(page.getByTestId('languages-not-storable')).toHaveText(/not a setting yet/i);

      await shoot(page, `${size.name}-15-languages`);
    });

    /*
     * ★ 11b · the scan panel, NOT FIRED.
     *
     * The button is present and this test does not press it. `runWorkspaceScan`
     * re-crawls a live website; a capture is not a strange user, and pressing
     * it here would cost a real fetch on every viewport of every run.
     *
     * So this photographs the resting state and asserts the sentence that has
     * to be read BEFORE the click — that suggestions come back rather than
     * changes going in. The result states are in ScanPanel.test.tsx.
     *
     * Also unreached anywhere: a REAL scan producing a REAL proposal. The
     * rescan dies at the model call on exhausted AI units, so Backend
     * verified the accept endpoint against a seeded proposal row. Storage and
     * endpoint are real; the scan that would produce the proposal is
     * substituted. That is a gap in the evidence and it is named, not papered.
     */
    test('16 · the scan panel, unfired', async ({ page }) => {
      await openWorkspace(page, 'en');

      await expect(page.getByTestId('scan-run')).toBeVisible();

      const before = page.getByTestId('scan-before');
      await expect(before).toBeVisible();
      await expect(before).toHaveText(/come back as suggestions/i);
      await expect(before).toHaveText(/only fields the website already owns/i);

      // Nothing has run, so no result may be on screen.
      await expect(page.getByTestId('scan-result')).toHaveCount(0);
      await expect(page.getByTestId('scan-refusal')).toHaveCount(0);

      await shoot(page, `${size.name}-16-scan-unfired`);
    });

    test('14 · one reply language, and the screen says so', async ({ page }) => {
      await openWorkspace(page, 'en');

      const note = page.getByTestId('provenance-one-language');
      await expect(note).toBeVisible();
      await expect(note).toHaveText(/replies in each customer's own language/i);
      await expect(note).toHaveText(/this setting does not change it/i);

      await shoot(page, `${size.name}-14-one-language`);
    });
  });
}
