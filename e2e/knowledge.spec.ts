import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';
import { shoot as captureScreen } from './shoot';

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
 * So the evidence covers the thing this screen exists to get right: **a date
 * instead of a freshness verdict**.
 *
 * ── AND ONE TEST THAT USED TO BE HERE ──
 * A test asserting the shared-name flag was removed. It could never pass: the
 * two same-named sources I found are **in different tenants**, and this
 * screen queries `where: { tenantId }` with nothing else — so one row is the
 * whole truth here and the screen can never render both at once.
 *
 * The flag itself is correct and stays: there is no unique index on
 * `(tenant_id, name)`, so two same-named sources in ONE tenant are possible.
 * It is checked in `src/features/knowledge/KnowledgeScreen.test.tsx` with two
 * such sources in props. **A capture test asserting something this tenant
 * cannot produce is a test that fails for being honest.**
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

    /* 1 · both halves of the screen. */
    test('1 · gaps and sources', async ({ page }) => {
      if (onlyOneProject()) return;

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
      if (onlyOneProject()) return;

      await openKnowledge(page, 'en');
      const main = page.locator('main');

      // The fact is present…
      // `\S`, not `\d`. The format is next-intl's business — "July 29, 2026"
      // puts a month name where a digit was demanded, and asserting the shape
      // of the date tests the library instead of the screen. The ruling is
      // that a date is STATED; that is what this checks.
      await expect(main).toHaveText(/last refreshed \S/i);
      // …and the verdict is not.
      await expect(main).not.toHaveText(/\bfresh\b|out of date|up to date|stale/i);

      await shoot(page, `${size.name}-2-date-not-verdict`);
    });

    /* 3 · THE PINNED OMISSIONS. */
    test('3 · no topic strength, no invented counts', async ({ page }) => {
      if (onlyOneProject()) return;

      await openKnowledge(page, 'en');
      const main = page.locator('main');

      // "Answers confidently · 34 topics" / "Thin — guesses sometimes · 6".
      await expect(main).not.toHaveText(/answers confidently|guesses sometimes|topic strength/i);
      // "Contradicts itself · 2" — the mechanism is real, this tenant has zero.
      await expect(main).not.toHaveText(/contradicts itself/i);
      // Learned-from-N-conversations has no source.
      await expect(main).not.toHaveText(/past conversations/i);

      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-3-pinned-omissions`);
    });

    /* 4 · Hebrew, right to left. */
    test('4 · Hebrew, right to left', async ({ page }) => {
      if (onlyOneProject()) return;

      await openKnowledge(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('sources-section')).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-4-hebrew`);
    });

    /* 5 · the two standing shell rules. */
    test('5 · content above the fold, no placeholders', async ({ page }) => {
      if (onlyOneProject()) return;

      await openKnowledge(page, 'en');

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
