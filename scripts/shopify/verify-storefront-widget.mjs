#!/usr/bin/env node
/**
 * Acceptance test for the Shopify chat widget, run against the REAL
 * published storefront.
 *
 * This exists because a previous round was reported complete on the
 * strength of a locally-served page that imitated the storefront. It
 * passed; the merchant's actual store did not. Nothing here is served by
 * us: the theme, the App Embed, the CDN and the cache are all Shopify's,
 * which is the entire point.
 *
 * Every measurement is taken from the live DOM through the widget's own
 * shadow root, so a rule that loses the cascade shows up as a wrong
 * number rather than a passing assertion about a stylesheet.
 *
 * Usage:
 *   node scripts/shopify/verify-storefront-widget.mjs [--headed]
 *
 * The storefront is password-protected. STOREFRONT_PASSWORD unlocks it
 * unattended; without it the script opens a window and waits for a human
 * to type the password, rather than asking for it anywhere it would be
 * recorded.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import process from "node:process";

// Playwright is not a dependency of this repo and must not become one.
// It is resolved from wherever it already exists on the machine, so the
// acceptance test can run without changing the project's dependency set.
const PLAYWRIGHT_CANDIDATES = [
  process.env.PLAYWRIGHT_PATH,
  path.join(os.homedir(), "projects/marketing/node_modules/playwright/index.mjs"),
  path.join(os.homedir(), "projects/marketing/node_modules/playwright"),
].filter(Boolean);

const pwPath = PLAYWRIGHT_CANDIDATES.find((c) => fs.existsSync(c));
if (!pwPath) {
  console.error("playwright could not be found. Set PLAYWRIGHT_PATH to an installed copy.");
  process.exit(2);
}
const { chromium } = await import(
  fs.statSync(pwPath).isDirectory() ? path.join(pwPath, "index.js") : pwPath
);

const STORE = process.env.STOREFRONT_URL ?? "https://urban-supply-gotcha-demo.myshopify.com/";
/**
 * The storefront password, from the environment or from a file outside
 * the repository.
 *
 * A file is offered because it keeps the password out of shell history
 * and out of any transcript, and it is never committed: ~/.gotcha-storefront-password
 * is outside the working tree.
 */
const PASSWORD_FILE = process.env.STOREFRONT_PASSWORD_FILE ??
  path.join(os.homedir(), ".gotcha-storefront-password");
const PASSWORD =
  process.env.STOREFRONT_PASSWORD ??
  (fs.existsSync(PASSWORD_FILE) ? fs.readFileSync(PASSWORD_FILE, "utf8").trim() : "");
const HEADED_POSSIBLE = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const HEADED = process.argv.includes("--headed") || (!PASSWORD && HEADED_POSSIBLE);

const EXECUTABLE = path.join(
  os.homedir(),
  ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome",
);

const results = [];
let failures = 0;

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (!pass) failures++;
  const mark = pass ? "✓" : "✗";
  console.log(`${mark} ${name}${detail ? "  - " + detail : ""}`);
}

/** Read the widget's live geometry from inside its shadow root. */
const PROBE = () => {
  const host = document.getElementById("gotcha-chat-root");
  if (!host || !host.shadowRoot) return { error: "no widget host" };
  const s = host.shadowRoot;
  const q = (sel) => s.querySelector(sel);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom };
  };
  const panel = q(".panel");
  const visible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };
  return {
    panel: box(panel),
    panelVisible: visible(panel),
    panelState: panel && panel.getAttribute("data-state"),
    panelView: panel && panel.getAttribute("data-view"),
    header: box(q(".hd")),
    headerVisible: visible(q(".hd")),
    headerAvatar: box(q(".hd-av")),
    hero: box(q(".hero")),
    body: box(q(".bd")),
    welcome: box(q(".wel")),
    closeBtn: box(q('[data-act="close"]')),
    closeVisible: visible(q('[data-act="close"]')),
    launcherVisible: visible(q('[data-act="launcher"]')),
    suggestions: Array.from(s.querySelectorAll(".sug button, .sug .sug-b")).map((b) => box(b)),
    composer: box(q(".ft")),
    title: (q(".wel-h") || {}).textContent,
  };
};

async function openWidget(page) {
  await page.evaluate(() => {
    const host = document.getElementById("gotcha-chat-root");
    const btn = host && host.shadowRoot.querySelector('[data-act="launcher"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(700);
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  const blocked = [];
  page.on("requestfailed", (r) => blocked.push(`${r.url()} - ${r.failure()?.errorText}`));

  console.log(`\nStorefront: ${STORE}\n`);
  await page.goto(STORE, { waitUntil: "domcontentloaded", timeout: 60000 });

  // ── Password gate ──
  const passField = page.locator('input[type="password"]').first();
  if (await passField.count()) {
    if (PASSWORD) {
      await passField.fill(PASSWORD);
      // Submitting the form is what leaves /password. Pressing Enter in
      // the field is not reliably enough on this template, and a run that
      // silently stays on the password page reports every check as a
      // failure for the wrong reason.
      const submit = page.locator('form button[type="submit"], form input[type="submit"], form button').first();
      await Promise.all([
        page.waitForURL((u) => !u.pathname.startsWith("/password"), { timeout: 30000 }).catch(() => {}),
        submit.count().then((n) => (n ? submit.click() : page.keyboard.press("Enter"))),
      ]);
      await page.waitForLoadState("domcontentloaded");
      if (new URL(page.url()).pathname.startsWith("/password")) {
        console.error("\nThe storefront password was not accepted. Nothing below would be meaningful.");
        await browser.close();
        process.exit(2);
      }
    } else {
      if (!HEADED_POSSIBLE) {
        console.error("The storefront is password protected and this machine has no display,");
        console.error("so a browser cannot be opened for you to type into.\n");
        console.error("Put the password in a file outside the repo and re-run:");
        console.error(`  printf '%s' 'YOUR-PASSWORD' > ${PASSWORD_FILE}`);
        console.error("  node scripts/shopify/verify-storefront-widget.mjs\n");
        await browser.close();
        process.exit(3);
      }
      console.log("The storefront is password protected. A browser window is open -");
      console.log("please enter the password there. Waiting up to 3 minutes...\n");
      await page.waitForSelector('input[type="password"]', { state: "detached", timeout: 180000 });
    }
  }
  await page.waitForTimeout(2500);

  // ── 1-3: the widget is actually on the page ──
  const bootstrapReq = await page.evaluate(() =>
    Array.from(document.scripts).map((s) => s.src).filter((s) => s.includes("gotcha-shopify")),
  );
  check("1. the App Embed loads the GOTCHA bootstrap", bootstrapReq.length > 0, bootstrapReq[0] ?? "no script tag");
  check("2. no request was blocked (CORS, CSP, 404)", blocked.length === 0, blocked.slice(0, 2).join(" | "));

  let p = await page.evaluate(PROBE);
  check("3. the launcher is painted on the storefront", !p.error, p.error ?? "");
  if (p.error) { await browser.close(); return report(); }

  // ── 4-11: the WELCOME state ──
  await openWidget(page);
  p = await page.evaluate(PROBE);
  check("4. the panel opens", p.panelVisible === true, `state=${p.panelState}`);
  check("5. it opens in the welcome view", p.panelView === "welcome", `view=${p.panelView}`);
  check("6. the welcome screen has no conversation header", p.headerVisible === false);

  if (p.hero) {
    const gap = p.hero.top - p.panel.top;
    check("7. the hero sits flush against the panel's top edge", Math.abs(gap) <= 1, `gap=${gap.toFixed(1)}px`);
    check("8. the hero is not excessively tall", p.hero.height <= Math.round(p.panel.height * 0.34),
      `hero=${Math.round(p.hero.height)}px of panel=${Math.round(p.panel.height)}px`);
  } else {
    check("7. the hero sits flush against the panel's top edge", true, "no hero media configured");
    check("8. the hero is not excessively tall", true, "no hero media configured");
  }

  check("9. a close control is visible on the welcome screen", p.closeVisible === true);
  check("10. the close control meets the 44px touch target",
    !!p.closeBtn && p.closeBtn.width >= 44 && p.closeBtn.height >= 44,
    p.closeBtn ? `${Math.round(p.closeBtn.width)}x${Math.round(p.closeBtn.height)}` : "missing");
  check("11. the close control is inside the panel",
    !!p.closeBtn && p.closeBtn.top >= p.panel.top - 1 && p.closeBtn.bottom <= p.panel.bottom + 1);

  // ── 12-14: the X actually closes, and stays closed ──
  await page.evaluate(() => {
    const host = document.getElementById("gotcha-chat-root");
    host.shadowRoot.querySelector('[data-act="close"]').click();
  });
  await page.waitForTimeout(400);
  p = await page.evaluate(PROBE);
  check("12. clicking X visibly closes the panel", p.panelVisible === false, `state=${p.panelState}`);

  await page.waitForTimeout(3000);
  p = await page.evaluate(PROBE);
  check("13. it does not reopen on its own within 3s", p.panelVisible === false);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  p = await page.evaluate(PROBE);
  check("14. it stays closed across a page reload", p.panelVisible === false, `state=${p.panelState}`);

  // ── 15-19: the transition into a conversation ──
  await openWidget(page);
  p = await page.evaluate(PROBE);
  const sent = await page.evaluate(() => {
    const host = document.getElementById("gotcha-chat-root");
    const s = host.shadowRoot;
    const sug = s.querySelector(".sug button");
    if (sug) { sug.click(); return "suggestion"; }
    const input = s.querySelector("textarea, input[type='text']");
    if (!input) return null;
    input.value = "Do you have this in a size 42?";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const form = s.querySelector("form");
    if (form) { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); return "form"; }
    return null;
  });
  await page.waitForTimeout(2500);
  p = await page.evaluate(PROBE);
  check("15. sending a message enters the conversation view", p.panelView === "conversation", `via ${sent}, view=${p.panelView}`);
  check("16. the compact header appears", p.headerVisible === true);
  check("17. the conversation header is 40-48px tall",
    !!p.header && p.header.height >= 40 && p.header.height <= 48,
    p.header ? `${p.header.height.toFixed(1)}px` : "missing");
  check("18. the header avatar is 28-34px",
    !!p.headerAvatar && p.headerAvatar.width >= 28 && p.headerAvatar.width <= 34,
    p.headerAvatar ? `${p.headerAvatar.width.toFixed(1)}px` : "missing");
  check("19. the close control survives the state change", p.closeVisible === true);

  // ── 20-21: the composer never covers the content ──
  check("20. the scroll region ends above the composer",
    !p.composer || !p.body || p.body.bottom <= p.composer.top + 1,
    p.composer && p.body ? `body=${Math.round(p.body.bottom)} composer=${Math.round(p.composer.top)}` : "n/a");
  check("21. closing still works from the conversation view", await (async () => {
    await page.evaluate(() => {
      const host = document.getElementById("gotcha-chat-root");
      host.shadowRoot.querySelector('[data-act="close"]').click();
    });
    await page.waitForTimeout(400);
    return (await page.evaluate(PROBE)).panelVisible === false;
  })());

  // ── 22-27: mobile ──
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(STORE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await phone.waitForTimeout(2500);
  await openWidget(phone);
  const m = await phone.evaluate(PROBE);
  check("22. the widget opens on a phone viewport", m.panelVisible === true, `view=${m.panelView}`);
  check("23. the panel does not overflow the phone viewport",
    !!m.panel && m.panel.width <= 390 && m.panel.left >= -1,
    m.panel ? `${Math.round(m.panel.width)}px wide at x=${Math.round(m.panel.left)}` : "missing");
  check("24. the mobile hero leaves room for the rest of the panel",
    !m.hero || m.hero.height <= Math.round(m.panel.height * 0.3),
    m.hero ? `${Math.round(m.hero.height)}px of ${Math.round(m.panel.height)}px` : "no hero");
  check("25. the mobile close target is still 44px",
    !!m.closeBtn && m.closeBtn.width >= 44 && m.closeBtn.height >= 44,
    m.closeBtn ? `${Math.round(m.closeBtn.width)}x${Math.round(m.closeBtn.height)}` : "missing");
  check("26. every suggestion is reachable above the composer",
    m.suggestions.length === 0 || !m.composer || m.suggestions.every((s) => s.bottom <= m.composer.top + 1),
    `${m.suggestions.length} suggestions`);
  check("27. X closes the panel on mobile", await (async () => {
    await phone.evaluate(() => {
      const host = document.getElementById("gotcha-chat-root");
      host.shadowRoot.querySelector('[data-act="close"]').click();
    });
    await phone.waitForTimeout(400);
    return (await phone.evaluate(PROBE)).panelVisible === false;
  })());

  // ── 28: nothing broke on the merchant's page ──
  const ours = consoleErrors.filter((e) => /gotcha/i.test(e));
  check("28. the widget logs no errors on the storefront", ours.length === 0, ours.slice(0, 2).join(" | "));

  await page.screenshot({ path: "/home/ocs/.cache/cc-work/storefront-desktop.png" }).catch(() => {});
  await phone.screenshot({ path: "/home/ocs/.cache/cc-work/storefront-mobile.png" }).catch(() => {});

  await browser.close();
  report();
}

function report() {
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures) {
    console.log("\nFAILED:");
    for (const r of results.filter((x) => !x.pass)) console.log(`  • ${r.name}${r.detail ? " - " + r.detail : ""}`);
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("verification could not run:", err.message);
  process.exit(2);
});
