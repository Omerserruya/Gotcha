import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Split billing (Shopify review 132211) - acceptance evidence for the two
 * subscriptions: GOTCHA Core, billed by GOTCHA, and the Shopify Connector,
 * billed and managed by Shopify.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/settings-billing-connector.spec.ts
 *
 * ── TWO MODES ──
 * LIVE (default, e.g. dev with a real store): whatever state the store is in,
 * the Billing page's Connector section and the integration head must give the
 * SAME verdict - status, and "Shopify access" (the server's grantsAccess).
 *
 * FIXTURES (`E2E_CONNECTOR_FIXTURES=1`, against an app started with
 * `E2E_SECURITY_FIXTURES=1` on a loopback origin): every state in
 * `connector-fixtures.ts` is chosen per test by the `e2e_connector_fixture`
 * cookie (see `load-connector.ts`; ignored anywhere else).
 *
 * ── NOTHING IS WRITTEN ──
 * No click on Choose, Manage, Connect, Disconnect or any plan switch: each is
 * a real Shopify or billing action. Only what the screens SAY is asserted.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const FIXTURES = process.env.E2E_CONNECTOR_FIXTURES === '1';
const EVIDENCE = join('e2e', 'evidence', 'split-billing');

/** Mirrors CONNECTOR_FIXTURES' keys (e2e cannot import app code through its aliases). */
const STATES = [
  'core_only',
  'core_unpaid',
  'plan_selection_required',
  'approval_pending',
  'active',
  'trialing',
  'both_active',
  'past_due',
  'frozen',
  'cancelled',
  'unknown_plan',
  'error',
  'uninstall_pending',
  'uninstalled',
] as const;

/** States whose store is installed: the integration screen draws a head for them. */
const INSTALLED = new Set([
  'plan_selection_required',
  'approval_pending',
  'active',
  'trialing',
  'both_active',
  'past_due',
  'frozen',
  'cancelled',
  'unknown_plan',
  'error',
  'uninstall_pending',
]);

test.beforeAll(() => {
  if (!SESSION) {
    throw new Error(
      'GOTCHA_SESSION is not set. This spec captures authenticated screens; ' +
        'without a session it would photograph the sign-in page instead.',
    );
  }
  mkdirSync(EVIDENCE, { recursive: true });
});

test.beforeEach(async ({ context, baseURL }) => {
  const domain = new URL(baseURL ?? 'http://localhost:3000').hostname;
  await context.addCookies([
    { name: COOKIE_NAME, value: SESSION!, domain, path: '/', httpOnly: true, sameSite: 'Lax' },
  ]);
});

async function open(page: Page, path: string) {
  await page.goto(path);
  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(`Redirected to sign-in from ${path}. Set GOTCHA_SESSION to a current one.`);
  }
}

/** What the Billing page says about the Connector, and the Core it sits beside. */
async function readBilling(page: Page, locale: string) {
  await open(page, `/${locale}/settings/billing`);
  const section = page.getByTestId('connector-section');
  await expect(section, 'no Connector section on Billing').toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('core-no-shopify')).toBeVisible();
  await expect(page.getByTestId('connector-billed-by')).toBeVisible();
  // No GOTCHA payment in the Connector section: no price, no card, no link off Shopify's page.
  const text = (await section.textContent()) ?? '';
  expect(text).not.toMatch(/[$₪€£]|\bcard\b|כרטיס/);
  for (const href of await section
    .locator('a')
    .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))) {
    expect(
      href.startsWith('https://admin.shopify.com/') ||
        href.includes('/studio/capabilities') ||
        href.includes('/settings/billing/plan'),
      `unexpected link in the Connector section: ${href}`,
    ).toBe(true);
  }
  return {
    kind: await section.getAttribute('data-kind'),
    status: (
      await page.getByTestId('connector-status').locator('span').first().textContent()
    )?.trim(),
    access: await page.getByTestId('connector-access').getAttribute('data-access'),
  };
}

async function readHead(page: Page, locale: string) {
  await open(page, `/${locale}/studio/capabilities?system=shopify`);
  const head = page.getByTestId('system-head');
  if (!(await head.isVisible().catch(() => false))) return null;
  return {
    status: (await page.getByTestId('system-state').textContent())?.trim(),
    access: await page.getByTestId('system-access').getAttribute('data-access'),
    line: (await page.getByTestId('system-line').textContent())?.trim(),
  };
}

for (const locale of ['en', 'he'] as const) {
  if (FIXTURES) {
    for (const state of STATES) {
      test(`${locale} · ${state}: Billing and the integration head agree`, async ({
        page,
        context,
        baseURL,
      }) => {
        const domain = new URL(baseURL ?? 'http://localhost:3000').hostname;
        await context.addCookies([
          { name: 'e2e_connector_fixture', value: state, domain, path: '/' },
        ]);
        const billing = await readBilling(page, locale);
        await page.screenshot({
          path: join(EVIDENCE, `${state}-billing-${locale}.png`),
          fullPage: true,
        });
        if (INSTALLED.has(state)) {
          const head = await readHead(page, locale);
          expect(head, 'the Shopify head is missing for an installed store').not.toBeNull();
          expect(head!.status).toBe(billing.status);
          expect(head!.access).toBe(billing.access);
          if (billing.access !== 'true') expect(head!.line).not.toMatch(/\d/);
          await page.screenshot({
            path: join(EVIDENCE, `${state}-head-${locale}.png`),
            fullPage: true,
          });
        }
      });
    }
  } else {
    test(`${locale} · live: Billing and the integration head agree for this store`, async ({
      page,
    }) => {
      const billing = await readBilling(page, locale);
      await page.screenshot({ path: join(EVIDENCE, `live-billing-${locale}.png`), fullPage: true });
      const head = await readHead(page, locale);
      if (head) {
        expect(head.status).toBe(billing.status);
        expect(head.access).toBe(billing.access);
        // Never "Active" without the server's grant, and no count without it.
        if (billing.access !== 'true') expect(head.line).not.toMatch(/\d/);
        await page.screenshot({ path: join(EVIDENCE, `live-head-${locale}.png`), fullPage: true });
      }
    });

    test(`${locale} · live: the plan page is GOTCHA Core only`, async ({ page }) => {
      await open(page, `/${locale}/settings/billing/plan`);
      await expect(page.getByTestId('core-only')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('heading', { level: 1 })).toContainText('GOTCHA Core');
      await page.screenshot({ path: join(EVIDENCE, `live-plan-${locale}.png`), fullPage: true });
    });
  }
}
