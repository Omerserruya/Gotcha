import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

/**
 * Take a screenshot that actually contains the screen.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ `fullPage: true` IS INERT IN THIS APP, AND EVERY SHOT WE HAVE EVER TAKEN
 *    WAS ONE VIEWPORT TALL
 * ════════════════════════════════════════════════════════════════════════════
 * `AppShell.module.css` gives `.frame` `block-size: 100dvh` and
 * `overflow: hidden`, and puts `overflow-y: auto` on `main`. **The document
 * never scrolls — `main` does.** So `documentElement.scrollHeight` is exactly
 * the viewport height, `fullPage` has nothing to extend to, and Playwright
 * faithfully captures the first screenful.
 *
 * Measured across the whole evidence set: **444 of 445 PNGs are exactly
 * 1440x900, 1280x800 or 390x844.** Not one shot in eighteen screens shows
 * anything below the fold.
 *
 * ── AND THE REAL DAMAGE IS NOT THE CROPPING ──
 * The screens differ only below the fold, so the shots do not just lose
 * content — **they collide.** In `s04`, 48 files hold 18 distinct images:
 * `1280-04b-customer`, `1280-04b-live-read`, `1280-04d-orders`,
 * `1280-04e-actions` and `1280-04f-notes` are one md5. A file named
 * `04d-orders` containing no orders is not a cropped photograph of the
 * orders panel; it is a picture of something else under that name.
 *
 * The assertions were real and they passed. They ran against the DOM, which
 * was complete. **Nothing in a Playwright run looks at the file it just
 * wrote**, so the one artifact a human would actually inspect was the one
 * thing nobody checked — for eighteen screens and five months of evidence.
 *
 * ── WHAT THIS DOES ──
 * Grows the viewport to the height of the real scroll container, so `main`'s
 * own box grows with it and `fullPage` finally has something to capture.
 * Then restores it, so the next assertion sees the layout it expects.
 *
 * ── AND IT CHECKS ITS OWN OUTPUT ──
 * The PNG header is read back and the height asserted. That is the check the
 * original could not fail: it asked for a full page, got a viewport, and had
 * no way to notice. **A tool that cannot fail is not a check** — four of them
 * today reported safety about a region they could not see, and this is the
 * fifth, caught by looking at the artifact rather than the intent.
 */

/**
 * Chrome's compositor tops out well below its texture limit and a shot this
 * tall is unreadable anyway.
 *
 * ★ EXCEEDING IT THROWS. It must never clamp and shoot: a silently clipped
 * screenshot is the defect this file exists for, in a smaller box. A page
 * genuinely taller than this needs a decision — split the shot, or narrow
 * what is on screen — and that decision belongs to whoever is looking, not
 * to a default.
 */
const MAX_SHOT_HEIGHT = 12_000;

/** Breathing room below the last element, so nothing sits on the edge. */
const FOOT = 80;

/** The height of a PNG, read from its IHDR. */
function pngHeight(path: string): number {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(24);
    readSync(fd, header, 0, 24, 0);
    // 8-byte signature, 4 length, 4 "IHDR", 4 width, 4 height.
    return header.readUInt32BE(20);
  } finally {
    closeSync(fd);
  }
}

/**
 * The height the shot has to cover.
 *
 * `main` is this shell's scroll container. The fallback is the document, for
 * any page outside the shell — sign-in renders its own `100dvh` frame with no
 * `main` at all, and would otherwise measure as zero.
 */
async function contentHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const doc = document.documentElement;
    return Math.max(main?.scrollHeight ?? 0, doc.scrollHeight, document.body.scrollHeight);
  });
}

export async function shoot(page: Page, evidenceDir: string, name: string): Promise<void> {
  const path = join(evidenceDir, `${name}.png`);
  const viewport = page.viewportSize();
  if (!viewport) {
    // No viewport means no scroll container to grow, and no way to know what
    // was captured. Better to say so than to write a file.
    throw new Error(`shoot(${name}): the page has no viewport size to grow from.`);
  }

  const content = await contentHeight(page);
  const wanted = Math.max(content + FOOT, viewport.height);

  expect(
    wanted,
    `shoot(${name}): the page is ${content}px tall, past the ${MAX_SHOT_HEIGHT}px limit. ` +
      'Clamping here would silently clip the shot, which is the defect this helper exists ' +
      'for — split the capture or narrow the page instead.',
  ).toBeLessThanOrEqual(MAX_SHOT_HEIGHT);

  const grew = wanted > viewport.height;
  if (grew) {
    await page.setViewportSize({ width: viewport.width, height: wanted });
    /*
     * Wait for the CONDITION rather than a fixed sleep. `.frame` is sized in
     * `dvh`, so the layout settles when `main`'s own box has caught up with
     * the new viewport — a timed wait would be either flaky or slow, and
     * would not say which.
     */
    await page
      .waitForFunction(
        (target) => (document.querySelector('main')?.clientHeight ?? 0) >= target,
        wanted - FOOT - 1,
        { timeout: 5_000 },
      )
      .catch(() => {
        /*
         * Not fatal on its own: a page with no `main`, or one whose content
         * shrank on resize, never satisfies this. The height assertion below
         * is what actually decides whether the shot is usable.
         */
      });
  }

  try {
    await page.screenshot({ path, fullPage: true });
  } finally {
    if (grew) await page.setViewportSize(viewport);
  }

  /*
   * ★★ LOOK AT THE FILE. The original asked for a full page, received a
   * viewport, wrote it, and passed. Every caller trusted a request nothing
   * verified.
   *
   * Asserted against the CONTENT height rather than the requested one, so a
   * page that reflowed smaller after the resize is fine and a shot that
   * quietly came back one viewport tall is not.
   */
  const written = pngHeight(path);
  expect(
    written,
    `shoot(${name}): the page measured ${content}px but the PNG is ${written}px — ` +
      'the shot is clipped, and a clipped shot under a descriptive name is the thing ' +
      'this helper exists to prevent.',
  ).toBeGreaterThanOrEqual(Math.min(content, wanted));
}

/**
 * Record a state that was NOT photographed, and why.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A PERMANENTLY SKIPPED GUARD IS INDISTINGUISHABLE FROM A PASSING ONE
 * ════════════════════════════════════════════════════════════════════════════
 * `outreach.spec.ts`'s campaign-card test exists to prove we do not render
 * counters the platform never increments. It skips, because the tenant has no
 * campaigns — so **the assertion written to catch a false counter is the one
 * the tenant's state switches off.** The screen's dormant-defect pattern, in
 * the guard rather than in the product.
 *
 * A skip is the honest outcome: the assertion genuinely did not run, and
 * turning it into a pass would be worse. What is not honest is that a skip
 * reads as a pass in every summary either of us writes, and disappears
 * entirely from a count of greens.
 *
 * So the skip leaves an artifact beside the shots. `e2e/evidence` is emptied
 * before a run, so a missing shot already means "a spec did not shoot" — this
 * makes the *deliberate* absences say so in their own words, and leaves the
 * accidental ones as the only silent gaps.
 *
 * Deliberately a plain `.txt` next to the PNGs rather than a log line: the
 * evidence directory is what somebody reviews, and a reason that lives only
 * in a terminal that has scrolled away is not part of the evidence.
 */
export function recordUnreached(evidenceDir: string, name: string, reason: string): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, `${name}.unreached.txt`),
    `${name}\n\nNOT PHOTOGRAPHED.\n\n${reason.trim()}\n`,
    'utf8',
  );
}
