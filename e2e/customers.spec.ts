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
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ WHAT 04b's EVIDENCE DOES AND DOES NOT SHOW
 * ════════════════════════════════════════════════════════════════════════════
 * **The customer page is photographed from a FIXTURE, and the live timeline
 * read 404s during the run.**
 *
 * The fixture list serves synthetic ids, so `GET /api/identity/{id}/timeline`
 * is called with an id no tenant has and answers 404 — twelve times in the
 * 2026-09-24 run, logged as `customer.timeline_failed`. The tests pass
 * because `withDetailFixtures` substitutes over that failure for fixture ids,
 * which is deliberate: a 404 for an id we invented is not the screen failing.
 *
 * So these shots prove **04b renders fixture data correctly.** They do not
 * show the screen working against the real endpoint: the contract fields, the
 * cursor, `coverage`, `origin` labelling, handovers and AI actions have all
 * been photographed from a constant.
 *
 * Same shape as 11b's accept path, verified against a seeded proposal rather
 * than a scan, and it belongs on the same list. Written here so it cannot
 * soften into "04b is verified against the API" three documents from now.
 *
 * ── 04e IS IN THIS RUN, AND ITS GATE IS THE THING TO WATCH ──
 * The customer audit route went live today with `crm:contacts:read` or
 * ADMIN — widened from the admin-only constant its three siblings still
 * use, because that constant also gates the workspace-wide CSV export.
 * A `customer-actions-forbidden` panel therefore means the widened gate is
 * not in the running image, and this spec fails on it rather than
 * photographing it.
 *
 * ── AND THE ONE TEST THAT DOES EXERCISE THE LIVE READ ──
 * `E2E_REAL_CONTACT_ID` closes it. A REAL id under the gate takes the live
 * path — the endpoint is called, the response is parsed by our contract, and
 * only then is the rendered detail swapped for the fixture. So a 404, a 500
 * or a contract rejection all surface as the error panel and fail the test,
 * while the shot itself is still fixture data and safe to keep.
 *
 * Set it to a contact id from this tenant and the test runs; leave it unset
 * and it skips, saying so.
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

    /*
     * ══════════════════════════════════════════════════════════════════════
     * 04b · THE LIVE READ, WITH A SAFE SHOT
     * ══════════════════════════════════════════════════════════════════════
     * Everything else in this file photographs 04b from a fixture, because
     * the fixture list serves synthetic ids and the timeline endpoint 404s
     * on them by design.
     *
     * ★ A REAL id under the gate takes a different path through
     * `withDetailFixtures`: the live endpoint IS called and the response IS
     * parsed by our contract, and the substitution happens only after a
     * SUCCESSFUL read. So this one test proves the things the others cannot
     * —
     *
     *   the route answers for a real contact          (a 404 → error panel)
     *   our schema accepts what it returns            (a parse failure → null → error panel)
     *   the union, coverage and page blocks are real  (missing → parse failure)
     *
     * — while the shot is still fixture data, because the swap happens
     * before rendering. The live response is never photographed.
     *
     * Skipped rather than failed when the id is absent: a capture run that
     * cannot reach a real contact should say so, not go red.
     */
    test('04b · the live timeline read, photographed safely', async ({ page }) => {
      /*
       * ★ THE ID IS DISCOVERED, NOT SUPPLIED.
       *
       * Asking a human to paste a contact id made this test skip forever:
       * nobody has one to hand, and the gap stayed documented rather than
       * closed. The list endpoint has them, and going through the BFF gets
       * one without rendering a real person anywhere.
       *
       * No PII reaches the evidence: only an opaque id is read, it is used
       * to navigate, and the page it opens substitutes the fixture before
       * rendering. The env var still wins when set, for pinning a specific
       * contact.
       *
       * ⚠ This SPENDS a cookie rotation — `gotcha_session` rotates on every
       * BFF request. Inside the browser context that is handled by the
       * cookie jar, unlike a curl from outside, which is what made probing
       * the session so expensive before.
       */
      let realId = process.env.E2E_REAL_CONTACT_ID ?? '';
      if (!realId) {
        const probe = await page.request.post('/api/bff/api/contacts/segment', { data: {} });
        if (probe.ok()) {
          const body = (await probe.json()) as { data?: { id?: string }[] } | { id?: string }[];
          const rows = Array.isArray(body) ? body : (body.data ?? []);
          realId = rows.find((r) => typeof r?.id === 'string')?.id ?? '';
        }
      }

      test.skip(
        !realId,
        'No real contact id was discoverable and E2E_REAL_CONTACT_ID is unset, so 04b is ' +
          'evidenced only against the fixture and the live timeline read is UNEXERCISED.',
      );

      /*
       * ══════════════════════════════════════════════════════════════════════
       * ★★ ASSERT ON THE RESPONSE, BECAUSE THE SCREEN CANNOT TELL THE
       *    DIFFERENCE BETWEEN A FIELD THAT ARRIVED AND ONE THAT DEFAULTED
       * ══════════════════════════════════════════════════════════════════════
       * `coverage`, `page.types`, `totals` and `events[].id` all carry
       * defaults in our contract. That is right for resilience and it means
       * **their absence is silent**: a stale API that sends none of them
       * parses cleanly, renders a page that looks correct, and passes every
       * assertion made against the DOM.
       *
       * Ten of eleven services ran August images for a day while our
       * contracts described today's API, and nothing we photographed could
       * have told us. So this reads the raw response and asserts values the
       * SERVER could produce and our defaults could not:
       *
       *   page.types      default []      → a non-empty array is the server's
       *   coverage        default {}      → a non-empty map is the server's
       *   events[].id     default ''      → a non-empty id is the server's
       *   events[].origin default null    → a named origin is the server's
       *
       * `events[].type` needs no such check: it has NO default, so a payload
       * without it fails the parse outright and the page renders its error.
       * A required field proves itself; a defaulted one cannot.
       */
      const raw = await page.request.get(`/api/bff/api/identity/${realId}/timeline`);
      expect(raw.status(), 'the live timeline endpoint did not answer 200 for a real contact').toBe(
        200,
      );
      const payload = (await raw.json()) as {
        events?: { id?: string; type?: string; origin?: string | null; conversationId?: string }[];
        page?: { types?: string[]; limit?: number };
        coverage?: Record<string, unknown>;
        totals?: Record<string, number | boolean>;
      };

      expect(
        payload.page?.types ?? [],
        'page.types was absent or empty — our contract defaults it to [], so the screen would ' +
          'have rendered correctly against an API that never sent it. This is the shape that ' +
          'let a day of captures run against August images.',
      ).not.toHaveLength(0);

      expect(
        Object.keys(payload.coverage ?? {}),
        'coverage was absent or empty — defaulted to {} by our contract, which renders as no ' +
          'caveats at all rather than as a missing field',
      ).not.toHaveLength(0);

      expect(
        payload.totals,
        'totals was absent — defaulted to zeroes, which render as a plausible empty history',
      ).toBeDefined();
      expect(Object.keys(payload.totals ?? {})).toContain('messages');

      /*
       * Per-event, only when there are events: a contact with none is a real
       * state and not evidence about the fields.
       */
      const first = payload.events?.[0];
      if (first) {
        expect(first.id ?? '', 'events[].id was absent — defaulted to the empty string').not.toBe(
          '',
        );
        expect(
          ['message', 'handover', 'ai_action'],
          'events[].type was outside the union our contract accepts',
        ).toContain(first.type);
        /*
         * ★ `origin` is the fix that has never run. Until today the route
         * never mentioned origin, so `applyLiveByDefault` filtered imported
         * history out entirely and a long-standing customer rendered as new.
         * A named origin on the wire is proof that fix is deployed.
         */
        expect(
          ['LIVE', 'HISTORICAL_IMPORT'],
          'events[].origin was null or absent — the origin fix is not deployed, and imported ' +
            'history is being hidden exactly as it was before',
        ).toContain(first.origin);
      }

      /*
       * ★ AND 04d's READ, WHICH HAS THE SAME PROBLEM.
       *
       * The 04d capture navigates to a FIXTURE id, so it proves the fixture
       * renders. This is the only place a real commerce-context response is
       * seen — and it needs the conversation the timeline just gave us,
       * which is why it lives here rather than in its own test.
       *
       * `state` is the one field that proves itself: it has NO default, so a
       * response without it fails the parse. The assertion is that it is a
       * member of the union we render explicitly — anything else means the
       * platform grew a state and our screen is rendering nothing for it.
       */
      const conversationId = payload.events?.find((e) => e.conversationId)?.conversationId;
      if (conversationId) {
        const commerce = await page.request.get(`/api/bff/api/commerce-context/${conversationId}`);
        if (commerce.status() === 200) {
          const body = (await commerce.json()) as { state?: string };
          expect(
            [
              'not_connected',
              'connection_unhealthy',
              'customer_not_linked',
              'verification_required',
              'missing_scopes',
              'no_orders',
              'unavailable',
              'ok',
            ],
            `commerce-context answered state "${body.state}", which 04d has no sentence for — ` +
              'the union grew and the screen renders nothing for the new member',
          ).toContain(body.state);
        }
        /*
         * A non-200 is not asserted against: this endpoint is permission
         * gated on `customer:commerce:read`, and a session without it is a
         * fact about the session rather than about 04d.
         */
      }

      await page.goto(`/en/customers/${realId}`);

      /*
       * ★ THE WHOLE ASSERTION. If the live read 404s, if the response fails
       * our contract, or if the route errors, `timeline` is null and a real
       * id's failure is NOT substituted — so the error panel renders and
       * this fails. Reaching the detail block means the live read succeeded
       * and parsed.
       */
      await expect(
        page.getByTestId('customer-unavailable'),
        'the LIVE timeline read failed or did not match our contract for a real contact. ' +
          'This is the one test that exercises it; the rest of this file runs on a fixture.',
      ).toHaveCount(0);
      await expect(
        page.getByTestId('customer-detail'),
        missingIds('the 04b detail for a REAL contact'),
      ).toBeVisible({ timeout: 15_000 });

      /*
       * And the shot is still safe: the substitution ran, so what is on
       * screen is Avery Stone rather than a real person's messages. If this
       * fails, the gate did not engage and nothing may be photographed.
       */
      await expect(
        page.locator('main'),
        'the fixtures did not engage on a REAL contact id, so this page is showing a real ' +
          "person's messages. Nothing has been written.",
      ).toContainText('Avery Stone');

      await shoot(page, `${size.name}-04b-live-read`);
    });

    /*
     * ══════════════════════════════════════════════════════════════════════
     * 04d · HER ORDERS
     * ══════════════════════════════════════════════════════════════════════
     * Only ONE of the eight states is reachable here: Shopify is in ERROR on
     * this deployment, so the live answer is `connection_unhealthy` — and
     * that is exactly what a merchant on this tenant sees, which makes it the
     * state most worth photographing.
     *
     * The other seven and every order card are unit-only and on the list.
     */
    test('04d · orders, in the one state this tenant can show', async ({ page }) => {
      await openCustomer(page, 'en');

      const orders = page.getByTestId('customer-orders');
      await expect(orders, missingIds('the 04d orders block')).toBeVisible();

      /*
       * ★ WHICHEVER STATE IT IS, IT MUST BE NAMED — and never collapsed into
       * a bare error. `CommerceContextResponse`'s own comment asks the
       * frontend to render an explicit UI for each, and the whole point is
       * that five of them carry different repairs.
       *
       * Asserted by finding the state block rather than by naming one, so
       * this passes on the fixture's `ok` and on the live
       * `connection_unhealthy` without pretending to know which ran.
       */
      const named = await orders.locator('[data-state]').count();
      const cards = await page.getByTestId('order-list').count();
      expect(
        named + cards,
        'the orders block rendered neither a named state nor a list — a bare error, which is the ' +
          'one thing the eight-state union exists to prevent',
      ).toBeGreaterThan(0);

      if (cards > 0) {
        /*
         * ★ THE CHIPS ARE THE PLATFORM'S, with the platform's tone. A tone
         * we re-derived would make this screen disagree with the Inbox about
         * the same order.
         */
        const chip = orders.locator('[data-tone]').first();
        await expect(chip).toHaveText(/\S/);

        // Exactly one order expanded: three expanded is none expanded.
        expect(await page.locator('[data-expanded="yes"]').count()).toBeLessThanOrEqual(1);
      }

      /*
       * ★★ AND NOTHING ON THIS PAGE IS PRESSED.
       *
       * The order actions cancel, refund and return real orders in a live
       * store. They are built and they are never exercised by a capture —
       * their outcomes are unit-tested, including the one that matters most:
       * an unsettled result must not invite a retry.
       */
      await expect(orders).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-04d-orders`);
    });

    /*
     * ══════════════════════════════════════════════════════════════════════
     * 04e · WHAT WAS DONE IN THIS CUSTOMER'S CONTEXT
     * ══════════════════════════════════════════════════════════════════════
     * The route went live today with a gate widened specifically for this
     * screen: `crm:contacts:read` or ADMIN, so whoever can open screen 04
     * can read it. Its three siblings keep `settings:workspace:update` —
     * the export deliberately, because one constant gated all four and
     * widening it in place would have handed every agent a CSV of the whole
     * workspace log.
     *
     * ── WHAT THIS RUN CANNOT PHOTOGRAPH ──
     * `contradicts` and the name-as-hint rows. They need an emitter whose
     * recorded verdict disagrees with its own action name, and the only
     * writer of an `ok.`/`err.` action derives both from one boolean. Unit
     * tested, named unreached, and NOT fabricated into the fixture.
     */
    test('04e · the record of what was done, and what it cannot account for', async ({ page }) => {
      await openCustomer(page, 'en');

      /*
       * ★ THE FORBIDDEN PANEL IS A FAILED RUN, NOT A SCREEN.
       *
       * If it appears, the widened gate did not land in the running image —
       * which is a deploy fact worth knowing immediately, and exactly the
       * thing that would otherwise be photographed as though it were the
       * design.
       */
      await expect(
        page.getByTestId('customer-actions-forbidden'),
        'the audit route answered 403 — the widened gate is not in the running auth image',
      ).toHaveCount(0);
      await expect(
        page.getByTestId('customer-actions-failed'),
        'the customer audit read failed — this run would photograph a fault',
      ).toHaveCount(0);

      const actions = page.getByTestId('customer-actions');
      await expect(actions, missingIds('the 04e actions block')).toBeVisible();

      /*
       * ★★ EVERY ROW STATES AN OUTCOME, AND `not_recorded` IS EXPECTED TO BE
       * THE COMMON ONE.
       *
       * No customer-keyed write in this platform records `metadata.ok` —
       * `commerce.customer_action_executed` and `..._failed` both omit it.
       * So a log that is mostly "outcome not recorded" is the honest
       * picture, and a screen showing verdicts everywhere would mean
       * somebody let the action NAME decide.
       */
      const rows = await actions.locator('[data-outcome]').count();
      const empty = await page.getByTestId('actions-empty').count();
      expect(
        rows + empty,
        'the 04e block rendered neither rows nor the nothing-recorded sentence',
      ).toBeGreaterThan(0);

      if (rows > 0) {
        await expect(actions.locator('[data-outcome]').first()).toHaveText(/\S/);
      }

      /*
       * ★★ THE GAP THE SCREEN MUST STILL DECLARE.
       *
       * Order-keyed rows are not attributable at all — same id space, no
       * local Order table — so the endpoint declares it and the screen
       * prints it. An empty list cannot say why it is empty, and "nothing
       * was done" is the wrong thing for this screen to imply.
       */
      await expect(
        page.getByTestId('actions-gap-order'),
        'the order coverage gap is not on screen — a short log reading as a complete one',
      ).toBeVisible();

      await expect(actions).not.toHaveText(/\{[a-zA-Z]+\}/);

      await shoot(page, `${size.name}-04e-actions`);
    });

    /*
     * 04e · Hebrew. Its own test because the audit rows are the densest
     * mixed-direction content on the page: Latin tool names and event names
     * inside an RTL paragraph.
     */
    test('04e · Hebrew, right to left', async ({ page }) => {
      await openCustomer(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const actions = page.getByTestId('customer-actions');
      await expect(actions, missingIds('the 04e actions block in Hebrew')).toBeVisible();
      // Hebrew, not the English fallback — a missing key renders EMPTY in a
      // production build, so presence of text is not enough on its own.
      await expect(actions).toHaveText(/[֐-׿]/);

      await shoot(page, `${size.name}-04e-hebrew`);
    });
  });
}
