#!/usr/bin/env node
/**
 * The website chat widget, in a real browser.
 *
 * Two questions, both of which used to have the wrong answer:
 *
 *   1. Does a DELETED widget draw anything? It must not. The old script
 *      painted its launcher before asking the server, so removing a
 *      channel left a button on a customer's site that opened onto
 *      silence.
 *   2. Does a live widget render the SAME experience as the storefront?
 *      They were two implementations and had drifted.
 *
 * The server is stubbed here - this is about the script's behaviour, and
 * a real tenant's widget id is not something to require in a test - but
 * the SCRIPT and the BUNDLE are the real files, and Chromium is real.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import process from "node:process";

const pwPath = [
  process.env.PLAYWRIGHT_PATH,
  path.join(path.resolve(new URL("../..", import.meta.url).pathname), "frontend-v2/node_modules/playwright/index.mjs"),
  path.join(os.homedir(), "projects/marketing/node_modules/playwright/index.mjs"),
].filter(Boolean).find((c) => fs.existsSync(c));
if (!pwPath) { console.error("playwright not found; set PLAYWRIGHT_PATH"); process.exit(2); }
const { chromium } = await import(pwPath);

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const DIR = path.join(ROOT, "frontend/public/widget");
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "widget-manifest.json"), "utf8"));
const embedScript = fs.readFileSync(path.join(DIR, "chatcenter-widget.js"), "utf8");
const chatBundle = fs.readFileSync(path.join(DIR, manifest.chat), "utf8");

const ORIGIN = "https://example-tenant-site.test";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? "  - " + detail : ""}`);
}

/** The public widget config the bootstrap endpoint returns. */
function widgetConfig(overrides = {}) {
  return {
    appearance: {
      primaryColor: "#0ea5e9", contrastColor: "#ffffff", logoUrl: null, avatarUrl: null,
      launcherIcon: "chat", launcherPosition: "right", cornerRadius: 20,
      language: "en", direction: "ltr", showPoweredBy: true,
    },
    welcome: { headline: "Talk to us", subline: "Ask us anything.", assistantName: "Support", suggestedQuestions: ["Where is my order?"] },
    offline: { active: false, message: "Away", behavior: "ai", formFields: [], consentRequired: false, consentText: "" },
    features: { humanHandoff: true, productMessaging: false, addToCart: false },
    ux: {
      welcome: { title: "Talk to us", subtitle: "Ask us anything about our service.", assistantName: "Support",
        suggestedQuestions: ["Where is my order?", "Do you ship abroad?", "How do refunds work?"],
        avatarUrl: null, avatarSize: 56, avatarOverlap: 30, showAvatarBorder: true, textAlign: "center",
        accentColor: "#0ea5e9", textColor: "#0f172a" },
      launcher: { shape: "pill", size: 48, position: "right", mobilePosition: "right", offsetBottom: 18,
        offsetSide: 18, mobileOffsetBottom: 14, backgroundColor: "#0ea5e9", iconColor: "#ffffff",
        borderColor: "#ffffff", showBorder: false, shadow: 2, icon: "chat", iconUrl: null,
        label: "Chat with us", showLabel: true, showUnreadBadge: true, hideOnMobileWhenOpen: true },
      hero: { mediaType: "none", mediaUrl: null, posterUrl: null, height: 124, mobileHeight: 108,
        focalPoint: "50% 50%", objectFit: "cover", overlayStrength: 0, fadeStrength: 60,
        cornerRadius: 0, backgroundColor: "#ffffff", videoLoop: true, videoAutoplay: true },
      proactive: { enabled: false, trigger: "time_on_page", delaySeconds: 15, mobileDelaySeconds: 25,
        minPageViews: 2, scrollPercent: 50, customEvent: "", title: "", message: "", actionLabel: "",
        autoOpen: false, playSound: false, maxPerSession: 1, maxPerVisitor: 3, cooldownHours: 24,
        includeUrls: [], excludeUrls: [], desktopEnabled: true, mobileEnabled: true,
        firstVisitOnly: false, returningVisitorOnly: false },
      sounds: { enabled: false, pack: "subtle", volume: 40, outgoing: false, incomingAi: false,
        incomingHuman: false, proactive: false },
      behavior: { openOnLoad: false, closeOnOutsideClick: false, rememberOpenState: true,
        mobileFullScreen: true, keepHeaderMedia: false },
    },
    ...overrides,
  };
}

// The browser the installed Playwright ships with, unless one is named:
// a hardcoded build path broke this script the day that build was replaced.
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
});

/**
 * Serve a tenant's page with the embed snippet on it, with the widget
 * either alive or deleted.
 */
async function openSite({ widgetExists, widget = widgetConfig(), availability = "online", lang = "en",
  stored = null, history = [], wait = 1800, ctx: given = null }) {
  const ctx = given || await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const calls = [];
  // A returning visitor: the loader's own keys (cc_ + the widget id's last 12).
  if (stored) {
    await page.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem("cc_wid_test_123_" + k, v);
    }, stored);
  }

  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.pathname);

    if (url.pathname === "/") {
      return route.fulfill({
        status: 200, contentType: "text/html",
        body: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"></head>` +
          '<body style="margin:0;min-height:100vh;background:#f8fafc">' +
          '<h1 style="font:600 22px sans-serif;padding:24px">A tenant\'s own website</h1>' +
          `<script>window.__chatcenter={apiUrl:"${ORIGIN}",widgetId:"wid_test_123"};</script>` +
          '<script src="/widget/chatcenter-widget.js"></script>' +
          "</body></html>",
      });
    }
    if (url.pathname === "/widget/chatcenter-widget.js") {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: embedScript });
    }
    if (url.pathname === `/widget/${manifest.chat}`) {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: chatBundle });
    }
    if (url.pathname === "/widget/widget-manifest.json") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(manifest) });
    }
    if (url.pathname === "/api/embedded-chat/bootstrap") {
      // The uniform refusal a deleted widget gets.
      if (!widgetExists) {
        // 200 with an empty body: "render nothing" is an answer, and a
        // 404 would put a red line in the tenant's own console.
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) });
      }
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ data: { availability, widget } }),
      });
    }
    if (url.pathname === "/api/embedded-chat/init") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ data: { sessionId: "conv_1", visitorId: "v1", sessionToken: "conv_1" } }) });
    }
    if (url.pathname.startsWith("/api/embedded-chat/messages")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { messages: history } }) });
    }
    if (url.pathname === "/api/embedded-chat/message") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) });
    }
    return route.fulfill({ status: 404, body: "" });
  });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });

  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(wait);
  return { ctx, page, calls, errors };
}

// ── A widget that no longer exists ──
{
  const { ctx, page, calls, errors } = await openSite({ widgetExists: false });
  const host = await page.locator("#gotcha-chat-root").count();
  check("deleted widget: nothing is added to the page at all", host === 0, `hosts=${host}`);
  check("deleted widget: it asked the server before drawing",
    calls.includes("/api/embedded-chat/bootstrap"), calls.filter((c) => c.startsWith("/api")).join(", ") || "no api calls");
  check("deleted widget: the chat bundle is never even downloaded",
    !calls.some((c) => c.includes(manifest.chat)));
  check("deleted widget: nothing is printed on the tenant's page",
    errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

// ── A live widget ──
{
  const { ctx, page, errors } = await openSite({ widgetExists: true });

  const launcher = await page.evaluate(() => {
    const host = document.getElementById("gotcha-chat-root");
    if (!host || !host.shadowRoot) return null;
    const b = host.shadowRoot.querySelector('[data-act="launcher"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return { w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, label: b.textContent.trim() };
  });
  check("live widget: the launcher is painted", !!launcher, launcher ? `${launcher.w}x${launcher.h} "${launcher.label}"` : "missing");
  check("live widget: it uses the tenant's own accent",
    launcher && launcher.bg === "rgb(14, 165, 233)", launcher ? launcher.bg : "");

  await page.evaluate(() => {
    document.getElementById("gotcha-chat-root").shadowRoot.querySelector('[data-act="launcher"]').click();
  });
  await page.waitForTimeout(1200);

  const panel = await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    const p = s.querySelector(".panel");
    if (!p) return null;
    const box = (sel) => { const e = s.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height) : null; };
    return {
      view: p.getAttribute("data-view"),
      title: (s.querySelector(".wel-h") || {}).textContent,
      suggestions: s.querySelectorAll(".sug-b:not([hidden])").length,
      composer: box(".ft"),
      close: !!s.querySelector('[data-act="close"]'),
      hasProductCard: !!s.querySelector(".card"),
    };
  });

  check("live widget: opens into the SAME welcome experience as the storefront",
    !!panel && panel.view === "welcome", panel ? `view=${panel.view}` : "no panel");
  check("live widget: shows the tenant's configured welcome copy",
    !!panel && panel.title === "Talk to us", panel ? `"${panel.title}"` : "");
  check("live widget: shows the configured suggested questions",
    !!panel && panel.suggestions === 3, panel ? `${panel.suggestions} shown` : "");
  check("live widget: the composer is the compact one",
    !!panel && panel.composer <= 96, panel ? `${panel.composer}px` : "");
  check("live widget: the close control is present",
    !!panel && panel.close);
  check("live widget: no commerce UI on a website widget",
    !!panel && panel.hasProductCard === false);

  const closed = await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    s.querySelector('[data-act="close"]').click();
    const p = s.querySelector(".panel");
    return { display: getComputedStyle(p).display, state: p.getAttribute("data-state") };
  });
  check("live widget: X closes it", closed.display === "none" && closed.state === "closed",
    `display=${closed.display}`);

  check("live widget: logs nothing on the tenant's page", errors.length === 0, errors.slice(0, 2).join(" | "));

  await page.screenshot({ path: path.join(os.homedir(), ".cache/cc-work/shots/webchat-live.png") }).catch(() => {});
  await ctx.close();
}

// ── Design 7: the bubble and the pop-up (live widget, L1) ──
//
// What the shadow root holds, read in one place.
const look = (page) => page.evaluate(() => {
  const s = document.getElementById("gotcha-chat-root")?.shadowRoot;
  if (!s) return null;
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom) }; };
  const b = s.querySelector('[data-act="launcher"]');
  const pop = s.querySelector('[data-act="popup"]');
  const bdg = s.querySelector(".bdg");
  return {
    bubble: rect(b), bg: b && getComputedStyle(b).backgroundColor, fg: b && getComputedStyle(b).color,
    face: b ? (b.querySelector(".mark") || {}).textContent || "" : "", chevron: !!(b && b.querySelector(".chev")),
    expanded: b && b.getAttribute("aria-expanded"),
    dot: !!(b && b.querySelector(".on")),
    badge: bdg && bdg.getAttribute("data-show") === "1" ? bdg.textContent : "",
    pop: rect(pop), popDir: pop && pop.getAttribute("dir"),
    typing: !!(pop && pop.querySelector(".pop-ty")),
    name: pop ? (pop.querySelector(".pop-nm") || {}).textContent : null,
    replies: pop ? (pop.querySelector(".pop-t") || {}).textContent || "" : null,
    message: pop ? (pop.querySelector(".pop-m") || {}).textContent || "" : null,
    deals: pop && pop.querySelector('[data-act="deals"]') ? pop.querySelector('[data-act="deals"]').textContent : "",
    dealNext: !!(pop && pop.querySelector('[data-act="deal-next"]')),
    panel: (s.querySelector(".panel") || {}).getAttribute?.("data-state") || null,
  };
});
const shadowClick = (page, sel) => page.evaluate((q) => document.getElementById("gotcha-chat-root").shadowRoot.querySelector(q).click(), sel);
const withUx = (ux, extra = {}) => { const w = widgetConfig(extra); w.ux = { ...w.ux, ...ux }; return w; };
const popupOn = (over = {}) => ({ ...widgetConfig().ux.proactive, enabled: true, delaySeconds: 1, mobileDelaySeconds: 1, message: "Hi! Looking for a gift?", ...over });

{
  const { ctx, page, errors } = await openSite({ widgetExists: true,
    widget: { ...widgetConfig({ brand: { name: "Urban Supply - GOTCHA Demo", initial: "U" } }), appearance: { ...widgetConfig().appearance, primaryColor: "#2b2622", contrastColor: "#fbf8f3" } } });
  const a = await look(page);
  check("L1 bubble: 56px, 22px from the side and the bottom", a.bubble.w === 56 && a.bubble.h === 56 && a.bubble.right === 22 && a.bubble.bottom === 22, JSON.stringify(a.bubble));
  check("L1 bubble: the main colour, the brand's initial in its contrast colour", a.bg === "rgb(43, 38, 34)" && a.fg === "rgb(251, 248, 243)" && a.face === "U", `${a.bg} ${a.fg} "${a.face}"`);
  check("L1 bubble: the green dot while someone answers", a.dot);
  check("L1: a pop-up switched off never shows", a.pop === null);
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(500);
  const o = await look(page);
  check("L1 bubble: open, it is a chevron that minimises", o.chevron && o.expanded === "true" && !o.dot && o.panel === "open", JSON.stringify({ c: o.chevron, e: o.expanded, d: o.dot, p: o.panel }));
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(300);
  const c = await look(page);
  check("L1 bubble: the chevron closes the chat", c.panel === "closed" && c.face === "U" && c.dot, JSON.stringify({ p: c.panel, f: c.face }));
  check("L1: logs nothing (bubble)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

{
  // A pale main colour: the initial takes the colour the server chose to read on it.
  const pale = widgetConfig({ brand: { name: "Aviv & Co.", initial: "A" } });
  pale.appearance = { ...pale.appearance, primaryColor: "#f5e6c8", contrastColor: "#111111" };
  const { page, ctx } = await openSite({ widgetExists: true, widget: pale, wait: 900 });
  const a = await look(page);
  check("L1 bubble: a pale main colour gets dark text", a.bg === "rgb(245, 230, 200)" && a.fg === "rgb(17, 17, 17)" && a.face === "A", `${a.bg} ${a.fg} "${a.face}"`);
  await ctx.close();
}

{
  const { page, ctx } = await openSite({ widgetExists: true, availability: "offline", widget: withUx({ proactive: popupOn() }), wait: 3400 });
  const a = await look(page);
  check("L1 offline: no green dot, and the pop-up does not promise a quick reply", !a.dot && a.pop && a.replies === "", JSON.stringify({ d: a.dot, r: a.replies }));
  await ctx.close();
}

{
  const { ctx, page, errors } = await openSite({ widgetExists: true, widget: withUx({ proactive: popupOn() }), wait: 400 });
  const before = await look(page);
  check("L1 pop-up: not before the merchant's delay", before.pop === null);
  await page.waitForTimeout(900);
  const typing = await look(page);
  check("L1 pop-up: who is writing, then typing", !!typing.pop && typing.typing && typing.name === "Support" && typing.replies === "replies right away" && !typing.message, JSON.stringify({ t: typing.typing, n: typing.name, r: typing.replies }));
  check("L1 pop-up: no '1' while it is still typing", typing.badge === "", typing.badge);
  await page.waitForTimeout(1700);
  const ready = await look(page);
  check("L1 pop-up: the merchant's message, after the typing", ready.message === "Hi! Looking for a gift?" && !ready.typing, ready.message);
  check("L1 pop-up: 330px, 90px up, 22px from the side", ready.pop.w === 330 && ready.pop.bottom === 90 && ready.pop.right === 22, JSON.stringify(ready.pop));
  check("L1 bubble: '1' once the pop-up has its message", ready.badge === "1", ready.badge);
  check("L1 pop-up: no deals strip without chosen coupons", ready.deals === "");
  await shadowClick(page, '[data-act="popup-open"]');
  await page.waitForTimeout(500);
  const opened = await look(page);
  check("L1 pop-up: its message opens the chat, and both pop-up and '1' go", opened.panel === "open" && opened.pop === null && opened.badge === "", JSON.stringify({ p: opened.panel, b: opened.badge }));
  // Once per visit: the next page of the same visit offers nothing.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3200);
  const again = await look(page);
  check("L1 pop-up: once per visit", again.pop === null);
  check("L1: logs nothing (pop-up)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

{
  const { ctx, page } = await openSite({ widgetExists: true, widget: withUx({ proactive: popupOn() }), wait: 3200 });
  await shadowClick(page, '[data-act="popup-close"]');
  await page.waitForTimeout(200);
  const a = await look(page);
  check("L1 pop-up: ✕ dismisses it and its '1'", a.pop === null && a.badge === "" && a.panel === "closed", JSON.stringify({ b: a.badge, p: a.panel }));
  await ctx.close();
}

{
  const w = withUx({ proactive: popupOn() });
  w.promotions = [
    { code: "SPRING15", amount: "15.00", discountType: "percent", expiresAt: null, minimumAmount: null },
    { code: "TENOFF", amount: "10.00", discountType: "fixed_cart", expiresAt: null, minimumAmount: null },
    { code: "VIP20", amount: "20", discountType: "percent", expiresAt: "2026-12-31T21:59:59.000Z", minimumAmount: "100" },
  ];
  const { ctx, page } = await openSite({ widgetExists: true, widget: w, wait: 3200 });
  const a = await look(page);
  check("L1 deals: the first chosen coupon, in words", a.deals.includes("Active deal") && a.deals.includes("15% off") && a.deals.includes("Coupon code SPRING15"), a.deals);
  await shadowClick(page, '[data-act="deal-next"]');
  const b = await look(page);
  check("L1 deals: onward skips an amount with no currency", b.deals.includes("20% off") && b.deals.includes("VIP20") && b.deals.includes("valid until 31/12"), b.deals);
  await shadowClick(page, '[data-act="deal-next"]');
  const c = await look(page);
  check("L1 deals: and comes round again", c.deals.includes("SPRING15"), c.deals);
  await ctx.close();
}

{
  const w = withUx({ proactive: popupOn() });
  w.promotions = [{ code: "TENOFF", amount: "10.00", discountType: "fixed_cart", expiresAt: null, minimumAmount: null }];
  const { ctx, page } = await openSite({ widgetExists: true, widget: w, wait: 3200 });
  const a = await look(page);
  check("L1 deals: nothing truthful to say, no strip", a.message && a.deals === "", a.deals);
  await ctx.close();
}

{
  const history = [
    { id: "m1", direction: "INBOUND", body: "Do you ship to Eilat?", createdAt: "2026-10-14T08:00:00.000Z" },
    { id: "m2", direction: "OUTBOUND", body: "Yes, in two days.\nAnything else?", createdAt: "2026-10-14T08:00:05.000Z" },
  ];
  const { ctx, page } = await openSite({ widgetExists: true, widget: withUx({ proactive: popupOn() }), wait: 3200,
    stored: { conversation: "conv_1", token: "conv_1", session: "conv_1" }, history });
  const a = await look(page);
  check("L1 resume: a conversation under way is offered back, with its last line", a.message === "Pick up where we left off?Yes, in two days.", a.message);
  check("L1 resume: no '1' for an offer", a.badge === "", a.badge);
  await ctx.close();
}

{
  const he = widgetConfig();
  he.appearance = { ...he.appearance, language: "he" };
  he.ux = { ...he.ux, proactive: popupOn({ message: "היי, אפשר לעזור?" }), launcher: { ...he.ux.launcher, position: "left", mobilePosition: "left" } };
  const { ctx, page } = await openSite({ widgetExists: true, widget: he, lang: "he", wait: 3200 });
  const a = await look(page);
  check("L1 Hebrew: the pop-up reads right to left, in Hebrew", a.popDir === "rtl" && a.replies === "עונה מיד", `${a.popDir} "${a.replies}"`);
  check("L1 left side: bubble and pop-up on the left", a.bubble.x === 22 && a.pop.x === 22, `${a.bubble.x} ${a.pop.x}`);
  await page.screenshot({ path: path.join(os.homedir(), ".cache/cc-work/shots/webchat-l1-he.png") }).catch(() => {});
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in Chromium`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const r of failed) console.log(`  • ${r.name}${r.detail ? " - " + r.detail : ""}`);
}
process.exit(failed.length ? 1 : 0);
