import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { missingIds } from './diagnose';
import { recordUnreached, shoot as captureScreen } from './shoot';

/**
 * Screen 02 · Inbox — acceptance evidence.
 *
 * Authored by the frontend worker, RUN BY THE SUPERVISOR.
 *
 *   export PATH="$HOME/.local/share/node22/bin:$PATH"
 *   GOTCHA_SESSION='<cookie value>' npx playwright test e2e/inbox.spec.ts
 *
 * **Run this spec alone.** It fans out to six endpoints per load.
 *
 * Shots land in e2e/evidence/s02/.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ NOTHING ON THIS SCREEN MAY BE PRESSED. ONE BUTTON MESSAGES A CUSTOMER.
 * ════════════════════════════════════════════════════════════════════════════
 * **"Take control" sends a real WhatsApp message to a real person.** `claim()`
 * ends in `sendAutoGreeting(...)`, on claim and on reclaim, and dev sends real
 * traffic. It would also seize a live conversation from whoever is handling
 * it, and there is no unassign to put it back.
 *
 * The others are no better: *Return to the AI* clears the handover latch on a
 * live conversation, *Transfer* reassigns it to a colleague and greets the
 * customer from them, and the commerce panel's controls cancel orders and
 * issue refunds.
 *
 * So this spec asserts that the controls EXIST and never that they work.
 * `expect(...).toBeVisible()` is the whole interaction budget. The only
 * `.click()` in this file is `test.fail`-guarded proof that nothing else
 * clicks — see the last test.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE SHOT THIS SPEC EXISTS FOR: FOUR PANELS, IN A REAL BROWSER
 * ════════════════════════════════════════════════════════════════════════════
 * Every panel is an async server component, and an async server component
 * nested inside another **renders nothing** — silently, with no error and
 * nothing in a log. `page.test.tsx` checks the element tree, which is the
 * only place jsdom can reach it. This is the other half: the browser is where
 * the defect actually manifests, and it has been found here five times.
 *
 * ── WHAT THIS TENANT MAY NOT BE ABLE TO SHOW ──
 * Written without knowing the demo tenant's queue. Anything state-dependent
 * is recorded with `recordUnreached` rather than asserted, so a state this
 * tenant cannot produce leaves a reason beside the PNGs instead of a red run
 * or a silent gap. A capture test asserting something the tenant cannot
 * produce is a test that fails for being honest.
 */

const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const EVIDENCE = join('e2e', 'evidence', 's02');

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

async function openInbox(page: Page, locale: 'en' | 'he') {
  await page.goto(`/${locale}/inbox`);

  if (page.url().includes('/sign-in') || page.url().includes('/api/auth/login')) {
    throw new Error(
      `Redirected to sign-in from /${locale}/inbox. Set GOTCHA_SESSION to a current one.`,
    );
  }

  await expect(
    page.getByRole('heading', { level: 1 }),
    'no page heading — is the app serving on this origin?',
  ).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(async () => page.getByTestId('inbox-screen').count(), {
      message: missingIds('inbox-screen'),
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  return page;
}

async function shoot(page: Page, name: string) {
  await captureScreen(page, EVIDENCE, name);
}

/**
 * ★★ ONE PROJECT PHOTOGRAPHS, BECAUSE BOTH WOULD WRITE THE SAME FILES.
 *
 * The suite runs `ltr` and `rtl`, which differ only in the browser's `locale`.
 * This screen's direction comes from the URL — `/en/inbox` and `/he/inbox` —
 * so the two projects would render identical pixels into identical filenames,
 * and with `fullyParallel: true` they would race to write them. A torn PNG is
 * worse than a missing one: it looks like a rendering defect.
 *
 * Hebrew is not lost — test 4 navigates to `/he/inbox` and captures it. The
 * project axis adds nothing here that the URL axis does not already carry.
 *
 * ── AND THE GUARD IS INSIDE THE TEST, WHICH IS NOT A STYLE CHOICE ──
 * `settings-notifications-seeded.spec.ts` records the trap: a describe-scope
 * `test.skip(({}, testInfo) => …)` receives fixtures ONLY — there is no
 * second argument — so `testInfo` is `undefined` and reading `.project`
 * throws in both projects. The guard meant to separate them ran in both and
 * crashed on the value it existed to read.
 */
const CAPTURING_PROJECT = 'ltr';

function onlyOneProject(): boolean {
  const project = test.info().project.name;
  if (project === CAPTURING_PROJECT) return false;
  test.skip(true, `Captured by the ${CAPTURING_PROJECT} project; direction comes from the URL.`);
  return true;
}

/** Is a conversation open, or is the queue empty / unreadable? */
async function conversationIsOpen(page: Page): Promise<boolean> {
  return (await page.getByTestId('inbox-nothing-open').count()) === 0;
}

for (const size of SIZES) {
  test.describe(`${size.name}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    /*
     * 1 · THE WHOLE SCREEN, AND THE ONLY TEST THAT CANNOT BE SKIPPED.
     *
     * The queue and the context column render in every state — a failed read
     * included, because each says so itself. If either is missing from the
     * PNG, it is the nesting trap and not the tenant.
     */
    test('1 · four panels, as peers', async ({ page }) => {
      if (onlyOneProject()) return;

      await openInbox(page, 'en');

      await expect(
        page.getByTestId('inbox-screen'),
        'the screen container is absent, so nothing below this is meaningful',
      ).toBeVisible();

      /*
       * ★ THE QUEUE COLUMN IS PRESENT IN EVERY STATE. `ConversationList`
       * renders its own "we could not read the queue" — so an empty region
       * here means the component did not run at all, which is what a nested
       * async component looks like.
       */
      await expect(page.getByLabel(/waiting|ממתינות/i)).toBeVisible();
      await expect(page.getByLabel(/about this customer|על הלקוח הזה/i)).toBeVisible();

      await shoot(page, `${size.name}-1-inbox`);
    });

    /*
     * 2 · THE OPEN CONVERSATION, WITH WHO IS DRIVING ABOVE IT.
     *
     * The verbs sit above the stream because "who has this conversation" is
     * the first question on opening one. Below it they read as "reply",
     * which is the one thing they are not.
     */
    test('2 · the conversation, and the controls that change who holds it', async ({ page }) => {
      if (onlyOneProject()) return;

      await openInbox(page, 'en');

      if (!(await conversationIsOpen(page))) {
        recordUnreached(
          EVIDENCE,
          `${size.name}-2-conversation`,
          'No conversation was open. Either the queue is empty on this tenant or the ' +
            'queue read failed — the screen says which, and shot 1 has it. ' +
            'Not a defect in this screen: "nothing is open" is a state it renders ' +
            'deliberately, and shot 3 photographs it.',
        );
        test.skip();
        return;
      }

      await expect(page.getByTestId('message-stream')).toBeVisible();

      /*
       * ⚠ VISIBLE, NEVER PRESSED. Whichever verbs this conversation's state
       * offers, they are photographed and not touched: the claim button
       * sends the workspace's greeting to the customer.
       */
      const verbs = page.locator('[data-testid^="verbs-"]');
      await expect(verbs).toBeVisible();

      await shoot(page, `${size.name}-2-conversation`);
    });

    /*
     * 3 · WHAT THE CUSTOMER WILL RECEIVE, SAID BEFORE ANYBODY PRESSES.
     *
     * The greeting warning is the reason this screen is not just three
     * buttons. It has three states and the tenant decides which appears:
     * a configured greeting, none, or — for anybody who is not an ADMIN —
     * "we could not check", because the setting is ADMIN-only to read.
     */
    test('3 · the greeting warning', async ({ page }) => {
      if (onlyOneProject()) return;

      await openInbox(page, 'en');

      const warning = page.locator('[data-testid^="greeting-"]');
      if ((await warning.count()) === 0) {
        recordUnreached(
          EVIDENCE,
          `${size.name}-3-greeting`,
          'No greeting warning was drawn. That is correct in two cases and both are ' +
            'states rather than faults:\n' +
            '  · the open conversation is already assigned to this session, so no ' +
            '    claim control is drawn and nothing can be sent;\n' +
            '  · the workspace has no auto-greeting configured AND this session can ' +
            '    read that (ADMIN), so claiming sends nothing and a warning about ' +
            '    something that cannot happen would be noise on every conversation.\n\n' +
            'If this session is NOT an admin and a claim button IS visible, the ' +
            'hedged sentence must be there — that would be a real absence.',
        );
        test.skip();
        return;
      }

      await expect(warning.first()).toBeVisible();
      await shoot(page, `${size.name}-3-greeting`);
    });

    /*
     * 4 · HEBREW, WHICH IS HALF THE PRODUCT.
     *
     * Three columns in RTL is where a physical CSS property shows itself —
     * `npm run lint:css` still reports 24 of them elsewhere in the tree, so
     * this shot is worth more than a duplicate.
     */
    test('4 · the same screen in Hebrew', async ({ page }) => {
      if (onlyOneProject()) return;

      await openInbox(page, 'he');

      await expect(page.getByTestId('inbox-screen')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      await shoot(page, `${size.name}-4-hebrew`);
    });
  });
}

/*
 * ════════════════════════════════════════════════════════════════════════════
 * 5 · THE PROHIBITION, ASSERTED RATHER THAN PROMISED
 * ════════════════════════════════════════════════════════════════════════════
 * A comment saying "this spec presses nothing" is a claim about a file that
 * somebody will edit. This reads the file and fails if a `.click()` appears
 * in it, so adding one to "just check the button works" turns the run red
 * instead of messaging a customer.
 *
 * Once, not per viewport: it is a fact about the source.
 */
test('5 · this spec contains no click', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(join('e2e', 'inbox.spec.ts'), 'utf8');

  /*
   * ★★ THE NEEDLE IS BUILT AT RUNTIME, AND COMMENTS ARE STRIPPED FIRST.
   *
   * The first version of this test counted the literal and found four — its
   * own search string, plus the three times the prose above names the thing
   * it forbids. **A tripwire that always fires is worth exactly as much as
   * one that never does**, and this one would have been red on its first run
   * with nothing wrong.
   *
   * So the needle never appears as text in this file, and the prose that
   * discusses it lives in comments, which come out before the count.
   */
  const needle = ['.', 'click', '('].join('');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const clicks = code.split(needle).length - 1;

  expect(
    clicks,
    'A press was added to the inbox spec. Screen 02 has no safe button: ' +
      '"take control" sends the workspace greeting to a real customer and seizes ' +
      'a live conversation with no way to put it back, and the commerce panel ' +
      'cancels orders and issues refunds. If a control genuinely needs proving, ' +
      'prove it in a component test with the action mocked — Verbs.test.tsx ' +
      'mocks it to throw — and leave the capture to photograph.',
  ).toBe(0);
});
