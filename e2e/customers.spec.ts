import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';

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
 * ── THIS SPEC REQUIRES THE CAPTURE FIXTURES ──
 * Start the server with `E2E_SECURITY_FIXTURES=1`. **Without it this run
 * fails and writes nothing**, by design.
 *
 * Screen 04 renders a name, a phone number and an email address on the same
 * row. This tenant's two contacts are real people, so a full-page capture at
 * three viewports would produce eighteen copies of something directly
 * identifying *and* directly contactable — a different thing from screen 16's
 * IP and city, not a worse degree of it. That happened once already and the
 * files were deleted.
 *
 * So `openCustomers()` asserts a fixture marker is on the page **before the
 * first screenshot**. The same guard on screen 16 is the only safety
 * assertion on this project that has ever caught a live condition, and it
 * earned that on exactly this failure.
 *
 * ── WHAT THE FIXTURES SHOW ──
 * Three contacts, two of which share a `personId` — so the evidence exercises
 * the thing this screen was rebuilt around: **one human on two channels
 * collapsing to one row**, with both channels on it. The live tenant has two
 * contacts, no tags and no dates, and that sparseness is recorded in the
 * reviewer's note rather than dressed up here.
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
  // something upstream failed — `missingIds` says what to check first.
  await expect(
    page.getByTestId('customer-search'),
    missingIds('an id this screen emits'),
  ).toBeVisible({ timeout: 15_000 });

  // Refuse to photograph a failed read as though it were the screen.
  await expect(
    page.getByTestId('customers-unavailable'),
    'the customers could not be read, so this run would photograph an error panel',
  ).toHaveCount(0);

  /*
   * ── THE GATE ──
   * Refuse to photograph real people. If the fixtures did not engage, this
   * page is showing the tenant's actual contacts — names, phone numbers and
   * email addresses — and the run must stop before the camera rather than
   * after it.
   */
  const listed = await page.getByTestId('customer-list').count();
  if (listed > 0) {
    await expect(
      page.locator('main'),
      'the capture fixtures did not engage, so this page is showing REAL contacts. ' +
        'Start the server with E2E_SECURITY_FIXTURES=1 and an APP_ORIGIN on localhost. ' +
        'Nothing has been written.',
    ).toContainText('example.com');
  }
  /*
   * Keyed on whether ROWS ARE ON SCREEN, not on whether a query was typed.
   * The first version gated only the unsearched view, which left every search
   * that MATCHED free to photograph real people — the guard would have been
   * bypassed by the one case it most needed to cover.
   */

  return page;
}

/**
 * Open ONE customer — screen 04b — with the same refusal to photograph a real
 * person as the list has.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ 04b WAS BUILT, UNIT-TESTED, COMMITTED AND UNPHOTOGRAPHABLE
 * ════════════════════════════════════════════════════════════════════════════
 * The list spec ran 48/48 green with 24 shots and visited this page ZERO
 * times, so a full pass over screen 04 said nothing whatever about 04b. The
 * tell was in the evidence directory: **the shot count did not change when a
 * new screen was added.** A screen that produces no new evidence has not
 * been photographed.
 *
 * And writing this helper is what surfaced the deeper problem. The fixture
 * list serves synthetic ids; opening one called the timeline endpoint with an
 * id no tenant has, which 404s — so under the gate every customer page
 * rendered "we couldn't load this customer". Had this spec been written after
 * a capture rather than before, the run would have banked a shot of an error
 * panel as evidence for 04b.
 */
async function openCustomer(page: Page, locale: 'en' | 'he') {
  await openCustomers(page, locale);

  /*
   * Navigate by CLICKING the row, not by constructing a URL. The defect 04b
   * exists to fix is that the rows were not links — a spec that types the
   * path would pass on a list whose rows still do nothing.
   */
  const firstRow = page.getByTestId('customer-list').locator('a').first();
  await expect(
    firstRow,
    'no link in the customer list — the rows are not clickable, which is the defect 04b exists to fix',
  ).toBeVisible({ timeout: 15_000 });
  await firstRow.click();

  await expect(
    page.getByTestId('customer-detail'),
    missingIds('the 04b customer detail'),
  ).toBeVisible({ timeout: 15_000 });

  // Refuse to photograph a failed read as though it were the screen.
  await expect(
    page.getByTestId('customer-unavailable'),
    'the customer could not be read, so this run would photograph an error panel as 04b',
  ).toHaveCount(0);

  /*
   * ── THE GATE, AND IT MATTERS MORE HERE THAN ON THE LIST ──
   * The list shows a name and a phone number. THIS page shows the BODIES of
   * a real person's messages, a model-written character study of them, and
   * the durable facts GOTCHA has learned. Eighteen copies at three viewports.
   */
  await expect(
    page.locator('main'),
    "the capture fixtures did not engage, so this page is showing a REAL person's " +
      'messages, brief and remembered facts. Start the server with ' +
      'E2E_SECURITY_FIXTURES=1 and an APP_ORIGIN on localhost. Nothing has been written.',
  ).toContainText('Avery Stone');

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
      // "People", which became true only once `personId` was returned and the
      // route began filtering tombstones. Before that a row was a channel
      // identity and the screen said "contacts".
      await expect(count).toHaveText(/people|person/i);

      /*
       * ── THE INVARIANT, NOT A NUMBER ──
       * The header must equal the number of person rows rendered. It did not:
       * the count was contact ROWS under a label reading "people", so three
       * rows collapsed to two people and the header still said three.
       *
       * Asserted against the rendered rows rather than against an expected
       * figure, so it keeps holding when the fixture changes — an assertion
       * that hard-coded "2" would pass a screen that counted the wrong thing
       * the moment someone added a row.
       */
      // `li[...]` scopes to the rows: the count itself is a <p>, and the
      // channel badges are <span>. No exclusion needed — and `!=` is not a
      // CSS attribute operator anyway, which cost a run on screen 12.
      const personRows = page.locator('li[data-testid^="customer-"]');
      await expect(personRows.first()).toBeVisible();
      const rendered = await personRows.count();
      const heading = (await count.textContent())?.trim() ?? '';
      const stated = Number(heading.match(/\d+/)?.[0] ?? NaN);
      expect(
        stated,
        `the header says "${heading}" but ${rendered} person rows are rendered — the count ` +
          'is counting something other than what is on screen',
      ).toBe(rendered);

      await shoot(page, `${size.name}-1-list`);
    });

    /*
     * 2 · searching by name, which works as of 2026-09-20.
     *
     * The `name` case landed while this screen was being built. Until it did,
     * a name search matched nothing and the empty state had to say so.
     */
    test('2 · a name search finds the person', async ({ page }) => {
      await openCustomers(page, 'en', 'Avery');

      await expect(page.getByTestId('customer-list')).toBeVisible();
      await expect(page.locator('main')).toContainText('Avery Stone');

      /*
       * And the name appears TWICE, which is the screen telling the truth
       * rather than failing: three entries carry it — a WhatsApp one, a typed
       * one with the same number, and an Instagram one with no number at all.
       * The first two join; the third cannot. So a search for one person
       * returns two rows, and the sentence above the list says why.
       */
      const rows = page.locator('li[data-testid^="customer-"]');
      await expect(rows).toHaveCount(2);

      await shoot(page, `${size.name}-2-name-search`);
    });

    /*
     * 2b · a query that matches nothing still says what was searched.
     *
     * **Order number is the one that cannot work** — orders are not local to
     * this platform at all. Reporting a bare "no results" would tell someone
     * their customer does not exist, when the truth is we never looked at the
     * field they typed into.
     */
    test('2b · no match names what was searched, and what cannot be', async ({ page }) => {
      await openCustomers(page, 'en', 'Zzyzx');

      await expect(page.getByTestId('customers-empty')).toBeVisible();
      const fields = page.getByTestId('search-fields');
      await expect(fields).toBeVisible();
      await expect(fields).toHaveText(/order numbers aren't searchable/i);

      await shoot(page, `${size.name}-2b-no-match`);
    });

    /*
     * 2c · THE LIMIT OF THE COLLAPSE, STATED.
     *
     * The unifier that populates `personId` matches on **phone only**, and
     * Instagram contacts have no phone — `externalId` there is an opaque
     * page-scoped id. So one person on two channels is two rows and will
     * stay two rows.
     *
     * The design's first line is *"One identity per human, however many
     * channels they use."* That is a missing capability, not a bug, and a
     * reader must not close this screen believing it works.
     */
    test('2c · says what the collapse cannot join', async ({ page }) => {
      await openCustomers(page, 'en');

      const limit = page.getByTestId('identity-limit');
      await expect(limit).toBeVisible();
      await expect(limit).toHaveText(/appear here twice/i);
      // The reason, not just the symptom — and the reason is specific.
      await expect(limit).toHaveText(/same phone number/i);
      await expect(limit).toHaveText(/instagram never provides one/i);

      await shoot(page, `${size.name}-2c-identity-limit`);
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
      //
      //     Matched on the segment NAMES, not on the bare word "wholesale" —
      //     that is also a legitimate contact tag, and an assertion that
      //     forbade it would fail on real data rather than on a real defect.
      await expect(main).not.toHaveText(/talking to you now|unhappy lately|gone quiet/i);
      await expect(main).not.toHaveText(/best customers|wholesale customers/i);

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

    /*
     * ══════════════════════════════════════════════════════════════════════
     * 04b · ONE CUSTOMER
     * ══════════════════════════════════════════════════════════════════════
     * Every assertion is by CONTENT. This screen's failure mode is a sentence
     * that reads well and is not true — a canned string in the serif italic
     * reserved for a written character study, a stream that omits a class of
     * action without saying so, a count that describes a page rather than a
     * history.
     */
    test('04b · the person, and what the page will not claim about them', async ({ page }) => {
      await openCustomer(page, 'en');

      await expect(page.getByTestId('detail-name')).toHaveText(/Avery Stone/);

      /*
       * ★ THE SUMMARY IS A SUMMARY, AND THE CANNED STRING IS NOT ONE.
       *
       * `POST /customer-summary` answers `ok: true` with "New customer with
       * no recorded prior interactions." for somebody who has never written.
       * Through the serif italic this screen reserves for a written character
       * study, that constant would read as a model's conclusion about them.
       */
      const brief = page.getByTestId('customer-brief');
      await expect(brief).toBeVisible();
      await expect(brief).toHaveText(/\S/);
      await expect(brief).not.toHaveText(/New customer with no recorded prior interactions/i);

      /*
       * ★★ THE COUNT NAMES THE WHOLE, NOT THE PAGE.
       *
       * The old route thinned rather than truncated — 50 conversations × the
       * newest 5 messages of each — so the stream looked complete with holes
       * in the middle of every conversation. "Showing N of M" is the sentence
       * that could not be said then and can be now.
       */
      const count = page.getByTestId('timeline-count');
      await expect(count).toHaveText(/showing \d/i);
      await expect(count).toHaveText(/of [\d,]+ messages/i);
      // Never the sentence that described the shape we replaced.
      await expect(count).not.toHaveText(/recent activity only/i);

      /*
       * ★★ COVERAGE, INCLUDING AVAILABLE-AND-INCOMPLETE.
       *
       * `ai_action` is `available: true` and still omits any action taken
       * through an adapter — a Shopify refund the AI performed is not in the
       * list, and Backend's own note says the gap is invisible from the data.
       * A screen that renders the events and drops the detail deletes the
       * only warning there is.
       */
      const coverage = page.getByTestId('timeline-coverage');
      await expect(coverage, 'the coverage caveats are not on screen').toBeVisible();
      await expect(coverage).toHaveText(/\S/);

      // An imported message says it was imported: told about, not witnessed.
      await expect(page.getByTestId('event-imported')).toHaveText(/imported/i);

      /*
       * ★ NOTES — read here, written in the CRM, and anonymous.
       */
      const notes = page.getByTestId('customer-notes');
      await expect(notes).toBeVisible();
      await expect(page.getByTestId('notes-read-only')).toHaveText(/written in your CRM/i);
      await expect(page.getByTestId('notes-anonymous')).toHaveText(/doesn.t record who wrote/i);

      /*
       * ★ AND THE TWO THINGS THAT MUST NOT APPEAR.
       *
       * Tenure, because all three fields that look like it undersell a
       * long-standing customer — "customer since" built from any of them
       * tells a three-year customer they joined today.
       *
       * Money, because it is two live uncached vendor calls per customer and
       * lives where one person is being decided about.
       */
      const main = page.locator('main');
      await expect(main).not.toHaveText(/customer since/i);
      await expect(main).not.toHaveText(/lifetime value/i);
      // No un-substituted ICU placeholder anywhere on the page.
      await expect(main).not.toHaveText(/\{[a-zA-Z]+\}/);

      // And no write control: the CRM note write files against the wrong
      // conversation from here, so it is not offered.
      await expect(main.locator('textarea')).toHaveCount(0);

      await shoot(page, `${size.name}-04b-customer`);
    });

    /*
     * 04b · Hebrew. The brief is prose from the platform and the caveats are
     * prose from the route, so this shot is where a right-to-left reading of
     * somebody else's sentences is actually checked.
     */
    test('04b · Hebrew, right to left', async ({ page }) => {
      await openCustomer(page, 'he');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('customer-detail')).toBeVisible();
      await shoot(page, `${size.name}-04b-hebrew`);
    });
  });
}
