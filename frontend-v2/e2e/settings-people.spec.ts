import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';
import { shoot as captureScreen } from './shoot';

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

  await expect(page.getByTestId('people-table'), missingIds('an id this screen emits')).toBeVisible(
    { timeout: 15_000 },
  );

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

/**
 * ★★ ONE PROJECT CAPTURES, BECAUSE BOTH WOULD WRITE THE SAME FILES.
 *
 * `ltr` and `rtl` differ only in the browser's `locale`, and every screen here
 * takes its direction from the URL — `/en/…` and `/he/…` — which is what
 * next-intl reads. So the two projects rendered identical pixels into
 * identical filenames and, with `fullyParallel: true`, raced to write them.
 *
 * Two costs, and the second is why this landed before a shoot:
 *   · a torn PNG is not a missing shot, it is a corrupt one, and it reads as
 *     a rendering defect;
 *   · it doubled the request budget. The limit is 1,000 requests per fifteen
 *     minutes per IP per service — see `missingIds` — and half of every run
 *     was a re-run of the English tests under a Hebrew locale that changes
 *     nothing.
 *
 * Hebrew is not lost: the specs that cover it navigate to `/he/…` themselves.
 *
 * ── AND THE GUARD IS THE FIRST STATEMENT INSIDE EACH TEST, NOT AT DESCRIBE
 *    SCOPE ──
 * `settings-notifications-seeded.spec.ts` records the trap and it was
 * re-verified before this change: a describe-scope
 * `test.skip(({}, testInfo) => …)` receives FIXTURES ONLY — there is no
 * second argument — so `testInfo` is `undefined` and reading `.project`
 * throws **in both projects**. The guard meant to separate them runs in both
 * and crashes on the value it exists to read.
 */
const CAPTURING_PROJECT = 'ltr';

function onlyOneProject(): boolean {
  const project = test.info().project.name;
  if (project === CAPTURING_PROJECT) return false;
  test.skip(true, `Captured by the ${CAPTURING_PROJECT} project; direction comes from the URL.`);
  return true;
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /* 1 · the roster: both kinds in one list, against real tenant data. */
    test('1 · roster, both kinds', async ({ page }) => {
      if (onlyOneProject()) return;

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
      if (onlyOneProject()) return;

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
      if (onlyOneProject()) return;

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
     * 6 · the invite form, filled and NOT sent.
     *
     * Deliberately never submitted with a new address. A successful invite
     * creates a real user, a real identity in Authentik and **emails a real
     * person** — there is no undo for that which does not involve explaining
     * yourself to whoever received it. The capture photographs the form; shot
     * 7 exercises the write down a path that creates nothing.
     *
     * The role is a list of the roles the viewer may give (auth 679b8812:
     * `POST /api/agents` takes `role`), on the agent role until changed.
     */
    test('6 · the invite form', async ({ page }) => {
      if (onlyOneProject()) return;

      await openPeople(page, 'en');
      await page.getByTestId('invite-open').click();

      const form = page.getByTestId('invite-form');
      await expect(form).toBeVisible();

      // The design draws only an email field. `name` is required by the
      // backend, so the form asks for it rather than inventing one from the
      // address and greeting a real person as "omerts58".
      await form.getByLabel('Email').fill('someone@example.com');
      await form.getByLabel('Name').fill('Someone Example');

      // The role: a real list now, on the agent role until someone changes it.
      const role = form.getByTestId('invite-role');
      await expect(role).toBeEnabled();
      await expect(role.locator('option:checked')).toHaveText(/agent/i);

      await shoot(page, `${size.name}-6-invite-form`);
    });

    /*
     * 7 · the invite refuses someone who is already here.
     *
     * The one write this capture may safely perform. `inviteUser` checks for
     * an existing member FIRST and throws before creating an identity, a user
     * or an email, so a 409 costs nothing and leaves nothing behind. It proves
     * the action, the BFF, the session and the error classifier all work end
     * to end without mutating the tenant.
     *
     * The address is read from the roster rather than hardcoded, so this does
     * not silently stop testing anything if the demo tenant changes.
     */
    test('7 · inviting an existing member is refused, and creates nothing', async ({ page }) => {
      if (onlyOneProject()) return;

      await openPeople(page, 'en');

      const existing = (
        await page.locator('[data-kind="person"] [data-testid^="person-sub-"]').first().innerText()
      ).trim();
      expect(existing, 'no member email on the roster to reuse').toContain('@');

      await page.getByTestId('invite-open').click();
      const form = page.getByTestId('invite-form');
      await form.getByLabel('Email').fill(existing);
      await form.getByLabel('Name').fill('Duplicate Probe');
      await page.getByTestId('invite-send').click();

      /*
       * Asserted on KIND rather than on the exact sentence. A tenant at its
       * seat limit answers 402 before the handler runs, which is a different
       * message and an equally correct refusal — both create nothing, and
       * pinning the wording would fail on a condition that is not a defect.
       */
      const note = page.getByTestId('invite-note');
      await expect(note).toBeVisible({ timeout: 15_000 });
      await expect(note).toHaveAttribute('data-note-kind', 'problem');

      await shoot(page, `${size.name}-7-invite-refused`);
    });

    /*
     * 8 · the Add a team form, opened and NOT submitted.
     *
     * Creating a team is permanent and there is no delete in this screen, so
     * the capture opens the form, photographs it and cancels. A test that
     * leaves a "Test Team" behind is the same mistake as the one that left a
     * timestamp in the workspace description.
     */
    test('8 · the add-a-team form', async ({ page }) => {
      if (onlyOneProject()) return;

      await openPeople(page, 'en');

      const teamCards = page.locator('li[data-testid^="team-"]');
      const teamsBefore = await teamCards.count();

      await page.getByTestId('team-add-open').click();
      const form = page.getByTestId('team-add-form');
      await expect(form).toBeVisible();
      await form.getByLabel(/team name/i).fill('Wholesale');

      // No channel field and no escalation field: nothing behind either.
      await expect(form.getByLabel(/channel|escalat/i)).toHaveCount(0);

      await shoot(page, `${size.name}-8-add-team`);

      // Cancel, and prove nothing was created.
      await form.getByRole('button', { name: 'Cancel' }).click();
      await expect(form).toBeHidden();
      expect(
        await teamCards.count(),
        'the add-a-team shot created a team — it must never do that',
      ).toBe(teamsBefore);
    });

    /*
     * 5 · the page's own content is the first thing on screen.
     *
     * Found by capture at 390, where the Settings section list filled the
     * whole viewport and pushed the heading and the roster below the fold —
     * someone opening a Settings URL on a phone met a wall of navigation and
     * had to scroll past it to reach the page they asked for.
     *
     * Asserted at EVERY width rather than only the narrow one, because the
     * rule is not "the phone layout is special": a navigation list is never
     * the reason a reader cannot see the page they asked for.
     */
    test('5 · content starts above the fold', async ({ page }) => {
      if (onlyOneProject()) return;

      await openPeople(page, 'en');

      /*
       * No ICU placeholder may survive into rendered copy.
       *
       * Screen 14 shipped a banner reading "Reconnecting {system} means…" and
       * every assertion passed, because they all forbade wordings rather than
       * requiring one. This is the cheap general guard for that whole class.
       */
      await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);

      const heading = page.getByRole('heading', { level: 1 });
      const box = await heading.boundingBox();
      expect(box, 'the page heading has no box — is it rendered?').not.toBeNull();

      expect(
        box!.y,
        `the heading starts ${Math.round(box!.y)}px down a ${size.height}px viewport, ` +
          'which means navigation is occupying the screen the page was asked for',
      ).toBeLessThan(size.height / 2);

      await shoot(page, `${size.name}-5-above-the-fold`);
    });

    /*
     * 4 · Hebrew.
     *
     * Selected by test id rather than by copy — a Hebrew page has no "Owner"
     * to click, and a spec that reads English strings passes here only by
     * photographing the wrong locale.
     */
    test('4 · Hebrew, right to left', async ({ page }) => {
      if (onlyOneProject()) return;

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
