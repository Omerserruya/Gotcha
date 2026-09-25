import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

/**
 * Screen 05d · Outreach · calls — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/calls.spec.ts
 *
 * **Run this spec alone.** The whole suite in parallel trips the BFF's rate
 * limiter, and a 429 renders as "the ids are missing" — which is why
 * `missingIds` lists the causes in the order worth checking rather than
 * naming one.
 *
 * Shots land in e2e/evidence/s05d/.
 *
 * ── WHAT THIS TENANT SHOWS, AND WHY THIS SPEC NOW ASKS ──
 * `voice_copilot_enabled` was **false** on every tenant when this spec was
 * written, so every test below asserted the not-enabled panel. On
 * 2026-09-25 it was switched on and **the whole premise silently became
 * false** — which is the defect this run exists to photograph the repair of.
 *
 * So the premise is no longer written down. This spec **reads the flag from
 * `/api/tenant-settings` first** and asserts the screen that flag entails.
 * A spec that hardcodes the state of the world is correct until the world
 * moves, and it cannot tell you when it stops being correct.
 *
 * **The shot that matters is still the same distinction**, now from the
 * other side: a 404 from the gate and a 404 from a missing route are
 * identical on the wire, and the screen resolves it by asking a different
 * question rather than reading the 404 more carefully.
 *
 * ── THREE SCREENS ARE FAULTS AND MUST NEVER BE PHOTOGRAPHED ──
 *   `calls-availability-unknown`  the settings read failed — we cannot say
 *   `calls-unavailable`           voice IS on and the calls read failed
 *   the panel that contradicts the flag we just read
 *
 * ── 05e's LIVE CALL STAYS UNREACHED ──
 * A call in progress cannot be produced: no `TWILIO_*` credentials exist and
 * nothing here may dial. `hasActiveVoiceChannel` is read and reported so the
 * run says WHY rather than leaving it to be assumed, and the live branch is
 * unit-tested and named as unreached rather than quietly missing.
 *
 * ── NOTHING IS WRITTEN ──
 * No `.click()` dials, answers or ends anything.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's05d');

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

/**
 * The flag the whole screen hangs on, read from the same place the screen
 * reads it — before anything is asserted about what should be on it.
 *
 * ⚠ This SPENDS a cookie rotation: `gotcha_session` rotates on every BFF
 * request. Inside the browser context the jar handles it. Read once per
 * test rather than per assertion.
 */
async function readVoiceFlags(page: Page) {
  const res = await page.request.get('/api/bff/api/tenant-settings');
  expect(res.status(), 'tenant-settings did not answer 200 — the flag is unreadable').toBe(200);
  const body = (await res.json()) as {
    data?: { voiceCopilotEnabled?: unknown; hasActiveVoiceChannel?: unknown };
  };
  const d = body.data ?? {};
  /*
   * ★ ASSERTED AS BOOLEANS, NOT COERCED.
   *
   * Our contract made both required for exactly this reason: absent, they
   * would have defaulted to `false` and read as "no voice" — a claim about
   * the workspace manufactured from a missing key. The spec must not do
   * quietly what the contract was changed to refuse.
   */
  expect(typeof d.voiceCopilotEnabled, 'voiceCopilotEnabled absent from tenant-settings').toBe(
    'boolean',
  );
  expect(typeof d.hasActiveVoiceChannel, 'hasActiveVoiceChannel absent from tenant-settings').toBe(
    'boolean',
  );
  return {
    voiceOn: d.voiceCopilotEnabled as boolean,
    hasNumber: d.hasActiveVoiceChannel as boolean,
  };
}

async function openCalls(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/outreach/calls`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/outreach/calls. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  const states = [
    'calls-not-enabled',
    'call-log',
    'calls-empty',
    'calls-no-number',
    'calls-unavailable',
    'calls-availability-unknown',
  ];
  await expect
    .poll(
      async () => {
        const counts = await Promise.all(states.map((id) => page.getByTestId(id).count()));
        return counts.reduce((a, b) => a + b, 0);
      },
      { message: missingIds(`none of ${states.join(', ')}`), timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  /*
   * TWO STATES ARE FAULTS, AND NEITHER IS EVIDENCE OF ANYTHING.
   *
   * `calls-unavailable` means voice is on and the read failed.
   * `calls-availability-unknown` means we could not even ask — the state
   * this screen grew in order to stop claiming "no voice" from a failed
   * request. Photographing either would file a broken stack as a design.
   */
  await expect(
    page.getByTestId('calls-unavailable'),
    'voice is on and the calls could not be read — this run would photograph a fault',
  ).toHaveCount(0);
  await expect(
    page.getByTestId('calls-availability-unknown'),
    'tenant-settings did not answer, so the screen cannot say whether voice is on',
  ).toHaveCount(0);

  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /*
     * 1 · THE SCREEN THE FLAG ENTAILS — WHICHEVER WAY THE FLAG IS SET.
     *
     * This test used to hardcode "voice is off". It passed for weeks and
     * then the flag was switched on, at which point it was asserting a
     * state of the world that had moved. It now reads the flag and holds
     * the screen to it, so a flip in either direction is reported as the
     * change it is rather than as a mysterious failure.
     */
    test('1 · the screen agrees with the flag it read', async ({ page }) => {
      const { voiceOn, hasNumber } = await readVoiceFlags(page);
      await openCalls(page, 'en');

      if (!voiceOn) {
        // Voice off is a fact about the workspace, not a fault, and it names
        // what would change it.
        const off = page.getByTestId('calls-not-enabled');
        await expect(off).toBeVisible();
        await expect(off).toHaveText(/aren't switched on for this workspace/i);
        await expect(off).toHaveText(/ask whoever set up gotcha/i);
        await shoot(page, `${size.name}-1-voice-off`);
        return;
      }

      /*
       * ★★ VOICE IS ON, SO THE NOT-ENABLED PANEL IS NOW A LIE IF IT APPEARS.
       *
       * This is the exact assertion that would have caught the repaired
       * defect from the outside: a failed settings read used to render this
       * panel to a workspace that has voice.
       */
      await expect(
        page.getByTestId('calls-not-enabled'),
        'voice is ON and the screen says it is not switched on for this workspace',
      ).toHaveCount(0);

      if (!hasNumber) {
        /*
         * Switched on with no ACTIVE VOICE channel. "Calls appear here as
         * they happen" would be a promise about something that cannot
         * happen, so the screen names the missing number instead.
         */
        const none = page.getByTestId('calls-no-number');
        await expect(none).toBeVisible();
        await expect(none).toHaveText(/no phone number is connected/i);
        await shoot(page, `${size.name}-1-voice-on-no-number`);
        return;
      }

      // A number is connected. Either there are calls or there are not, and
      // both are honest screens.
      const log = page.getByTestId('call-log');
      const empty = page.getByTestId('calls-empty');
      expect(
        (await log.count()) + (await empty.count()),
        'voice is on with a connected number and neither the log nor the empty state rendered',
      ).toBeGreaterThan(0);
      await shoot(page, `${size.name}-1-voice-on`);
    });

    /*
     * 1b · 05e's LIVE CALL, NAMED AS UNREACHED.
     *
     * A call in progress is the one thing this screen cannot be made to
     * show: dialling writes to a real carrier, and no `TWILIO_*` credentials
     * exist to dial with. Rather than leave that as an absence somebody
     * later reads as coverage, the run records the reason.
     */
    test('1b · the live-call branch is unreachable, and says so', async ({ page }) => {
      const { hasNumber } = await readVoiceFlags(page);
      await openCalls(page, 'en');

      await expect(
        page.getByTestId('live-call'),
        'a call is in progress — this spec must not photograph a real conversation',
      ).toHaveCount(0);

      test.info().annotations.push({
        type: 'unreached',
        description:
          `05e's live call is not exercised: hasActiveVoiceChannel=${hasNumber}, no TWILIO_* ` +
          'credentials exist, and nothing here may dial. Its behaviour is covered only by ' +
          'src/features/calls/load-calls.test.ts.',
      });
    });

    /*
     * 2 · it is not dressed as an error.
     *
     * The distinction this screen exists to make: "not switched on" and "we
     * could not read your calls" are opposite conclusions from the same 404,
     * and only one of them is true here.
     */
    test('2 · not an error panel', async ({ page }) => {
      await openCalls(page, 'en');
      const main = page.locator('main');

      await expect(main).not.toHaveText(/couldn't read|could not read|something went wrong/i);
      await expect(main).not.toHaveText(/error|failed|try again/i);

      await shoot(page, `${size.name}-2-not-an-error`);
    });

    /*
     * 3 · THE PINNED OMISSIONS.
     */
    test('3 · no calling campaign, no conversion, no sentiment', async ({ page }) => {
      await openCalls(page, 'en');
      const main = page.locator('main');

      // (a) No AI calling campaign: no model, no list-driven object, no
      //     per-call outcome capture tied to one.
      await expect(main).not.toHaveText(/have gotcha call a list|calling campaign/i);

      // (b) `converted` — FOURTH appearance across four screens.
      await expect(main).not.toHaveText(/ended in a sale|\bconverted\b/i);

      // (c) Sentiment: 9 of 89 conversations, 48+ days old where present.
      await expect(main).not.toHaveText(/\bupset\b|\bmood\b/i);

      // (d) No mute anywhere in the platform — pinned here too because 05e
      //     puts it in the call header beside two controls that work.
      await expect(main).not.toHaveText(/\bmute\b/i);

      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-3-pinned-omissions`);
    });

    /* 4 · Hebrew, right to left. */
    test('4 · Hebrew, right to left', async ({ page }) => {
      const { voiceOn, hasNumber } = await readVoiceFlags(page);
      await openCalls(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      /*
       * Whichever panel the flag entails, in Hebrew. The testid is derived
       * from the flag for the same reason test 1 is: a hardcoded one asserts
       * a world that can move underneath it.
       */
      const id = !voiceOn ? 'calls-not-enabled' : hasNumber ? 'call-log' : 'calls-no-number';
      const panel = page.getByTestId(id);
      await expect(panel.or(page.getByTestId('calls-empty')).first()).toBeVisible();
      // Hebrew, not the English fallback: a missing key renders EMPTY in a
      // production build, so a text-present check is not enough on its own.
      await expect(page.locator('main')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-4-hebrew`);
    });

    /* 5 · the two standing shell rules. */
    test('5 · content above the fold, no placeholders', async ({ page }) => {
      await openCalls(page, 'en');

      const box = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect(box, 'the page heading has no box — is it rendered?').not.toBeNull();
      expect(
        box!.y,
        `the heading starts ${Math.round(box!.y)}px down a ${size.height}px viewport`,
      ).toBeLessThan(size.height / 2);

      await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-5-above-the-fold`);
    });
  });
}
