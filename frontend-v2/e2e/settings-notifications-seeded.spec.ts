import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIResponse, type Page } from '@playwright/test';

import { shoot } from './shoot';

/**
 * Screen 15 · Settings · Notifications — the rule list, photographed.
 *
 * **THIS SPEC WRITES TO THE TENANT.** It is opt-in and off by default:
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   E2E_SEED_RULES=1 GOTCHA_SESSION='<cookie>' \
 *     npx playwright test e2e/settings-notifications-seeded.spec.ts
 *
 * Without `E2E_SEED_RULES=1` every test skips. `settings-notifications.spec.ts`
 * is the read-only evidence and needs no flag.
 *
 * `APP_ORIGIN` here must match the server's own `APP_ORIGIN`, because the BFF
 * refuses every state-changing request whose `Origin` does not. A mismatch
 * shows up as `{"error":"Cross-origin request rejected."}` on the create,
 * which is a config difference between this shell and the server, not a fault
 * in the screen.
 *
 * ── WHY IT WRITES AT ALL ──
 * This tenant has zero rules, so the rule list — which carries this screen's
 * consequential judgements — cannot otherwise be photographed. Authorized by
 * the supervisor on two verified claims:
 *
 *   `system.error.critical` is raised by NOTHING. It has two union
 *   declarations, a template, a category map and a migration comment, and
 *   zero emitters anywhere in the platform — derived twice by different
 *   routes, and the one dynamic emit path (`ai-bot.service.ts:1979`) resolves
 *   to refund/discount/meeting, so no `type: <variable>` hides another.
 *
 *   That is a stronger guarantee than `enabled: false`, which rests on a
 *   single `where` clause in a single query. "Nothing in the codebase raises
 *   this event" is a property of the whole repository. The rules here are
 *   therefore created ENABLED, deliberately: it is the event that makes them
 *   inert, not the flag, and it buys the two sentences that matter as real
 *   evidence rather than as unit-tested assertions.
 *
 *   `recipients: { type: 'tenant_owner' }` on both, so that if every check any
 *   of us made is somehow wrong, the blast radius is one email to the dev
 *   account that owns this tenant — bounded by construction rather than by
 *   our confidence.
 *
 *   `DELETE` is `findFirst({id, tenantId})` then `prisma.delete({id})` —
 *   plain and tenant-scoped, with no cascade, unlike
 *   `DELETE /api/channels/:id` which 500s for every channel type.
 *
 * ── THE SIX CONDITIONS, AS CODE RATHER THAN AS CARE ──
 * Every one of these is an assertion that stops the run, because the last time
 * a probe was run by hand on this project it 500'd and left a channel behind.
 *
 *   1. the stored `eventType` is re-read and must be exactly
 *      `system.error.critical`. That string IS the inertness guarantee, so if
 *      the route stored anything else the argument is void and the run stops.
 *   2. the tenant must hold 0 rules before anything is created; if not, stop —
 *      something else wrote and this spec is no longer the only writer.
 *   3. every created id is recorded the instant it is returned, before any
 *      screenshot, so teardown never depends on a later list query.
 *   4. deletion happens in this same run, in `afterAll`, not by hand after.
 *   5. the count is taken again afterwards and must be 0 — reported as a
 *      number, never as "cleaned up".
 *   6. a DELETE that does not answer `{ deleted: true }` fails the run loudly
 *      and is never retried down a second path.
 *
 * ── WHAT THIS IS FOR ──
 * Two rules on one event, one tenant-wide and one scoped to a department, so
 * that the screen's two most consequential sentences are in evidence rather
 * than only in `rule-view.test.ts`:
 *
 *   - **"GOTCHA never raises this event, so this rule can never fire."** Which
 *     is not hypothetical: the OLD app's notifications page offers
 *     `system.error.critical` as a configurable event today, so a customer can
 *     already have built exactly this rule.
 *   - **"GOTCHA uses the team's rule instead of this one — never both."** The
 *     tenant-wide rule is displaced by the department one, and both read as
 *     enabled. That silent override is this screen's finding.
 *
 * If the tenant has no departments, the second rule cannot be created and the
 * shadowing shot is skipped with a message saying so — never quietly dropped.
 */

const SESSION = process.env.GOTCHA_SESSION;
const SEED = process.env.E2E_SEED_RULES === '1';
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:3000';
const EVIDENCE = join('e2e', 'evidence', 's15');

/**
 * Serial, not parallel. Two workers counting and creating against the same
 * table would each see the other's rows and condition 2 would fire on a race
 * rather than on a real second writer — the screen 11 stale-write lesson.
 */
test.describe.configure({ mode: 'serial' });

/** Ids of everything this run created. Written before any screenshot. */
const created: string[] = [];
/** Reported at the end as numbers, per condition 5. */
let countBefore = -1;
let countAfter = -1;

test.skip(!SEED, 'E2E_SEED_RULES is not set. This spec writes to the tenant and is opt-in.');

/**
 * One project only.
 *
 * The suite runs `ltr` and `rtl` against the same tenant, so both would create
 * a rule at once and each would see the other's row and trip condition 2 —
 * reporting "something else wrote" when the something else was us. The
 * read-only spec covers Hebrew; this one supplements it with a single shot,
 * and correctness of the guard matters more here than a second locale.
 *
 * ── WHY THE GUARD LIVES INSIDE THE TEST AND NOT AT DESCRIBE SCOPE ──
 * The first attempt was `test.skip(({}, testInfo) => …)` here. **The
 * describe-scope callback receives fixtures only — there is no second
 * argument** — so `testInfo` was `undefined` and reading `.project` threw in
 * both projects. The guard that existed to stop the two projects racing was
 * itself running in both and crashing on the value it was meant to read.
 *
 * It failed safe, before any write, and the tenant was left clean. That was
 * luck about ordering rather than design, so the guard now sits in two places
 * that are not luck:
 *
 *   1. the first statement of the test, which is the earliest point a project
 *      name is knowable — `beforeAll` only creates a directory and checks for
 *      a cookie, so nothing can be written before it
 *   2. inside `seedRule`, immediately before the POST — **a guard at the
 *      write site cannot be outrun by anything**, however the file is later
 *      rearranged
 */
const WRITING_PROJECT = 'ltr';

test.beforeAll(() => {
  if (!SESSION) {
    throw new Error('GOTCHA_SESSION is not set; this spec cannot authenticate.');
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

/** The BFF refuses a state-changing request without a matching `Origin`. */
const WRITE_HEADERS = { Origin: ORIGIN, 'Content-Type': 'application/json' };

async function body(response: APIResponse): Promise<{ data?: unknown; error?: unknown }> {
  const text = await response.text();
  try {
    return JSON.parse(text) as { data?: unknown; error?: unknown };
  } catch {
    throw new Error(
      `expected JSON from ${response.url()} (status ${response.status()}), got: ${text.slice(0, 200)}`,
    );
  }
}

async function listRules(page: Page): Promise<{ id: string }[]> {
  const response = await page.request.get('/api/bff/api/notification-preferences');
  expect(response.status(), 'listing the tenant rules').toBe(200);
  const parsed = await body(response);
  expect(Array.isArray(parsed.data), 'the rules list should be an array').toBe(true);
  return parsed.data as { id: string }[];
}

/**
 * The event these rules are written against, and the reason they are inert.
 *
 * Nothing in the platform emits it: two union declarations, one template, a
 * category map and a migration comment, and zero emitters — derived twice by
 * different routes. Kept as a constant so the assertion that it round-tripped
 * intact reads against the same string that was sent.
 */
const INERT_EVENT = 'system.error.critical';

/** Creates a rule, records its id immediately, and returns the stored row. */
async function seedRule(
  page: Page,
  projectName: string,
  departmentId: string | null,
): Promise<{ id: string }> {
  /*
   * The guard at the write site. The skip at the top of the test should have
   * made this unreachable — but the last version of that skip crashed instead
   * of skipping, so "should have" is not a property worth relying on when the
   * consequence is a row on a real tenant.
   */
  expect(
    projectName,
    'a non-writing project reached seedRule — the project guard did not hold',
  ).toBe(WRITING_PROJECT);

  const scope = departmentId === null ? 'tenant-wide' : 'department';
  const response = await page.request.post('/api/bff/api/notification-preferences', {
    headers: WRITE_HEADERS,
    data: {
      eventType: INERT_EVENT,
      departmentId,
      // Bounded blast radius: the owner of this tenant is the dev test account.
      recipients: { type: 'tenant_owner' },
      channels: ['in_app'],
      enabled: true,
    },
  });
  expect(response.status(), `creating the ${scope} rule: ${await response.text()}`).toBe(201);

  // ── condition 3 · recorded the instant it returns, before anything else ──
  const row = (await body(response)).data as { id?: string; eventType?: string } | undefined;
  expect(row?.id, 'the create returned no id, so teardown could not delete it').toBeTruthy();
  created.push(row!.id!);

  /*
   * ── condition 1 · the inertness guarantee, re-read from the stored row ──
   * The entire authorisation for this write is that nothing emits this event.
   * If the route trimmed, defaulted or rewrote the type to anything else, that
   * argument is void and the rule may be able to fire. Fail here — `afterAll`
   * still deletes it, because the id was recorded above.
   */
  expect(
    row!.eventType,
    'the stored eventType is not the inert one — this rule may be able to fire, stop and report',
  ).toBe(INERT_EVENT);

  return { id: row!.id! };
}

test('1 · the rule list: an event that cannot fire, and a rule that is overridden', async ({
  page,
}, testInfo) => {
  /*
   * The project guard, as the first statement of the test. `testInfo` is a
   * real argument here — unlike in a describe-scope `test.skip` callback,
   * which is where the previous version of this crashed.
   */
  test.skip(
    testInfo.project.name !== WRITING_PROJECT,
    `Seeded captures write to the tenant and run in the ${WRITING_PROJECT} project only, ` +
      'so the two projects cannot race the rule count.',
  );

  // ── condition 2 ────────────────────────────────────────────────────────
  countBefore = (await listRules(page)).length;
  expect(
    countBefore,
    `expected 0 rules before seeding, found ${countBefore}. Something else wrote to this ` +
      'tenant, so this spec is no longer the only writer and must not create more. Stop and report.',
  ).toBe(0);

  // A department to scope the second rule to. Without one there is nothing for
  // the tenant-wide rule to be displaced BY, and that half is skipped with a
  // note rather than quietly dropped.
  const departmentsResponse = await page.request.get('/api/bff/api/departments');
  expect(departmentsResponse.status(), 'reading the tenant departments').toBe(200);
  const departments = ((await body(departmentsResponse)).data ?? []) as { id: string }[];

  const project = testInfo.project.name;
  const wide = await seedRule(page, project, null);
  const scoped = departments.length > 0 ? await seedRule(page, project, departments[0]!.id) : null;

  await page.goto('/en/settings/notifications');
  await expect(page.getByTestId('rule-list')).toBeVisible({ timeout: 15_000 });

  /*
   * Grouped under the RAW type, not a business-language name. There is no
   * friendly name for a type the product does not raise, and the raw string is
   * what an admin needs in order to find and remove the row.
   */
  const group = page.getByTestId(`group-${INERT_EVENT}`);
  await expect(group).toBeVisible();
  await expect(group).toHaveAttribute('data-status', 'unfiring');
  await expect(group).toHaveText(new RegExp(INERT_EVENT.replace(/\./g, '\\.')));

  // ── the first sentence: a rule that can never fire, and says so ─────────
  await expect(page.getByTestId(`unfiring-${INERT_EVENT}`)).toHaveText(/never raises this event/i);

  const wideRule = page.getByTestId(`rule-${wide.id}`);
  await expect(wideRule).toBeVisible();
  // Enabled, and still useless. That is the whole point of the flag above it.
  await expect(wideRule).toHaveAttribute('data-enabled', 'yes');
  await expect(wideRule).toHaveText(/account owner/i);
  await expect(page.getByTestId(`scope-${wide.id}`)).toHaveText(/every team/i);

  if (scoped) {
    // ── the second sentence: the silent override, in evidence ────────────
    await expect(page.getByTestId(`rule-${scoped.id}`)).toBeVisible();
    await expect(page.getByTestId(`shadowed-${wide.id}`)).toHaveText(/instead of this one/i);
    // The rule doing the displacing is not itself marked as displaced.
    await expect(page.getByTestId(`shadowed-${scoped.id}`)).toHaveCount(0);
    // And a department rule must never be drawn as reaching every team.
    await expect(page.getByTestId(`scope-${scoped.id}`)).not.toHaveText(/every team/i);
  } else {
    testInfo.annotations.push({
      type: 'note',
      description:
        'This tenant has no departments, so nothing can displace anything and the shadowing ' +
        'sentence is not in this evidence. It stays asserted in rule-view.test.ts.',
    });
  }

  await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);

  /*
   * ★ THE ONE SHOT IN THE PROJECT THAT WAS NOT TAKEN THROUGH `shoot()`.
   *
   * It survived the fix to every other spec because the sweep keyed on the
   * FUNCTION NAME rather than on the behaviour, and this file writes its
   * screenshot inline. Being opt-in behind `E2E_SEED_RULES` is what would
   * have kept it truncated indefinitely: the run that would have exposed it
   * is the one nobody starts by default.
   *
   * The rule list is the longest list on the screen and precisely the thing
   * a reader scrolls, so this was among the worst shots to lose below the
   * fold.
   */
  await shoot(page, EVIDENCE, '1440-7-rule-list');
});

/** ── conditions 4, 5 and 6 ───────────────────────────────────────────── */
test.afterAll(async ({ browser }) => {
  if (!SEED || created.length === 0) return;

  const context = await browser.newContext();
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
  const page = await context.newPage();

  const failures: string[] = [];
  for (const id of created) {
    const response = await page.request.delete(`/api/bff/api/notification-preferences/${id}`, {
      headers: { Origin: ORIGIN },
    });
    const parsed = await body(response).catch(() => ({ data: undefined }));
    const deleted = (parsed.data as { deleted?: boolean } | undefined)?.deleted;
    if (response.status() !== 200 || deleted !== true) {
      // Condition 6: no retry, no second path. Say exactly what is left behind.
      failures.push(`${id} → status ${response.status()}, deleted=${String(deleted)}`);
    }
  }

  countAfter = (await listRules(page)).length;
  await context.close();

  if (failures.length > 0) {
    throw new Error(
      `TEARDOWN FAILED — rules are still on the tenant and must be removed by hand:\n  ` +
        `${failures.join('\n  ')}\nRule count before: ${countBefore}, after: ${countAfter}.`,
    );
  }

  expect(
    countAfter,
    `rule count before: ${countBefore}, after: ${countAfter} — the tenant must be left as found`,
  ).toBe(0);

  /*
   * Condition 5 wants a number, not a claim. Written beside the screenshot so
   * the evidence carries its own proof that the tenant was left as found,
   * rather than that proof living in a terminal someone has since closed.
   */
  writeFileSync(
    join(EVIDENCE, 'seed-counts.txt'),
    `rules before: ${countBefore}\ncreated:      ${created.length}\nrules after:  ${countAfter}\n`,
  );
});
