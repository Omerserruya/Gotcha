import { expect, test } from '@playwright/test';

/**
 * ★★ NOTHING IS CUT ON A LAPTOP HEIGHT (Omer on a 14", 2026-10-07).
 *
 * The supervisor's scan, kept: on each main screen, at the heights a laptop
 * with a toolbar actually has, no element that hides or clips its overflow
 * may hold more text than it shows - and the page never scrolls sideways.
 * Measured before the fix: Employees' strip 11/70px and Home's team card
 * 38/146 at 1280×720. The static rule is `src/no-clipped-cards.test.ts`;
 * this is what sees the real screens with real data.
 *
 * ★ `clip` counts as well as `hidden`: the fix moved cards to `clip`, and a
 *   scan of `hidden` alone would pass a clipped card it can no longer see.
 * ★ A box that scrolls on purpose (`overflow: auto`) is not counted - its
 *   content is reachable. A box INSIDE one still is: scrolling its parent
 *   never shows what the box itself cuts (Employees' strip was exactly that).
 * ★ Text cut on purpose (a line clamp, an ellipsis) does not count.
 *
 * Run (needs a session, like every spec here):
 *   GOTCHA_SESSION='<cookie>' [E2E_CONVERSATION_ID=…] [E2E_EMPLOYEE_ID=…] \
 *     npx playwright test e2e/no-clipping.spec.ts --project=ltr
 */
const SESSION = process.env.GOTCHA_SESSION;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'gotcha_session';
const BASE = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3000');

const SIZES = [
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
] as const;

const ROUTES = [
  '/home',
  '/inbox',
  '/approvals',
  '/customers',
  '/outreach',
  '/studio/employees',
  '/studio/knowledge',
  '/studio/skills',
  '/studio/automations',
  '/studio/integrations',
  '/analytics',
  '/settings/channels',
  '/settings/workspace',
  '/settings/billing',
  ...(process.env.E2E_CONVERSATION_ID ? [`/inbox?c=${process.env.E2E_CONVERSATION_ID}`] : []),
  ...(process.env.E2E_EMPLOYEE_ID
    ? [`/studio/employees/${process.env.E2E_EMPLOYEE_ID}/skills`]
    : []),
];

test.beforeAll(() => {
  if (!SESSION) {
    throw new Error('GOTCHA_SESSION is not set: without one this scans the sign-in page.');
  }
});

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: SESSION!,
      domain: BASE.hostname,
      path: '/',
      httpOnly: true,
      secure: BASE.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
});

for (const size of SIZES) {
  for (const route of ROUTES) {
    test(`${size.width}×${size.height} ${route}: nothing cut, no sideways scroll`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto(`${BASE.pathname.replace(/\/$/, '')}/en${route}`);
      expect(page.url(), 'redirected to sign-in: the session is not current').not.toMatch(
        /sign-in|api\/auth\/login/,
      );
      // The streamed sections land, as the supervisor's scan waited for them.
      await page.waitForLoadState('networkidle');

      const found = await page.evaluate(() => {
        const cut: string[] = [];
        const hides = (v: string) => v === 'hidden' || v === 'clip';
        for (const el of document.querySelectorAll<HTMLElement>('main *, [role=dialog] *')) {
          const cs = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          // Width only: a box squeezed to 0px tall is the worst cut, not nothing.
          if (box.width < 4) continue;
          if (!hides(cs.overflowY)) continue;
          if (el.scrollHeight <= el.clientHeight + 2) continue;
          if (!el.innerText?.trim()) continue;
          if (cs.webkitLineClamp !== 'none' || cs.textOverflow === 'ellipsis') continue;
          cut.push(`${el.tagName}.${el.className} ${el.clientHeight}/${el.scrollHeight}`);
        }
        const sideways =
          document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
        return { cut, sideways };
      });

      expect(found.cut, 'content cut by its own box').toEqual([]);
      expect(found.sideways, 'the page scrolls sideways').toBe(false);
    });
  }
}

/*
 * ★★ A WINDOW WITH MORE SAYS SO (Omer on a 14", 2026-10-07). At 1512×760 - his
 * screen - every box that scrolls inside itself and has content below its
 * edge carries `data-more`, the fade (ScrollFades). A Mac hides the
 * scrollbar; a row cut through the middle with no hint read as broken.
 */
for (const route of ROUTES) {
  test(`1512×760 ${route}: every window with more fades at its edge`, async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 760 });
    await page.goto(`${BASE.pathname.replace(/\/$/, '')}/en${route}`);
    expect(page.url(), 'redirected to sign-in: the session is not current').not.toMatch(
      /sign-in|api\/auth\/login/,
    );
    await page.waitForLoadState('networkidle');
    const silent = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('main *, [role=dialog] *')]
        .filter((el) => {
          const o = getComputedStyle(el).overflowY;
          if (o !== 'auto' && o !== 'scroll') return false;
          if (el.getBoundingClientRect().width < 4) return false;
          return (
            el.scrollHeight - el.scrollTop - el.clientHeight > 4 && !el.hasAttribute('data-more')
          );
        })
        .map((el) => `${el.tagName}.${el.className} ${el.clientHeight}/${el.scrollHeight}`),
    );
    expect(silent, 'a window with more and no fade').toEqual([]);
  });
}
