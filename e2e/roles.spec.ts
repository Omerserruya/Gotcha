import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

/**
 * Screen 12b · Settings · People & teams · Roles — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/roles.spec.ts
 *
 * **Run this spec alone**, and check gate 0 first.
 *
 * Shots land in e2e/evidence/s12b/.
 *
 * ── WHAT THIS TENANT SHOWS ──
 * **Four roles, all built-in, and no custom ones.** Owner has one person;
 * Admin, Agent and Department Manager have nobody. **Zero per-person grants.**
 *
 * So every permission anyone holds here comes from a role nobody chose — and
 * the screen says the custom-role half is empty rather than leaving four
 * locked rows to imply that is all there is.
 *
 * ── NOTHING IS WRITTEN ──
 * No `.click()` creates, copies or deletes a role.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's12b');

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

async function openRoles(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/settings/people/roles`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/settings/people/roles. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  const states = ['roles-screen', 'roles-unavailable'];
  await expect
    .poll(
      async () => {
        const counts = await Promise.all(states.map((id) => page.getByTestId(id).count()));
        return counts.reduce((a, b) => a + b, 0);
      },
      { message: missingIds(`none of ${states.join(', ')}`), timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  await expect(
    page.getByTestId('roles-unavailable'),
    'the roles could not be read, so this run would photograph an error panel',
  ).toHaveCount(0);

  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /* 1 · the roles, with what each allows counted. */
    test('1 · the roles', async ({ page }) => {
      await openRoles(page, 'en');

      await expect(page.getByTestId('role-list')).toBeVisible();
      const roles = page.locator('li[data-testid^="role-"]');
      await expect(roles.first()).toBeVisible();

      // Built-in roles are marked as fixed, because the route refuses an edit.
      await expect(page.locator('[data-testid^="builtin-"]').first()).toBeVisible();
      await expect(page.locator('main')).toHaveText(/copy it and change the copy/i);

      /*
       * A role holding `*` says what it means. Owner holds exactly one
       * feature row — the wildcard — so counting rendered "Allows one thing"
       * beneath "Full access to everything". Arithmetically right about the
       * row, wrong about the world.
       */
      const owner = page.locator('li[data-testid^="role-"]', { hasText: /owner/i }).first();
      if ((await owner.count()) > 0) {
        await expect(owner).toHaveText(/allows everything/i);
        await expect(owner).not.toHaveText(/allows one thing/i);
      }

      await shoot(page, `${size.name}-1-roles`);
    });

    /*
     * 2 · THE SHOT THAT MATTERS.
     *
     * The design writes a money limit into three role descriptions — "refunds
     * up to ₪1,000", "up to ₪500". `TenantRoleFeature` is (roleId, feature)
     * with no other columns, so no amount is stored or enforced anywhere.
     */
    test('2 · roles carry no money limits, and the screen says so', async ({ page }) => {
      await openRoles(page, 'en');

      const note = page.getByTestId('no-limits');
      await expect(note).toBeVisible();
      await expect(note).toHaveText(/don't carry money limits/i);
      // The reason, not just the fact.
      await expect(note).toHaveText(/either allows refunds or it doesn't/i);

      /*
       * Scoped to the LIST, not to `main`. The note is the one place an
       * amount legitimately appears — it quotes the limit that does not
       * exist in order to say so. Asserting over the whole page made the
       * disclaimer fail the assertion it was written to satisfy.
       */
      await expect(page.getByTestId('role-list')).not.toHaveText(/₪\s?\d|up to \d/i);

      await shoot(page, `${size.name}-2-no-money-limits`);
    });

    /* 3 · no custom roles, said as a state. */
    test('3 · the custom half is empty and says so', async ({ page }) => {
      await openRoles(page, 'en');

      const none = page.getByTestId('no-custom-roles');
      await expect(none).toBeVisible();
      await expect(none).toHaveText(/no roles of your own yet/i);

      await shoot(page, `${size.name}-3-no-custom-roles`);
    });

    /* 4 · Hebrew, right to left. */
    test('4 · Hebrew, right to left', async ({ page }) => {
      await openRoles(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('no-limits')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-4-hebrew`);
    });

    /* 5 · the two standing shell rules. */
    test('5 · content above the fold, no placeholders', async ({ page }) => {
      await openRoles(page, 'en');

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
