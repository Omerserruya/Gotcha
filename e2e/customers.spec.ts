import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Screen 04 · Customers — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/customers.spec.ts
 *
 * Shots land in e2e/evidence/s04/.
 *
 * ── WHAT THIS TENANT CAN AND CANNOT SHOW ──
 * Counted before this spec was written:
 *
 *     contacts                    2
 *     with last_interaction_at    0
 *     with last_seen_at           0
 *     with tags                   0
 *     with source                 0
 *
 * **A two-row list with no tags and no dates.** That is the honest state and
 * it is not worked around — the fourth screen in a row whose real state is the
 * sparse one, which is in the reviewer's note as a pattern rather than as four
 * separate footnotes.
 *
 * `GET /api/contacts` is not used by this screen and could not answer if it
 * were: it needs a connected CRM and a non-empty query, and this tenant's only
 * integration is Shopify (ECOMMERCE, ERROR).
 *
 * ── NOTHING IS WRITTEN ──
 * Search is a GET. There is no `.click()` here that changes anything — and in
 * particular nothing merges two identities, which is the one destructive
 * action this screen will eventually offer.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's04');

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

async function openCustomers(page: Page, locale: 'en' | 'he', query = '') {
  const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
  await page.goto(`/${locale}/customers${suffix}`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/customers. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  // The search form is on every state of this screen, so its absence means
  // the served build predates it — which looks exactly like a missing session
  // unless the message says so.
  await expect(
    page.getByTestId('customer-search'),
    'the page rendered but `customer-search` is absent — the SERVED BUILD may predate this ' +
      'screen. Run `npm run build` and restart `next start`.',
  ).toBeVisible({ timeout: 15_000 });

  // Refuse to photograph a failed read as though it were the screen.
  await expect(
    page.getByTestId('customers-unavailable'),
    'the customers could not be read, so this run would photograph an error panel',
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
     * 1 · the list, and the count that describes it.
     *
     * The count is the route's real `prisma.contact.count`, not the length of
     * what came back — unlike `GET /api/contacts`, whose `meta.total` is
     * `rows.length` and therefore cannot support pagination at all.
     */
    test('1 · the list, counted honestly', async ({ page }) => {
      await openCustomers(page, 'en');

      await expect(page.getByTestId('customer-list')).toBeVisible();
      const count = page.getByTestId('customer-count');
      await expect(count).toBeVisible();
      await expect(count).toHaveText(/contact/i);

      // Contacts, never "people": the endpoint omits `personId` and
      // `mergedIntoId`, so one human on two channels is two rows here and a
      // merged-away row is still returned. The screen must not claim
      // otherwise.
      await expect(count).not.toHaveText(/\bpeople\b|\bcustomers\b/i);

      await shoot(page, `${size.name}-1-list`);
    });

    /*
     * 2 · THE SHOT THAT MATTERS ON THIS TENANT.
     *
     * Searching a name finds nothing, because the rule vocabulary has
     * thirteen cases and no name case. Saying only "no results" would tell
     * someone their customer does not exist when the truth is that we never
     * looked at the field they typed into.
     */
    test('2 · a name search says which fields it looked at', async ({ page }) => {
      await openCustomers(page, 'en', 'Dana');

      await expect(page.getByTestId('customers-empty')).toBeVisible();
      const fields = page.getByTestId('search-fields');
      await expect(fields).toBeVisible();
      await expect(fields).toHaveText(/searching by name isn't available/i);

      await shoot(page, `${size.name}-2-name-search`);
    });

    /*
     * 3 · THE PINNED OMISSIONS.
     *
     * Each is a ruling, and a ruling survives only if something fails when it
     * is undone.
     */
    test('3 · no segments, no sort, no invented commerce facts', async ({ page }) => {
      await openCustomers(page, 'en');
      const main = page.locator('main');

      // (a) The five segments. Three need absent sources, one needs a writer
      //     that does not run, and "wholesale" needs tags no contact carries.
      await expect(main).not.toHaveText(/talking to you now|unhappy lately|gone quiet/i);
      await expect(main).not.toHaveText(/wholesale|best customers/i);

      // (b) The list is ordered by a column nothing writes, so it has no
      //     order to claim and no control that the server would honour.
      await expect(main).not.toHaveText(/most recent first|sort by/i);
      await expect(main.locator('select')).toHaveCount(0);

      // (c) Value, orders and tenure are two live uncached Shopify calls per
      //     customer, and none is on `Contact`.
      await expect(main).not.toHaveText(/lifetime|total spent|orders?\b.*₪|with you since/i);

      // (d) `AgentCustomerMemory` is per-agent, last-turn-only and advisory;
      //     there is no `Note` model at all.
      await expect(main).not.toHaveText(/gotcha remembers|add a note/i);

      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-3-pinned-omissions`);
    });

    /*
     * 4 · no machine identifiers, and no raw contact handles in a place they
     * do not belong. A cuid on screen is the `ai_voice` class.
     */
    test('4 · no raw identifiers', async ({ page }) => {
      await openCustomers(page, 'en');

      await expect(page.locator('main')).not.toHaveText(/\bc[a-z0-9]{24,}\b/);

      await shoot(page, `${size.name}-4-no-raw-identifiers`);
    });

    /* 5 · Hebrew, right to left. */
    test('5 · Hebrew, right to left', async ({ page }) => {
      await openCustomers(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('customer-search')).toBeVisible();
      // Hebrew copy, not an untranslated fallback sitting in an RTL page.
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-5-hebrew`);
    });

    /* 6 · the two standing shell rules. */
    test('6 · content above the fold, no placeholders', async ({ page }) => {
      await openCustomers(page, 'en');

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
