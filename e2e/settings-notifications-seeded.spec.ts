import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIResponse, type Page } from '@playwright/test';

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
 * ── WHY IT WRITES AT ALL ──
 * This tenant has zero rules, so the rule list — which carries this screen's
 * consequential judgements — cannot otherwise be photographed. Authorized by
 * the supervisor on two verified claims:
 *
 *   `engine:125`  the dispatcher's own query is `enabled: true`, so a rule
 *                 created disabled cannot reach `deliverChannel` at all
 *   `DELETE`      `findFirst({id, tenantId})` then `prisma.delete({id})` —
 *                 plain and tenant-scoped, with no cascade, unlike
 *                 `DELETE /api/channels/:id` which 500s for every channel
 *
 * ── THE SIX CONDITIONS, AS CODE RATHER THAN AS CARE ──
 * Every one of these is an assertion that stops the run, because the last time
 * a probe was run by hand on this project it 500'd and left a channel behind.
 *
 *   1. `enabled: false` passed as the LITERAL false — the route's check is
 *      `b.enabled !== false`, so any other falsy value would enable the rule.
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
 * ── WHAT THIS CANNOT SHOW, AND WHY ──
 * **The shadowing sentence does not appear here.** `shadowedRuleIds` excludes
 * disabled rules on both sides — correctly, because the engine's own query
 * filters `enabled: true`, so a switched-off department rule displaces
 * nothing. Condition 1 and the shadowing shot are therefore mutually
 * exclusive, and condition 1 wins. Shadowing stays asserted in
 * `rule-view.test.ts` and is not photographed.
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

/*
 * One project only.
 *
 * The suite runs `ltr` and `rtl` against the same tenant, so both would create
 * a rule at once and each would see the other's row and trip condition 2 —
 * reporting "something else wrote" when the something else was us. The
 * read-only spec covers Hebrew; this one supplements it with a single shot,
 * and correctness of the guard matters more here than a second locale.
 */
test.skip(
  ({}, testInfo) => testInfo.project.name !== 'ltr',
  'Seeded captures run in the ltr project only, so the two projects cannot race the rule count.',
);

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

test('1 · the rule list, with a rule in it', async ({ page }) => {
  // ── condition 2 ────────────────────────────────────────────────────────
  countBefore = (await listRules(page)).length;
  expect(
    countBefore,
    `expected 0 rules before seeding, found ${countBefore}. Something else wrote to this ` +
      'tenant, so this spec is no longer the only writer and must not create more. Stop and report.',
  ).toBe(0);

  // ── condition 1 ────────────────────────────────────────────────────────
  const response = await page.request.post('/api/bff/api/notification-preferences', {
    headers: WRITE_HEADERS,
    data: {
      eventType: 'payment.failed',
      departmentId: null,
      recipients: { type: 'tenant_owner' },
      channels: ['email', 'in_app'],
      // The LITERAL false. `b.enabled !== false` enables the rule for any
      // other value, including 0, '' and null.
      enabled: false,
    },
  });
  expect(response.status(), `creating the seed rule: ${await response.text()}`).toBe(201);

  // ── condition 3 · recorded before anything else happens ────────────────
  const row = (await body(response)).data as { id?: string; enabled?: boolean } | undefined;
  expect(row?.id, 'the create returned no id, so teardown could not delete it').toBeTruthy();
  created.push(row!.id!);

  // And the row must have come back DISABLED. If the route stored it enabled,
  // the inertness argument this whole spec rests on is void.
  expect(
    row!.enabled,
    'the rule was stored ENABLED — the inertness guarantee is void, delete it and stop',
  ).toBe(false);

  await page.goto('/en/settings/notifications');
  await expect(page.getByTestId('rule-list')).toBeVisible({ timeout: 15_000 });

  const rule = page.getByTestId(`rule-${created[0]}`);
  await expect(rule).toBeVisible();
  await expect(rule).toHaveAttribute('data-enabled', 'no');

  // The event, in business language and grouped under its own heading.
  await expect(page.getByTestId('group-payment.failed')).toBeVisible();
  // Who, on what, and how far it reaches — asserted by content.
  await expect(rule).toHaveText(/account owner/i);
  await expect(rule).toHaveText(/email/i);
  await expect(page.getByTestId(`scope-${created[0]}`)).toHaveText(/every team/i);
  // And the reason it does nothing, stated as a consequence.
  await expect(page.getByTestId(`disabled-${created[0]}`)).toHaveText(/nobody is told/i);

  await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);

  await page.screenshot({ path: join(EVIDENCE, '1440-7-rule-list.png'), fullPage: true });
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
