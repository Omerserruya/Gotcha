#!/usr/bin/env node
/**
 * Measure the chat widget's layout in a REAL rendering engine.
 *
 * Scope, stated plainly: this proves the CSS resolves to the intended
 * numbers in Chromium - header height, the gap above the hero, the hero
 * clamp, the close target - using the merchant's live configuration
 * fetched from the dev API. jsdom cannot do this: it does not lay out, so
 * a rule that loses the cascade still "passes" there. That is exactly how
 * the close button shipped broken once.
 *
 * What it does NOT prove: that the published Shopify theme loads the
 * current bundle. Only verify-storefront-widget.mjs, run against the real
 * password-protected storefront, can say that.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import process from "node:process";

const pwPath = [
  process.env.PLAYWRIGHT_PATH,
  path.join(os.homedir(), "projects/marketing/node_modules/playwright/index.mjs"),
].filter(Boolean).find((c) => fs.existsSync(c));
if (!pwPath) { console.error("playwright not found; set PLAYWRIGHT_PATH"); process.exit(2); }
const { chromium } = await import(pwPath);

const API = process.env.GOTCHA_API ?? "https://dev.gotcha.co.il";
const SHOP = process.env.SHOP_DOMAIN ?? "urban-supply-gotcha-demo.myshopify.com";
const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? "  - " + detail : ""}`);
}

// The merchant's real configuration, not a fixture.
const boot = await fetch(`${API}/api/shopify-chat/bootstrap`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: `https://${SHOP}` },
  body: JSON.stringify({ shopDomain: SHOP, context: { pageType: "index", locale: "en" } }),
}).then((r) => r.json());

if (!boot?.data?.widget) {
  console.error("could not load the live widget config:", JSON.stringify(boot).slice(0, 200));
  process.exit(2);
}
const widget = boot.data.widget;
console.log(`\nLive config for ${SHOP}`);
console.log(`  hero: ${widget.ux.hero.mediaType} ${widget.ux.hero.height}px / ${widget.ux.hero.mobileHeight}px mobile`);
console.log(`  welcome: "${widget.ux.welcome.title}"\n`);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "frontend/public/widget/widget-manifest.json"), "utf8"));
const bundle = fs.readFileSync(path.join(ROOT, "frontend/public/widget", manifest.chat), "utf8");

const browser = await chromium.launch({
  executablePath: path.join(os.homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
  headless: true,
});

async function measure({ width, height, messages }) {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  // A real https origin, not about:blank. On about:blank
  // `window.location.origin` is the string "null", so the widget's own
  // `new URL(raw, origin)` throws and every media URL is refused - which
  // looked exactly like "the merchant configured no hero".
  await page.goto(API, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    ([cfg, msgs]) => {
      const host = document.createElement("div");
      host.id = "gotcha-chat-root";
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });
      const app = window.__gotchaShopifyChatApp({
        api: "", assets: "",
        context: { pageType: "index", locale: "en" },
        availability: "online",
        // Seeded like a returning shopper when a transcript is supplied:
        // the widget only asks for history when it already has a
        // conversation to resume.
        store: (() => {
          const m = msgs.length ? { session: "t", conversation: "c" } : {};
          return { get: (k) => m[k] ?? null, set: (k, v) => { m[k] = v; }, del: (k) => { delete m[k]; } };
        })(),
        post: async (p) => p.endsWith("/conversation")
          ? { data: { conversationId: "c", status: "OPEN", isHandedOver: false, messages: msgs } }
          : { data: {} },
        shadow,
        setUnread: () => {}, onOpened: () => {}, onClosed: () => {},
        // The mute control renders only when the host can actually mute
        // something. Without these it is absent, and the overlap it once
        // caused with the close button cannot be measured at all.
        visitorMuted: () => false,
        setVisitorMuted: () => {},
        widget: cfg,
      });
      // Kept on window so a failing check can report whether the close
      // HANDLER ran, which distinguishes "the click never landed" from
      // "it landed and something re-opened the panel".
      window.__gotchaChatApp = app;
      app.open();
    },
    [widget, messages],
  );
  await page.waitForTimeout(500);
  const geom = await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    const box = (sel) => { const e = s.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom }; };
    const vis = (sel) => { const e = s.querySelector(sel); if (!e) return false; const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return c.display !== "none" && c.visibility !== "hidden" && r.height > 0; };
    const panel = s.querySelector(".panel");
    return {
      view: panel.getAttribute("data-view"), state: panel.getAttribute("data-state"),
      panel: box(".panel"), header: box(".hd"), headerVisible: vis(".hd"), headerAvatar: box(".hd-av"),
      hero: box(".hero"), body: box(".bd"), composer: box(".ft"),
      textarea: box(".ta"), send: box(".snd"), subRow: box(".sub"),
      // The VISIBLE close control is the ::before chip, not the 44px
      // target it sits inside. Measuring the button would report the
      // touch area and miss the whole point of the change.
      closeChip: (() => {
        const e = s.querySelector('[data-act="close"]');
        if (!e) return null;
        const cs = getComputedStyle(e, "::before");
        const w = parseFloat(cs.width), h = parseFloat(cs.height);
        return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : null;
      })(),
      // Nothing may stick out sideways, whatever the theme is doing.
      overflowsX: (() => {
        const pr = s.querySelector(".panel").getBoundingClientRect();
        return Array.from(s.querySelectorAll(".panel *")).some((n) => {
          const r = n.getBoundingClientRect();
          return r.width > 0 && (r.left < pr.left - 1 || r.right > pr.right + 1);
        });
      })(),
      // The clamp is computed against the panel's MAXIMUM height, because
      // in the welcome view the panel hugs its content - measuring the
      // rendered height would be circular.
      panelBasis: window.matchMedia("(max-width: 560px)").matches
        ? window.innerHeight
        : Math.min(640, window.innerHeight - 120),
      close: box('[data-act="close"]'), closeVisible: vis('[data-act="close"]'),
      mute: box('[data-act="mute"]'), muteVisible: vis('[data-act="mute"]'),
      // Two controls that look alike must not sit in the same place. The
      // real question is what a shopper's tap actually lands on.
      controlsOverlap: (() => {
        const c = s.querySelector('[data-act="close"]');
        const m = s.querySelector('[data-act="mute"]');
        if (!c || !m) return false;
        const seen = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
          return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0; };
        if (!seen(c) || !seen(m)) return false;
        const a = c.getBoundingClientRect(), b = m.getBoundingClientRect();
        return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      })(),
      topmostAtCloseCentre: (() => {
        const c = s.querySelector('[data-act="close"]');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        const hit = s.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit ? hit.getAttribute("data-act") : null;
      })(),
      suggestions: Array.from(s.querySelectorAll(".sug-b"))
        .filter((b) => !b.hidden)
        .map((b) => { const r = b.getBoundingClientRect(); return { bottom: r.bottom, height: r.height }; }),
      // A scroll region legitimately holds more than it shows. What
      // matters is that everything is REACHABLE, not that it all fits.
      bodyScroll: (() => { const e = s.querySelector(".bd"); return e ? { scrollHeight: e.scrollHeight, clientHeight: e.clientHeight } : null; })(),
      lastSuggestionReachable: (() => {
        const e = s.querySelector(".bd");
        const all = Array.from(s.querySelectorAll(".sug-b")).filter((b) => !b.hidden);
        if (!e || !all.length) return true;
        const last = all[all.length - 1];
        // `behavior: "instant"` matters: .bd sets scroll-behavior:smooth,
        // so a plain `scrollTop = n` animates and a synchronous read after
        // it sees the OLD position - which reads as "unreachable".
        e.scrollTo({ top: e.scrollHeight, behavior: "instant" });
        const r = last.getBoundingClientRect();
        const composer = s.querySelector(".ft");
        const limit = composer ? composer.getBoundingClientRect().top : Infinity;
        e.scrollTo({ top: 0, behavior: "instant" });
        return r.bottom <= limit + 1;
      })(),
    };
  });
  return { page, geom };
}

const NOW = new Date().toISOString();
const CONVO = [
  { id: "a", direction: "INBOUND", body: "Do you have this in a 42?", messageType: "text", author: null, authorKind: "visitor", createdAt: NOW, commerce: null },
  { id: "b", direction: "OUTBOUND", body: "We do, in black and white.", messageType: "text", author: "Store Assistant", authorKind: "ai", createdAt: NOW, commerce: null },
];

// ── Desktop, welcome ──
let { page, geom: d } = await measure({ width: 1280, height: 900, messages: [] });
check("desktop welcome: opens in the welcome view", d.view === "welcome", `view=${d.view}`);
check("desktop welcome: no conversation header", d.headerVisible === false);
if (d.hero) {
  const gap = d.hero.top - d.panel.top;
  check("desktop welcome: hero is flush with the panel's top edge", Math.abs(gap) <= 1, `gap=${gap.toFixed(2)}px`);
  check("desktop welcome: hero is clamped to a quarter of the usable panel",
    d.hero.height <= Math.ceil(d.panelBasis * 0.25),
    `${Math.round(d.hero.height)}px of ${d.panelBasis}px usable (${Math.round((d.hero.height / d.panelBasis) * 100)}%)`);
} else {
  check("desktop welcome: hero is flush with the panel's top edge", true, "no hero media configured");
  check("desktop welcome: hero is clamped to a sane share of the panel", true, "no hero media configured");
}
check("desktop welcome: the close control is visible", d.closeVisible === true);
check("desktop welcome: the close control is at least 44x44",
  d.close && d.close.width >= 44 && d.close.height >= 44,
  d.close ? `${Math.round(d.close.width)}x${Math.round(d.close.height)}` : "missing");

const closedNow = await page.evaluate(() => {
  const s = document.getElementById("gotcha-chat-root").shadowRoot;
  s.querySelector('[data-act="close"]').click();
  const p = s.querySelector(".panel");
  const dbg = window.__gotchaChatApp && window.__gotchaChatApp.debugState ? window.__gotchaChatApp.debugState() : {};
  return { display: getComputedStyle(p).display, state: p.getAttribute("data-state"),
    height: p.getBoundingClientRect().height, clicks: dbg.closeClicks ?? null };
});
check("desktop: clicking X actually removes the panel from the layout",
  closedNow.display === "none" && closedNow.height === 0,
  `display=${closedNow.display} state=${closedNow.state} height=${closedNow.height} handlerRuns=${closedNow.clicks}`);
await page.close();

// ── Desktop, conversation ──
({ page, geom: d } = await measure({ width: 1280, height: 900, messages: CONVO }));
check("desktop conversation: enters the conversation view", d.view === "conversation", `view=${d.view}`);
check("desktop conversation: header is 40-48px tall",
  d.header && d.header.height >= 40 && d.header.height <= 48,
  d.header ? `${d.header.height.toFixed(1)}px` : "missing");
check("desktop conversation: header avatar is 28-34px",
  d.headerAvatar && d.headerAvatar.width >= 28 && d.headerAvatar.width <= 34,
  d.headerAvatar ? `${d.headerAvatar.width.toFixed(1)}px` : "missing");
check("desktop conversation: the scroll region ends above the composer",
  !d.composer || d.body.bottom <= d.composer.top + 1,
  d.composer ? `body ends ${Math.round(d.body.bottom)}, composer starts ${Math.round(d.composer.top)}` : "n/a");
check("desktop conversation: the close control survives the state change", d.closeVisible === true);
check("desktop conversation: mute and close do not overlap",
  d.controlsOverlap === false,
  d.muteVisible ? `close x=${d.close.left.toFixed(0)} mute x=${d.mute.left.toFixed(0)}` : "mute not offered");
check("desktop conversation: a tap on the close button reaches the close button",
  d.topmostAtCloseCentre === "close",
  `topmost=${d.topmostAtCloseCentre}`);
check("desktop: the composer is one line, not a panel",
  d.composer && d.composer.height <= 96,
  d.composer ? `${Math.round(d.composer.height)}px` : "missing");
check("desktop: the textarea defaults to a single line",
  d.textarea && d.textarea.height <= 42,
  d.textarea ? `${Math.round(d.textarea.height)}px` : "missing");
check("desktop: the send button is 36-40px",
  d.send && d.send.width >= 36 && d.send.width <= 40,
  d.send ? `${Math.round(d.send.width)}px` : "missing");
check("desktop: the footer row is thin",
  !d.subRow || d.subRow.height <= 20,
  d.subRow ? `${Math.round(d.subRow.height)}px` : "n/a");
check("desktop: the visible close chip is smaller than its touch target",
  d.closeChip && d.closeChip.width <= 32 && d.close.width >= 44,
  d.closeChip ? `chip ${Math.round(d.closeChip.width)}px inside ${Math.round(d.close.width)}px target` : "no chip");
check("desktop: nothing overflows the panel horizontally", d.overflowsX === false);
await page.close();

// ── Every viewport the merchant's shoppers actually use ──
for (const [w, h] of [[320, 568], [360, 640], [375, 667], [390, 844], [430, 932], [768, 1024]]) {
  const { page: vp, geom: m } = await measure({ width: w, height: h, messages: [] });
  const fits = m.panel.width <= w + 1 && m.panel.left >= -1;
  const heroOk = !m.hero || m.hero.height <= Math.ceil(m.panelBasis * (w <= 560 ? 0.22 : 0.25));
  // Scrolled to the end, the last suggestion must clear the composer.
  const sugOk = m.lastSuggestionReachable;
  const closeOk = m.close && m.close.width >= 44 && m.close.height >= 44;
  check(`${w}x${h}: fits, hero clamped, every suggestion clears the composer, 44px close, no overflow`,
    fits && heroOk && sugOk && closeOk && m.overflowsX === false,
    `panel=${Math.round(m.panel.width)}px hero=${m.hero ? Math.round(m.hero.height) : 0}px sugs=${m.suggestions.length}` +
      (fits ? "" : " FITS✗") + (heroOk ? "" : " HERO✗") + (sugOk ? "" : " SUGS✗") +
      (closeOk ? "" : " CLOSE✗") + (m.overflowsX ? " OVERFLOW✗" : ""));
  await vp.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} layout checks passed in Chromium`);
if (failed.length) { console.log("\nFAILED:"); for (const r of failed) console.log(`  • ${r.name} - ${r.detail}`); }
console.log("\nNote: this measures the widget in a real browser. It does NOT prove the");
console.log("published Shopify theme serves this bundle - see verify-storefront-widget.mjs.");
process.exit(failed.length ? 1 : 0);
