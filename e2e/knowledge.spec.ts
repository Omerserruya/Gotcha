import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

/**
 * Screen 08 · Studio · Knowledge — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/knowledge.spec.ts
 *
 * **Run this spec alone.**
 *
 * Shots land in e2e/evidence/s08/.
 *
 * ── WHAT THIS TENANT SHOWS ──
 * Two knowledge sources — **both named "Company Knowledge"** — holding three
 * and two documents, both last refreshed 29 July. Zero unanswered questions
 * and zero conflicts.
 *
 * So the evidence covers the two things this screen exists to get right:
 * **a date instead of a freshness verdict**, and **a name that identifies two
 * different sources**.
 *
 * ── NOTHING IS WRITTEN ──
 * No `.click()` adds, edits or deletes anything.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's08');

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

async function openKnowledge(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/studio/knowledge`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/studio/knowledge. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  const states = ['knowledge-screen', 'knowledge-unavailable'];
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
    page.getByTestId('knowledge-unavailable'),
    'neither half could be read, so this run would photograph an error panel',
  ).toHaveCount(0);

  return page;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /* 1 · both halves of the screen. */
    test('1 · gaps and sources', async ({ page }) => {
      await openKnowledge(page, 'en');

      await expect(page.getByTestId('gaps-section')).toBeVisible();
      await expect(page.getByTestId('sources-section')).toBeVisible();

      // Nothing unanswered on this tenant, and that is said as a state.
      await expect(page.getByTestId('gaps-none')).toHaveText(/couldn't answer/i);

      const sources = page.locator('li[data-testid^="source-"]');
      await expect(sources.first()).toBeVisible();

      await shoot(page, `${size.name}-1-knowledge`);
    });

    /*
     * 2 · THE SHOT THAT MATTERS.
     *
     * Each source says WHEN it was last refreshed and never whether that is
     * good — there is no staleness policy in the platform, and this tenant's
     * sources are two months old, which is exactly the case a "Fresh" label
     * would get wrong.
     */
    test('2 · a date, never a freshness verdict', async ({ page }) => {
      await openKnowledge(page, 'en');
      const main = page.locator('main');

      // The fact is present…
      await expect(main).toHaveText(/last refreshed \d/i);
      // …and the verdict is not.
      await expect(main).not.toHaveText(/\bfresh\b|out of date|up to date|stale/i);

      await shoot(page, `${size.name}-2-date-not-verdict`);
    });

    /*
     * 3 · two sources, one name.
     *
     * Both are called "Company Knowledge". Printing the name twice tells the
     * reader nothing about which is which, so the screen says so.
     */
    test('3 · a shared name is flagged, not left ambiguous', async ({ page }) => {
      await openKnowledge(page, 'en');

      const flags = page.locator('[data-testid^="same-name-"]');
      await expect(
        flags.first(),
        'no source is flagged as sharing a name — either the tenant changed or the ' +
          'disambiguation was removed',
      ).toBeVisible();
      await expect(flags.first()).toHaveText(/another source has this name/i);

      await shoot(page, `${size.name}-3-shared-name`);
    });

    /* 4 · THE PINNED OMISSIONS. */
    test('4 · no topic strength, no invented counts', async ({ page }) => {
      await openKnowledge(page, 'en');
      const main = page.locator('main');

      // "Answers confidently · 34 topics" / "Thin — guesses sometimes · 6".
      await expect(main).not.toHaveText(/answers confidently|guesses sometimes|topic strength/i);
      // "Contradicts itself · 2" — the mechanism is real, this tenant has zero.
      await expect(main).not.toHaveText(/contradicts itself/i);
      // Learned-from-N-conversations has no source.
      await expect(main).not.toHaveText(/past conversations/i);

      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-4-pinned-omissions`);
    });

    /* 5 · Hebrew, right to left. */
    test('5 · Hebrew, right to left', async ({ page }) => {
      await openKnowledge(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('sources-section')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-5-hebrew`);
    });

    /* 6 · the two standing shell rules. */
    test('6 · content above the fold, no placeholders', async ({ page }) => {
      await openKnowledge(page, 'en');

      const box = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect(box, 'the page heading has no box — is it rendered?').not.toBeNull();
      expect(
        box!.y,
        `the heading starts ${Math.round(box!.y)}px down a ${size.height}px viewport`,
      ).toBeLessThan(size.height / 2);

      await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-6-above-the-fold`);
    });
  });
}
