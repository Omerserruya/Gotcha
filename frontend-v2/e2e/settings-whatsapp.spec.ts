import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';
import { shoot as captureScreen } from './shoot';

/**
 * Screen 13 · Settings · WhatsApp numbers — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/settings-whatsapp.spec.ts
 *
 * Shots land in e2e/evidence/s13/.
 *
 * ── ONE CARD IS REACHABLE, AND THIS SPEC ONLY CLAIMS THAT ONE ──
 * Measured before writing:
 *
 *     whatsapp_numbers          ZERO rows, whole database
 *     whatsapp_number_events    ZERO rows
 *     inbound_exclusions        ZERO for this tenant
 *     channel_accounts          WHATSAPP · CONNECTED · "Demo WhatsApp"
 *
 * So `data` is empty and `unprofiled` has exactly one entry. **Every state
 * that matters is unreachable here** — outbound blocked, a repair we can run,
 * a fix that belongs to Meta, the registration case, the audit trail.
 *
 * Those are asserted in `WhatsAppNumbers.test.tsx`, where the branch can
 * actually be reached. **An absence assertion on this page would pass against
 * a blank one**, so this spec asserts by content what IS here and does not
 * pretend the rest was covered by photographing its absence.
 *
 * ── AND THAT INCLUDES THE TEMPLATES-PAUSED BANNER ──
 * The banner Omer asked for by name is built, and it cannot appear here. It
 * renders from `healthSnapshot.entities[].entity_type === "MESSAGE_TEMPLATE"`
 * with `can_send_message === "BLOCKED"`, and only a number with a lifecycle
 * row carries a snapshot — `data` is empty on every tenant on this database.
 *
 * So there is NO capture assertion for it, not even an absence one. Absent
 * here is indistinguishable from absent everywhere, and a green
 * `not.toHaveText(/templates are paused/i)` would be reporting that a feature
 * works when it has never once been rendered. Nine component tests cover it,
 * including the two cases the copy turns on: that Meta's reason is quoted
 * rather than asserted, and that "replies still go out" is gated on the
 * number actually receiving.
 *
 * ── NOTHING IS WRITTEN ──
 * Every verb on this router reconfigures a live messaging channel: `repair`
 * calls Meta, `resume` runs a registration, `DELETE` disconnects a number a
 * business receives customer messages on. There is no `.click()` here.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's13');

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

async function openWhatsApp(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/settings/channels/whatsapp`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/settings/channels/whatsapp. ` +
        'Set GOTCHA_SESSION to a current one.',
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  await expect(
    page.getByTestId('whatsapp-numbers'),
    missingIds('the numbers list this screen emits'),
  ).toBeVisible({ timeout: 15_000 });

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

    /*
     * ★ 1 · THE ONLY CARD THIS TENANT HAS.
     *
     * A WhatsApp channel connected before per-number health existed. It is
     * working, and NOTHING is known about it — which is neither healthy nor
     * broken, and the card must imply neither.
     *
     * The route surfaces these "rather than hiding them, because a number the
     * customer can see in their inbox but not on this page reads as a bug".
     * So the first thing asserted is that it is HERE at all.
     */
    test('1 · connected, with nothing known, and not hidden', async ({ page }) => {
      if (onlyOneProject()) return;

      await openWhatsApp(page, 'en');

      const card = page.getByTestId('whatsapp-unprofiled');
      await expect(card).toBeVisible();
      await expect(card).toHaveText(/no health information/i);

      const body = page.getByTestId('whatsapp-unprofiled-body');
      // Says it works — not "unknown", which would read as broken.
      await expect(body).toHaveText(/connected and working/i);
      // And says WHY there is nothing more, plus what would change it.
      await expect(body).toHaveText(/before GOTCHA could check individual numbers/i);
      await expect(body).toHaveText(/reconnecting it would enable both/i);

      // The workspace is not empty, and must not say it is.
      await expect(page.getByTestId('whatsapp-empty')).toHaveCount(0);

      await shoot(page, `${size.name}-1-unprofiled`);
    });

    /*
     * 2 · no repair is offered for a number that cannot take one.
     *
     * Every repair verb addresses a `WhatsAppNumber` record, and this channel
     * has none — so a button here would fail on every press. The platform's
     * rule for the analogous case is the reason: "offering one and having it
     * fail is worse than saying plainly that this one is theirs to fix."
     *
     * These absence assertions are worth running BECAUSE the same page renders
     * those ids for a profiled number. They are absent here for a reason, not
     * because the screen is blank — test 1 has already proved it is not.
     */
    test('2 · nothing is offered that could not work', async ({ page }) => {
      if (onlyOneProject()) return;

      await openWhatsApp(page, 'en');

      await expect(page.getByTestId('whatsapp-unprofiled')).toBeVisible();

      await expect(page.getByTestId('whatsapp-repairs')).toHaveCount(0);
      await expect(page.getByTestId('whatsapp-register')).toHaveCount(0);
      await expect(page.getByTestId('whatsapp-customer-actions')).toHaveCount(0);
      // And no delivery verdict, because there is no health to derive one from.
      await expect(page.getByTestId('whatsapp-delivery-detail')).toHaveCount(0);

      await shoot(page, `${size.name}-2-no-false-actions`);
    });

    /*
     * 3 · Hebrew, right to left.
     *
     * The route's `note` ships in ENGLISH ONLY — there is no `noteHe` — so
     * this card's explanation is translated in our catalogue rather than
     * rendered verbatim. That is the opposite call from the billing estimate
     * disclaimer, which ships translated and is a commercial claim; this is an
     * operational explanation with no Hebrew available, and English on the one
     * card a Hebrew tenant can see is the worse of the two errors.
     */
    test('3 · Hebrew', async ({ page }) => {
      if (onlyOneProject()) return;

      await openWhatsApp(page, 'he');

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      const body = page.getByTestId('whatsapp-unprofiled-body');
      await expect(body).toBeVisible();
      await expect(body).toHaveText(/[֐-׿]/);
      // The whole explanation, not a Hebrew heading over English prose.
      await expect(body).not.toHaveText(/connected and working/i);

      await shoot(page, `${size.name}-3-hebrew`);
    });
  });
}
