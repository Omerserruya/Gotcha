/**
 * Does `shoot()` actually capture the screen?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ════════════════════════════════════════════════════════════════════════════
 * Every screenshot this project ever took was one viewport tall. `fullPage:
 * true` extends to the DOCUMENT, and this app's document never scrolls:
 * `.frame` is `100dvh` with `overflow: hidden` and `main` carries
 * `overflow-y: auto`. 444 of 445 PNGs came out at exactly the viewport size,
 * and because screens differ only below the fold, five differently-named
 * files in `s04` shared one md5.
 *
 * **Nothing in a Playwright run looks at the file it just wrote.** The
 * assertions were true, the DOM was complete, and the artifact — the one
 * thing a human would actually inspect — was the one thing unchecked.
 *
 * So the helper now verifies its own output, and this verifies the helper.
 * It drives Chromium directly rather than through the test runner, so it
 * needs **no dev server, no session and no `next build`** — it can be run
 * while a capture is in progress without touching it.
 *
 *   npx tsx scripts/check-shoot.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Page } from '@playwright/test';

import { shoot } from '../e2e/shoot';

const out = (text: string) => process.stdout.write(text);

/**
 * The shell's scroll structure, reduced to what matters: a `100dvh` frame
 * that hides its overflow, and a `main` that scrolls. Reproduced rather than
 * loaded from the app so this needs no server — and kept in step with
 * `AppShell.module.css` by the two properties named above, which are the
 * only ones the defect turns on.
 */
const page = (panels: number) =>
  `data:text/html,${encodeURIComponent(`
<html><body style="margin:0">
<div style="block-size:100dvh;overflow:hidden;display:flex">
  <main style="flex:1;overflow-y:auto;padding:16px;font:16px sans-serif">
    ${Array.from(
      { length: panels },
      (_, i) =>
        `<section style="height:300px;background:hsl(${i * 37},60%,85%)">panel ${i + 1}</section>`,
    ).join('')}
  </main>
</div></body></html>`)}`;

/** Width and height from a PNG's IHDR. */
function size(path: string): { width: number; height: number } {
  const header = readFileSync(path).subarray(0, 24);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

let failures = 0;
function check(label: string, pass: boolean, detail: string) {
  if (!pass) failures += 1;
  out(`  ${pass ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${detail}\n`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'check-shoot-'));
  const browser = await chromium.launch();
  try {
    const tab: Page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    /* ── 1 · the defect is real, and `fullPage` cannot see past it ──────── */
    await tab.goto(page(8));
    const content = await tab.evaluate(() => document.querySelector('main')!.scrollHeight);
    const documentHeight = await tab.evaluate(() => document.documentElement.scrollHeight);
    check(
      'the document does not scroll; main does',
      documentHeight <= 800 && content > 2000,
      `document ${documentHeight}px · main ${content}px`,
    );

    await tab.screenshot({ path: join(dir, 'old.png'), fullPage: true });
    const old = size(join(dir, 'old.png'));
    check(
      'the OLD helper captured one viewport',
      old.height === 800,
      `${old.width}x${old.height} for ${content}px of content`,
    );

    /* ── 2 · the helper captures the whole of it ────────────────────────── */
    await shoot(tab, dir, 'new');
    const fixed = size(join(dir, 'new.png'));
    check(
      'shoot() captures the content',
      fixed.height >= content,
      `${fixed.width}x${fixed.height} for ${content}px of content`,
    );
    check(
      'and restores the viewport afterwards',
      tab.viewportSize()?.height === 800,
      `viewport is now ${tab.viewportSize()?.height}px`,
    );

    /* ── 3 · a page past the limit FAILS rather than clipping ───────────── */
    await tab.goto(page(60));
    let threw = false;
    try {
      await shoot(tab, dir, 'enormous');
    } catch {
      threw = true;
    } finally {
      await tab.setViewportSize({ width: 1280, height: 800 });
    }
    check(
      'a page past the limit throws, never clips',
      threw,
      threw ? 'refused to write a clipped shot' : 'wrote a clipped shot silently',
    );

    /* ── 4 · growing the height does not change a width-keyed layout ────── */
    await tab.setViewportSize({ width: 390, height: 844 });
    await tab.goto(page(8));
    const narrow = await tab.evaluate(
      () => document.querySelector('main')!.getBoundingClientRect().width,
    );
    await tab.setViewportSize({ width: 390, height: 2600 });
    const grown = await tab.evaluate(
      () => document.querySelector('main')!.getBoundingClientRect().width,
    );
    check(
      'a taller viewport leaves the 390px layout alone',
      narrow === grown,
      `main is ${narrow}px wide before and ${grown}px after`,
    );
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }

  out(failures === 0 ? '\n  shoot() captures the screen.\n' : `\n  ${failures} failed.\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
