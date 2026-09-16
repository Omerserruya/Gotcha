import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Screen 12 · Settings · People & teams — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR: this session has no
 * browser, and a capture one of us describes and the other performs is the one
 * place a screen gets accepted on a guess.
 *
 * Captured EARLY and deliberately — the table first, before invite and team
 * editing exist. On screen 11 every one of five defects was found by capture
 * and none by 196 unit tests, so the picture comes before the rest of the
 * screen, not after it.
 *
 * ── RUNNING IT ──
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/settings-people.spec.ts
 *
 * The PATH line is not optional: the default `node` here is 18 and Playwright
 * needs 20+, failing with a message that reads like it is not installed.
 *
 * Shots land in e2e/evidence/s12/.
 *
 * ── WHAT THIS TENANT CAN AND CANNOT SHOW ──
 * One member (an ADMIN whose role is Owner), one AI employee (Maya, ACTIVE),
 * one team (Customer Support) with ZERO members, no presence rows and no
 * invites. The design draws four people, three AI employees and two teams.
 *
 * So the sparse states are not an edge case here — they are the screen. These
 * shots are evidence that an empty team card and a two-row roster read as
 * deliberate rather than broken. They cannot be evidence of a multi-team
 * layout, and nothing in this file pretends otherwise.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's12');

const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 800 },
  /* The four columns stop being columns below 768; this is that layout. */
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
 * Three checks, because a missing test id has three quite different causes.
 * The third one has actually happened on this project: a clean tree and a
 * green `verify` say nothing about what `next start` is serving out of
 * `.next`, and a commit that is not built is a commit that is not running.
 */
async function openPeople(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/settings/people`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/settings/people. The session cookie is ` +
        'missing or expired — set GOTCHA_SESSION to a current one.',
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  await expect(
    page.getByTestId('people-table'),
    'The screen rendered but `people-table` is absent. Either the member list failed to ' +
      'load (check the server log for `people.members_failed`), or the SERVED BUILD predates ' +
      'this screen — run `npm run build` and restart `next start`.',
  ).toBeVisible({ timeout: 15_000 });

  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /* 1 · the roster: both kinds in one list, against real tenant data. */
    test('1 · roster, both kinds', async ({ page }) => {
      await openPeople(page, 'en');

      const people = page.locator('[data-kind="person"]');
      const ai = page.locator('[data-kind="ai"]');

      // Both kinds present at all is the screen's whole premise.
      await expect(people).toHaveCount(1);
      await expect(ai).toHaveCount(1);

      // The AI row must carry a count, and it must read as "open" — never
      // "live". `not CLOSED` includes WAITING, which usually means waiting on
      // the CUSTOMER, so the integer means "not finished" and cannot support
      // the present tense the design's "88 live" asserts.
      const aiNow = ai.first().locator('[data-testid^="person-now-"]');
      await expect(aiNow).toHaveText(/\d+ open/);
      await expect(aiNow).not.toHaveText(/live/i);

      await shoot(page, `${size.name}-1-roster-en`);
    });

    /*
     * 2 · the money-limit ruling, asserted rather than trusted.
     *
     * The design writes "refunds up to ₪500" per person. `BusinessPolicyConfig`
     * scopes amounts per ACTION KIND, tenant-wide, with no notion of a subject,
     * so a per-person figure is not something the backend declined to send —
     * it is something it cannot say. Omer ruled it dropped.
     *
     * This is the regression guard for that ruling: a currency symbol or a
     * bare number appearing in "Can do" means someone reintroduced a claim
     * the product cannot enforce.
     */
    test('2 · "Can do" carries a role, never a money limit', async ({ page }) => {
      await openPeople(page, 'en');

      const roles = page.locator('[data-testid^="person-role-"]');
      const count = await roles.count();
      expect(count).toBeGreaterThan(0);

      for (let i = 0; i < count; i += 1) {
        const text = (await roles.nth(i).innerText()).trim();
        expect(text, 'a role cell was empty').not.toBe('');
        expect(
          text,
          `"${text}" contains a money limit the policy engine cannot express`,
        ).not.toMatch(/[₪$€£]|\d/);
      }

      await shoot(page, `${size.name}-2-can-do`);
    });

    /*
     * 3 · the sparse states, which on this tenant ARE the screen.
     *
     * A team with nobody in it must say so. An empty meta line would read as
     * a rendering fault, and zero members is the real and actionable state of
     * every team on a tenant that has not finished setting up.
     *
     * Also the shot that proves no channel line and no escalation target are
     * rendered — both were ruled out because nothing in the backend can fill
     * them, and "Not set" was ruled out too: it would promise a control that
     * exists on no screen.
     */
    test('3 · teams, including one with no members', async ({ page }) => {
      await openPeople(page, 'en');

      const cards = page.getByTestId('team-cards');
      await expect(cards).toBeVisible();

      const meta = page.locator('[data-testid^="team-meta-"]').first();
      await expect(meta).toHaveText(/No members|person|people/);

      // Neither ruled-out fact may appear.
      await expect(cards).not.toHaveText(/WhatsApp|Instagram|escalat/i);

      await shoot(page, `${size.name}-3-teams`);
    });

    /*
     * 4 · Hebrew.
     *
     * Selected by test id rather than by copy — a Hebrew page has no "Owner"
     * to click, and a spec that reads English strings passes here only by
     * photographing the wrong locale.
     */
    test('4 · Hebrew, right to left', async ({ page }) => {
      await openPeople(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('[data-kind="person"]')).toHaveCount(1);
      await expect(page.locator('[data-kind="ai"]')).toHaveCount(1);

      // The built-in role is translated: a Hebrew reader must not be shown the
      // English word for their own role.
      await expect(page.locator('[data-testid^="person-role-"]').first()).not.toHaveText(
        /Owner|Admin|Agent/,
      );

      await shoot(page, `${size.name}-4-hebrew`);
    });
  });
}
